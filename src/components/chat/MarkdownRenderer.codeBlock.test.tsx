// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
import MarkdownRenderer from './MarkdownRenderer';

const renderInProvider = (ui: ReactElement) => render(<DesignSystemProvider>{ui}</DesignSystemProvider>);

const writeText = vi.fn(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  writeText.mockClear();
});

const CODE_BLOCK = ['```typescript', 'const answer: number = 42;', 'export function read() { return answer; }', '```'].join('\n');

describe('MarkdownRenderer code block', () => {
  it('paints the code area with the code surface token', () => {
    const { container } = renderInProvider(<MarkdownRenderer content={CODE_BLOCK} />);
    const codeArea = container.querySelector<HTMLElement>('div[style*="--ds-code"]');
    expect(codeArea).not.toBeNull();
    expect(codeArea?.style.background).toBe('var(--ds-code)');
  });

  it('colors keywords from the syntax tokens', () => {
    const { container } = renderInProvider(<MarkdownRenderer content={CODE_BLOCK} />);
    const keyword = [...container.querySelectorAll<HTMLElement>('span')].find((span) => span.textContent === 'const');
    expect(keyword).toBeDefined();
    expect(keyword?.style.color).toBe('var(--ds-syntax-keyword)');
  });

  it('keeps the copy button findable by name before and after copying', async () => {
    renderInProvider(<MarkdownRenderer content={CODE_BLOCK} />);
    const copy = screen.getByRole('button', { name: 'Copy' });
    fireEvent.click(copy);
    await act(async () => { await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith('const answer: number = 42;\nexport function read() { return answer; }');
    const copied = screen.getByRole('button', { name: 'Copy' });
    expect(copied).toHaveClass('text-success');
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(screen.getByRole('button', { name: 'Copy' })).not.toHaveClass('text-success');
  });

  it('names the save button with the save-as label', () => {
    renderInProvider(<MarkdownRenderer content={CODE_BLOCK} />);
    expect(screen.getByRole('button', { name: 'Save as' })).toBeInTheDocument();
  });
});

describe('MarkdownRenderer inline content', () => {
  it('sets inline code in the code font at the inline size on the code surface', () => {
    const { container } = renderInProvider(<MarkdownRenderer content={'Run `npm test` now'} />);
    const code = container.querySelector('code');
    expect(code).toHaveClass('text-code-inline');
    expect(code).toHaveClass('font-code');
    expect(code).toHaveClass('bg-code');
  });

  it('renders links with the link color in a new window', () => {
    renderInProvider(<MarkdownRenderer content={'[x](https://example.com)'} />);
    const link = screen.getByRole('link', { name: 'x' });
    expect(link).toHaveClass('text-link');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('sets body text, headings and table cells in the chat type scale', () => {
    const content = ['# One', '## Two', '### Three', '', 'Body text', '', '| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
    const { container } = renderInProvider(<MarkdownRenderer content={content} />);
    expect(container.querySelector('h1')).toHaveClass('text-h1');
    expect(container.querySelector('h2')).toHaveClass('text-h2');
    expect(container.querySelector('h3')).toHaveClass('text-h3');
    expect(container.querySelector('p')).toHaveClass('text-body');
    expect(container.querySelector('p')).toHaveClass('text-label');
    expect(container.querySelector('thead')).toHaveClass('bg-code');
    expect(container.querySelector('td')).toHaveClass('border-separator');
  });

  it('names a citation badge with its number and source title', () => {
    const onCitationClick = vi.fn();
    renderInProvider(
      <MarkdownRenderer
        content={'See the report [1].'}
        searchResults={[{ title: 'Annual report', url: 'https://example.com/r', snippet: '' }]}
        onCitationClick={onCitationClick}
      />,
    );
    const badge = screen.getByRole('button', { name: '[1] Annual report' });
    expect(badge).not.toHaveAttribute('title');
    fireEvent.click(badge);
    expect(onCitationClick).toHaveBeenCalledWith(1);
  });
});
