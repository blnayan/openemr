/**
 * SidecarOriginLookup — HTTP client that resolves chart-row UUIDs to
 * their source uploaded document via
 * /interface/agentforge/sidecar.php?action=resource_origins.
 *
 * Used by chat-time tools (getRecentLabs, getAllergies, getMedications)
 * to attribute each row back to its originating PDF/PNG, so the
 * citation renderer can suffix claims with "(from <document>)".
 *
 * The lookup batches by resource_type per HTTP call (the endpoint
 * accepts up to 100 UUIDs per request). Errors are non-fatal — on
 * failure, lookup() returns an empty map and the caller treats every
 * row as "unknown origin."
 */
import type { ResourceOriginLookup } from './types.js';

export interface SidecarOriginLookupOptions {
  readonly baseUrl: string;
  readonly jwt: string;
  /** The patient pid from the JWT claim — sidecar.php requires it as a
   *  query parameter and cross-checks it against the JWT's pid claim. */
  readonly pid: number;
  readonly fetchImpl?: typeof fetch;
}

const MAX_UUIDS_PER_CALL = 100;

export class SidecarOriginLookup implements ResourceOriginLookup {
  private readonly baseUrl: string;
  private readonly jwt: string;
  private readonly pid: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SidecarOriginLookupOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.jwt = opts.jwt;
    this.pid = opts.pid;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async lookup(
    refs: ReadonlyArray<{
      readonly resourceType: 'procedure_result' | 'lists' | 'pnotes';
      readonly uuid: string;
    }>,
  ): Promise<ReadonlyMap<string, { document_id: number; document_name: string | null; document_date: string | null } | null>> {
    const out = new Map<string, { document_id: number; document_name: string | null; document_date: string | null } | null>();
    if (refs.length === 0) return out;

    // Bucket by resource_type so each batch hits a single SQL path.
    const byType = new Map<string, string[]>();
    for (const r of refs) {
      const list = byType.get(r.resourceType) ?? [];
      list.push(r.uuid);
      byType.set(r.resourceType, list);
    }

    for (const [resourceType, uuids] of byType.entries()) {
      // Chunk to MAX_UUIDS_PER_CALL since the endpoint refuses more.
      for (let i = 0; i < uuids.length; i += MAX_UUIDS_PER_CALL) {
        const chunk = uuids.slice(i, i + MAX_UUIDS_PER_CALL);
        try {
          const url = `${this.baseUrl}/interface/agentforge/sidecar.php`
            + `?action=resource_origins`
            + `&pid=${encodeURIComponent(String(this.pid))}`
            + `&resource_type=${encodeURIComponent(resourceType)}`
            + `&uuids=${encodeURIComponent(chunk.join(','))}`;
          const res = await this.fetchImpl(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${this.jwt}` },
          });
          if (!res.ok) continue; // best-effort — skip on error, leave entries unmapped
          const body = await res.json() as Record<string, { document_id: number; document_name: string | null; document_date: string | null } | null>;
          for (const u of chunk) {
            // Look up by both the original casing and a canonical hex form
            // to tolerate caller variation. The PHP endpoint echoes the
            // original input form back in the response keys.
            const entry = body[u] ?? body[u.toUpperCase()] ?? body[u.toLowerCase()] ?? null;
            out.set(u, entry);
          }
        } catch {
          // Best-effort lookup; leave the chunk's UUIDs unmapped.
        }
      }
    }
    return out;
  }
}
