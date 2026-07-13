/**
 * FhirClient — typed wrapper over OpenEMR's FHIR R4 endpoints. Every
 * outbound request carries the JWT minted by OpenEMR; the JWT is the
 * sole source of patient identity (D5).
 *
 * Observability note: FHIR transport calls are intentionally NOT traced.
 * They are deterministic, high-volume plumbing and don't add reasoning
 * signal for copilot quality analysis.
 */

import { Agent } from 'undici';

export interface FhirClientOptions {
  baseUrl: string;
  jwt: string;
  timeoutMs?: number;
  tlsInsecure?: boolean;
}

// Per-instance dispatcher for tlsInsecure. Mutating the global
// NODE_TLS_REJECT_UNAUTHORIZED env var works but races against any other
// TLS handshake in flight (it's process-wide). Scoping the relaxation to
// THIS client's dispatcher keeps the rest of the process secure.
function buildInsecureAgent(): Agent {
  return new Agent({ connect: { rejectUnauthorized: false } });
}

export class FhirClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly resource: string,
  ) {
    super(`FHIR ${status} on ${resource}`);
    this.name = 'FhirClientError';
  }
}

export class FhirClient {
  private readonly baseUrl: string;
  private readonly jwt: string;
  private readonly timeoutMs: number;
  private readonly dispatcher: Agent | undefined;

  constructor(options: FhirClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.jwt = options.jwt;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.dispatcher = (options.tlsInsecure ?? false) ? buildInsecureAgent() : undefined;
  }

  async getPatient(patientUuid: string): Promise<fhir4.Patient> {
    return (await this.fetchJson(
      `/Patient/${encodeURIComponent(patientUuid)}`,
      'Patient',
    )) as fhir4.Patient;
  }

  async searchBundle<T extends fhir4.Resource>(
    resourceType: string,
    params: Record<string, string>,
  ): Promise<fhir4.Bundle<T>> {
    const search = new URLSearchParams(params);
    const path = `/${resourceType}?${search.toString()}`;
    return (await this.fetchJson(path, resourceType)) as fhir4.Bundle<T>;
  }

  private async fetchJson(path: string, resourceLabel: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.jwt}`,
          Accept: 'application/fhir+json',
        },
        signal: controller.signal,
        // dispatcher is undici-specific; node:fetch types omit it but
        // the runtime accepts it on Node 22+.
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      } as unknown as Parameters<typeof fetch>[1]);

      const text = await response.text();
      if (!response.ok) {
        throw new FhirClientError(response.status, text, resourceLabel);
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new FhirClientError(response.status, text, resourceLabel);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
