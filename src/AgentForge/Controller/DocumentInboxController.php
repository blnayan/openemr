<?php

/**
 * DocumentInboxController — renders the Document Inbox page and dispatches
 * between the three implicit modes: idle, active, and reviewing.
 *
 * Mode dispatch is driven by the `mode` query parameter:
 *   - (absent / unknown) → idle: drop-zone placeholder + history table
 *   - `active`           → active: in-progress strip above history table
 *   - `reviewing`        → reviewing: placeholder review screen with
 *                          back-to-inbox link; viewer and edit panel
 *                          arrive in issues 31 and 32.
 *
 * The controller is instantiated by the HTTP entry point
 * `interface/agentforge/inbox.php`, which owns globals bootstrap,
 * ACL gating, and session extraction. This class only handles the
 * data layer and page rendering, keeping the entry point thin.
 *
 * Authorization: `patients/docs` read (enforced by the entry point).
 * Upload / confirm / reject endpoints require write; this page is
 * read-only and scoped to the pid bound to the active session.
 *
 * Cache-Control: the entry point sets `Cache-Control: private, no-store`
 * before calling render() because the history table contains uploader
 * names and filenames (PHI-adjacent per PRD §"Cache and PHI posture").
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Controller;

use DateTimeImmutable;
use OpenEMR\AgentForge\Domain\UploadJobStatus;
use OpenEMR\AgentForge\Persistence\DocumentInboxQueryOptions;
use OpenEMR\AgentForge\Persistence\DocumentInboxQueryService;
use OpenEMR\AgentForge\Persistence\DocumentInboxResult;
use OpenEMR\AgentForge\Persistence\DocumentInboxRow;
use OpenEMR\AgentForge\Persistence\ReviewJobView;

/**
 * Implicit modes the inbox page renders.
 */
enum DocumentInboxMode: string
{
    case Idle      = 'idle';
    case Active    = 'active';
    case Reviewing = 'reviewing';

    /**
     * Parse the raw `mode` query-string value into a mode, defaulting
     * to Idle for absent or unrecognised values.
     */
    public static function fromQuery(?string $raw): self
    {
        if ($raw === null || $raw === '') {
            return self::Idle;
        }
        return self::tryFrom($raw) ?? self::Idle;
    }
}

final readonly class DocumentInboxController
{
    public function __construct(
        private DocumentInboxQueryService $queryService,
    ) {
    }

    /**
     * Production factory wiring the controller to the default query
     * service. Kept off the constructor for the same reason as the
     * query service factory: isolated tests never need QueryUtils.
     */
    public static function default(): self
    {
        return new self(DocumentInboxQueryService::default());
    }

    /**
     * Render the Document Inbox page for the given patient.
     *
     * @param int    $patientId   The patient id bound to the active session.
     * @param string $modeRaw     Raw value of the `mode` query parameter.
     * @param string $jobUuid     Optional job UUID (used in reviewing mode).
     * @param string $webRoot     OpenEMR web root (e.g. "" or "/openemr").
     */
    public function render(
        int $patientId,
        string $modeRaw,
        string $jobUuid,
        string $webRoot,
    ): void {
        $mode = DocumentInboxMode::fromQuery($modeRaw);

        $opts   = new DocumentInboxQueryOptions();
        $result = $this->queryService->listForPatient($patientId, $opts);

        match ($mode) {
            DocumentInboxMode::Idle      => $this->renderIdle($patientId, $result, $webRoot),
            DocumentInboxMode::Active    => $this->renderActive($patientId, $result, $webRoot),
            DocumentInboxMode::Reviewing => $this->renderReviewing($patientId, $jobUuid, $result, $webRoot),
        };
    }

    // -------------------------------------------------------------------------
    // Private rendering helpers
    // -------------------------------------------------------------------------

    private function renderIdle(int $patientId, DocumentInboxResult $result, string $webRoot): void
    {
        ?>
        <div id="agentforge-document-inbox" class="container-fluid mt-3">
            <h1 class="h3 mb-3"><?php echo xlt('Document Inbox'); ?></h1>

            <?php $this->renderDropZone($webRoot); ?>
            <?php $this->renderHistoryTable($patientId, $result, $webRoot); ?>
        </div>
        <?php
    }

    private function renderActive(int $patientId, DocumentInboxResult $result, string $webRoot): void
    {
        ?>
        <div id="agentforge-document-inbox" class="container-fluid mt-3">
            <h1 class="h3 mb-3"><?php echo xlt('Document Inbox'); ?></h1>

            <?php $this->renderDropZone($webRoot); ?>
            <?php $this->renderHistoryTable($patientId, $result, $webRoot); ?>
        </div>
        <?php
    }

    private function renderReviewing(
        int $patientId,
        string $jobUuid,
        DocumentInboxResult $result,
        string $webRoot,
    ): void {
        $backUrl = attr($webRoot . '/interface/agentforge/inbox.php');

        // Load the extraction data for this specific job.  If absent (UUID
        // invalid or belongs to another patient) fall back to the placeholder.
        $reviewView = $jobUuid !== ''
            ? $this->queryService->loadForReview($jobUuid, $patientId)
            : null;

        ?>
        <div id="agentforge-document-inbox" class="container-fluid mt-3">
            <h1 class="h3 mb-3"><?php echo xlt('Document Inbox'); ?></h1>

            <div class="mb-3">
                <a href="<?php echo $backUrl; ?>" class="btn btn-sm btn-outline-secondary">
                    &larr; <?php echo xlt('Back to Inbox'); ?>
                </a>
            </div>

            <?php if ($reviewView !== null): ?>
                <?php $this->renderReviewScreen($reviewView, $webRoot); ?>
            <?php else: ?>
                <?php $this->renderReviewNotFound($jobUuid); ?>
            <?php endif; ?>
        </div>
        <?php
    }

    // -------------------------------------------------------------------------
    // Sub-section renderers
    // -------------------------------------------------------------------------

    /**
     * Drop-zone with wired file input and doc-type selector.
     *
     * The drop-zone accepts drag-and-drop or click-to-browse. On file
     * selection it immediately POSTs to the upload endpoint. Multiple
     * drops in quick succession produce multiple in-flight cards; there
     * is no queue — each upload fires independently.
     *
     * PHI posture: no extracted text in data-* attributes. Only the job
     * UUID (server-generated, not PHI) is stored in the card's data-uuid
     * attribute to anchor polling.
     */
    private function renderDropZone(string $webRoot): void
    {
        $uploadUrl = attr($webRoot . '/interface/agentforge/upload.php');
        ?>
        <div class="card mb-4" id="af-dropzone-card">
            <div class="card-body">
                <!-- Doc-type selector. Bootstrap 4 segmented toggle:
                     btn-group-toggle hides the underlying radio inputs
                     and styles the labels as a clean toggle group; the
                     `.active` class on the selected label gives the
                     filled-in look without the bare radio dot. -->
                <div class="mb-3" id="af-doctype-group">
                    <label class="font-weight-bold d-block mb-2"><?php echo xlt('Document type'); ?></label>
                    <div class="btn-group btn-group-toggle" data-toggle="buttons"
                         role="group" aria-label="<?php echo xla('Document type'); ?>">
                        <label class="btn btn-outline-primary active">
                            <input type="radio" name="af_doc_type" value="lab_pdf"
                                   checked autocomplete="off">
                            <?php echo xlt('Lab PDF'); ?>
                        </label>
                        <label class="btn btn-outline-primary">
                            <input type="radio" name="af_doc_type" value="intake_form"
                                   autocomplete="off">
                            <?php echo xlt('Intake Form'); ?>
                        </label>
                    </div>
                </div>

                <!-- Drop target -->
                <div id="af-dropzone"
                     class="text-center py-5 rounded"
                     style="border: 2px dashed #ced4da; cursor: pointer;"
                     role="button"
                     tabindex="0"
                     aria-label="<?php echo xla('Drop file here or click to browse'); ?>">
                    <p class="text-muted mb-1">
                        <strong><?php echo xlt('Drop a file here, or click to browse'); ?></strong>
                    </p>
                    <p class="text-muted small mb-0">
                        <?php echo xlt('PDF, PNG, JPEG, or WebP · Max 10 MB'); ?>
                    </p>
                    <div id="af-upload-error" class="alert alert-danger mt-3 d-none" role="alert"></div>
                </div>

                <!-- Hidden file input -->
                <input type="file" id="af-file-input" accept=".pdf,.png,.jpg,.jpeg,.webp"
                       class="d-none" aria-hidden="true">
            </div>
        </div>

        <script>
        (function () {
            'use strict';

            var UPLOAD_URL   = <?php echo json_encode($webRoot . '/interface/agentforge/upload.php'); ?>;
            var STATUS_URL   = <?php echo json_encode($webRoot . '/interface/agentforge/jobs/status.php'); ?>;
            var DELETE_URL   = <?php echo json_encode($webRoot . '/interface/agentforge/jobs/delete.php'); ?>;
            var INBOX_URL    = <?php echo json_encode($webRoot . '/interface/agentforge/inbox.php'); ?>;
            var POLL_MS      = 1500;
            var TIMEOUT_MS   = 90000;

            // Per-row polling state lives only here — nothing in data-*.
            // Map<rowId, { jobUuid, startedAt, timer }>
            var rowState = {};
            var rowSeq   = 0;

            var dropzone   = document.getElementById('af-dropzone');
            var fileInput  = document.getElementById('af-file-input');
            var errorBox   = document.getElementById('af-upload-error');

            // --- Drop-zone interaction -----------------------------------

            dropzone.addEventListener('click', function () { fileInput.click(); });
            dropzone.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
            });

            // --- Trash-icon delete (any row) ---------------------------
            // Document-level delegation: this script tag is emitted in the
            // middle of the page (between drop-zone and history table), so
            // #af-history-table does not exist yet at this point. Listening
            // on document covers any rows rendered later, both the static
            // table and any inserted by polling.
            document.addEventListener('click', function (ev) {
                    var btn = ev.target.closest('.af-delete-btn');
                    if (!btn) return;
                    ev.preventDefault();
                    var jobUuid  = btn.getAttribute('data-job-uuid') || '';
                    var filename = btn.getAttribute('data-filename') || 'this document';
                    var status   = btn.getAttribute('data-status') || '';
                    if (jobUuid === '') return;
                    var prompt = 'Delete "' + filename + '"?\n\nThe inbox row AND the file in the patient’s Documents tab will be removed.';
                    if (status === 'committed') {
                        prompt = 'Delete "' + filename + '"?\n\nThe inbox row and the file in the Documents tab will be removed. The lab procedure rows, intake medications/allergies, and chief-concern note that were already written to the patient chart will NOT be removed.';
                    } else if (status === 'pending' || status === 'extracting') {
                        prompt = 'Delete "' + filename + '"?\n\nExtraction is still in progress — the worker may still be writing. The inbox row and the file in the Documents tab will be removed.';
                    }
                    var ok = window.confirm(prompt);
                    if (!ok) return;
                    btn.disabled = true;
                    fetch(DELETE_URL, {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        body: JSON.stringify({ job_uuid: jobUuid })
                    }).then(function (resp) {
                        if (resp.ok) {
                            window.location.assign(INBOX_URL);
                            return;
                        }
                        btn.disabled = false;
                        return resp.json().then(function (body) {
                            var msg = body && body.error
                                ? 'Delete failed: ' + body.error
                                : 'Delete failed (HTTP ' + resp.status + ').';
                            window.alert(msg);
                        }, function () {
                            window.alert('Delete failed (HTTP ' + resp.status + ').');
                        });
                    }).catch(function () {
                        btn.disabled = false;
                        window.alert('Delete failed: network error.');
                    });
            });

            dropzone.addEventListener('dragover', function (e) {
                e.preventDefault();
                dropzone.style.borderColor = '#0d6efd';
                dropzone.style.background  = '#f0f4ff';
            });
            dropzone.addEventListener('dragleave', function () {
                dropzone.style.borderColor = '#ced4da';
                dropzone.style.background  = '';
            });
            dropzone.addEventListener('drop', function (e) {
                e.preventDefault();
                dropzone.style.borderColor = '#ced4da';
                dropzone.style.background  = '';
                var files = e.dataTransfer && e.dataTransfer.files;
                if (files && files.length > 0) {
                    for (var i = 0; i < files.length; i++) {
                        uploadFile(files[i]);
                    }
                }
            });

            fileInput.addEventListener('change', function () {
                var files = fileInput.files;
                if (files && files.length > 0) {
                    for (var i = 0; i < files.length; i++) {
                        uploadFile(files[i]);
                    }
                }
                // Reset so the same file can be re-selected if needed.
                fileInput.value = '';
            });

            // --- Upload --------------------------------------------------

            function selectedDocType() {
                var checked = document.querySelector('input[name="af_doc_type"]:checked');
                return checked ? checked.value : 'lab_pdf';
            }

            function showError(msg) {
                errorBox.textContent = msg;
                errorBox.classList.remove('d-none');
                setTimeout(function () { errorBox.classList.add('d-none'); }, 8000);
            }

            function uploadFile(file) {
                errorBox.classList.add('d-none');
                var docType  = selectedDocType();
                var patientIdMeta = document.querySelector('meta[name="patient-id"]');
                var patientId = patientIdMeta ? patientIdMeta.content : '';

                // Pre-allocate the job UUID client-side so we can begin
                // polling status.php right away. The upload XHR blocks
                // for the duration of the synchronous sidecar extraction
                // — without an early-known UUID we'd have nothing to
                // poll until the XHR returns. 32 hex chars to match the
                // server's `bin2hex(random_bytes(16))` format.
                var jobUuid = generateClientJobUuid();
                var rowId   = 'af-row-' + jobUuid;
                rowState[rowId] = {
                    jobUuid:   jobUuid,
                    startedAt: Date.now(),
                    timer:     null,
                };
                insertPendingRow(rowId, file.name, docType);
                // Start polling immediately. The first few polls will
                // 404 until upload.php inserts the row; the poller
                // tolerates that (treats as "still extracting").
                schedulePoll(rowId);

                var fd = new FormData();
                fd.append('file', file, file.name);
                fd.append('doc_type', docType);
                fd.append('job_uuid', jobUuid);
                if (patientId) { fd.append('patient_id', patientId); }

                var xhr = new XMLHttpRequest();
                xhr.open('POST', UPLOAD_URL, true);
                xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                xhr.onload = function () {
                    // Polling drives the badge; the XHR's only job is
                    // detecting hard failures (non-2xx, malformed JSON).
                    // Success (200) is a no-op — the next poll will
                    // surface the new server-side status.
                    if (xhr.status === 200) {
                        return;
                    }
                    var errResp;
                    try { errResp = JSON.parse(xhr.responseText); } catch (e) { errResp = null; }
                    var msg = errResp && errResp.message
                        ? errResp.message
                        : (<?php echo json_encode(xlt('Upload failed (HTTP ')); ?> + xhr.status + ')');
                    failRow(rowId, <?php echo json_encode(xlt('Upload failed')); ?>);
                    showError(msg);
                };
                xhr.onerror = function () {
                    failRow(rowId, <?php echo json_encode(xlt('Upload failed')); ?>);
                    showError(<?php echo json_encode(xlt('Upload failed: network error.')); ?>);
                };
                xhr.send(fd);
            }

            // 32-hex-char id, matching the server's
            // bin2hex(random_bytes(16)) format. Prefer the native
            // crypto.randomUUID and strip hyphens; fall back to the
            // older getRandomValues path for older browsers.
            function generateClientJobUuid() {
                if (window.crypto && typeof window.crypto.randomUUID === 'function') {
                    return window.crypto.randomUUID().replace(/-/g, '');
                }
                var buf = new Uint8Array(16);
                window.crypto.getRandomValues(buf);
                var hex = '';
                for (var i = 0; i < buf.length; i++) {
                    hex += (buf[i] < 16 ? '0' : '') + buf[i].toString(16);
                }
                return hex;
            }

            // --- Polling -------------------------------------------------

            function schedulePoll(rowId) {
                var state = rowState[rowId];
                if (!state) { return; }
                state.timer = setTimeout(function () { poll(rowId); }, POLL_MS);
            }

            function poll(rowId) {
                var state = rowState[rowId];
                if (!state) { return; }

                if (Date.now() - state.startedAt > TIMEOUT_MS) {
                    updateRowStatus(rowId, 'timeout');
                    return;
                }

                var url = STATUS_URL + '?job_uuid=' + encodeURIComponent(state.jobUuid);
                var xhr = new XMLHttpRequest();
                xhr.open('GET', url, true);
                xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                xhr.onload = function () {
                    // 404 here means upload.php hasn't inserted the
                    // row yet — i.e. the file is still in flight. The
                    // badge keeps the "Uploading" label set by
                    // insertPendingRow; we just reschedule and try
                    // again on the next tick.
                    if (xhr.status !== 200) { schedulePoll(rowId); return; }
                    var resp;
                    try { resp = JSON.parse(xhr.responseText); } catch (e) { resp = null; }
                    if (!resp) { schedulePoll(rowId); return; }

                    var status = resp.status;
                    updateRowStatus(rowId, status);

                    if (status === 'pending' || status === 'extracting') {
                        schedulePoll(rowId);
                    } else {
                        // ready_for_review / committed / rejected / failed:
                        // reload so the server-rendered row appears with the
                        // proper extractionId, clickable filename, and
                        // canonical timestamps.
                        setTimeout(function () { window.location.reload(); }, 800);
                    }
                };
                xhr.onerror = function () { schedulePoll(rowId); };
                xhr.send();
            }

            // --- Row insertion + status -----------------------------------

            function insertPendingRow(rowId, filename, docType) {
                var table = document.getElementById('af-history-table');
                if (!table) { return; }
                var tbody = table.querySelector('tbody');
                if (!tbody) {
                    // Empty-state placeholder is rendered as a <p>; replace
                    // the card body with a fresh table so the row has
                    // somewhere to live.
                    var body = table.querySelector('.card-body');
                    if (!body) { return; }
                    body.innerHTML =
                        '<div class="table-responsive">' +
                            '<table class="table table-sm table-hover mb-0">' +
                                '<thead class="thead-light"><tr>' +
                                    '<th>' + escHtml(<?php echo json_encode(xlt('Filename')); ?>) + '</th>' +
                                    '<th>' + escHtml(<?php echo json_encode(xlt('Time')); ?>) + '</th>' +
                                    '<th>' + escHtml(<?php echo json_encode(xlt('Type')); ?>) + '</th>' +
                                    '<th>' + escHtml(<?php echo json_encode(xlt('Uploaded by')); ?>) + '</th>' +
                                    '<th>' + escHtml(<?php echo json_encode(xlt('Status')); ?>) + '</th>' +
                                    '<th class="text-right"></th>' +
                                '</tr></thead><tbody></tbody>' +
                            '</table>' +
                        '</div>';
                    tbody = body.querySelector('tbody');
                    if (!tbody) { return; }
                }

                var docTypeLabel = docType === 'lab_pdf'
                    ? <?php echo json_encode(xlt('Lab PDF')); ?>
                    : <?php echo json_encode(xlt('Intake Form')); ?>;

                var tr = document.createElement('tr');
                tr.id = rowId;
                tr.innerHTML =
                    '<td class="af-filename-cell">' + escHtml(filename || <?php echo json_encode(xlt('(unnamed)')); ?>) + '</td>' +
                    '<td class="text-nowrap">' + escHtml(formatNowDateTime()) + '</td>' +
                    '<td>' + escHtml(docTypeLabel) + '</td>' +
                    '<td>' + escHtml(<?php echo json_encode(xlt('Administrator')); ?>) + '</td>' +
                    '<td class="af-status-cell"><span class="badge badge-secondary">' +
                        escHtml(<?php echo json_encode(xlt('Uploading')); ?>) +
                    '</span></td>' +
                    '<td class="text-right text-nowrap"></td>';
                tbody.prepend(tr);
            }

            // Map backend status → (badge class, label).
            // Six visible labels only: Uploading (set by insertPendingRow
            // while the upload XHR is in flight), Extracting (server
            // state is pending OR extracting — collapsed for users since
            // the dispatch is synchronous and pending is brief), Ready
            // for Review, Committed, Rejected, Failed.
            var STATUS_PRESENTATION = {
                pending:          {cls: 'badge-info',              lbl: <?php echo json_encode(xlt('Extracting')); ?>},
                extracting:       {cls: 'badge-info',              lbl: <?php echo json_encode(xlt('Extracting')); ?>},
                ready_for_review: {cls: 'badge-warning text-dark', lbl: <?php echo json_encode(xlt('Ready for Review')); ?>},
                committed:        {cls: 'badge-success',           lbl: <?php echo json_encode(xlt('Committed')); ?>},
                rejected:         {cls: 'badge-dark',              lbl: <?php echo json_encode(xlt('Rejected')); ?>},
                failed:           {cls: 'badge-danger',            lbl: <?php echo json_encode(xlt('Failed')); ?>},
                timeout:          {cls: 'badge-danger',            lbl: <?php echo json_encode(xlt('Failed')); ?>},
            };

            function updateRowStatus(rowId, status) {
                var tr = document.getElementById(rowId);
                if (!tr) { return; }
                var cell = tr.querySelector('.af-status-cell');
                if (!cell) { return; }
                var p = STATUS_PRESENTATION[status]
                    || {cls: 'badge-secondary', lbl: status};
                cell.innerHTML = '<span class="badge ' + escAttr(p.cls) + '">' + escHtml(p.lbl) + '</span>';
            }

            function failRow(rowId, label) {
                var tr = document.getElementById(rowId);
                if (!tr) { return; }
                var cell = tr.querySelector('.af-status-cell');
                if (cell) {
                    cell.innerHTML = '<span class="badge badge-danger">' + escHtml(label) + '</span>';
                }
                setTimeout(function () {
                    var t = document.getElementById(rowId);
                    if (t && t.parentNode) { t.parentNode.removeChild(t); }
                    delete rowState[rowId];
                }, 6000);
            }

            function escHtml(s) {
                return String(s)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            }

            function escAttr(s) { return escHtml(s); }

            function formatNowDateTime() {
                // mm-dd-yyyy hh:mm AM/PM, matching the server-side PHP
                // format ('m-d-Y h:i A') so both rendering paths show
                // identical Time-column values, e.g. "05-07-2026 04:01 AM".
                var d = new Date();
                var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
                var hour24 = d.getHours();
                var hour12 = hour24 % 12;
                if (hour12 === 0) { hour12 = 12; }
                var ampm = hour24 < 12 ? 'AM' : 'PM';
                return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' + d.getFullYear() +
                    ' ' + pad(hour12) + ':' + pad(d.getMinutes()) + ' ' + ampm;
            }

            // --- Resume polling for in-flight rows after a page reload ----
            // Each row server-rendered with status pending/extracting carries
            // id=af-row-<uuid> + data-job-uuid + data-status. Without this
            // bootstrap rowState would be empty after reload and the badge
            // would freeze at whatever the server last persisted.
            function resumeInFlightPollers() {
                var rows = document.querySelectorAll(
                    'tr[data-job-uuid][data-status="pending"], tr[data-job-uuid][data-status="extracting"]'
                );
                for (var i = 0; i < rows.length; i++) {
                    var tr = rows[i];
                    var rowId = tr.id;
                    var jobUuid = tr.getAttribute('data-job-uuid') || '';
                    if (rowId === '' || jobUuid === '' || rowState[rowId]) { continue; }
                    rowState[rowId] = { jobUuid: jobUuid, startedAt: Date.now(), timer: null };
                    schedulePoll(rowId);
                }
            }
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', resumeInFlightPollers);
            } else {
                resumeInFlightPollers();
            }

        }());
        </script>
        <?php
    }

    /**
     * Render the side-by-side review screen for an existing extraction.
     *
     * Layout:
     *   Left column  — document viewer (PdfPageViewer / ImageViewer) + BboxOverlay
     *   Right column — extracted-fields panel placeholder (issue 32 fills this)
     *
     * PHI posture: extracted text and bbox payloads are passed to the browser
     * as a single JSON blob embedded in a <script> block.  No data-* attribute
     * carries extracted text — the component references records by numeric
     * index only (PRD §"Cache and PHI posture").
     *
     * The document bytes URL uses `Cache-Control: private, no-store` because
     * the entry point already sent that header for the whole page.
     *
     * PDF.js is loaded from the CDN version matching the server-side renderer's
     * pdfjs-dist 5.x series (useSystemFonts:false for parity).
     */
    private function renderReviewScreen(ReviewJobView $view, string $webRoot): void
    {
        // Build bbox records from the extracted JSON for the JS component.
        // Only the field path (a JSON pointer string) and a short label are
        // passed — no extracted text values reach DOM data-* attributes.
        $bboxRecords     = $this->buildBboxRecords($view->extractedJson);
        $bboxRecordsJson = json_encode($bboxRecords, JSON_UNESCAPED_UNICODE);

        // Full extracted payload for the field-edit panel.
        // State lives in the JS module scope and disappears on navigation;
        // it is never written to DOM data-* attributes (PRD §"Cache and PHI posture").
        $extractedJsonStr = json_encode($view->extractedJson, JSON_UNESCAPED_UNICODE);

        // Document bytes URL (served by OpenEMR's canonical document retrieval).
        // The URL identifies the document by its integer primary key — not PHI.
        $docBytesUrl = $webRoot . '/controller.php?document&retrieve'
            . '&patient_id=' . $view->patientId
            . '&document_id=' . $view->documentId
            . '&as_file=true';

        $docBytesUrlJson = json_encode($docBytesUrl);

        $docType   = $view->docType;
        $pageCount = $view->pageCount;
        $isReadOnly = in_array($view->status, [
            UploadJobStatus::Committed,
            UploadJobStatus::Rejected,
        ], true);
        $readOnlyLabelJson = json_encode($isReadOnly);
        $pageCountJson     = json_encode($pageCount);

        // PDF.js CDN (version 5.x to match server-side pdfjs-dist 5.7.x).
        $pdfWorkerUrl = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/build/pdf.worker.min.mjs';

        // Endpoint URLs for XHR confirm / reject.
        $confirmUrlJson = json_encode($webRoot . '/interface/agentforge/jobs/confirm.php');
        $rejectUrlJson  = json_encode($webRoot . '/interface/agentforge/jobs/reject.php');
        $inboxUrlJson   = json_encode($webRoot . '/interface/agentforge/inbox.php');
        $jobUuidJson    = json_encode($view->jobUuid);

        // Status badge
        $statusLabel = $this->statusLabel($view->status);
        $statusClass = $this->statusBadgeClass($view->status);

        // i18n strings embedded in JS via json_encode (xlt runs server-side).
        $i18n = json_encode([
            'confirmBtn'        => xlt('Confirm'),
            'rejectBtn'         => xlt('Reject'),
            'rejectRowBtn'      => xlt('Reject row'),
            'rowRejected'       => xlt('Rejected'),
            'restoreRow'        => xlt('Restore'),
            'readOnlyBadge'     => xlt('Read-only'),
            'sectionHeader'     => xlt('Extracted fields'),
            'sectionLab'        => xlt('Lab results'),
            'sectionHeader2'    => xlt('Document header'),
            'sectionMeds'       => xlt('Current medications'),
            'sectionAllergies'  => xlt('Allergies'),
            'sectionFamily'     => xlt('Family history'),
            'sectionChief'      => xlt('Chief concern'),
            'sectionDemo'       => xlt('Demographics'),
            'labelTestName'     => xlt('Test'),
            'labelValue'        => xlt('Value'),
            'labelUnit'         => xlt('Unit'),
            'labelRefRange'     => xlt('Reference range'),
            'labelAbnormal'     => xlt('Abnormal flag'),
            'labelLoinc'        => xlt('LOINC'),
            'labelProvider'     => xlt('Ordering provider'),
            'labelLab'          => xlt('Performing lab'),
            'labelCollDate'     => xlt('Collection date'),
            'labelPatientOnDoc' => xlt('Patient name on document'),
            'labelMedName'      => xlt('Medication'),
            'labelDose'         => xlt('Dose'),
            'labelFrequency'    => xlt('Frequency'),
            'labelRoute'        => xlt('Route'),
            'labelSubstance'    => xlt('Substance'),
            'labelReaction'     => xlt('Reaction'),
            'labelSeverity'     => xlt('Severity'),
            'labelRelation'     => xlt('Relation'),
            'labelConditions'   => xlt('Conditions'),
            'labelChiefText'    => xlt('Chief concern'),
            'labelDOB'          => xlt('Date of birth'),
            'labelSex'          => xlt('Sex'),
            'labelPhone'        => xlt('Phone'),
            'labelAddress'      => xlt('Address'),
            'toast409'          => xlt('This document has already been processed. Please refresh the page.'),
            'dirtyBadge'        => xlt('Edited'),
            'confirmingLabel'   => xlt('Confirming…'),
            'rejectingLabel'    => xlt('Rejecting…'),
            'errorLabel'        => xlt('Error — please try again.'),
        ]);
        ?>

        <!-- PDF.js (CDN, version-pinned to match server-side renderer) -->
        <script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/build/pdf.min.mjs"
                type="module"
                crossorigin="anonymous"></script>

        <!-- AgentForge viewer components (BboxOverlay, PdfPageViewer, ImageViewer) -->
        <script src="<?php echo attr($webRoot . '/public/assets/agentforge/document-viewer.js'); ?>"></script>

        <style>
            #af-review-screen .af-field-row { cursor: default; }
            #af-review-screen .af-field-row.has-bbox { cursor: pointer; }
            #af-review-screen .af-field-row.has-bbox:hover { background: #f0f4ff; }
            #af-review-screen .af-field-row.af-highlighted { background: #fef9c3; }
            #af-review-screen .af-rejected-row { opacity: 0.45; }
            #af-review-screen .af-rejected-row input,
            #af-review-screen .af-rejected-row textarea { pointer-events: none; }
            #af-review-screen .af-section-heading {
                font-size: 0.7rem;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                color: #6c757d;
                padding: 0.5rem 0 0.25rem;
            }
            #af-review-screen .af-toast {
                position: fixed;
                bottom: 1.5rem;
                right: 1.5rem;
                z-index: 9999;
                min-width: 280px;
            }
        </style>

        <div id="af-review-screen" class="row no-gutters" style="min-height:60vh;">

            <!-- Left: document viewer -->
            <div class="col-lg-7 col-md-6 border-right" style="background:#f8f9fa;">
                <div class="p-2 border-bottom d-flex align-items-center justify-content-between">
                    <span class="font-weight-bold small text-muted">
                        <?php echo xlt('Document'); ?>
                    </span>
                    <div class="d-flex align-items-center">
                        <a href="<?php echo attr($docBytesUrl); ?>" target="_blank"
                           class="btn btn-xs btn-outline-secondary mr-2">
                            <i class="fa fa-external-link-alt mr-1" aria-hidden="true"></i>
                            <?php echo xlt('View document'); ?>
                        </a>
                        <span class="badge <?php echo attr($statusClass); ?>">
                            <?php echo text($statusLabel); ?>
                        </span>
                    </div>
                </div>

                <!-- Page navigation (shown for PDFs with > 1 page) -->
                <div id="af-page-nav" class="px-2 py-1 border-bottom d-flex align-items-center d-none">
                    <button id="af-page-prev" class="btn btn-sm btn-outline-secondary mr-2" disabled>
                        &larr; <?php echo xlt('Prev'); ?>
                    </button>
                    <span id="af-page-label" class="small text-muted mr-2">
                        <?php echo xlt('Page'); ?> <span id="af-page-current">1</span> <?php echo xlt('of'); ?> <span id="af-page-total">?</span>
                    </span>
                    <button id="af-page-next" class="btn btn-sm btn-outline-secondary">
                        <?php echo xlt('Next'); ?> &rarr;
                    </button>
                </div>

                <!-- Viewer canvas + overlay container -->
                <div id="af-viewer-container"
                     class="p-2"
                     style="position:relative; overflow:auto; min-height:400px;">
                    <div id="af-viewer-wrap" style="position:relative; display:inline-block;">
                        <!-- Viewer mounts here (PdfPageViewer or ImageViewer) -->
                    </div>
                </div>
            </div>

            <!-- Right: extracted-fields panel -->
            <div class="col-lg-5 col-md-6 d-flex flex-column">
                <div class="p-2 border-bottom d-flex align-items-center justify-content-between">
                    <span class="font-weight-bold small text-muted" id="af-panel-heading">
                        <?php echo xlt('Extracted fields'); ?>
                    </span>
                    <div class="d-flex align-items-center">
                        <!-- dirty badge: shown when reviewer has edited any field -->
                        <span id="af-dirty-badge" class="badge badge-warning mr-2 d-none">
                            <?php echo xlt('Edited'); ?>
                        </span>
                        <?php if (!$isReadOnly): ?>
                        <!-- Whole-document reject -->
                        <button type="button" class="btn btn-sm btn-outline-danger mr-2"
                                id="af-reject-btn">
                            <?php echo xlt('Reject'); ?>
                        </button>
                        <!-- Confirm -->
                        <button type="button" class="btn btn-sm btn-success"
                                id="af-confirm-btn">
                            <?php echo xlt('Confirm'); ?>
                        </button>
                        <?php else: ?>
                        <span class="badge badge-secondary">
                            <?php echo xlt('Read-only'); ?>
                        </span>
                        <?php endif; ?>
                    </div>
                </div>

                <!-- Field-edit panel: populated by JS from EXTRACTED_JSON -->
                <div id="af-fields-panel" class="flex-grow-1 overflow-auto p-2">
                </div>
            </div>
        </div>

        <!-- Toast container for 409 / error feedback -->
        <div id="af-toast-container"></div>

        <script type="module">
        // Prime window.pdfjsLib so the classic-script viewer can reference it.
        import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/build/pdf.min.mjs';
        window.pdfjsLib = pdfjsLib;

        (function () {
            'use strict';

            // -----------------------------------------------------------------
            // Page-level constants injected from PHP
            // -----------------------------------------------------------------
            var DOC_SRC        = <?php echo $docBytesUrlJson; ?>;
            var PAGE_COUNT     = <?php echo $pageCountJson; ?>;
            var RECORDS        = <?php echo $bboxRecordsJson; ?>;
            var JOB_UUID       = <?php echo $jobUuidJson; ?>;
            var READ_ONLY      = <?php echo $readOnlyLabelJson; ?>;
            var PDF_WORKER     = <?php echo json_encode($pdfWorkerUrl); ?>;
            var DOC_TYPE       = <?php echo json_encode($docType); ?>;
            var DOC_MIME       = <?php echo json_encode($view->mimeType); ?>;
            var CONFIRM_URL    = <?php echo $confirmUrlJson; ?>;
            var REJECT_URL     = <?php echo $rejectUrlJson; ?>;
            var INBOX_URL      = <?php echo $inboxUrlJson; ?>;
            var EXTRACTED_JSON = <?php echo $extractedJsonStr; ?>;
            var I18N           = <?php echo $i18n; ?>;

            // -----------------------------------------------------------------
            // Viewer bootstrap
            // -----------------------------------------------------------------
            var wrap = document.getElementById('af-viewer-wrap');
            if (!wrap || !window.AgentForge || !window.AgentForge.viewer) { return; }

            var V = window.AgentForge.viewer;

            // Dispatch the viewer on the actual file MIME (or its
            // prefix) — DOC_TYPE is the AgentForge user-facing doc
            // category and is independent of file format. Both lab and
            // intake docs may arrive as PDF or as one of the image
            // formats the drop-zone accepts (.png/.jpg/.jpeg/.webp).
            var mimeType = (DOC_MIME || '').toLowerCase();
            var isImage  = mimeType.indexOf('image/') === 0;
            // Treat anything that's not explicitly an image as a PDF candidate —
            // documents.mimetype is sometimes 'application/octet-stream' for
            // uploads that bypassed sniffing.
            var isPdf    = !isImage;

            // Wire overlay click → highlight matching field row in panel.
            var overlay = new V.BboxOverlay(wrap, RECORDS, function (fieldPath) {
                highlightFieldRow(fieldPath);
            });

            var pdfViewer;
            if (isPdf) {
                pdfViewer = new V.PdfPageViewer({
                    scale:        1.5,
                    workerSrc:    PDF_WORKER,
                    onDimensions: function (w, h) {
                        overlay.render(currentPage, w, h, PAGE_COUNT);
                    },
                });
            } else {
                pdfViewer = new V.ImageViewer({
                    onDimensions: function (w, h) {
                        overlay.render(0, w, h, PAGE_COUNT);
                    },
                });
            }
            pdfViewer.mount(wrap, DOC_SRC);

            // Expose globally so field-panel click-to-source can call
            // window.afReviewViewer.flashByFieldPath(path).
            window.afReviewViewer = {
                flashByFieldPath: function (fieldPath) {
                    overlay.flashByFieldPath(fieldPath);
                },
                goToPage: function (pageIndex) {
                    currentPage = pageIndex;
                    pdfViewer.renderPage(pageIndex, function (w, h) {
                        overlay.render(pageIndex, w, h, PAGE_COUNT);
                    });
                },
            };

            // Page navigation for multi-page PDFs.
            var currentPage = 0;
            var pageNav  = document.getElementById('af-page-nav');
            var prevBtn  = document.getElementById('af-page-prev');
            var nextBtn  = document.getElementById('af-page-next');
            var curLabel = document.getElementById('af-page-current');
            var totLabel = document.getElementById('af-page-total');

            if (isPdf && PAGE_COUNT > 1 && pageNav) {
                pageNav.classList.remove('d-none');
                if (totLabel) { totLabel.textContent = PAGE_COUNT; }
                if (prevBtn) {
                    prevBtn.addEventListener('click', function () {
                        if (currentPage > 0) {
                            currentPage--;
                            window.afReviewViewer.goToPage(currentPage);
                            updatePageNav();
                        }
                    });
                }
                if (nextBtn) {
                    nextBtn.addEventListener('click', function () {
                        if (currentPage < PAGE_COUNT - 1) {
                            currentPage++;
                            window.afReviewViewer.goToPage(currentPage);
                            updatePageNav();
                        }
                    });
                }
            }

            function updatePageNav() {
                if (curLabel) { curLabel.textContent = currentPage + 1; }
                if (prevBtn)  { prevBtn.disabled = currentPage === 0; }
                if (nextBtn)  { nextBtn.disabled = currentPage >= PAGE_COUNT - 1; }
            }
            updatePageNav();

            // -----------------------------------------------------------------
            // Review panel — field-edit surface
            // -----------------------------------------------------------------

            // editedJson is a deep copy of EXTRACTED_JSON that the reviewer
            // mutates.  On confirm it is sent to the server; the server's
            // EditedFieldPathDiffer computes the diff against the original.
            var editedJson = JSON.parse(JSON.stringify(EXTRACTED_JSON));

            // rejectedRowIndices: Set of integer indices for lab result rows
            // the reviewer has toggled to "reject this row".
            var rejectedRowIndices = {};
            var isDirty = false;

            var panel = document.getElementById('af-fields-panel');
            if (panel) {
                buildPanel();
            }

            function markDirty() {
                isDirty = true;
                var badge = document.getElementById('af-dirty-badge');
                if (badge) { badge.classList.remove('d-none'); }
            }

            // ---- Panel builders ----

            function buildPanel() {
                panel.innerHTML = '';
                if (DOC_TYPE === 'lab_pdf') {
                    buildLabPanel();
                } else if (DOC_TYPE === 'intake_form') {
                    buildIntakePanel();
                }
            }

            function buildLabPanel() {
                // Document header section. The lab_pdf schema (agent/src/schemas/LabPdfSchema.ts)
                // emits these as top-level keys, not nested under a `header` object.
                appendSection(I18N.sectionHeader2, [
                    makeFieldRow('performing_lab',           I18N.labelLab,      editedJson.performing_lab           || '', null, 'performing_lab'),
                    makeFieldRow('ordering_provider',        I18N.labelProvider, editedJson.ordering_provider        || '', null, 'ordering_provider'),
                    makeFieldRow('collection_date_default',  I18N.labelCollDate, editedJson.collection_date_default  || '', null, 'collection_date_default'),
                ]);

                // Patient-on-document header
                var pod = editedJson.patient_on_document || {};
                appendSection(I18N.labelPatientOnDoc, [
                    makeFieldRow('patient_on_document.name', I18N.labelPatientOnDoc, pod.name || '', 'patient_on_document', 'name'),
                ]);

                // Lab results
                var results = Array.isArray(editedJson.results) ? editedJson.results : [];
                if (results.length > 0) {
                    appendSectionHeading(I18N.sectionLab);
                    results.forEach(function (row, idx) {
                        appendLabResultRow(row, idx);
                    });
                }
            }

            function buildIntakePanel() {
                // Demographics
                var demo = editedJson.demographics || {};
                appendSection(I18N.sectionDemo, [
                    makeFieldRow('demographics.dob',     I18N.labelDOB,     demo.dob     || '', 'demographics', 'dob'),
                    makeFieldRow('demographics.sex',     I18N.labelSex,     demo.sex     || '', 'demographics', 'sex'),
                    makeFieldRow('demographics.phone',   I18N.labelPhone,   demo.phone   || '', 'demographics', 'phone'),
                    makeFieldRow('demographics.address', I18N.labelAddress, demo.address || '', 'demographics', 'address'),
                ]);

                // Chief concern
                var cc = editedJson.chief_concern;
                if (cc && typeof cc === 'object') {
                    appendSection(I18N.sectionChief, [
                        makeFieldRow('chief_concern.text', I18N.labelChiefText, cc.text || '', 'chief_concern', 'text'),
                    ]);
                }

                // Medications
                var meds = Array.isArray(editedJson.current_medications) ? editedJson.current_medications : [];
                if (meds.length > 0) {
                    appendSectionHeading(I18N.sectionMeds);
                    meds.forEach(function (med, idx) {
                        appendIntakeMedRow(med, idx);
                    });
                }

                // Allergies
                var allergies = Array.isArray(editedJson.allergies) ? editedJson.allergies : [];
                if (allergies.length > 0) {
                    appendSectionHeading(I18N.sectionAllergies);
                    allergies.forEach(function (allergy, idx) {
                        appendIntakeAllergyRow(allergy, idx);
                    });
                }

                // Family history
                var fh = Array.isArray(editedJson.family_history) ? editedJson.family_history : [];
                if (fh.length > 0) {
                    appendSectionHeading(I18N.sectionFamily);
                    fh.forEach(function (entry, idx) {
                        appendFamilyHistoryRow(entry, idx);
                    });
                }
            }

            // ---- Section helpers ----

            function appendSectionHeading(label) {
                var h = document.createElement('div');
                h.className = 'af-section-heading border-top mt-2 pt-2';
                h.textContent = label;
                panel.appendChild(h);
            }

            function appendSection(label, rows) {
                appendSectionHeading(label);
                rows.forEach(function (row) { if (row) { panel.appendChild(row); } });
            }

            // ---- Generic field row (label + input) ----
            // The row is also the "has-bbox" hook for click-to-source.
            // fieldPath is the JSON dot-path for flashByFieldPath().
            // parentKey / childKey are where in editedJson the value lives.

            function makeFieldRow(fieldPath, label, value, parentKey, childKey) {
                var row = document.createElement('div');
                row.className = 'af-field-row d-flex align-items-start py-1 px-1';
                if (RECORDS.some(function (r) { return r.fieldPath === fieldPath; })) {
                    row.classList.add('has-bbox');
                    row.addEventListener('click', function () {
                        if (window.afReviewViewer) {
                            window.afReviewViewer.flashByFieldPath(fieldPath);
                        }
                    });
                }
                row.dataset.fieldPath = fieldPath;

                var labelEl = document.createElement('label');
                labelEl.className = 'small text-muted mb-0 mr-2';
                labelEl.style.minWidth = '130px';
                labelEl.style.lineHeight = '1.6';
                labelEl.textContent = label;

                var input = document.createElement('input');
                input.type = 'text';
                input.className = 'form-control form-control-sm';
                input.value = value !== null && value !== undefined ? String(value) : '';
                input.readOnly = READ_ONLY;
                input.setAttribute('aria-label', label);

                if (!READ_ONLY && childKey) {
                    input.addEventListener('input', function () {
                        setNestedValue(editedJson, parentKey, childKey, input.value);
                        markDirty();
                    });
                }

                row.appendChild(labelEl);
                row.appendChild(input);
                return row;
            }

            function setNestedValue(obj, parentKey, childKey, value) {
                if (parentKey === null || parentKey === undefined || parentKey === '') {
                    obj[childKey] = value;
                    return;
                }
                if (!obj[parentKey] || typeof obj[parentKey] !== 'object') {
                    obj[parentKey] = {};
                }
                obj[parentKey][childKey] = value;
            }

            // ---- Lab result row (multi-field card + per-row reject) ----

            function appendLabResultRow(row, idx) {
                var fieldPath = 'results[' + idx + '].display_value';

                var card = document.createElement('div');
                card.className = 'card mb-2 af-lab-row';
                if (rejectedRowIndices[idx]) {
                    card.classList.add('af-rejected-row');
                }
                card.dataset.labIdx = String(idx);

                var cardBody = document.createElement('div');
                cardBody.className = 'card-body p-2';

                // Header row: test name + reject button
                var headerDiv = document.createElement('div');
                headerDiv.className = 'd-flex justify-content-between align-items-center mb-1';

                var nameLabel = document.createElement('span');
                nameLabel.className = 'font-weight-bold small';

                // Test name input
                var nameInput = document.createElement('input');
                nameInput.type = 'text';
                nameInput.className = 'form-control form-control-sm mr-2';
                nameInput.value = row.test_name || '';
                nameInput.readOnly = READ_ONLY;
                nameInput.setAttribute('aria-label', I18N.labelTestName);
                if (!READ_ONLY) {
                    nameInput.addEventListener('input', function () {
                        editedJson.results[idx].test_name = nameInput.value;
                        markDirty();
                    });
                }

                headerDiv.appendChild(nameInput);

                if (!READ_ONLY) {
                    var rejectRowBtn = document.createElement('button');
                    rejectRowBtn.type = 'button';
                    rejectRowBtn.className = 'btn btn-xs btn-outline-danger flex-shrink-0';
                    rejectRowBtn.textContent = rejectedRowIndices[idx]
                        ? I18N.restoreRow
                        : I18N.rejectRowBtn;
                    rejectRowBtn.setAttribute('aria-label', I18N.rejectRowBtn);
                    rejectRowBtn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        toggleLabRowReject(idx, card, rejectRowBtn);
                    });
                    headerDiv.appendChild(rejectRowBtn);
                }

                cardBody.appendChild(headerDiv);

                // Click-to-source: clicking the card flashes bbox
                if (RECORDS.some(function (r) { return r.fieldPath === fieldPath; })) {
                    card.classList.add('has-bbox');
                    card.addEventListener('click', function () {
                        if (window.afReviewViewer) {
                            window.afReviewViewer.flashByFieldPath(fieldPath);
                        }
                    });
                }
                card.dataset.fieldPath = fieldPath;

                // Fields grid
                var grid = document.createElement('div');
                grid.className = 'row no-gutters';

                function addGridField(labelText, currentVal, onInput) {
                    var col = document.createElement('div');
                    col.className = 'col-6 pr-1 mb-1';
                    var lbl = document.createElement('label');
                    lbl.className = 'small text-muted mb-0 d-block';
                    lbl.textContent = labelText;
                    var inp = document.createElement('input');
                    inp.type = 'text';
                    inp.className = 'form-control form-control-sm';
                    inp.value = currentVal !== null && currentVal !== undefined ? String(currentVal) : '';
                    inp.readOnly = READ_ONLY;
                    if (!READ_ONLY && onInput) {
                        inp.addEventListener('input', function () { onInput(inp.value); markDirty(); });
                    }
                    col.appendChild(lbl);
                    col.appendChild(inp);
                    grid.appendChild(col);
                }

                addGridField(I18N.labelValue, row.display_value, function (v) { editedJson.results[idx].display_value = v; });
                addGridField(I18N.labelUnit,  row.unit,          function (v) { editedJson.results[idx].unit = v; });

                var refRange = row.reference_range || {};
                var refRawText = refRange.raw_text || '';
                addGridField(I18N.labelRefRange, refRawText, function (v) {
                    if (!editedJson.results[idx].reference_range) { editedJson.results[idx].reference_range = {}; }
                    editedJson.results[idx].reference_range.raw_text = v;
                });
                addGridField(I18N.labelAbnormal, row.abnormal_flag || '', function (v) { editedJson.results[idx].abnormal_flag = v || null; });

                cardBody.appendChild(grid);
                card.appendChild(cardBody);
                panel.appendChild(card);
            }

            function toggleLabRowReject(idx, card, btn) {
                if (rejectedRowIndices[idx]) {
                    delete rejectedRowIndices[idx];
                    card.classList.remove('af-rejected-row');
                    btn.textContent = I18N.rejectRowBtn;
                } else {
                    rejectedRowIndices[idx] = true;
                    card.classList.add('af-rejected-row');
                    btn.textContent = I18N.restoreRow;
                }
                markDirty();
            }

            // ---- Intake medication row ----

            function appendIntakeMedRow(med, idx) {
                var fpBase = 'current_medications[' + idx + ']';
                var card = document.createElement('div');
                card.className = 'card mb-2';
                var cb = document.createElement('div');
                cb.className = 'card-body p-2';

                function appendMedField(label, key, val) {
                    var lbl = document.createElement('label');
                    lbl.className = 'small text-muted mb-0';
                    lbl.textContent = label;
                    var inp = document.createElement('input');
                    inp.type = 'text';
                    inp.className = 'form-control form-control-sm mb-1';
                    inp.value = val !== null && val !== undefined ? String(val) : '';
                    inp.readOnly = READ_ONLY;
                    if (!READ_ONLY) {
                        inp.addEventListener('input', function () {
                            editedJson.current_medications[idx][key] = inp.value;
                            markDirty();
                        });
                    }
                    cb.appendChild(lbl);
                    cb.appendChild(inp);
                }

                // Click-to-source for medication name
                var fp = fpBase + '.name';
                if (RECORDS.some(function (r) { return r.fieldPath === fp; })) {
                    card.classList.add('has-bbox');
                    card.addEventListener('click', function () {
                        if (window.afReviewViewer) { window.afReviewViewer.flashByFieldPath(fp); }
                    });
                }
                card.dataset.fieldPath = fp;

                appendMedField(I18N.labelMedName,   'name',      med.name);
                appendMedField(I18N.labelDose,       'dose',      med.dose);
                appendMedField(I18N.labelFrequency,  'frequency', med.frequency);
                appendMedField(I18N.labelRoute,      'route',     med.route);

                card.appendChild(cb);
                panel.appendChild(card);
            }

            // ---- Intake allergy row ----

            function appendIntakeAllergyRow(allergy, idx) {
                var fpBase = 'allergies[' + idx + ']';
                var card = document.createElement('div');
                card.className = 'card mb-2';
                var cb = document.createElement('div');
                cb.className = 'card-body p-2';

                function appendAllergyField(label, key, val) {
                    var lbl = document.createElement('label');
                    lbl.className = 'small text-muted mb-0';
                    lbl.textContent = label;
                    var inp = document.createElement('input');
                    inp.type = 'text';
                    inp.className = 'form-control form-control-sm mb-1';
                    inp.value = val !== null && val !== undefined ? String(val) : '';
                    inp.readOnly = READ_ONLY;
                    if (!READ_ONLY) {
                        inp.addEventListener('input', function () {
                            editedJson.allergies[idx][key] = inp.value;
                            markDirty();
                        });
                    }
                    cb.appendChild(lbl);
                    cb.appendChild(inp);
                }

                var fp = fpBase + '.substance';
                if (RECORDS.some(function (r) { return r.fieldPath === fp; })) {
                    card.classList.add('has-bbox');
                    card.addEventListener('click', function () {
                        if (window.afReviewViewer) { window.afReviewViewer.flashByFieldPath(fp); }
                    });
                }
                card.dataset.fieldPath = fp;

                appendAllergyField(I18N.labelSubstance, 'substance', allergy.substance);
                appendAllergyField(I18N.labelReaction,  'reaction',  allergy.reaction);
                appendAllergyField(I18N.labelSeverity,  'severity',  allergy.severity);

                card.appendChild(cb);
                panel.appendChild(card);
            }

            // ---- Family history row ----

            function appendFamilyHistoryRow(entry, idx) {
                var fpBase = 'family_history[' + idx + ']';
                var card = document.createElement('div');
                card.className = 'card mb-2';
                var cb = document.createElement('div');
                cb.className = 'card-body p-2';

                var fp = fpBase + '.conditions';
                if (RECORDS.some(function (r) { return r.fieldPath === fp; })) {
                    card.classList.add('has-bbox');
                    card.addEventListener('click', function () {
                        if (window.afReviewViewer) { window.afReviewViewer.flashByFieldPath(fp); }
                    });
                }

                var relLbl = document.createElement('label');
                relLbl.className = 'small text-muted mb-0';
                relLbl.textContent = I18N.labelRelation;
                var relInp = document.createElement('input');
                relInp.type = 'text';
                relInp.className = 'form-control form-control-sm mb-1';
                relInp.value = entry.relation || '';
                relInp.readOnly = READ_ONLY;
                if (!READ_ONLY) {
                    relInp.addEventListener('input', function () {
                        editedJson.family_history[idx].relation = relInp.value;
                        markDirty();
                    });
                }

                var condLbl = document.createElement('label');
                condLbl.className = 'small text-muted mb-0';
                condLbl.textContent = I18N.labelConditions;
                var condInp = document.createElement('input');
                condInp.type = 'text';
                condInp.className = 'form-control form-control-sm mb-1';
                condInp.value = Array.isArray(entry.conditions) ? entry.conditions.join(', ') : '';
                condInp.readOnly = READ_ONLY;
                if (!READ_ONLY) {
                    condInp.addEventListener('input', function () {
                        editedJson.family_history[idx].conditions = condInp.value
                            ? condInp.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
                            : [];
                        markDirty();
                    });
                }

                cb.appendChild(relLbl);
                cb.appendChild(relInp);
                cb.appendChild(condLbl);
                cb.appendChild(condInp);
                card.appendChild(cb);
                panel.appendChild(card);
            }

            // ---- Field highlight on overlay click ----

            function highlightFieldRow(fieldPath) {
                // Remove any existing highlight
                var prev = panel.querySelector('.af-highlighted');
                if (prev) { prev.classList.remove('af-highlighted'); }

                // Find the row whose data-field-path matches
                var target = panel.querySelector('[data-field-path="' + fieldPath + '"]');
                if (target) {
                    target.classList.add('af-highlighted');
                    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    setTimeout(function () { target.classList.remove('af-highlighted'); }, 1200);
                }
            }

            // -----------------------------------------------------------------
            // Confirm flow
            // -----------------------------------------------------------------

            var confirmBtn = document.getElementById('af-confirm-btn');
            if (confirmBtn && !READ_ONLY) {
                confirmBtn.addEventListener('click', function () {
                    doConfirm();
                });
            }

            function buildSubmissionJson() {
                // Deep-clone editedJson, then drop rejected lab rows.
                var payload = JSON.parse(JSON.stringify(editedJson));
                if (DOC_TYPE === 'lab_pdf' && Array.isArray(payload.results)) {
                    payload.results = payload.results.filter(function (_r, idx) {
                        return !rejectedRowIndices[idx];
                    });
                }
                return payload;
            }

            function doConfirm() {
                if (!confirmBtn) { return; }
                confirmBtn.disabled = true;
                var originalText = confirmBtn.textContent;
                confirmBtn.textContent = I18N.confirmingLabel;

                var body = JSON.stringify({
                    job_uuid:    JOB_UUID,
                    edited_json: buildSubmissionJson(),
                });

                var xhr = new XMLHttpRequest();
                xhr.open('POST', CONFIRM_URL, true);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                xhr.onload = function () {
                    if (xhr.status === 200) {
                        window.location.href = INBOX_URL;
                        return;
                    }
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = originalText;
                    if (xhr.status === 409) {
                        showToast(I18N.toast409, 'warning');
                    } else {
                        showToast(I18N.errorLabel, 'danger');
                    }
                };
                xhr.onerror = function () {
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = originalText;
                    showToast(I18N.errorLabel, 'danger');
                };
                xhr.send(body);
            }

            // -----------------------------------------------------------------
            // Reject flow (whole document)
            // -----------------------------------------------------------------

            var rejectBtn = document.getElementById('af-reject-btn');
            if (rejectBtn && !READ_ONLY) {
                rejectBtn.addEventListener('click', function () {
                    doReject();
                });
            }

            function doReject() {
                if (!rejectBtn) { return; }
                rejectBtn.disabled = true;
                var originalText = rejectBtn.textContent;
                rejectBtn.textContent = I18N.rejectingLabel;

                var body = JSON.stringify({ job_uuid: JOB_UUID });

                var xhr = new XMLHttpRequest();
                xhr.open('POST', REJECT_URL, true);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                xhr.onload = function () {
                    if (xhr.status === 200) {
                        window.location.href = INBOX_URL;
                        return;
                    }
                    rejectBtn.disabled = false;
                    rejectBtn.textContent = originalText;
                    if (xhr.status === 409) {
                        showToast(I18N.toast409, 'warning');
                    } else {
                        showToast(I18N.errorLabel, 'danger');
                    }
                };
                xhr.onerror = function () {
                    rejectBtn.disabled = false;
                    rejectBtn.textContent = originalText;
                    showToast(I18N.errorLabel, 'danger');
                };
                xhr.send(body);
            }

            // -----------------------------------------------------------------
            // Toast helper
            // -----------------------------------------------------------------

            function showToast(message, variant) {
                var container = document.getElementById('af-toast-container');
                if (!container) { return; }
                var toast = document.createElement('div');
                toast.className = 'af-toast alert alert-' + (variant || 'info') + ' shadow';
                toast.role = 'alert';
                toast.textContent = message;
                container.appendChild(toast);
                setTimeout(function () { toast.remove(); }, 8000);
            }

        }());
        </script>
        <?php
    }

    /**
     * Build the BboxRecord array consumed by the browser-side BboxOverlay.
     *
     * Iterates the extracted JSON and extracts every bbox with its field
     * path (a dotted JSON pointer string) and a short human-readable label.
     * No extracted text values (test results, chief concern, etc.) appear
     * in the output — only the field name and the bbox coordinates.
     *
     * This is the only place in the PHP layer that traverses the extracted
     * JSON for UI purposes.  The shape mirrors `BboxRecord` in
     * `agent/src/viewer/BboxOverlay.ts`.
     *
     * @param array<string, mixed> $json
     *
     * @return list<array{bbox: array{page: int, x: float, y: float, w: float, h: float, image_w: int, image_h: int}, fieldPath: string, label: string}>
     */
    private function buildBboxRecords(array $json): array
    {
        $records = [];
        $docType = is_string($json['doc_type'] ?? null) ? $json['doc_type'] : '';

        if ($docType === 'lab_pdf') {
            // Patient-on-document header bbox.
            $patient = $json['patient_on_document'] ?? null;
            if (is_array($patient) && isset($patient['bbox']) && is_array($patient['bbox'])) {
                $rec = $this->makeBboxRecord($patient['bbox'], 'patient_on_document.name', xlt('Patient name'));
                if ($rec !== null) {
                    $records[] = $rec;
                }
            }

            // Per-test result bboxes.
            $results = $json['results'] ?? [];
            if (is_array($results)) {
                foreach ($results as $i => $result) {
                    if (!is_array($result) || !isset($result['bbox']) || !is_array($result['bbox'])) {
                        continue;
                    }
                    $testName = is_string($result['test_name'] ?? null)
                        ? $result['test_name']
                        : xlt('Test') . ' ' . ($i + 1);
                    $fieldPath = 'results[' . $i . '].display_value';
                    $label     = $testName;
                    $rec = $this->makeBboxRecord($result['bbox'], $fieldPath, $label);
                    if ($rec !== null) {
                        $records[] = $rec;
                    }
                }
            }
        } elseif ($docType === 'intake_form') {
            // Chief concern bbox.
            $chiefConcern = $json['chief_concern'] ?? null;
            if (is_array($chiefConcern) && isset($chiefConcern['bbox']) && is_array($chiefConcern['bbox'])) {
                $rec = $this->makeBboxRecord($chiefConcern['bbox'], 'chief_concern.text', xlt('Chief concern'));
                if ($rec !== null) {
                    $records[] = $rec;
                }
            }

            // Medications.
            $meds = $json['current_medications'] ?? [];
            if (is_array($meds)) {
                foreach ($meds as $i => $med) {
                    if (!is_array($med) || !isset($med['bbox']) || !is_array($med['bbox'])) {
                        continue;
                    }
                    $name      = is_string($med['name'] ?? null) ? $med['name'] : xlt('Medication');
                    $fieldPath = 'current_medications[' . $i . '].name';
                    $rec = $this->makeBboxRecord($med['bbox'], $fieldPath, $name);
                    if ($rec !== null) {
                        $records[] = $rec;
                    }
                }
            }

            // Allergies.
            $allergies = $json['allergies'] ?? [];
            if (is_array($allergies)) {
                foreach ($allergies as $i => $allergy) {
                    if (!is_array($allergy) || !isset($allergy['bbox']) || !is_array($allergy['bbox'])) {
                        continue;
                    }
                    $substance = is_string($allergy['substance'] ?? null)
                        ? $allergy['substance']
                        : xlt('Allergy');
                    $fieldPath = 'allergies[' . $i . '].substance';
                    $rec = $this->makeBboxRecord($allergy['bbox'], $fieldPath, $substance);
                    if ($rec !== null) {
                        $records[] = $rec;
                    }
                }
            }
        }

        return $records;
    }

    /**
     * Build a single BboxRecord from a raw bbox array.  Returns null when
     * the bbox is structurally invalid so the caller can skip it cleanly.
     *
     * Accepts `array<mixed>` rather than `array<string, mixed>` because
     * PHPStan infers the element type as `mixed` when the caller reads a
     * nested key from an `array<string, mixed>` parent — a known widening
     * in PHPStan's array narrowing. The method validates every key before
     * use, so the looser input type is safe.
     *
     * @param array<mixed> $bbox
     *
     * @return array{bbox: array{page: int, x: float, y: float, w: float, h: float, image_w: int, image_h: int}, fieldPath: string, label: string}|null
     */
    private function makeBboxRecord(array $bbox, string $fieldPath, string $label): ?array
    {
        // Validate required bbox fields.
        $page    = $bbox['page']    ?? null;
        $x       = $bbox['x']       ?? null;
        $y       = $bbox['y']       ?? null;
        $w       = $bbox['w']       ?? null;
        $h       = $bbox['h']       ?? null;
        $imageW  = $bbox['image_w'] ?? null;
        $imageH  = $bbox['image_h'] ?? null;

        if (
            !is_numeric($page)
            || !is_numeric($x) || !is_numeric($y)
            || !is_numeric($w) || !is_numeric($h)
            || !is_numeric($imageW) || !is_numeric($imageH)
        ) {
            return null;
        }

        $imageWInt = (int) $imageW;
        $imageHInt = (int) $imageH;
        if ($imageWInt <= 0 || $imageHInt <= 0) {
            return null;
        }

        return [
            'bbox' => [
                'page'    => (int) $page,
                'x'       => (float) $x,
                'y'       => (float) $y,
                'w'       => (float) $w,
                'h'       => (float) $h,
                'image_w' => $imageWInt,
                'image_h' => $imageHInt,
            ],
            'fieldPath' => $fieldPath,
            'label'     => $label,
        ];
    }

    /**
     * Fallback rendered when a reviewing-mode URL carries an invalid or
     * unauthorised job_uuid.
     */
    private function renderReviewNotFound(string $jobUuid): void
    {
        ?>
        <div class="card" id="af-review-not-found">
            <div class="card-body py-5 text-center">
                <p class="text-muted mb-1">
                    <strong><?php echo xlt('Review Screen'); ?></strong>
                </p>
                <?php if ($jobUuid !== ''): ?>
                    <p class="text-muted small mb-0">
                        <?php echo xlt('No extraction found for the requested job.'); ?>
                    </p>
                <?php else: ?>
                    <p class="text-muted small mb-0">
                        <?php echo xlt('No job identifier provided.'); ?>
                    </p>
                <?php endif; ?>
            </div>
        </div>
        <?php
    }

    /**
     * History table (one row per upload).
     *
     * Columns: filename, doc_type, uploaded-by + relative time,
     * color-coded status, action links.
     */
    private function renderHistoryTable(int $patientId, DocumentInboxResult $result, string $webRoot): void
    {
        $allRows = array_merge($result->active, $result->history);
        ?>
        <div class="card" id="af-history-table">
            <div class="card-header d-flex justify-content-between align-items-center">
                <strong><?php echo xlt('Upload History'); ?></strong>
            </div>
            <div class="card-body p-0">
                <?php if ($allRows === []): ?>
                    <p class="text-muted text-center py-4 mb-0">
                        <?php echo xlt('No documents have been uploaded for this patient yet.'); ?>
                    </p>
                <?php else: ?>
                    <div class="table-responsive">
                        <table class="table table-sm table-hover mb-0">
                            <thead class="thead-light">
                                <tr>
                                    <th><?php echo xlt('Filename'); ?></th>
                                    <th><?php echo xlt('Time'); ?></th>
                                    <th><?php echo xlt('Type'); ?></th>
                                    <th><?php echo xlt('Uploaded by'); ?></th>
                                    <th><?php echo xlt('Status'); ?></th>
                                    <th class="text-right"><span class="sr-only"><?php echo xlt('Delete'); ?></span></th>
                                </tr>
                            </thead>
                            <tbody>
                                <?php foreach ($allRows as $row): ?>
                                    <?php $this->renderHistoryRow($patientId, $row, $webRoot); ?>
                                <?php endforeach; ?>
                            </tbody>
                        </table>
                    </div>
                <?php endif; ?>
            </div>
        </div>
        <?php
    }

    private function renderHistoryRow(int $patientId, DocumentInboxRow $row, string $webRoot): void
    {
        $filename   = $row->filename !== '' ? $row->filename : xlt('(unnamed)');
        $docType    = $this->docTypeLabel($row->docType);
        $uploadedBy = $this->uploaderDisplay($row);
        $statusHtml = '<span class="badge ' . attr($this->statusBadgeClass($row->status)) . '">'
            . text($this->statusLabel($row->status)) . '</span>';

        // Hooks the JS poller (page-level <script>, see schedulePoll/poll)
        // uses to identify a row and update its status badge in place. We
        // emit them on every row so a reload mid-extraction continues to
        // poll without waiting for a fresh upload to seed rowState.
        $rowId = 'af-row-' . preg_replace('/[^a-zA-Z0-9_-]/', '', $row->jobUuid);

        // Filename is a link to the review screen only once an extraction
        // row exists. Pre-extraction rows render the filename as plain
        // text — the review screen has nothing meaningful to show yet.
        $isReviewable = $row->extractionId !== null;
        $reviewUrl    = attr($webRoot . '/interface/agentforge/inbox.php?mode=reviewing&job_uuid=' . urlencode($row->jobUuid));

        // Trash icon — rendered on every row. The .af-delete-btn handler
        // in the page-level <script> wires the POST to
        // interface/agentforge/jobs/delete.php with a JS confirm first.
        // data-job-uuid is a stable UUID, not PHI, so it is safe to embed.
        $deleteBtn = '<button type="button" class="btn btn-xs btn-outline-danger af-delete-btn" '
            . 'data-job-uuid="' . attr($row->jobUuid) . '" '
            . 'data-filename="' . attr($filename) . '" '
            . 'data-status="' . attr($row->status->value) . '" '
            . 'title="' . attr(xla('Remove this document from the inbox')) . '" '
            . 'aria-label="' . attr(xla('Remove this document from the inbox')) . '">'
            . '<i class="fa fa-trash" aria-hidden="true"></i>'
            . '</button>';

        ?>
        <tr id="<?php echo attr($rowId); ?>"
            data-job-uuid="<?php echo attr($row->jobUuid); ?>"
            data-status="<?php echo attr($row->status->value); ?>">
            <td>
                <?php if ($isReviewable): ?>
                    <a href="<?php echo $reviewUrl; ?>" class="text-decoration-none">
                        <?php echo text($filename); ?>
                    </a>
                <?php else: ?>
                    <span class="text-muted"><?php echo text($filename); ?></span>
                <?php endif; ?>
            </td>
            <td class="text-nowrap">
                <?php echo text($this->relativeTime($row->uploadedAt)); ?>
            </td>
            <td><?php echo text($docType); ?></td>
            <td><?php echo text($uploadedBy); ?></td>
            <td class="af-status-cell"><?php echo $statusHtml; ?></td>
            <td class="text-right text-nowrap"><?php echo $deleteBtn; ?></td>
        </tr>
        <?php
    }

    // -------------------------------------------------------------------------
    // Display helpers (pure transformations — no output)
    // -------------------------------------------------------------------------

    private function statusLabel(UploadJobStatus $status): string
    {
        // Six visible labels (mirrors the JS STATUS_PRESENTATION map):
        // Pending and Extracting both surface as "Extracting" — pending
        // is a short-lived intermediate state and the user perceives it
        // as the same in-progress phase.
        return match ($status) {
            UploadJobStatus::Pending,
            UploadJobStatus::Extracting     => xlt('Extracting'),
            UploadJobStatus::ReadyForReview => xlt('Ready for Review'),
            UploadJobStatus::Committed      => xlt('Committed'),
            UploadJobStatus::Rejected       => xlt('Rejected'),
            UploadJobStatus::Failed         => xlt('Failed'),
        };
    }

    private function statusBadgeClass(UploadJobStatus $status): string
    {
        return match ($status) {
            UploadJobStatus::Pending,
            UploadJobStatus::Extracting     => 'badge-info',
            UploadJobStatus::ReadyForReview => 'badge-warning text-dark',
            UploadJobStatus::Committed      => 'badge-success',
            UploadJobStatus::Rejected       => 'badge-dark',
            UploadJobStatus::Failed         => 'badge-danger',
        };
    }

    private function docTypeLabel(string $docType): string
    {
        return match ($docType) {
            'lab_pdf'     => xlt('Lab PDF'),
            'intake_form' => xlt('Intake Form'),
            default       => text($docType),
        };
    }

    private function uploaderDisplay(DocumentInboxRow $row): string
    {
        return $row->uploadedByDisplayName ?? xlt('Unknown');
    }

    private function relativeTime(DateTimeImmutable $dt): string
    {
        // mm-dd-yyyy hh:mm AM/PM, e.g. "05-07-2026 04:01 AM".
        return $dt->format('m-d-Y h:i A');
    }
}
