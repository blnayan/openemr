<?php

/**
 * AgentForge sidebar launch handshake
 *
 * The AgentForge web component (`public/assets/agentforge/agent-sidebar.js`)
 * mounts a hidden iframe at `/interface/agentforge/oauth/launch.php` on
 * `connectedCallback` and waits for an `agentforge:smart-ready` postMessage
 * before letting the user submit a chat. Without this endpoint the iframe
 * 404s and the sidebar's `_ensureSmartLaunched` timeout fires after 15s,
 * which surfaces as "Co-Pilot unavailable" and chat is never sent.
 *
 * This file is a minimal handshake stub: it gates on the same ACL as
 * `chat.php`, then emits an HTML document whose inline script posts the
 * ready message back to the parent. No tokens, no redirect dance, no
 * OAuth — the actual auth/mint work happens in `chat.php` per request.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

// SMART iframe loads may arrive without the parent page's session cookie
// (SameSite rules can strip PHPSESSID for iframe requests). Without a site
// in session AND no ?site= in the URL, globals.php returns 400 "Site ID is
// missing from session data!" before our ACL check ever runs. Pin the site
// explicitly so the ACL check below is what actually gates the response.
$_GET['site'] = $_GET['site'] ?? 'default';

require_once __DIR__ . '/../../globals.php';

use OpenEMR\Common\Acl\AclMain;

if (!AclMain::aclCheckCore('patients', 'demo')) {
    http_response_code(403);
    exit;
}

header('Content-Type: text/html; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');
// Only allow the OpenEMR frontend itself to embed this iframe — prevents an
// attacker page from probing login state by iframing this URL from their site.
header("Content-Security-Policy: frame-ancestors 'self'");

?><!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>AgentForge launch</title></head>
<body>
<script>
// Target the parent's exact origin instead of '*'. Defense-in-depth:
// the page is only ever loaded same-origin, but pinning the target
// stops the ready event from leaking if an attacker embeds this URL
// (the frame-ancestors header above already blocks that, but we're not
// relying on a single layer).
window.parent.postMessage({type: 'agentforge:smart-ready'}, window.location.origin);
</script>
</body>
</html>
