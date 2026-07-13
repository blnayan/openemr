/**
 * IntakeExtractorWorker — the Pattern A intake-extractor worker.
 *
 * Reads the latest intake-form sidecar row for a patient via the
 * injected SidecarReader and validates the payload against
 * IntakeFormSchema. Returns null shape when no row exists; raises
 * the parse failure to the supervisor (forced refusal) when a row
 * exists but doesn't match the schema — corrupting on bad data is
 * preferable to silently fabricating a clean payload.
 *
 * The worker is intentionally a thin adapter so the supervisor graph
 * node stays focused on graph mechanics; the heavy lifting (extraction
 * itself) lives in the issue 02/03 PHP-side pipeline.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import { IntakeFormSchema } from '../../schemas/IntakeFormSchema.js';
import type {
  IntakeExtractorOutput,
  SidecarReader,
} from './types.js';

export class IntakeExtractorError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'IntakeExtractorError';
  }
}

export class IntakeExtractorWorker {
  constructor(private readonly reader: SidecarReader) {}

  async run(input: { readonly pid: number }): Promise<IntakeExtractorOutput> {
    const row = await this.reader.readLatest({
      pid: input.pid,
      docType: 'intake_form',
    });
    if (row === null) {
      return {
        worker: 'intake_extractor',
        intakeForm: null,
        extractionId: null,
        documentId: null,
        documentName: null,
      };
    }
    const parsed = IntakeFormSchema.safeParse(row.extractedJson);
    if (!parsed.success) {
      throw new IntakeExtractorError(
        'Sidecar intake_form row failed IntakeFormSchema validation',
        parsed.error.issues,
      );
    }
    return {
      worker: 'intake_extractor',
      intakeForm: parsed.data,
      extractionId: row.extractionId,
      documentId: row.documentId,
      documentName: row.documentName,
    };
  }
}
