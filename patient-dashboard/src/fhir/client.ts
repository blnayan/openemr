/**
 * Typed FHIR client — the only path application code takes to
 * `/apis/default/fhir/*`. Centralizes:
 *
 *   - OAuth bearer header injection (token sourced from `useAuth()` via the
 *     `getAccessToken` callback, so this module stays decoupled from React).
 *   - FHIR Bundle traversal + per-entry Zod parsing for list reads.
 *   - Single-resource Zod parsing for direct reads.
 *   - Typed errors so the auth layer can react to 401s.
 *
 * Pattern for future card slices: every FHIR resource gets its own schema +
 * DTO under `fhir/schemas/`, exposed here as one method on the returned
 * client. Callers consume via TanStack Query hooks under `fhir/hooks/`.
 */

import { parsePatient, type PatientDTO } from './schemas/patient';
import { parseAllergy, type AllergyDTO } from './schemas/allergyIntolerance';
import { parseCondition, type ConditionDTO } from './schemas/condition';
import {
  parseMedicationRequest,
  type MedicationRequestDTO,
} from './schemas/medicationRequest';
import {
  parseCareTeam,
  type CareTeamParticipantDTO,
} from './schemas/careTeam';
import {
  parseObservation,
  type LabObservationDTO,
} from './schemas/observation';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when the FHIR server returns a non-2xx response. The `status`
 * property lets the auth layer distinguish 401 (refresh / re-launch) from
 * other failures without parsing the message.
 */
export class FhirHttpError extends Error {
  public readonly status: number;
  public readonly path: string;

  constructor(status: number, path: string, message?: string) {
    super(message ?? `FHIR request failed: HTTP ${status} ${path}`);
    this.name = 'FhirHttpError';
    this.status = status;
    this.path = path;
  }
}

/** Convenience predicate for callers that want a typed 401 branch. */
export function isUnauthorizedError(err: unknown): err is FhirHttpError {
  return err instanceof FhirHttpError && err.status === 401;
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export interface FhirClientOptions {
  /** FHIR base URL, e.g. `https://localhost:9300/apis/default/fhir`. */
  baseUrl: string;
  /**
   * Returns the current OAuth access token, or `null` if not authenticated.
   * Called on every request so token rotation is picked up automatically.
   */
  getAccessToken: () => string | null;
  /** Test seam. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface FhirClient {
  fetchPatient: (patientId: string) => Promise<PatientDTO>;
  /**
   * List the patient's allergies, parsed into `AllergyDTO[]`. Walks Bundle
   * pages internally. Filtering of resolved/inactive entries lives in the
   * `useAllergies` hook so the client stays a thin shape-translator.
   */
  fetchAllergies: (patientId: string) => Promise<AllergyDTO[]>;
  /**
   * List the patient's conditions, parsed into `ConditionDTO[]`. Walks
   * Bundle pages internally. Filtering of resolved / inactive / refuted
   * entries lives in the `useConditions` hook so the client stays a thin
   * shape-translator.
   */
  fetchConditions: (patientId: string) => Promise<ConditionDTO[]>;
  /**
   * List the patient's MedicationRequests, parsed into
   * `MedicationRequestDTO[]`. Walks Bundle pages internally. The same
   * underlying call feeds both the Medications card (#27, filtered by
   * `status === 'active'`) and the Prescriptions card (#28, filtered by
   * `intent`). Filtering of inactive entries lives in the `useMedications`
   * / `usePrescriptions` hooks so the client stays a thin shape-translator.
   *
   * Note: `MedicationStatement` is the FHIR resource the W2 PRD names for
   * "current medications", but OpenEMR's FHIR server does not implement
   * `patient/MedicationStatement.rs`. `MedicationRequest` is what's
   * available, and it backs both cards.
   */
  fetchMedicationRequests: (patientId: string) => Promise<MedicationRequestDTO[]>;
  /**
   * List the patient's Care Team participants, parsed and flattened across
   * every `CareTeam` resource in the Bundle. One FHIR `CareTeam` resource
   * yields multiple `CareTeamParticipantDTO`s (one per `participant` entry),
   * so this method `flatMap`s the per-resource arrays into a single flat
   * list. Filtering of inactive / entered-in-error rows lives in the
   * `useCareTeam` hook so the client stays a thin shape-translator.
   */
  fetchCareTeam: (patientId: string) => Promise<CareTeamParticipantDTO[]>;
  /**
   * List the patient's `Observation` resources for a single category, parsed
   * into `LabObservationDTO[]`. Walks Bundle pages internally. Filtering of
   * preliminary / cancelled / entered-in-error rows lives in the
   * `useLabResults` hook so the client stays a thin shape-translator.
   *
   * The `category` parameter is generic on purpose so the same method can
   * back vital-signs / social-history cards in future slices; v1 only ever
   * passes `'laboratory'`.
   */
  fetchObservations: (
    patientId: string,
    category: string,
  ) => Promise<LabObservationDTO[]>;
  /**
   * Fetch a paginated FHIR Bundle, walk every entry across `link[rel=next]`
   * pages, and run each `entry.resource` through the supplied parser. Will
   * be wired into resource-specific methods (`fetchAllergies`, …) by
   * subsequent slices.
   */
  fetchBundle: <T>(path: string, parser: (raw: unknown) => T) => Promise<T[]>;
}

/**
 * FHIR Bundle shape — only the fields we walk. We deliberately don't run a
 * full Zod parse over the bundle envelope since each entry's resource is
 * parsed by its own schema; parsing the envelope as well would be redundant
 * and would couple the client to incidental Bundle metadata.
 */
interface FhirBundle {
  resourceType?: unknown;
  entry?: Array<{ resource?: unknown }>;
}

function isBundle(json: unknown): json is FhirBundle {
  return (
    typeof json === 'object'
    && json !== null
    && (json as { resourceType?: unknown }).resourceType === 'Bundle'
  );
}

export function createFhirClient(options: FhirClientOptions): FhirClient {
  const { baseUrl, getAccessToken } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const trimmedBase = baseUrl.replace(/\/+$/, '');

  function buildUrl(path: string): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${trimmedBase}${cleanPath}`;
  }

  async function request(path: string): Promise<unknown> {
    const token = getAccessToken();
    const headers: Record<string, string> = {
      Accept: 'application/fhir+json',
    };
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetchImpl(buildUrl(path), {
      method: 'GET',
      headers,
    });
    if (!res.ok) {
      throw new FhirHttpError(res.status, path);
    }
    return res.json();
  }

  /**
   * Fetch a paginated FHIR Bundle, walk every entry across `link[rel=next]`
   * pages, and run each `entry.resource` through the supplied parser.
   *
   * Not used by `fetchPatient` (single-resource read) but exported below for
   * the next slices (Allergies, Conditions, …) that consume Bundles.
   */
  async function fetchBundle<T>(
    path: string,
    parser: (raw: unknown) => T,
  ): Promise<T[]> {
    const out: T[] = [];
    let nextPath: string | null = path;

    while (nextPath !== null) {
      const json = await request(nextPath);
      if (!isBundle(json)) {
        throw new Error(`Expected FHIR Bundle at ${nextPath}`);
      }
      for (const entry of json.entry ?? []) {
        if (entry.resource !== undefined) {
          out.push(parser(entry.resource));
        }
      }
      nextPath = extractNextLink(json, trimmedBase);
    }

    return out;
  }

  return {
    async fetchPatient(patientId: string): Promise<PatientDTO> {
      // Single-resource read keeps the parse boundary simple — no Bundle
      // unwrapping when there's only one resource to parse.
      const json = await request(`/Patient/${encodeURIComponent(patientId)}`);
      return parsePatient(json);
    },
    async fetchAllergies(patientId: string): Promise<AllergyDTO[]> {
      return fetchBundle(
        `/AllergyIntolerance?patient=${encodeURIComponent(patientId)}`,
        parseAllergy,
      );
    },
    async fetchConditions(patientId: string): Promise<ConditionDTO[]> {
      return fetchBundle(
        `/Condition?patient=${encodeURIComponent(patientId)}`,
        parseCondition,
      );
    },
    async fetchMedicationRequests(
      patientId: string,
    ): Promise<MedicationRequestDTO[]> {
      return fetchBundle(
        `/MedicationRequest?patient=${encodeURIComponent(patientId)}`,
        parseMedicationRequest,
      );
    },
    async fetchCareTeam(
      patientId: string,
    ): Promise<CareTeamParticipantDTO[]> {
      // One CareTeam resource → many participant DTOs. We use the existing
      // `fetchBundle` (one-T-per-resource) to pull the raw resources, then
      // `flatMap(parseCareTeam)` to flatten participants into a single list.
      // Picked over adding a `fetchBundleFlat` helper because nothing else
      // in the codebase needs the flatten path yet.
      const perResource = await fetchBundle(
        `/CareTeam?patient=${encodeURIComponent(patientId)}`,
        parseCareTeam,
      );
      return perResource.flat();
    },
    async fetchObservations(
      patientId: string,
      category: string,
    ): Promise<LabObservationDTO[]> {
      return fetchBundle(
        `/Observation?patient=${encodeURIComponent(patientId)}&category=${encodeURIComponent(category)}`,
        parseObservation,
      );
    },
    fetchBundle,
  };
}

/**
 * Extract the next-page URL from a FHIR Bundle's `link[rel=next]` entry and
 * convert it to a base-relative path the client can re-issue.
 *
 * Returns `null` when there's no next page or the next URL falls outside the
 * configured base — that latter check guards against an upstream bug
 * sending us to an unrelated host.
 */
function extractNextLink(bundle: FhirBundle, base: string): string | null {
  const links = (bundle as { link?: Array<{ relation?: string; url?: string }> })
    .link;
  if (!Array.isArray(links)) {
    return null;
  }
  const next = links.find((l) => l.relation === 'next' && typeof l.url === 'string');
  if (next?.url === undefined) {
    return null;
  }
  if (!next.url.startsWith(base)) {
    return null;
  }
  return next.url.slice(base.length) || '/';
}
