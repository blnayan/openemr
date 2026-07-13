import { describe, it, expect } from 'vitest';
import { FhirContextWorker } from '../../../../src/graph/supervisor/FhirContextWorker.js';
import { ConflictDetectorWorker } from '../../../../src/graph/supervisor/ConflictDetectorWorker.js';
import type { AccumulatedHandoff } from '../../../../src/graph/supervisor/types.js';

describe('FhirContextWorker', () => {
  it('returns dispatcher snapshot with worker tag', async () => {
    const worker = new FhirContextWorker({
      async run() {
        return {
          hasPatientSummary: true,
          activeProblemsCount: 1,
          activeMedsCount: 2,
          recentLabsCount: 3,
          recentVitalsCount: 4,
          allergiesCount: 1,
          recentEncountersCount: 1,
          anchors: ['Maria Chen'],
        };
      },
    });
    const out = await worker.run({ question: 'q', pid: 1 });
    expect(out.worker).toBe('fhir_context');
    expect(out.snapshot.activeMedsCount).toBe(2);
  });
});

describe('ConflictDetectorWorker', () => {
  it('detects med mismatch between intake and empty chart meds', () => {
    const worker = new ConflictDetectorWorker();
    const accumulated: AccumulatedHandoff[] = [
      {
        worker: 'fhir_context',
        latency_ms: 1,
        output: {
          worker: 'fhir_context',
          snapshot: {
            hasPatientSummary: true,
            activeProblemsCount: 1,
            activeMedsCount: 0,
            recentLabsCount: 1,
            recentVitalsCount: 1,
            allergiesCount: 1,
            recentEncountersCount: 1,
            anchors: [],
          },
        },
      },
      {
        worker: 'intake_extractor',
        latency_ms: 1,
        output: {
          worker: 'intake_extractor',
          extractionId: 'x1',
          documentId: null,
          documentName: null,
          intakeForm: {
            patient_name: 'Maria Chen',
            date_of_birth: '1980-01-01',
            sex: 'female',
            chief_concern: 'Follow-up',
            current_medications: [{ name: 'Metformin', dose: '500 mg' }],
            allergies: [],
            family_history: [],
            cited_spans: [],
          },
        },
      },
    ] as unknown as AccumulatedHandoff[];

    const out = worker.run({ accumulated });
    expect(out.worker).toBe('conflict_detector');
    expect(out.conflicts.some(c => c.type === 'medication_mismatch')).toBe(true);
  });
});

