import type { Nodes, Root, RootContent } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { REMARK_PLUGINS } from './markdownPlugins';

// While a reply streams, re-parsing all of it for every chunk costs time that grows
// with its length (about 4 ms per KB). CommonMark block structure is decided line by
// line, and appended text can only reshape the last top-level block, so every block
// but the trailing two is final: the splitter keeps those as they are and re-parses
// only the text after them. Each block is then rendered by itself and skipped while
// its source does not change.

/** Trailing top-level blocks that are parsed again on every update. */
const UNSTABLE_TAIL_BLOCKS = 2;

export interface MarkdownBlock {
  /** Start offset of the block in the reply, stable while the reply grows. */
  key: number;
  /** The reply's text from the end of the previous block to the end of this one. */
  source: string;
  /**
   * Set on a top-level code block. The renderer draws it straight from these
   * fields whether or not its closing fence has arrived, so the elements it
   * renders into survive the fence closing.
   */
  code?: { lang: string | null; value: string; open: boolean };
  /** The TeX of a display formula at the end of the reply whose closing delimiter has not arrived. */
  pendingMath?: string;
}

export type MarkdownSplit =
  | { mode: 'blocks'; blocks: readonly MarkdownBlock[] }
  // A reference-style link definition or a footnote resolves across the whole
  // reply, so a reply that has one renders as one document; an unfinished
  // display formula at its end is set apart from it.
  | { mode: 'whole'; pendingMath: { start: number; tex: string } | null };

const processor = unified().use(remarkParse).use(REMARK_PLUGINS);

/** Parses with the renderer's own plugins, so block boundaries match what it renders. */
export function parseMarkdown(text: string): Root {
  return processor.parse(text);
}

function offsetsOf(node: RootContent): { start: number; end: number } {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) throw new Error(`markdown block without a position: ${node.type}`);
  return { start, end };
}

function holdsDefinition(node: Nodes): boolean {
  if (node.type === 'definition' || node.type === 'footnoteDefinition') return true;
  return 'children' in node && node.children.some(holdsDefinition);
}

const CLOSED_DISPLAY_MATH = /(?:\$\$|\\\])[ \t]*$/;

/** A `$$` or `\[` block whose closing delimiter has not arrived. */
function isPendingDisplayMath(source: string): boolean {
  return /^(?:\$\$|\\\[)/.test(source) && !CLOSED_DISPLAY_MATH.test(source.trimEnd().slice(2));
}
const OPENING_FENCE = /^(`{3,}|~{3,})([^\n]*)\n/;

interface OpenFence {
  /** Index of the fence in the blocks returned with it. */
  index: number;
  marker: string;
  /** Absolute offset where the fence's content starts (after the opening line). */
  contentStart: number;
  /** Absolute offset of the first line no closing fence has been looked for in. */
  scannedLineStart: number;
  lang: string | null;
}

function isClosingFence(line: string, marker: string): boolean {
  const trimmed = line.replace(/^ {0,3}/, '');
  let run = 0;
  while (trimmed[run] === marker[0]) run += 1;
  return run >= marker.length && /^[ \t]*$/.test(trimmed.slice(run));
}

/** Whether `text`, read from a line start, holds a line that could close the fence. */
function mayCloseFence(text: string, marker: string): boolean {
  return text.split('\n').some((line) => isClosingFence(line, marker));
}

export function createMarkdownSplitter(parse: (text: string) => Root): (content: string) => MarkdownSplit {
  let previous = '';
  let result: MarkdownSplit = { mode: 'blocks', blocks: [] };
  let frozen: MarkdownBlock[] = [];
  let frozenEnd = 0;
  let openFence: OpenFence | null = null;

  const reset = () => {
    previous = '';
    frozen = [];
    frozenEnd = 0;
    openFence = null;
    result = { mode: 'blocks', blocks: [] };
  };

  /** Grows an unclosed fence by the appended text, or returns null when the text may close it. */
  const extendOpenFence = (content: string): MarkdownSplit | null => {
    if (!openFence || result.mode !== 'blocks') return null;
    if (mayCloseFence(content.slice(openFence.scannedLineStart), openFence.marker)) return null;
    const blocks = [...result.blocks];
    const fence = blocks[openFence.index];
    const value = content.slice(openFence.contentStart).replace(/\n$/, '');
    blocks[openFence.index] = {
      ...fence,
      source: fence.source + content.slice(previous.length),
      code: { lang: openFence.lang, value, open: true },
    };
    openFence.scannedLineStart = content.lastIndexOf('\n') + 1;
    return { mode: 'blocks', blocks };
  };

  /**
   * Marks the reply's last block as an unfinished display formula or an unclosed
   * fence; for a fence, returns what the fast path needs to grow it.
   */
  const describeTail = (
    content: string,
    node: RootContent,
    start: number,
    end: number,
    block: MarkdownBlock,
  ): Omit<OpenFence, 'index'> | null => {
    if (node.type === 'math') {
      if (isPendingDisplayMath(content.slice(start, end))) block.pendingMath = node.value;
      return null;
    }
    if (!block.code) return null;
    const source = content.slice(start, end);
    const opening = OPENING_FENCE.exec(source);
    if (!opening) return null;
    const contentStart = start + opening[0].length;
    if (mayCloseFence(content.slice(contentStart), opening[1])) return null;
    block.code.open = true;
    // Only an unindented fence keeps its text verbatim, which the fast path relies on;
    // a carriage return would stay in the slice where the parser drops it.
    if ((start > 0 && content[start - 1] !== '\n') || content.slice(end).trim() !== '' || source.includes('\r')) return null;
    return {
      marker: opening[1],
      contentStart,
      scannedLineStart: content.lastIndexOf('\n') + 1,
      lang: block.code.lang,
    };
  };

  /** One document: parsed whole on each update, only to find an unfinished formula at its end. */
  const whole = (content: string): MarkdownSplit => {
    const last = parse(content).children.at(-1);
    if (last?.type !== 'math') return { mode: 'whole', pendingMath: null };
    const { start, end } = offsetsOf(last);
    return {
      mode: 'whole',
      pendingMath: isPendingDisplayMath(content.slice(start, end)) ? { start, tex: last.value } : null,
    };
  };

  return (content: string) => {
    if (content === previous) return result;
    if (!content.startsWith(previous)) reset();
    if (result.mode === 'whole' && previous !== '') {
      previous = content;
      result = whole(content);
      return result;
    }

    const extended = extendOpenFence(content);
    if (extended) {
      previous = content;
      result = extended;
      return result;
    }

    const tailText = content.slice(frozenEnd);
    const nodes = parse(tailText).children;
    if (nodes.some(holdsDefinition)) {
      previous = content;
      result = whole(content);
      return result;
    }

    const blocks: MarkdownBlock[] = [];
    let tailFence: Omit<OpenFence, 'index'> | null = null;
    let blockStart = frozenEnd;
    for (const [index, node] of nodes.entries()) {
      const offsets = offsetsOf(node);
      const start = frozenEnd + offsets.start;
      const end = frozenEnd + offsets.end;
      const block: MarkdownBlock = { key: start, source: content.slice(blockStart, end) };
      if (node.type === 'code') block.code = { lang: node.lang ?? null, value: node.value, open: false };
      if (index === nodes.length - 1) tailFence = describeTail(content, node, start, end, block);
      blocks.push(block);
      blockStart = end;
    }

    const stable = Math.max(0, blocks.length - UNSTABLE_TAIL_BLOCKS);
    const all = [...frozen, ...blocks];
    openFence = tailFence ? { ...tailFence, index: all.length - 1 } : null;
    if (stable > 0) {
      frozen = [...frozen, ...blocks.slice(0, stable)];
      frozenEnd += offsetsOf(nodes[stable - 1]).end;
    }
    previous = content;
    result = { mode: 'blocks', blocks: all };
    return result;
  };
}
