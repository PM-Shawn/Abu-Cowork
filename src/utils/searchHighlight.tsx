import type { ReactNode } from 'react';

/**
 * Sentinel control characters used to delimit highlighted segments — STX
 * (start-of-text, 0x02) opens a match, ETX (end-of-text, 0x03) closes it.
 * These (not literal `<mark>`/`</mark>` text) are the delimiters because this
 * is a coding-assistant app: conversation titles and message bodies routinely
 * contain literal HTML/markup text, and a literal `<mark>` in content would
 * otherwise be misparsed as a delimiter by `renderMarkedText`. Control chars
 * never occur in normal user-authored text, so they're safe, unambiguous
 * sentinels. The backend (`snippet()` in `src-tauri/src/catalog_db.rs`) uses
 * the same two characters to mark FTS snippet matches.
 */
export const MARK_OPEN = '';
export const MARK_CLOSE = '';

const MARK_SPLIT_RE = new RegExp(`(${MARK_OPEN}|${MARK_CLOSE})`, 'g');

/**
 * Splits `text` on the `MARK_OPEN`/`MARK_CLOSE` sentinel delimiters and
 * returns an array of React nodes, wrapping marked segments in a `<mark>`
 * element.
 *
 * SECURITY: this does NOT parse HTML — it only recognizes the sentinel
 * control characters as delimiters via a plain string split. Any `<`, `>`,
 * `&`, or even literal `<mark>` text in the input (e.g. from message content)
 * is rendered as plain text via React's normal text-node escaping, never
 * interpreted as markup. Do not swap this for `dangerouslySetInnerHTML`.
 */
export function renderMarkedText(text: string, markClassName: string): ReactNode[] {
  if (!text) return [];
  const parts = text.split(MARK_SPLIT_RE);
  const nodes: ReactNode[] = [];
  let marking = false;
  let key = 0;
  for (const part of parts) {
    if (part === MARK_OPEN) {
      marking = true;
      continue;
    }
    if (part === MARK_CLOSE) {
      marking = false;
      continue;
    }
    if (part === '') continue;
    if (marking) {
      nodes.push(
        <mark key={key++} className={markClassName}>
          {part}
        </mark>
      );
    } else {
      nodes.push(part);
    }
  }
  return nodes;
}

/**
 * Wraps every case-insensitive occurrence of `query` in `text` with the
 * `MARK_OPEN`/`MARK_CLOSE` sentinel delimiters, then renders via
 * `renderMarkedText`. Used to highlight the search term inside a conversation
 * title (the backend `snippet()` only targets message body text, not titles —
 * see Phase 1 review note in the FTS5 search spec).
 *
 * Escapes regex metacharacters in `query` so arbitrary user input can't break
 * or hijack the match pattern.
 */
export function highlightQuery(text: string, query: string, markClassName: string): ReactNode[] {
  const trimmed = query.trim();
  if (!trimmed) return [text];
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marked = text.replace(new RegExp(`(${escaped})`, 'gi'), `${MARK_OPEN}$1${MARK_CLOSE}`);
  return renderMarkedText(marked, markClassName);
}
