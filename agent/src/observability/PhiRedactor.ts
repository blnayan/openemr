/**
 * PhiRedactor — pure-function deep redactor for any payload that's about
 * to leave the process (Langfuse trace, log line, error response).
 *
 * Algorithm per call:
 *   1. Deep-clone the payload (never mutate the caller's object).
 *   2. Walk it; structural keys (`tool_name`, `latency_ms`, etc.) pass
 *      through verbatim.
 *   3. For every other string node, apply in order:
 *        a. Explicit-set replacements (PhiSet members) → typed token
 *        b. Regex fallbacks for SSN / phone / email / DOB / street →
 *           typed token
 *
 * Token format: `[REDACTED:<type>:<hmac8>]`
 *   - `<type>` ∈ {`name`,`dob`,`pubpid`,`address`,`phone`,`email`,
 *                 `ssn`,`pid`}
 *   - `<hmac8>` is the first 8 hex chars of HMAC-SHA256(salt, value).
 *     Same value across spans → same token, so traces remain joinable.
 *
 * Salt rotation: change `AGENTFORGE_PHI_REDACTION_SALT` and redeploy.
 * After rotation, tokens for the same value differ — that's intentional;
 * old observation stores cannot be cross-correlated with new ones, which
 * is the whole point of rotating.
 *
 * Direct construction is allowed; the *no-runtime-opt-out* guarantee is
 * enforced by the observability client wrapper (`tracedClient.ts`), not by
 * this module — a redactor with no caller does no harm.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import { createHmac } from 'node:crypto';
import { PhiSet } from './PhiSet.js';

export type PhiTokenType =
  | 'name'
  | 'dob'
  | 'pubpid'
  | 'address'
  | 'phone'
  | 'email'
  | 'ssn'
  | 'pid';

/**
 * Keys whose values pass through verbatim. These are observability
 * structural fields — they describe the *shape* of work being done, not
 * its PHI-bearing content. Any new structural field must be added here
 * explicitly; the default is to redact.
 */
const PRESERVED_KEYS: ReadonlySet<string> = new Set([
  // Pseudonymous identifiers (D12).
  'patient_uuid',
  'patientUuid',
  // Worker / tool metadata.
  'tool_name',
  'toolName',
  'worker',
  'kind',
  // Run shape.
  'run_type',
  'runType',
  'span_id',
  'spanId',
  'trace_id',
  'traceId',
  'parent_run_id',
  'parentRunId',
  // Latency / cost.
  'latency_ms',
  'latencyMs',
  'duration_ms',
  'durationMs',
  'tokens_in',
  'tokensIn',
  'tokens_out',
  'tokensOut',
  'usage',
  'cost',
  'cost_usd',
  'costUsd',
  'model',
  // Citation pointers (ids only, no PHI).
  'citation_id',
  'citationId',
  'citation_ids',
  'citationIds',
  'chunk_id',
  'chunkId',
  'section_id',
  'sectionId',
  // Counts and statuses.
  'row_count',
  'rowCount',
  'count',
  'ok',
  'status',
  'severity',
  'confidence',
  'grade',
  'page',
  'http_status',
  'httpStatus',
  // Backwards-compat with the existing PRESERVED_KEYS set.
  'patient_uuid',
]);

const PHONE_RE = /(?:\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\b\d{10}\b)/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const STREET_RE =
  /\b\d{1,5}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court)\b/g;
const DOB_RE = /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g;

export interface RedactorOptions {
  readonly salt: string;
}

export class PhiRedactor {
  private readonly salt: string;

  constructor(opts: RedactorOptions) {
    if (typeof opts.salt !== 'string' || opts.salt.length === 0) {
      throw new Error(
        'PhiRedactor requires a non-empty salt. Set AGENTFORGE_PHI_REDACTION_SALT.',
      );
    }
    this.salt = opts.salt;
  }

  /**
   * Pure function: returns a *new* payload with PHI replaced.
   * Never mutates the input.
   */
  redact<T>(payload: T, phiSet: PhiSet): T {
    const cloned = structuredClone(payload);
    return this.walk(cloned, phiSet) as T;
  }

  /** Helper used by the observability wrapper's processInputs/processOutputs. */
  redactKv(payload: Record<string, unknown>, phiSet: PhiSet): Record<string, unknown> {
    return this.redact(payload, phiSet);
  }

  private walk(node: unknown, phi: PhiSet): unknown {
    if (typeof node === 'string') {
      return this.scrub(node, phi);
    }
    if (Array.isArray(node)) {
      return node.map(item => this.walk(item, phi));
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (PRESERVED_KEYS.has(k)) {
          // Preserved keys still survive a defensive type check: scalars
          // pass through; nested structures are walked recursively so a
          // nested string under `usage.user_email` would still be
          // redacted (the *key* `usage` survives, but the *value* tree
          // is not exempted from the walk).
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
            out[k] = v;
          } else {
            out[k] = this.walk(v, phi);
          }
        } else {
          out[k] = this.walk(v, phi);
        }
      }
      return out;
    }
    return node;
  }

  private scrub(text: string, phi: PhiSet): string {
    let out = text;

    // Explicit-set replacements first. Sort longer-first per category so
    // "Maria González" replaces before "Maria" (avoid leaving an orphan
    // family name that would otherwise be a substring-of-already-redacted).
    out = this.replaceFromSet(out, phi.names, 'name');
    out = this.replaceFromSet(out, phi.addresses, 'address');
    out = this.replaceFromSet(out, phi.dobs, 'dob');
    out = this.replaceFromSet(out, phi.pubpids, 'pubpid');
    out = this.replaceFromSet(out, phi.phones, 'phone');
    out = this.replaceFromSet(out, phi.emails, 'email');

    // Regex fallbacks — even values not present in the explicit set are
    // redacted if they look like PHI. Critical when a span carries
    // demographics for a *different* patient than the JWT-bound one
    // (which would be a wrong-patient bug anyway, but defense in depth).
    out = out.replace(SSN_RE, m => this.token('ssn', m));
    out = out.replace(EMAIL_RE, m => this.token('email', m));
    out = out.replace(PHONE_RE, m => this.token('phone', m));
    out = out.replace(STREET_RE, m => this.token('address', m));
    out = out.replace(DOB_RE, m => this.token('dob', m));

    return out;
  }

  private replaceFromSet(text: string, values: ReadonlySet<string>, kind: PhiTokenType): string {
    if (values.size === 0) return text;
    // Sort longer-first to avoid the "Maria" inside "Maria González"
    // problem.
    const sorted = [...values].sort((a, b) => b.length - a.length);
    let out = text;
    for (const v of sorted) {
      if (v.length === 0) continue;
      // Case-insensitive literal replace. `v` may contain regex
      // metacharacters (a hyphenated street, a phone with parens), so
      // escape it.
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'gi');
      out = out.replace(re, () => this.token(kind, v));
    }
    return out;
  }

  private token(kind: PhiTokenType, value: string): string {
    const hmac = createHmac('sha256', this.salt)
      .update(value.toLowerCase())
      .digest('hex')
      .slice(0, 8);
    return `[REDACTED:${kind}:${hmac}]`;
  }
}
