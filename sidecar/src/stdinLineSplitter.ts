/**
 * NDJSON framing for this process's stdin.
 *
 * The shell writes one JSON-RPC message per line and terminates it with a
 * single 0x0A byte; the main process frames this process's stdout the same
 * way (electron/sidecarSupervisor.cjs). This splitter cuts the incoming byte
 * stream on 0x0A alone and decodes each finished line as UTF-8 afterwards, so
 * two properties hold:
 *
 *  - a character whose UTF-8 encoding straddles a chunk boundary is decoded
 *    correctly, because the split happens on bytes and the decode always sees
 *    the whole line;
 *  - U+2028 and U+2029, which `JSON.stringify` leaves raw inside a string,
 *    stay inside the line that carries them.
 *
 * Chunks of an unfinished line are collected and concatenated once, when the
 * newline that closes the line arrives, so a line of many megabytes costs one
 * copy rather than one per chunk.
 */

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export interface StdinLineSplitter {
  /** Feed one raw chunk; every line it completes is emitted synchronously. */
  push(chunk: Buffer): void;
  /** The stream ended: emit the trailing line if it had no terminator. */
  end(): void;
}

/** Decode one complete line, dropping the carriage return of a CRLF ending. */
function decodeLine(line: Buffer): string {
  const end = line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN ? line.length - 1 : line.length;
  return line.toString('utf8', 0, end);
}

export function createStdinLineSplitter(onLine: (line: string) => void): StdinLineSplitter {
  let pending: Buffer[] = [];

  /** Join the carried-over chunks with the closing piece and hand the line over. */
  const flush = (tail: Buffer): void => {
    if (pending.length === 0) {
      onLine(decodeLine(tail));
      return;
    }
    const parts = pending;
    pending = [];
    parts.push(tail);
    onLine(decodeLine(Buffer.concat(parts)));
  };

  return {
    push(chunk: Buffer): void {
      if (!Buffer.isBuffer(chunk)) {
        throw new TypeError('stdin chunks must be Buffers — stdin must not be in a string encoding mode');
      }
      let start = 0;
      for (;;) {
        const index = chunk.indexOf(LINE_FEED, start);
        if (index === -1) break;
        flush(chunk.subarray(start, index));
        start = index + 1;
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
    },
    end(): void {
      if (pending.length === 0) return;
      const parts = pending;
      pending = [];
      onLine(decodeLine(parts.length === 1 ? parts[0] : Buffer.concat(parts)));
    },
  };
}
