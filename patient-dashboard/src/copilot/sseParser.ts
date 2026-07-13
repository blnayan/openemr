/**
 * Tiny SSE frame parser.
 *
 * We don't take a dep on a full eventsource shim because the dock POSTs
 * its body and consumes the response via `fetch` + `ReadableStream`,
 * which the EventSource API can't do (it's GET-only and cookie-only).
 *
 * Wire format (from `agent/src/routes/chat.ts`):
 *
 *   event: <name>\n
 *   data: <single-line json>\n
 *   \n   ← terminator
 *
 * Each frame fits in a single chunk in practice, but the parser
 * tolerates frames that arrive split across multiple chunks (the
 * accumulator buffers until the `\n\n` terminator is seen).
 *
 * A `data: {}` line with no `event:` is a "message" event in the SSE
 * spec; the AgentForge stream never emits those, but we still surface
 * the event name as `'message'` so the caller can decide what to do.
 */

export interface SseFrame {
  /** The `event:` field, or `'message'` if the frame omitted it. */
  readonly event: string;
  /** The joined `data:` lines (newline-separated if there were several). */
  readonly data: string;
}

export class SseFrameParser {
  private buffer = '';

  /**
   * Push a chunk of raw text into the parser and return any complete
   * frames it now contains. The internal buffer keeps the partial tail
   * across calls so a frame split mid-stream still parses correctly.
   */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];

    // Frames are terminated by a blank line. The `\n\n` form is the
    // canonical one; we also accept `\r\n\r\n` because some HTTP layers
    // rewrite line endings on the way to the browser.
    const terminator = /\r?\n\r?\n/;
    let match: RegExpExecArray | null;
    while ((match = terminator.exec(this.buffer)) !== null) {
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = parseFrame(raw);
      if (frame !== null) {
        frames.push(frame);
      }
    }
    return frames;
  }

  /**
   * Drain any in-buffer content as a final frame, if it's non-empty
   * and structurally a frame. Used when the underlying stream closes
   * without a trailing blank line — rare, but possible if the proxy
   * cuts the connection mid-frame.
   */
  flush(): SseFrame | null {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (remaining === '') return null;
    return parseFrame(remaining);
  }
}

function parseFrame(raw: string): SseFrame | null {
  if (raw.length === 0) return null;
  // Lines starting with `:` are SSE comments — used for keep-alives.
  // Skip them so the data buffer doesn't accumulate junk.
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      // Per the SSE spec, leading single space after `data:` is dropped.
      const v = line.slice('data:'.length);
      dataLines.push(v.startsWith(' ') ? v.slice(1) : v);
      continue;
    }
    // Other field names (id:, retry:) we don't use; ignore them.
  }
  if (dataLines.length === 0) {
    return null;
  }
  return { event, data: dataLines.join('\n') };
}
