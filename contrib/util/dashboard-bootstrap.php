<?php

/**
 * One-shot lazy registration of the patient-dashboard SMART OAuth client.
 *
 * Wired via php.ini's `auto_prepend_file`, so this runs at the start of
 * every PHP request the apache child handles. The file_exists() short
 * circuits in O(1) once registration has succeeded, so steady-state cost
 * is a single stat() per request.
 *
 * Why this exists: register_dashboard_client.php must run after MySQL is
 * reachable AND auto_configure.php has populated sqlconf.php. The
 * container's CMD wrapper can't easily wait on both — but by the time
 * apache is serving a PHP request, both are guaranteed true. Hooking on
 * the first request is the simplest race-free trigger.
 *
 * Recovery semantics:
 *  - /tmp clears on every container restart, so a fresh container always
 *    re-runs registration (which upserts — safe). This is intentional:
 *    if OPENEMR_PUBLIC_URL changes between deploys, the new value gets
 *    written without manual intervention.
 *  - On failure, the lock dir is removed via a shutdown hook so the next
 *    request retries instead of being permanently wedged.
 *  - Wrapped in try/catch — auto_prepend errors would break every PHP
 *    response, which is unacceptable.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Nayan Bhut <nayanbhut03@gmail.com>
 * @copyright Copyright (c) 2026 Nayan Bhut
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

// Skip when invoked from CLI — register_dashboard_client.php is itself a
// CLI script, and triggering this prepend during its run would recurse.
if (PHP_SAPI === 'cli') {
    return;
}

try {
    $flag = '/tmp/.openemr-dashboard-registered';
    if (@file_exists($flag)) {
        return;
    }

    // mkdir is atomic — only the first concurrent request wins. The rest
    // see the lock and bail; they'll re-check the flag on the next request.
    $lock = $flag . '.lock';
    if (@mkdir($lock, 0700, true) === false) {
        return;
    }

    // Always release the lock on shutdown so a crash mid-registration
    // doesn't permanently wedge subsequent requests.
    register_shutdown_function(static function () use ($lock): void {
        @rmdir($lock);
    });

    $script = '/var/www/localhost/htdocs/openemr/contrib/util/register_dashboard_client.php';
    $output = @shell_exec('php ' . escapeshellarg($script) . ' 2>&1');

    if (is_string($output)
        && (strpos($output, 'Inserted') !== false || strpos($output, 'Updated') !== false)
    ) {
        @file_put_contents($flag, date('c') . "\n" . $output);
    }
} catch (\Throwable $e) {
    // Never let an auto_prepend error escape — it would 500 every PHP
    // request the apache child handles.
}
