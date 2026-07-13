/**
 * Observability barrel — public surface for the PHI-safe Langfuse
 * client. Anywhere else in the codebase that wants to ship a trace must
 * import from here, never from vendor SDK packages directly.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

export { PhiRedactor } from './PhiRedactor.js';
export type { PhiTokenType, RedactorOptions } from './PhiRedactor.js';
export { PhiSet } from './PhiSet.js';
export type { PhiSetData } from './PhiSet.js';
export { PhiSetBuilder } from './PhiSetBuilder.js';
export type { PhiSetBuilderDeps } from './PhiSetBuilder.js';
export {
  withPhiContext,
  withRequestTraceContext,
  traceGeneration,
  currentPhiSet,
  tracedTraceable,
  createTraceableWrapper,
  createTracedClient,
  shutdownObservability,
  TracedLangfuseClient,
  _resetRedactorForTesting,
} from './tracedClient.js';
export type {
  CreateTracedClientOptions,
  GenerationUsage,
  RequestTraceContextInput,
  TraceGenerationInput,
} from './tracedClient.js';
