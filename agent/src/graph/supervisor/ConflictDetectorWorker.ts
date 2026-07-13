/**
 * ConflictDetectorWorker — lightweight cross-source disagreement detector.
 *
 * This worker is intentionally deterministic for now: it inspects already
 * accumulated outputs and emits explicit, machine-readable conflict items.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type {
  AccumulatedHandoff,
  ConflictDetectorOutput,
  ConflictItem,
  FhirContextOutput,
  IntakeExtractorOutput,
  LabExtractorOutput,
} from './types.js';

export class ConflictDetectorWorker {
  run(input: { readonly accumulated: readonly AccumulatedHandoff[] }): ConflictDetectorOutput {
    const conflicts: ConflictItem[] = [];

    const fhir = pickFhir(input.accumulated);
    const intake = pickIntake(input.accumulated);
    const lab = pickLab(input.accumulated);

    if (fhir !== null && intake !== null && intake.intakeForm !== null) {
      const intakeMeds = intake.intakeForm.current_medications.length;
      if (intakeMeds > 0 && fhir.snapshot.activeMedsCount === 0) {
        conflicts.push({
          type: 'medication_mismatch',
          severity: 'attention',
          message:
            'Intake form lists current medications but chart has zero active medications.',
          evidence_refs: [
            intake.extractionId ? `doc:intake-${intake.extractionId}` : 'rule:no-data:intake',
            'rule:chart:active-medications-empty',
          ],
        });
      }
    }

    if (fhir !== null && lab !== null && lab.labPdf !== null) {
      const pdfResults = lab.labPdf.results.length;
      if (pdfResults > 0 && fhir.snapshot.recentLabsCount === 0) {
        conflicts.push({
          type: 'lab_value_mismatch',
          severity: 'attention',
          message:
            'Lab PDF has extracted results but chart has no recent lab observations.',
          evidence_refs: [
            lab.extractionId ? `doc:lab-${lab.extractionId}` : 'rule:no-data:lab-pdf',
            'rule:chart:recent-labs-empty',
          ],
        });
      }
    }

    if (fhir === null) {
      conflicts.push({
        type: 'missing_context',
        severity: 'info',
        message: 'FHIR context snapshot was unavailable for this turn.',
        evidence_refs: ['rule:no-data:fhir-context'],
      });
    }

    return {
      worker: 'conflict_detector',
      conflicts,
    };
  }
}

function pickFhir(handoffs: readonly AccumulatedHandoff[]): FhirContextOutput | null {
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (h && h.output.worker === 'fhir_context') return h.output;
  }
  return null;
}

function pickIntake(handoffs: readonly AccumulatedHandoff[]): IntakeExtractorOutput | null {
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (h && h.output.worker === 'intake_extractor') return h.output;
  }
  return null;
}

function pickLab(handoffs: readonly AccumulatedHandoff[]): LabExtractorOutput | null {
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (h && h.output.worker === 'lab_extractor') return h.output;
  }
  return null;
}

