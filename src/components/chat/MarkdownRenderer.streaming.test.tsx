// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';

// Counts the text each ReactMarkdown render is handed; rendering itself is the real one.
const markdownInputs: string[] = [];
vi.mock('react-markdown', async () => {
  const actual = await vi.importActual<typeof import('react-markdown')>('react-markdown');
  const Counted = (props: Parameters<typeof actual.default>[0]) => {
    markdownInputs.push(String(props.children ?? ''));
    return actual.default(props);
  };
  return { ...actual, default: Counted };
});

const { default: MarkdownRenderer } = await import('./MarkdownRenderer');

const inProvider = (ui: ReactElement) => <DesignSystemProvider>{ui}</DesignSystemProvider>;

/** innerHTML with React's generated ids taken out, so two separately mounted trees compare. */
function markup(element: Element): string {
  return element.innerHTML.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:/g, '');
}

const REPLY = [
  '# 标题',
  '',
  '第一段，带 **加粗**、`code` 与 [链接](https://example.com)。',
  '',
  '1. 第一项',
  '2. 第二项',
  '',
  '   第二项的续段',
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
  '---',
  '',
  '<b>原样显示的标签</b>',
  '',
  '~~删除~~ 与 ~随口~，最后一段。',
].join('\n');

beforeEach(() => {
  markdownInputs.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('MarkdownRenderer while a reply streams', () => {
  it('renders every prefix exactly as a one-shot render of the same text', () => {
    const streamed = render(inProvider(<MarkdownRenderer content="" streaming />));
    for (let end = 9; end < REPLY.length + 9; end += 9) {
      const prefix = REPLY.slice(0, Math.min(end, REPLY.length));
      streamed.rerender(inProvider(<MarkdownRenderer content={prefix} streaming />));
      const once = render(inProvider(<MarkdownRenderer content={prefix} />));
      expect(markup(streamed.container)).toBe(markup(once.container));
      once.unmount();
    }
  });

  it('keeps the elements it streamed into when the reply finishes', () => {
    const { container, rerender } = render(inProvider(<MarkdownRenderer content={REPLY} streaming />));
    const heading = container.querySelector('h1');
    const table = container.querySelector('table');
    rerender(inProvider(<MarkdownRenderer content={REPLY} streaming={false} />));
    expect(container.querySelector('h1')).toBe(heading);
    expect(container.querySelector('table')).toBe(table);
  });

  it('keeps a code block the user expanded expanded when its closing fence arrives', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `const value${i} = ${i};`).join('\n');
    const open = `说明\n\n\`\`\`ts\n${lines}\n`;
    const { container, rerender, getByRole, queryByRole } = render(inProvider(<MarkdownRenderer content={open} streaming />));
    fireEvent.click(getByRole('button', { name: /20/ }));
    const codeArea = container.querySelector('pre');
    rerender(inProvider(<MarkdownRenderer content={`${open}\`\`\`\n\n后文`} streaming />));
    expect(container.querySelector('pre')).toBe(codeArea);
    expect(queryByRole('button', { name: /20/ })).toBeNull();
  });

  it('hands ReactMarkdown text proportional to the reply, not to the reply times its chunks', () => {
    const reply = Array.from({ length: 200 }, (_, i) => `第 ${i} 段，带一些 **强调** 的文字。`).join('\n\n');
    const { rerender } = render(inProvider(<MarkdownRenderer content="" streaming />));
    for (let end = 40; end < reply.length + 40; end += 40) {
      rerender(inProvider(<MarkdownRenderer content={reply.slice(0, end)} streaming />));
    }
    const handed = markdownInputs.reduce((total, input) => total + input.length, 0);
    expect(handed).toBeLessThan(reply.length * 6);
  });

  it('renders a finished reply it never streamed as one document', () => {
    render(inProvider(<MarkdownRenderer content={REPLY} />));
    expect(markdownInputs).toEqual([REPLY]);
  });

  it('renders as one document once a reference definition arrives', () => {
    const reply = 'See [docs][d].\n\nMore.\n\n[d]: https://example.com';
    const { container, rerender } = render(inProvider(<MarkdownRenderer content="See [docs][d]." streaming />));
    rerender(inProvider(<MarkdownRenderer content={reply} streaming />));
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.com');
  });
});

describe('MarkdownRenderer math', () => {
  it('renders $…$, \\(…\\) and a \\[…\\] block with KaTeX', async () => {
    const { container } = render(inProvider(<MarkdownRenderer content={'设 $x$ 与 \\(y\\)：\n\n\\[\nx + y\n\\]'} />));
    await vi.waitFor(() => expect(container.querySelectorAll('.katex')).toHaveLength(3));
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(container.querySelector('pre')).toBeNull();
  });

  it('leaves prices as text', () => {
    const { container } = render(inProvider(<MarkdownRenderer content="价格是 $5，另一件 $10。" />));
    expect(container.textContent).toBe('价格是 $5，另一件 $10。');
    expect(container.querySelector('code')).toBeNull();
  });

  it('renders a ```math fence as a display formula', async () => {
    const { container } = render(inProvider(<MarkdownRenderer content={'```math\na^2 + b^2\n```'} />));
    await vi.waitFor(() => expect(container.querySelector('.katex-display')).not.toBeNull());
  });

  it('keeps inline code as code', () => {
    const { container } = render(inProvider(<MarkdownRenderer content="写成 `$x$` 即可" />));
    expect(container.querySelector('code')?.textContent).toBe('$x$');
  });

  it('shows a display formula as its source until its closing delimiter arrives', async () => {
    const { container, rerender } = render(inProvider(<MarkdownRenderer content={'前文\n\n$$\nE = mc'} streaming />));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('E = mc');
    rerender(inProvider(<MarkdownRenderer content={'前文\n\n$$\nE = mc^2\n$$'} streaming />));
    await vi.waitFor(() => expect(container.querySelector('.katex-display')).not.toBeNull());
  });

  it('shows an unfinished formula as its source in a reply that renders as one document', async () => {
    const head = 'See [docs][d].\n\n[d]: https://example.com\n\n$$ ready $$\n\n';
    const { container, rerender } = render(inProvider(<MarkdownRenderer content={`${head}$$\n\\frac{a}{`} streaming />));
    await vi.waitFor(() => expect(container.querySelectorAll('.katex')).toHaveLength(1));
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.com');
    expect(container.querySelector('.katex-error')).toBeNull();
    expect(container.textContent).toContain('\\frac{a}{');
    const link = container.querySelector('a');
    rerender(inProvider(<MarkdownRenderer content={`${head}$$\n\\frac{a}{b}\n$$`} streaming />));
    await vi.waitFor(() => expect(container.querySelectorAll('.katex-display')).toHaveLength(1));
    expect(container.querySelector('a')).toBe(link);
  });
});
