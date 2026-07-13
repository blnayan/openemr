<?php

/**
 * AgentAuditService — thin wrapper over EventAuditLogger that constrains
 * AgentForge audit entries to a closed catalog of event names. AUDIT.md §3
 * requires every agent action to land in audit_master through the existing
 * EventAuditLogger surface — no parallel audit tables.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\Audit;

use OpenEMR\Common\Logging\EventAuditLogger;

class AgentAuditService
{
    public const EVENT_CHAT_START    = 'agentforge:chat:turn:start';
    public const EVENT_CHAT_END      = 'agentforge:chat:turn:end';
    public const EVENT_TOOL_CALL     = 'agentforge:tool:call';
    public const EVENT_TOOL_RESULT   = 'agentforge:tool:result';
    public const EVENT_VERIFY_REJECT = 'agentforge:verify:reject';
    public const EVENT_RESPONSE      = 'agentforge:response';
    public const EVENT_ACL_DENIED    = 'agentforge:acl:denied';
    public const EVENT_UPLOAD_START  = 'agentforge:upload:start';
    public const EVENT_UPLOAD_DONE   = 'agentforge:upload:done';
    public const EVENT_UPLOAD_FAIL   = 'agentforge:upload:fail';

    public function __construct(
        private readonly EventAuditLogger $logger,
    ) {
    }

    public function logEvent(
        string $event,
        string $user,
        string $groupname,
        bool $success,
        string $comments,
        int $pid,
    ): void {
        $this->logger->newEvent(
            $event,
            $user,
            $groupname,
            $success,
            $comments,
            $pid,
            'open-emr',
        );
    }
}
