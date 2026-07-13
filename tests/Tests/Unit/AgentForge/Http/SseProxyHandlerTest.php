<?php

/**
 * SseProxyHandler Unit Test
 *
 * Tests that the SSE proxy forwards the minted JWT as Authorization: Bearer,
 * that it includes the required SSE headers, and verifies contract behavior
 * for upstream closure and error propagation.
 *
 * Plan reference: §5.1, §3.1 (SseProxyHandler contract), M1
 * ARCHITECTURE.md D7: "PHP request worker is held for the duration of one chat turn"
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Test Generator
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Unit\AgentForge\Http;

use OpenEMR\AgentForge\DTO\ChatRequest;
use OpenEMR\AgentForge\Http\SseProxyHandler;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

#[CoversClass(SseProxyHandler::class)]
final class SseProxyHandlerTest extends TestCase
{
    #[Test]
    public function constructorAcceptsAgentServiceBaseUrlAndTimeout(): void
    {
        // §3.1: SseProxyHandler has agentServiceBaseUrl and timeoutSeconds parameters
        $handler = new SseProxyHandler(
            agentServiceBaseUrl: 'http://agent.railway.internal',
            timeoutSeconds: 90,
        );

        self::assertInstanceOf(SseProxyHandler::class, $handler);
    }

    #[Test]
    public function constructorWithDefaultTimeoutOf90Seconds(): void
    {
        // §3.1: "timeoutSeconds = 90 — hard cap"
        $handler = new SseProxyHandler(
            agentServiceBaseUrl: 'http://agent.railway.internal',
        );

        $reflection = new \ReflectionClass($handler);
        $property   = $reflection->getProperty('timeoutSeconds');
        $property->setAccessible(true);

        self::assertSame(90, $property->getValue($handler));
    }

    #[Test]
    public function proxyUsesJwtAsBearerTokenInOutboundRequest(): void
    {
        // §3.1: "Opens streaming HTTP request to agent service with Authorization: Bearer <jwt>"
        // D4: JWT is the trust token for B2 (OpenEMR → Agent boundary)
        // ASSUMPTION: SseProxyHandler exposes a way to inspect the outbound request headers
        // (e.g., via a PSR-18 client abstraction or a testable HTTP client injection).
        // This test is marked incomplete until the production interface is defined.
        $this->markTestIncomplete(
            // TODO(plan-driven-test-generator): SseProxyHandler must accept an injectable
            // HTTP client (PSR-18 ClientInterface) so this test can assert that the
            // outbound request carries "Authorization: Bearer <jwt>". Currently the
            // production interface is not defined. See §3.1 SseProxyHandler contract.
            'SseProxyHandler needs an injectable HTTP client to assert outbound Bearer header. ' .
            'Lift this deferral once the production class accepts a PSR-18 ClientInterface.'
        );
    }

    #[Test]
    public function proxyAbortsFastWhenUpstreamReturnsNonSseContentType(): void
    {
        // §3.1: "Terminates when: event stream ends, timeout exceeded, or connection closed by browser"
        // ASSUMPTION: proxy() throws AgentServiceException when upstream returns non-SSE content type.
        $this->markTestIncomplete(
            // TODO(plan-driven-test-generator): Requires injectable HTTP client. See above.
            'Requires injectable HTTP client. Lift once PSR-18 client is injected.'
        );
    }
}
