import { describe, it, expect } from 'vitest';
import type { Root } from 'mdast';
import { createMarkdownSplitter, parseMarkdown, type MarkdownBlock, type MarkdownSplit } from './markdownBlocks';

/** Feeds `text` to a splitter in pieces of `step` characters and returns every result. */
function stream(text: string, step: number, parse: (text: string) => Root = parseMarkdown): MarkdownSplit[] {
  const split = createMarkdownSplitter(parse);
  const results: MarkdownSplit[] = [];
  for (let end = step; end < text.length + step; end += step) results.push(split(text.slice(0, Math.min(end, text.length))));
  return results;
}

function blocksOf(result: MarkdownSplit): readonly MarkdownBlock[] {
  if (result.mode !== 'blocks') throw new Error('expected a block split');
  return result.blocks;
}

/** What a block renders: its source, or for a code block its language, text and whether it is open. */
function rendered(block: MarkdownBlock): string {
  return block.code ? `code(${block.code.lang},${block.code.open}):${block.code.value}` : block.source;
}

const REPLY = [
  '# 标题',
  '',
  '第一段，带 **加粗** 与 `code`。',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '  第二项的续段',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```ts',
  'const a = 1;',
  '',
  'const b = 2;',
  '```',
  '',
  '> 引用',
  '> 第二行',
  '',
  'Setext 标题',
  '===',
  '',
  '最后一段。',
].join('\n');

describe('createMarkdownSplitter', () => {
  describe('block boundaries', () => {
    it.each([1, 7, 64])('streamed in steps of %i, ends with the blocks of a one-shot split', (step) => {
      const streamed = stream(REPLY, step).at(-1)!;
      const once = createMarkdownSplitter(parseMarkdown)(REPLY);
      expect(blocksOf(streamed).map(rendered)).toEqual(blocksOf(once).map(rendered));
    });

    it('gives every block the reply text from the previous block on, so the blocks add up to the reply', () => {
      for (const result of stream(REPLY, 5)) {
        const blocks = blocksOf(result);
        const joined = blocks.map((block) => block.source).join('');
        expect(REPLY.startsWith(joined)).toBe(true);
      }
    });

    it('keys a block by where it starts, so the key survives the block freezing', () => {
      const results = stream(REPLY, 3);
      const firstKeys = new Map<number, string>();
      for (const result of results) {
        for (const block of blocksOf(result)) {
          const seen = firstKeys.get(block.key);
          if (seen === undefined) firstKeys.set(block.key, REPLY.slice(block.key, block.key + 4));
          else expect(REPLY.slice(block.key, block.key + 4)).toBe(seen);
        }
      }
    });
  });

  describe('parse volume', () => {
    it('parses a long reply a bounded number of times over, not once per chunk', () => {
      const reply = Array.from({ length: 400 }, (_, i) => `第 ${i} 段，带一些 **强调** 的文字与 \`code\`。`).join('\n\n');
      let parsed = 0;
      const counting = (text: string) => {
        parsed += text.length;
        return parseMarkdown(text);
      };
      stream(reply, 20, counting);
      expect(reply.length).toBeGreaterThan(10_000);
      expect(parsed).toBeLessThan(reply.length * 8);
    });

    it('does not parse an unclosed fence again while it grows', () => {
      const code = Array.from({ length: 300 }, (_, i) => `const value${i} = ${i};`).join('\n');
      const reply = `前文\n\n\`\`\`ts\n${code}`;
      let parsed = 0;
      const counting = (text: string) => {
        parsed += text.length;
        return parseMarkdown(text);
      };
      const results = stream(reply, 16, counting);
      expect(parsed).toBeLessThan(reply.length * 3);
      const last = blocksOf(results.at(-1)!).at(-1)!;
      expect(last.code).toEqual({ lang: 'ts', value: code, open: true });
    });
  });

  describe('unclosed fence', () => {
    it('gives the same fence text as a parse of the same reply at every step', () => {
      const reply = '说明\n\n```python\ndef f():\n    return 1\n\n\nprint(f())\n';
      const results = stream(reply, 1);
      results.forEach((result, index) => {
        const prefix = reply.slice(0, index + 1);
        const once = blocksOf(createMarkdownSplitter(parseMarkdown)(prefix)).map(rendered);
        expect(blocksOf(result).map(rendered)).toEqual(once);
      });
    });

    it('closes the fence when its closing line arrives', () => {
      const split = createMarkdownSplitter(parseMarkdown);
      split('```ts\nconst a = 1;\n');
      const closed = blocksOf(split('```ts\nconst a = 1;\n```\n\n后文'));
      expect(closed.some((block) => block.code?.open)).toBe(false);
      expect(closed[0].code).toEqual({ lang: 'ts', value: 'const a = 1;', open: false });
      expect(closed.at(-1)!.source).toContain('后文');
    });

    it('keeps a fence that names an inner fence open', () => {
      const split = createMarkdownSplitter(parseMarkdown);
      split('````md\n');
      const blocks = blocksOf(split('````md\n```ts\nx\n```\n'));
      expect(blocks.at(-1)!.code).toEqual({ lang: 'md', value: '```ts\nx\n```', open: true });
    });

    it('parses a fence written with carriage returns, keeping its text as the parser reads it', () => {
      const reply = '说明\r\n\r\n```ts\r\nconst a = 1;\r\nconst b = 2;\r\n';
      const results = stream(reply, 3);
      const once = blocksOf(createMarkdownSplitter(parseMarkdown)(reply)).map(rendered);
      expect(blocksOf(results.at(-1)!).map(rendered)).toEqual(once);
    });
  });

  describe('display math', () => {
    it.each([
      ['$$\nE = mc', true],
      ['\\[\na + b', true],
      ['$$\nE = mc^2\n$$', false],
      ['\\[a + b\\]', false],
    ])('marks %j as pending: %s', (reply, pending) => {
      const blocks = blocksOf(createMarkdownSplitter(parseMarkdown)(`前文\n\n${reply}`));
      expect(blocks.at(-1)!.pendingMath !== undefined).toBe(pending);
    });

    it('sets an unfinished formula apart from a reply that renders as one document', () => {
      const split = createMarkdownSplitter(parseMarkdown);
      split('See [docs][d].\n\n[d]: https://example.com\n\n');
      const reply = 'See [docs][d].\n\n[d]: https://example.com\n\n$$\n\\frac{a}{';
      expect(split(reply)).toEqual({ mode: 'whole', pendingMath: { start: reply.indexOf('$$'), tex: '\\frac{a}{' } });
      expect(split(`${reply}b}\n$$`)).toEqual({ mode: 'whole', pendingMath: null });
    });
  });

  describe('reference definitions and footnotes', () => {
    it.each([
      ['See [docs][d].\n\nMore.\n\n[d]: https://example.com'],
      ['Claim[^1].\n\nMore.\n\n[^1]: Source.'],
    ])('renders %j as one document from the moment the definition arrives', (reply) => {
      const results = stream(reply, 4);
      const firstWhole = results.findIndex((result) => result.mode === 'whole');
      expect(firstWhole).toBeGreaterThan(0);
      expect(results.slice(firstWhole).every((result) => result.mode === 'whole')).toBe(true);
    });
  });

  describe('text that is not an append', () => {
    it('starts over when the reply is rewritten', () => {
      const split = createMarkdownSplitter(parseMarkdown);
      split('第一段\n\n第二段\n\n第三段\n\n第四段');
      const rewritten = blocksOf(split('改写后的第一段\n\n第二段'));
      expect(rewritten.map((block) => block.source)).toEqual(['改写后的第一段', '\n\n第二段']);
    });

    it('starts over from a definition-holding reply that is rewritten without it', () => {
      const split = createMarkdownSplitter(parseMarkdown);
      expect(split('a\n\n[d]: https://example.com').mode).toBe('whole');
      expect(split('b').mode).toBe('blocks');
    });
  });
});
