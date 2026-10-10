// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import type { SearchResult } from '@/types';
import SourcesSection from './SourcesSection';

const RESULTS: SearchResult[] = [
  { title: 'Process model', url: 'https://www.electronjs.org/docs/latest/tutorial/process-model', snippet: '', source: 'www.electronjs.org' },
  { title: 'Context isolation', url: 'https://www.electronjs.org/docs/latest/tutorial/context-isolation', snippet: '', source: 'www.electronjs.org' },
];

beforeEach(() => { initLanguage('en-US'); });
afterEach(() => { cleanup(); });

describe('SourcesSection', () => {
  it('expands from a disclosure header', () => {
    render(<SourcesSection results={RESULTS} />);
    const header = screen.getByRole('button', { name: /Sources/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens each source as an outside link that citations can scroll to', () => {
    render(<SourcesSection results={RESULTS} highlightedIndex={2} />);
    const first = screen.getByRole('link', { name: /Process model/ });
    expect(first).toHaveAttribute('href', RESULTS[0].url);
    expect(first).toHaveAttribute('target', '_blank');
    expect(first).toHaveAttribute('rel', 'noopener noreferrer');
    expect(first).toHaveAttribute('data-source-index', '1');
    expect(first).not.toHaveClass('bg-fill-selected');
    const highlighted = screen.getByRole('link', { name: /Context isolation/ });
    expect(highlighted).toHaveAttribute('data-source-index', '2');
    expect(highlighted).toHaveClass('bg-fill-selected');
  });
});
