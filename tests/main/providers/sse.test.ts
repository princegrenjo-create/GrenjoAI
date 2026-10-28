import { describe, expect, it } from 'vitest';
import { DONE_SENTINEL, SseFramer, isDoneFrame, type SseFrame } from '@main/providers/sse';
import { sliceChunks } from './fake-http';

const BODY = [
  ': keep-alive comment',
  'event: message',
  'data: {"a":1}',
  'id: 7',
  'data: second line',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

function framesOf(chunks: readonly string[]): SseFrame[] {
  const framer = new SseFramer();
  const frames: SseFrame[] = [];
  for (const chunk of chunks) frames.push(...framer.push(chunk));
  frames.push(...framer.end());
  return frames;
}

const EXPECTED: SseFrame[] = [
  { event: 'message', data: '{"a":1}\nsecond line' },
  { event: null, data: DONE_SENTINEL },
];

describe('SseFramer', () => {
  it('parses LF frames, joins multi-line data, ignores comments and id', () => {
    expect(framesOf([BODY])).toEqual(EXPECTED);
  });

  it('parses CRLF bodies identically', () => {
    expect(framesOf([BODY.replace(/\n/g, '\r\n')])).toEqual(EXPECTED);
  });

  it('parses a body with lone CR line terminators', () => {
    expect(framesOf(['data: a\rdata: b\r\r'])).toEqual([{ event: null, data: 'a\nb' }]);
  });

  it('produces identical frames for 1-byte chunks as for one chunk', () => {
    expect(framesOf(sliceChunks(BODY, 1))).toEqual(EXPECTED);
  });

  it('produces identical frames for every two-part split of the body', () => {
    for (let split = 0; split <= BODY.length; split += 1) {
      const frames = framesOf([BODY.slice(0, split), BODY.slice(split)]);
      expect(frames, `split at ${split}`).toEqual(EXPECTED);
    }
  });

  it('does not emit a frame until its terminating blank line arrives', () => {
    const framer = new SseFramer();
    expect(framer.push('data: {"x":1}\n')).toEqual([]);
    expect(framer.push('\n')).toEqual([{ event: null, data: '{"x":1}' }]);
  });

  it('recognises the [DONE] sentinel', () => {
    const frames = framesOf(['data: [DONE]\n\n']);
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame && isDoneFrame(frame)).toBe(true);
  });

  it('skips comment-only frames without emitting an event', () => {
    expect(framesOf([': ping\n\n: pong\n\n'])).toEqual([]);
  });

  it('flushes a final frame that is missing its blank line', () => {
    expect(framesOf(['data: tail'])).toEqual([{ event: null, data: 'tail' }]);
  });

  it('treats a truncated trailing line as data the parser can reject', () => {
    const frames = framesOf(['data: {"partial":']);
    expect(frames).toEqual([{ event: null, data: '{"partial":' }]);
  });

  it('is idempotent at the end of the stream', () => {
    const framer = new SseFramer();
    framer.push('data: one\n\n');
    expect(framer.end()).toEqual([]);
    expect(framer.end()).toEqual([]);
  });

  it('ignores unknown fields such as retry', () => {
    expect(framesOf(['retry: 3000\ndata: x\n\n'])).toEqual([{ event: null, data: 'x' }]);
  });
});
