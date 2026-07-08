import { createDocReference, type ChatReference } from '@/types/chatReference';
import type { SelectionSource, SelectionSourceContext } from './SelectionSource';

const TEXT_CAP = 8000;
const CONTEXT_CAP = 500;

/** 向上找最近的块级元素，取其 textContent 作为「所在段落」上下文 */
function nearestBlockText(node: Node | null): string {
  const BLOCK = new Set(['P', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV']);
  let el: HTMLElement | null =
    node && node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
  while (el) {
    if (BLOCK.has(el.tagName)) return el.textContent ?? '';
    el = el.parentElement;
  }
  return '';
}

function cap(s: string, n: number): string {
  // Total length (including the ellipsis) stays within `n`.
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Build a reference from a captured Range. Prefer this over `extract(Selection)`
 * whenever the reference is created after a UI interaction (e.g. opening a
 * comment box): a Range keeps its boundaries and `.toString()` even after the
 * live `window.getSelection()` collapses when a textarea steals focus, so this
 * still yields the originally-selected text. Returns null for empty ranges.
 */
export function extractFromRange(range: Range, ctx: SelectionSourceContext): ChatReference | null {
  const text = range.toString().trim();
  if (!text) return null;
  const context = nearestBlockText(range.startContainer).trim();
  return createDocReference({
    path: ctx.path,
    name: ctx.name,
    docType: 'markdown',
    text: cap(text, TEXT_CAP),
    context: context ? cap(context, CONTEXT_CAP) : undefined,
  });
}

export const markdownSelectionSource: SelectionSource = {
  docType: 'markdown',
  extract(sel, ctx) {
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    return extractFromRange(sel.getRangeAt(0), ctx);
  },
};
