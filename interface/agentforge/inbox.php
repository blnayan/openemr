<?php

/**
 * AgentForge Document Inbox page — GET /interface/agentforge/inbox.php
 *
 * Patient-menu entry point for the Document Inbox tab. Renders the
 * three implicit modes (idle / active / reviewing) via
 * {@see \OpenEMR\AgentForge\Controller\DocumentInboxController}.
 *
 * Query parameters (all optional):
 *   mode      — 'idle' (default) | 'active' | 'reviewing'
 *   job_uuid  — upload-job UUID; used in reviewing mode
 *
 * Authorization: `patients/docs` read privilege required.
 *
 * Sets `Cache-Control: private, no-store` before rendering because the
 * history table contains uploader names and filenames (PHI-adjacent per
 * W2_DOCUMENT_INBOX_PRD §"Cache and PHI posture").
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

require_once __DIR__ . '/../globals.php';

use OpenEMR\AgentForge\Controller\DocumentInboxController;
use OpenEMR\Common\Acl\AclMain;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Core\Header;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Menu\PatientMenuRole;
use OpenEMR\OeUI\OemrUI;

// --- Cache / PHI posture ---------------------------------------------------
header('Cache-Control: private, no-store');
header('X-Content-Type-Options: nosniff');

// --- ACL gate ---------------------------------------------------------------
if (!AclMain::aclCheckCore('patients', 'docs')) {
    http_response_code(403);
    echo '<!DOCTYPE html><html><body>' . xlt('Access denied.') . '</body></html>';
    exit;
}

// --- Session / patient binding ---------------------------------------------
$activeSession = SessionWrapperFactory::getInstance()->getActiveSession();
$pidRaw = $activeSession->get('pid');
$pid = is_int($pidRaw) ? $pidRaw
    : (is_string($pidRaw) && ctype_digit($pidRaw) ? (int) $pidRaw : 0);

if ($pid <= 0) {
    http_response_code(400);
    echo '<!DOCTYPE html><html><body>' . xlt('No patient selected.') . '</body></html>';
    exit;
}

// --- Query parameter parsing -----------------------------------------------
// @phpstan-ignore openemr.forbiddenRequestGlobals
$modeRaw = $_GET['mode'] ?? '';
// @phpstan-ignore openemr.forbiddenRequestGlobals
$jobUuidRaw = $_GET['job_uuid'] ?? '';
$modeRaw    = is_string($modeRaw) ? $modeRaw : '';
$jobUuid    = is_string($jobUuidRaw) ? basename($jobUuidRaw) : '';

// --- Web root (used to build absolute-path URLs inside the page) -----------
$webRoot = OEGlobalsBag::getInstance()->getString('webroot');

// --- Page chrome setup (OemrUI pattern used by patient_report.php) ---------
$arrOeUiSettings = [
    'heading_title'        => xl('Document Inbox'),
    'include_patient_name' => true,
    'expandable'           => false,
    'expandable_files'     => [],
    'action'               => '',
    'action_title'         => '',
    'action_href'          => '',
    'show_help_icon'       => false,
    'help_file_name'       => '',
];
$oemr_ui = new OemrUI($arrOeUiSettings);
?>
<!DOCTYPE html>
<html>
<head>
    <title><?php echo xlt('Document Inbox'); ?></title>
    <?php Header::setupHeader(['common']); ?>
    <meta name="patient-id" content="<?php echo attr((string) $pid); ?>">
    <style>
        .border-dashed { border: 2px dashed #ced4da !important; }
        .btn-xs { padding: .125rem .4rem; font-size: .75rem; line-height: 1.5; border-radius: .2rem; }
        #agentforge-document-inbox .badge { font-size: .8em; }
    </style>
</head>
<body>
    <div id="container_div" class="<?php echo $oemr_ui->oeContainer(); ?> mt-3">
        <div class="row">
            <div class="col-sm-12">
                <?php require_once(OEGlobalsBag::getInstance()->getString('include_root') . '/patient_file/summary/dashboard_header.php'); ?>
            </div>
        </div>

        <?php
        $list_id = 'document_inbox'; // marks the active nav item
        $menuPatient = new PatientMenuRole();
        $menuPatient->displayHorizNavBarMenu();
        ?>

        <?php
        $controller = DocumentInboxController::default();
        $controller->render(
            patientId: $pid,
            modeRaw:   $modeRaw,
            jobUuid:   $jobUuid,
            webRoot:   $webRoot,
        );
        ?>

    </div><!-- end container_div -->
</body>
</html>
