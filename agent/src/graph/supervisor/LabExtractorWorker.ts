/**
 * LabExtractorWorker — supervisor-side worker that surfaces the latest
 * AgentForge-uploaded lab PDF for a patient.
 *
 * Mirrors {@see IntakeExtractorWorker}: reads the latest `lab_pdf`
 * sidecar row via the injected SidecarReader and validates the payload
 * against {@see LabPdfSchema}. Returns null shape when no row exists;
 * raises the parse failure to the supervisor (forced refusal) when a
 * row exists but doesn't match the schema — corrupting on bad data is
 * preferable to silently fabricating a clean payload.
 *
 * Why a separate worker instead of relying on `get_recent_labs`:
 *   - `get_recent_labs` reads FHIR Observations (the chart) and is
 *     keyed by `tool:get_recent_labs:row-N` citations.
 *   - This worker reads the *raw uploaded extraction* with bbox
 *     coordinates intact, so the synthesizer can quote the document
 *     verbatim and the bbox-overlay viewer can jump to the cited
 *     region. Citations land as `doc:lab-<extraction_id>` plus a rich
 *     `patient_document` citation in the AnswerSchema's `citations[]`.
 *
 * The worker is intentionally a thin adapter so the supervisor graph
 * node stays focused on graph mechanics; the heavy lifting (extraction
 * itself) lives in the issue 02/03 PHP-side pipeline.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import { LabPdfSchema } from '../../schemas/LabPdfSchema.js';
import type {
  LabExtractorOutput,
  SidecarReader,
} from './types.js';

export class LabExtractorError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'LabExtractorError';
  }
}

export class LabExtractorWorker {
  constructor(private readonly reader: SidecarReader) {}

  async run(input: { readonly pid: number }): Promise<LabExtractorOutput> {
    const row = await this.reader.readLatest({
      pid: input.pid,
      docType: 'lab_pdf',
    });
    if (row === null) {
      return {
        worker: 'lab_extractor',
        labPdf: null,
        extractionId: null,
        documentId: null,
        documentName: null,
      };
    }
    const parsed = LabPdfSchema.safeParse(row.extractedJson);
    if (!parsed.success) {
      throw new LabExtractorError(
        'Sidecar lab_pdf row failed LabPdfSchema validation',
        parsed.error.issues,
      );
    }
    return {
      worker: 'lab_extractor',
      labPdf: parsed.data,
      extractionId: row.extractionId,
      documentId: row.documentId,
      documentName: row.documentName,
    };
  }
}
