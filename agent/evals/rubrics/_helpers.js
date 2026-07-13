/**
 * Shared helpers for the deterministic JS rubric assertions used by
 * promptfoo. These rubrics post-process whatever `output` shape the
 * provider returned and normalize it into either an `Answer` object
 * (AnswerSchema-shaped) or a stream-of-events string.
 *
 * Every rubric is pure JS — no LLM judges anywhere. See
 * W2_PRD.md §"Eval gate" and issue 16 for the contract.
 */

/**
 * Try hard to coerce the provider output into an `Answer`-shaped object.
 *
 * Accepts:
 *   - already-parsed object (via context.outputJson or output object)
 *   - JSON string body
 *   - SSE stream containing a single `event: answer\ndata: {...}` block
 *   - SSE stream containing `event: claim\ndata: {...}` lines (UC-1 shape)
 *
 * Returns `null` if no Answer-shape can be located. Callers decide
 * whether the absence is a failure.
 */
export function extractAnswer(output) {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    // Anything carrying an Answer-shape key is a candidate. Returning a
    // partial object lets the downstream Zod parse produce a precise
    // schema error rather than the generic "no payload" reason.
    if ('summary' in output || 'claims' in output) {
      return output;
    }
    if (output.answer && typeof output.answer === 'object') {
      return output.answer;
    }
  }

  if (typeof output !== 'string') return null;

  // Try JSON first.
  const trimmed = output.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        if ('summary' in parsed && 'claims' in parsed) return parsed;
        if (parsed.answer) return parsed.answer;
      }
    } catch {
      // fall through to SSE parsing
    }
  }

  // SSE: look for an `event: answer\ndata: {...}` block.
  const answerMatch = output.match(/event:\s*answer\s*\ndata:\s*({[\s\S]+?})\s*\n/);
  if (answerMatch) {
    try {
      return JSON.parse(answerMatch[1]);
    } catch {
      // continue
    }
  }

  // SSE: assemble from individual claim/section/conversation events.
  const claims = [...output.matchAll(/event:\s*claim\s*\ndata:\s*({[^\n]+})/g)]
    .map(m => safeParse(m[1]))
    .filter(Boolean);
  const summaryMatch = output.match(/event:\s*summary\s*\ndata:\s*({[^\n]+})/);
  const summary = summaryMatch ? safeParse(summaryMatch[1])?.text ?? '' : '';
  const confidenceMatch = output.match(/"confidence"\s*:\s*"(high|medium|low)"/);
  const confidence = confidenceMatch ? confidenceMatch[1] : 'medium';

  if (claims.length > 0 || summary) {
    return {
      summary: summary || '(no summary)',
      claims,
      followup_suggestions: [],
      confidence,
    };
  }

  return null;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Collect every string value that could plausibly carry PHI from a
 * trace-payload tree or response payload. Walks objects/arrays;
 * returns a flat array of strings.
 */
export function collectStrings(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectStrings(v, out);
    return out;
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectStrings(v, out);
  }
  return out;
}

/** Result helper — every rubric returns this exact shape. */
export function pass(reason = 'pass') {
  return { pass: true, score: 1, reason };
}

export function fail(reason) {
  return { pass: false, score: 0, reason };
}
