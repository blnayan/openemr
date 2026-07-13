<?php

/**
 * setup_system_client.php — idempotent registration of the SMART backend-
 * services OAuth client the AgentForge sidecar uses for system-level FHIR
 * access.
 *
 * Why a *system* client (and not the bot user / password grant on master)?
 *   - No human-style username/password to rotate or audit-trail incorrectly.
 *   - Asymmetric auth: the sidecar signs an RS384 client_assertion JWT with
 *     a private key it owns; OpenEMR validates it against the public JWK
 *     stored on the client row. Compromising the OpenEMR DB does NOT
 *     compromise the credential.
 *   - Avoids a bcrypt round-trip on every token refresh — the bottleneck
 *     in the password-grant flow.
 *
 * What this script provisions / repairs (idempotent — safe to re-run):
 *   1. `oauth_clients` row keyed by `client_name` (default
 *      "AgentForge System (backend services)") with:
 *        - client_role = 'system'
 *        - grant_types = 'client_credentials'
 *        - scope       = system/{Patient,Condition,Observation,
 *                        MedicationRequest,AllergyIntolerance,Encounter}.read
 *        - is_confidential = 1
 *        - is_enabled      = 1
 *        - client_secret   = NULL (asymmetric auth, no shared secret)
 *        - jwks            = <contents of --jwks-file>
 *
 * Flags:
 *   --jwks-file=PATH    Path (inside the container) to the JWKS JSON file.
 *                       Required on first run. Re-runs with a different file
 *                       rotate the public key.
 *   --client-name=NAME  Client name used as the upsert key. Default:
 *                       "AgentForge System (backend services)".
 *   --site=default      OpenEMR site id.
 *   --quiet             Suppress non-essential output.
 *
 * On success the script prints the client_id to stdout (regardless of
 * --quiet) — copy it into agent/.env.local under OPENEMR_FHIR_CLIENT_ID.
 *
 * Exit codes:
 *   0  success
 *   1  bad input (missing --jwks-file on first run, malformed JWKS)
 *   2  unexpected DB failure
 *
 * Example:
 *   docker compose exec openemr \
 *     php contrib/agentforge/setup_system_client.php \
 *       --jwks-file=/var/www/localhost/htdocs/openemr/agent/secrets/jwks.json
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("This script is CLI only.\n");
}

$opts = getopt('', ['jwks-file::', 'client-name::', 'site::', 'quiet']);
$jwksFile = isset($opts['jwks-file']) && $opts['jwks-file'] !== '' && $opts['jwks-file'] !== false
    ? (string) $opts['jwks-file']
    : null;
$clientName = isset($opts['client-name']) && $opts['client-name'] !== '' && $opts['client-name'] !== false
    ? (string) $opts['client-name']
    : 'AgentForge System (backend services)';
$site = isset($opts['site']) && $opts['site'] !== '' && $opts['site'] !== false
    ? (string) $opts['site']
    : 'default';
$quiet = isset($opts['quiet']);

// Read-and-validate the JWKS *before* bootstrapping OpenEMR so we fail fast.
//
// Three input paths, in priority order:
//   1. --jwks-file=PATH         (local dev — file on disk)
//   2. OPENEMR_AGENTFORGE_JWKS_JSON env (Railway — raw JSON string in env)
//   3. None — error if no existing row found at upsert time
//
// Env-var path lets us register the system client from auto_configure.php
// on every fresh container boot without bundling the JWKS file into the
// openemr build context (where it would be a stray static credential).
$jwksJson = null;
if ($jwksFile !== null) {
    if (!is_readable($jwksFile)) {
        fwrite(STDERR, "Error: --jwks-file '$jwksFile' is not readable.\n");
        exit(1);
    }
    $jwksJson = file_get_contents($jwksFile);
    if ($jwksJson === false) {
        fwrite(STDERR, "Error: failed to read --jwks-file '$jwksFile'.\n");
        exit(1);
    }
} else {
    $envJwks = getenv('OPENEMR_AGENTFORGE_JWKS_JSON');
    if ($envJwks !== false && $envJwks !== '') {
        $jwksJson = $envJwks;
    }
}
if ($jwksJson !== null) {
    $decoded = json_decode($jwksJson, true);
    if (
        !is_array($decoded)
        || !isset($decoded['keys'])
        || !is_array($decoded['keys'])
        || count($decoded['keys']) === 0
    ) {
        fwrite(STDERR, "Error: JWKS source is not a valid JWKS (missing 'keys' array).\n");
        exit(1);
    }
}

// Stable client_id: when OPENEMR_FHIR_CLIENT_ID is set on the openemr
// service (mirroring what the AgentForge sidecar uses), re-use it on every
// upsert. Without this every fresh DB install (auto_configure rebuilds the
// schema) generates a new random client_id and the agent's env var goes
// stale, surfacing as 400 invalid_client at the token endpoint.
$envClientId = getenv('OPENEMR_FHIR_CLIENT_ID');
$envClientId = ($envClientId !== false && $envClientId !== '') ? (string) $envClientId : null;

$_GET['site'] = $site;
$ignoreAuth = true;
require_once __DIR__ . '/../../interface/globals.php';

use OpenEMR\Common\Utils\HttpUtils;

function out(string $msg, bool $quiet): void
{
    if (!$quiet) {
        fwrite(STDOUT, $msg . "\n");
    }
}

// Read-only system scopes that mirror what the master/password-grant flow
// requested as user/*.read. Trim if the sidecar's needs ever shrink.
$scopes = implode(' ', [
    'system/Patient.read',
    'system/Condition.read',
    'system/Observation.read',
    'system/MedicationRequest.read',
    'system/AllergyIntolerance.read',
    'system/Encounter.read',
]);

$existing = sqlQueryNoLog(
    'SELECT client_id FROM oauth_clients WHERE client_name = ? LIMIT 1',
    [$clientName]
);

if ($existing && !empty($existing['client_id'])) {
    $existingId = (string) $existing['client_id'];
    // Re-run path: refresh the columns we manage. Specifically: re-set the
    // JWKS if a fresh file was supplied (key rotation), pin the
    // grant_types / scope / role / enabled flags in case they drifted, and
    // rotate client_id to the env-supplied value if it differs (so the
    // sidecar's pinned OPENEMR_FHIR_CLIENT_ID always wins).
    $clientId = $envClientId ?? $existingId;
    $sets = ['client_role = ?', 'grant_types = ?', 'scope = ?', 'is_confidential = 1', 'is_enabled = 1', 'client_secret = NULL'];
    $vals = ['system', 'client_credentials', $scopes];
    if ($clientId !== $existingId) {
        $sets[] = 'client_id = ?';
        $vals[] = $clientId;
    }
    if ($jwksJson !== null) {
        $sets[] = 'jwks = ?';
        $vals[] = $jwksJson;
    }
    $vals[] = $existingId;
    sqlStatement(
        'UPDATE oauth_clients SET ' . implode(', ', $sets) . ' WHERE client_id = ?',
        $vals
    );
    out("[=] oauth_clients: existing client '$clientName' updated (client_id=$clientId)", $quiet);
} else {
    if ($jwksJson === null) {
        fwrite(STDERR, "Error: JWKS source is required on first run (set --jwks-file or OPENEMR_AGENTFORGE_JWKS_JSON env).\n");
        exit(1);
    }
    // Use env-supplied id when available (stable across DB re-inits); fall
    // back to a random id matching OpenEMR's own ClientRepository format.
    $clientId = $envClientId ?? HttpUtils::base64url_encode(random_bytes(32));
    sqlStatement(
        'INSERT INTO oauth_clients ('
        . ' client_id, client_role, client_name, client_secret, register_date,'
        . ' redirect_uri, grant_types, scope, site_id, is_confidential,'
        . ' jwks_uri, jwks, is_enabled, dsi_type'
        . ') VALUES (?, ?, ?, NULL, NOW(), ?, ?, ?, ?, 1, NULL, ?, 1, 0)',
        [
            $clientId,
            'system',
            $clientName,
            '', // redirect_uri unused for client_credentials
            'client_credentials',
            $scopes,
            $site,
            $jwksJson,
        ]
    );
    out("[+] oauth_clients: inserted client '$clientName' (client_id=$clientId)", $quiet);
}

// Verify final state and print a summary.
$row = sqlQueryNoLog(
    'SELECT client_id, client_role, grant_types, is_enabled, is_confidential, scope FROM oauth_clients WHERE client_id = ?',
    [$clientId]
);

out('---', $quiet);
out('AgentForge system OAuth client registered.', $quiet);
out('  client_id        = ' . ($row['client_id'] ?? 'null'), $quiet);
out('  client_role      = ' . ($row['client_role'] ?? 'null'), $quiet);
out('  grant_types      = ' . ($row['grant_types'] ?? 'null'), $quiet);
out('  is_enabled       = ' . ($row['is_enabled'] ?? 'null'), $quiet);
out('  is_confidential  = ' . ($row['is_confidential'] ?? 'null'), $quiet);
out('  scope            = ' . ($row['scope'] ?? 'null'), $quiet);

// Always print the client_id on its own line (even with --quiet) so callers
// can capture it: `CID=$(php setup_system_client.php ... | tail -n1 | awk ...)`.
fwrite(STDOUT, "\nOPENEMR_FHIR_CLIENT_ID=" . $clientId . "\n");
fwrite(STDOUT, "Copy this into agent/.env.local under OPENEMR_FHIR_CLIENT_ID.\n");
