/**
 * FhirContextWorker — compact chart-context snapshot worker.
 *
 * Keeps supervisor routing and downstream conflict checks from needing to
 * repeatedly parse the full clinical-data transcript.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type {
  FhirContextDispatcher,
  FhirContextOutput,
} from './types.js';

export class FhirContextWorker {
  constructor(private readonly dispatcher: FhirContextDispatcher) {}

  async run(input: { readonly question: string; readonly pid: number }):
    Promise<FhirContextOutput> {
    const snapshot = await this.dispatcher.run(input);
    return {
      worker: 'fhir_context',
      snapshot,
    };
  }
}

