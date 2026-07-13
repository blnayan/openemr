/**
 * PhiSetBuilder — builds the per-request PhiSet by reading the FHIR
 * Patient resource (and, where supplied, the OpenEMR `pubpid`) at
 * request entry. The resulting PhiSet is bound into AsyncLocalStorage
 * via `withPhiContext` so every traced span sees the same set.
 *
 * Constructor injection: callers pass the `FhirClient` they already
 * have for the request — no global state, no module-level FHIR client.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type { FhirClient } from '../fhir/FhirClient.js';
import { PhiSet } from './PhiSet.js';

export interface PhiSetBuilderDeps {
  readonly fhirClient: FhirClient;
}

export class PhiSetBuilder {
  private readonly fhirClient: FhirClient;

  constructor(deps: PhiSetBuilderDeps) {
    this.fhirClient = deps.fhirClient;
  }

  /**
   * Build a PhiSet by fetching the FHIR Patient resource for the given
   * uuid. If the lookup fails (network error, 404), returns the empty
   * PhiSet — the regex fallbacks still run, so we degrade safely rather
   * than failing the whole request.
   *
   * The pubpid is *not* in FHIR Patient by default; pass it explicitly
   * when the caller already has it from the JWT claims.
   */
  async fromPatientUuid(
    patientUuid: string,
    options: { readonly pubpid?: string | null } = {},
  ): Promise<PhiSet> {
    try {
      const patient = await this.fhirClient.getPatient(patientUuid);
      return PhiSet.fromPatientResource(patient, options);
    } catch {
      // Fail safe: an empty set means the regex fallbacks still
      // redact obvious PHI. We log nothing here because logging would
      // itself need redaction; the caller's tracing layer captures
      // the FHIR error.
      return options.pubpid !== undefined && options.pubpid !== null && options.pubpid !== ''
        ? PhiSet.fromExplicit({ pubpids: [options.pubpid] })
        : PhiSet.empty();
    }
  }
}
