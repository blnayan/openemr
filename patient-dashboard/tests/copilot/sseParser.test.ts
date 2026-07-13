import { describe, expect, it } from 'vitest';

import { SseFrameParser } from '../../src/copilot/sseParser';

describe('SseFrameParser', () => {
  it('parses a single complete frame', () => {
    const p = new SseFrameParser();
    const frames = p.push('event: summary\ndata: {"text":"hi"}\n\n');
    expect(frames).toEqual([
      { event: 'summary', data: '{"text":"hi"}' },
    ]);
  });

  it('parses multiple frames in one push', () => {
    const p = new SseFrameParser();
    const frames = p.push(
      'event: summary\ndata: {"text":"hi"}\n\n'
        + 'event: claim\ndata: {"text":"a","citation_ids":["x"],"severity":"info"}\n\n'
        + 'event: done\ndata: {}\n\n',
    );
    expect(frames).toHaveLength(3);
    expect(frames[0]?.event).toBe('summary');
    expect(frames[1]?.event).toBe('claim');
    expect(frames[2]?.event).toBe('done');
  });

  it('buffers a frame split across two pushes', () => {
    const p = new SseFrameParser();
    expect(p.push('event: summa')).toEqual([]);
    expect(p.push('ry\ndata: {"text"')).toEqual([]);
    const frames = p.push(':"ok"}\n\n');
    expect(frames).toEqual([
      { event: 'summary', data: '{"text":"ok"}' },
    ]);
  });

  it('handles \\r\\n line endings', () => {
    const p = new SseFrameParser();
    const frames = p.push('event: summary\r\ndata: {"text":"hi"}\r\n\r\n');
    expect(frames).toEqual([
      { event: 'summary', data: '{"text":"hi"}' },
    ]);
  });

  it('skips comment lines', () => {
    const p = new SseFrameParser();
    const frames = p.push(
      ':keep-alive\nevent: summary\ndata: {"text":"hi"}\n\n',
    );
    expect(frames).toEqual([
      { event: 'summary', data: '{"text":"hi"}' },
    ]);
  });

  it('defaults event name to "message" when omitted', () => {
    const p = new SseFrameParser();
    const frames = p.push('data: {"text":"hi"}\n\n');
    expect(frames[0]?.event).toBe('message');
  });

  it('flushes a trailing partial frame', () => {
    const p = new SseFrameParser();
    p.push('event: summary\ndata: {"text":"hi"}');
    const tail = p.flush();
    expect(tail).toEqual({ event: 'summary', data: '{"text":"hi"}' });
  });

  it('flush returns null when buffer is empty', () => {
    const p = new SseFrameParser();
    expect(p.flush()).toBeNull();
  });
});
