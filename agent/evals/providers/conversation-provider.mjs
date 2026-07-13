/**
 * Multi-turn conversation provider for promptfoo.
 *
 * Reads `vars.turns` (array of { question, mode?, encounter_id? }), POSTs each
 * turn to /chat in order, threads the conversation_id from each response into
 * the next request, and returns a JSON-stringified bundle so assertions can
 * inspect the full transcript objectively.
 *
 * Output schema (output is JSON.stringify of this):
 *   {
 *     conversation_id: string | null,
 *     tools_used: string[],          // unique tool names cited across all turns
 *     tools_per_turn: string[][],    // unique tool names cited per turn
 *     turns: Array<{
 *       question: string,
 *       mode: 'previsit' | 'followup',
 *       sse: string,                 // raw SSE body for this turn
 *       summary_text: string,
 *       claims: Array<{ text: string, citation_ids: string[], severity: string, section?: string }>,
 *       has_done: boolean,
 *       conversation_id: string | null,
 *       anchor: string | null,
 *     }>
 *   }
 */

const SSE_CLAIM_RE = /event: claim\ndata: (\{[^\n]+\})/g;
const SSE_CONV_RE = /event: conversation\ndata: (\{[^\n]+\})/;
const SSE_SUMMARY_RE = /event: summary\ndata: (\{[^\n]+\})/;
const TOOL_CITATION_RE = /tool:([a-z_]+):row-/g;

function parseTurn(sse) {
  let conversation_id = null;
  let anchor = null;
  const convMatch = sse.match(SSE_CONV_RE);
  if (convMatch) {
    try {
      const parsed = JSON.parse(convMatch[1]);
      conversation_id = parsed.conversation_id ?? null;
      anchor = parsed.anchor ?? null;
    } catch {}
  }

  let summary_text = '';
  const sumMatch = sse.match(SSE_SUMMARY_RE);
  if (sumMatch) {
    try {
      summary_text = JSON.parse(sumMatch[1]).text ?? '';
    } catch {}
  }

  const claims = [];
  for (const m of sse.matchAll(SSE_CLAIM_RE)) {
    try {
      claims.push(JSON.parse(m[1]));
    } catch {}
  }

  const tools = new Set();
  for (const m of sse.matchAll(TOOL_CITATION_RE)) {
    tools.add(m[1]);
  }

  return {
    conversation_id,
    anchor,
    summary_text,
    claims,
    tools: [...tools],
    has_done: sse.includes('event: done'),
  };
}

export default class ConversationProvider {
  constructor(options = {}) {
    this.providerId = options.id || 'agentforge-conversation';
    this.config = options.config ?? {};
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    const baseUrl = this.config.url || process.env.AGENT_BASE_URL || 'http://localhost:3030';
    const jwt = process.env.EVAL_JWT;
    if (!jwt) {
      return { error: 'EVAL_JWT env var not set' };
    }

    const turns = context?.vars?.turns;
    if (!Array.isArray(turns) || turns.length === 0) {
      return { error: 'vars.turns must be a non-empty array' };
    }

    let conversationId = null;
    const turnRecords = [];
    const toolsPerTurn = [];
    const toolsUsed = new Set();

    for (const turn of turns) {
      const body = {
        question: turn.question,
        conversation_id: conversationId,
        encounter_id: turn.encounter_id ?? null,
        mode: turn.mode || 'followup',
      };

      let sse = '';
      try {
        const res = await fetch(`${baseUrl}/chat`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        sse = await res.text();
      } catch (err) {
        return { error: `fetch failed on turn '${turn.question}': ${err.message}` };
      }

      const parsed = parseTurn(sse);
      if (parsed.conversation_id) conversationId = parsed.conversation_id;

      toolsPerTurn.push(parsed.tools);
      for (const t of parsed.tools) toolsUsed.add(t);

      turnRecords.push({
        question: turn.question,
        mode: turn.mode || 'followup',
        sse,
        summary_text: parsed.summary_text,
        claims: parsed.claims,
        has_done: parsed.has_done,
        conversation_id: parsed.conversation_id,
        anchor: parsed.anchor,
      });
    }

    return {
      output: JSON.stringify({
        conversation_id: conversationId,
        tools_used: [...toolsUsed],
        tools_per_turn: toolsPerTurn,
        turns: turnRecords,
      }),
    };
  }
}
