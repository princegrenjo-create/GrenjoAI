/**
 * Incremental Server-Sent Events framer.
 *
 * The network hands us arbitrary byte boundaries: a frame may arrive split in
 * the middle of a field name, a value, or a CRLF pair. This class keeps the
 * partial line buffered and only emits a frame when its terminating blank line
 * arrives, so one byte at a time and one big chunk produce identical frames.
 *
 * Handled per the SSE event-stream grammar: LF / CRLF / CR line endings,
 * multi-line `data:` fields joined with a newline, `:` comment lines,
 * `event:` and `id:` fields, unknown fields ignored.
 */

export interface SseFrame {
  /** Value of the frame's `event:` field, or null when absent. */
  event: string | null;
  /** All `data:` lines of the frame, joined with "\n". */
  data: string;
}

/** Sentinel OpenAI-compatible providers send as the last frame. */
export const DONE_SENTINEL = '[DONE]';

export function isDoneFrame(frame: SseFrame): boolean {
  return frame.data === DONE_SENTINEL;
}

interface LineBoundary {
  index: number;
  length: number;
}

export class SseFramer {
  private buffer = '';

  private dataLines: string[] = [];

  private eventName: string | null = null;

  /** Feed decoded text; returns every frame completed by this chunk. */
  push(chunk: string): SseFrame[] {
    if (chunk.length === 0) return [];
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const boundary = this.findLineBoundary();
      if (!boundary) break;
      const line = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const frame = this.consumeLine(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /**
   * Flush what is left. A final frame that never got its terminating blank line
   * is still emitted — the data is complete even when the blank line is missing.
   * A truncated trailing line is emitted too; non-JSON data is skipped by the
   * provider parsers, so nothing fabricated reaches the UI.
   */
  end(): SseFrame[] {
    const frames: SseFrame[] = [];
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = '';
      const frame = this.consumeLine(line);
      if (frame) frames.push(frame);
    }
    if (this.dataLines.length > 0) {
      frames.push({ event: this.eventName, data: this.dataLines.join('\n') });
      this.dataLines = [];
      this.eventName = null;
    }
    return frames;
  }

  private findLineBoundary(): LineBoundary | null {
    for (let index = 0; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      if (char === '\n') return { index, length: 1 };
      if (char === '\r') {
        // A trailing CR may be the first half of CRLF: wait for the next chunk.
        if (index === this.buffer.length - 1) return null;
        return { index, length: this.buffer[index + 1] === '\n' ? 2 : 1 };
      }
    }
    return null;
  }

  private consumeLine(rawLine: string): SseFrame | null {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line.length === 0) {
      if (this.dataLines.length === 0) {
        // An empty line without data terminates the frame's event name only.
        this.eventName = null;
        return null;
      }
      const frame: SseFrame = { event: this.eventName, data: this.dataLines.join('\n') };
      this.dataLines = [];
      this.eventName = null;
      return frame;
    }

    if (line.startsWith(':')) return null; // comment / keep-alive

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.eventName = value.length > 0 ? value : null;
    // `id` and `retry` are valid but carry nothing this application needs.
    return null;
  }
}
