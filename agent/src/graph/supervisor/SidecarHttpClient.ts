/**
 * SidecarHttpClient — Node-side HTTP client for the PHP-hosted
 * sidecar reader endpoint at /interface/agentforge/sidecar.php.
 *
 * Implements both `SidecarReader` (latest row by docType) and
 * `SidecarSummaryReader` (list all rows for the patient). Production
 * wiring at the chat route constructs this with the same scoped
 * JWT the chat turn already minted; the PHP endpoint validates the
 * JWT against the same shared secret as upload.php / chat.php.
 *
 * Tests stub `SidecarReader` / `SidecarSummaryReader` directly and
 * never hit this class.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type { SidecarReader, PatientDocumentSummary } from './types.js';
import type { SidecarSummaryReader } from './availabilityHint.js';

export interface SidecarHttpClientOptions {
  /** Base URL e.g. `https://openemr.host`. */
  readonly baseUrl: string;
  /** Scoped JWT bearing pid + scope=`agentforge:chat`. */
  readonly jwt: string;
  /** Override fetch for tests; defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Skip TLS verification when talking to a self-signed dev OpenEMR. */
  readonly tlsInsecure?: boolean;
}

interface SidecarRowDto {
  readonly extraction_id: number;
  readonly doc_type: 'lab_pdf' | 'intake_form';
  readonly patient_match_status: 'verified' | 'unverifiable' | 'mismatch';
  readonly created_at: string;
  readonly extracted_json: unknown;
  readonly document_id?: number | null;
  readonly document_name?: string | null;
}

export class SidecarHttpClient implements SidecarReader, SidecarSummaryReader {
  private readonly baseUrl: string;
  private readonly jwt: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SidecarHttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.jwt = opts.jwt;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async readLatest(input: { readonly pid: number; readonly docType: 'lab_pdf' | 'intake_form' }):
    Promise<
      {
        readonly extractionId: string;
        readonly extractedJson: unknown;
        readonly documentId: number | null;
        readonly documentName: string | null;
      } | null
    > {
    const url = `${this.baseUrl}/interface/agentforge/sidecar.php`
      + `?pid=${encodeURIComponent(String(input.pid))}`
      + `&doc_type=${encodeURIComponent(input.docType)}`
      + `&latest=1`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.jwt}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`SidecarHttpClient.readLatest failed: HTTP ${res.status}`);
    }
    const body = await res.json() as SidecarRowDto | null;
    if (body === null) return null;
    return {
      extractionId: String(body.extraction_id),
      extractedJson: body.extracted_json,
      documentId: typeof body.document_id === 'number' && body.document_id > 0
        ? body.document_id
        : null,
      documentName: typeof body.document_name === 'string' && body.document_name !== ''
        ? body.document_name
        : null,
    };
  }

  async listForPatient(input: { readonly pid: number }):
    Promise<readonly PatientDocumentSummary[]> {
    const url = `${this.baseUrl}/interface/agentforge/sidecar.php`
      + `?pid=${encodeURIComponent(String(input.pid))}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.jwt}` },
    });
    if (!res.ok) {
      throw new Error(`SidecarHttpClient.listForPatient failed: HTTP ${res.status}`);
    }
    const body = await res.json() as readonly SidecarRowDto[];
    return body.map(r => ({
      extraction_id: String(r.extraction_id),
      doc_type: r.doc_type,
      patient_match_status: r.patient_match_status,
      created_at: r.created_at,
    }));
  }

  /** PatientDocumentVerifier-compatible existence check. */
  async exists(input: { readonly pid: number; readonly extractionId: string }): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/interface/agentforge/sidecar.php`
        + `?pid=${encodeURIComponent(String(input.pid))}`
        + `&extraction_id=${encodeURIComponent(input.extractionId)}`;
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.jwt}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
