/**
 * Supervisor barrel — public surface of the Pattern A supervisor graph.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

export type {
  AvailabilityHint,
  PatientDocumentSummary,
  GuidelineCorpusSummary,
  WorkerName,
  WorkerOutput,
  FhirContextOutput,
  FhirContextSnapshot,
  IntakeExtractorOutput,
  EvidenceRetrieverOutput,
  ClinicalDataOutput,
  ConflictDetectorOutput,
  ConflictItem,
  AccumulatedHandoff,
  SupervisorDecision,
  SidecarReader,
  ClinicalDataDispatcher,
  FhirContextDispatcher,
} from './types.js';
export { HANDOFF_CAP } from './types.js';
export {
  buildAvailabilityHint,
  renderHintForPrompt,
  type AvailabilityHintDeps,
  type SidecarSummaryReader,
  type ClinicalDataReachabilityProbe,
  type GuidelineCorpusRegistry,
} from './availabilityHint.js';
export { FhirContextWorker } from './FhirContextWorker.js';
export { IntakeExtractorWorker, IntakeExtractorError } from './IntakeExtractorWorker.js';
export { LabExtractorWorker, LabExtractorError } from './LabExtractorWorker.js';
export { ClinicalDataWorker } from './ClinicalDataWorker.js';
export { ConflictDetectorWorker } from './ConflictDetectorWorker.js';
export {
  SupervisorSynthesizer,
  SupervisorSynthesisError,
  type SynthesizerInput,
} from './Synthesizer.js';
export {
  SupervisorVerifier,
  type PatientDocumentVerifier,
  type VerifierDeps,
  type VerifyResult,
} from './Verifier.js';
export { SupervisorRouter, type RouterInput } from './SupervisorRouter.js';
export {
  createSupervisorGraph,
  type SupervisorGraphDeps,
  type SupervisorState,
} from './supervisorGraph.js';
export {
  runSupervisor,
  type RunSupervisorInput,
  type RunSupervisorResult,
  type RunSupervisorDeps,
} from './runSupervisor.js';
export { SidecarHttpClient } from './SidecarHttpClient.js';
export { StaticGuidelineCorpusRegistry } from './AdaCorpusRegistry.js';
