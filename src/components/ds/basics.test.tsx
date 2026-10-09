// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar } from './avatar';
import { Kbd } from './kbd';
import { Link } from './link';
import { Separator } from './separator';
import { Spinner } from './spinner';
import { StatusIcon } from './status-icon';
import { Tag } from './tag';

describe('basic components', () => {
  it('Link is an anchor in the link color', () => {
    render(<Link href="https://example.com">Docs</Link>);
    const link = screen.getByRole('link', { name: 'Docs' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveClass('text-link');
  });

  it('Kbd renders a keyboard key in the code font', () => {
    render(<Kbd>⌘K</Kbd>);
    const key = screen.getByText('⌘K');
    expect(key.tagName).toBe('KBD');
    expect(key).toHaveClass('font-code');
  });

  it('Spinner says what is happening and marks the part that stops under reduced motion', () => {
    const { container } = render(<Spinner label="Reading 9 files" />);
    expect(screen.getByRole('status')).toHaveTextContent('Reading 9 files');
    expect(container.querySelector('[data-ds-spinner]')).toHaveClass('animate-spin');
  });

  it('Spinner can keep its text for screen readers only', () => {
    render(<Spinner label="Loading" labelHidden />);
    expect(screen.getByText('Loading')).toHaveClass('sr-only');
  });

  // The small spinner sits beside 12px text (a Tag, a row label): its words are that size too.
  it('Spinner sizes its words with the spinner', () => {
    const classes = (text: string) => (screen.getByText(text).getAttribute('class') ?? '').split(/\s+/);
    render(<><Spinner size="sm" label="Checking" /><Spinner label="Loading files" /><Spinner size="lg" label="Starting" /></>);
    expect(classes('Checking')).toContain('text-ui-sm');
    expect(classes('Checking')).not.toContain('text-ui');
    expect(classes('Loading files')).toContain('text-ui');
    expect(classes('Loading files')).not.toContain('text-ui-sm');
    expect(classes('Starting')).toContain('text-ui');
  });

  // The words carry the size. A size on the status element would say nothing about what is shown.
  it('Spinner puts no text size on its status element', () => {
    render(<><Spinner size="sm" label="Checking" /><Spinner label="Loading files" /></>);
    for (const status of screen.getAllByRole('status')) {
      const tokens = (status.getAttribute('class') ?? '').split(/\s+/);
      expect(tokens).not.toContain('text-ui');
      expect(tokens).not.toContain('text-ui-sm');
    }
  });

  // A small spinner that trades places with 13px words (a menu item, a notice, a status row) keeps their size.
  it('Spinner can keep the regular text size beside the small icon', () => {
    const { container } = render(<Spinner size="sm" labelSize="ui" label="Checking" />);
    const tokens = (screen.getByText('Checking').getAttribute('class') ?? '').split(/\s+/);
    expect(tokens).toContain('text-ui');
    expect(tokens).not.toContain('text-ui-sm');
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');
  });

  it.each([
    ['success', 'text-success'],
    ['warning', 'text-warning'],
    ['danger', 'text-danger'],
    ['info', 'text-info'],
  ] as const)('StatusIcon %s pairs its color with a shape', (tone, color) => {
    render(<StatusIcon tone={tone} label={tone} />);
    expect(screen.getByRole('img', { name: tone })).toHaveClass(color);
  });

  it('Tag shows a status icon for status tones and none for neutral', () => {
    const { container } = render(<><Tag tone="warning">Expiring</Tag><Tag>Draft</Tag></>);
    const [warning, neutral] = container.querySelectorAll('span.inline-flex');
    expect(warning).toHaveClass('bg-warning-soft');
    expect(warning.querySelector('svg')).not.toBeNull();
    expect(neutral).toHaveClass('bg-fill');
    expect(neutral.querySelector('svg')).toBeNull();
  });

  it('Tag puts a title and data attributes on its root', () => {
    render(<Tag title="说明" data-testid="t">x</Tag>);
    const root = screen.getByTestId('t');
    expect(root).toHaveAttribute('title', '说明');
    expect(root).toHaveClass('inline-flex');
    expect(root).toHaveTextContent('x');
  });

  it('Avatar falls back to the first character of the name on the brand color', () => {
    render(<Avatar name="shawn" />);
    const fallback = screen.getByRole('img', { name: 'shawn' });
    expect(fallback).toHaveTextContent('S');
    expect(fallback).toHaveClass('bg-brand', 'text-brand-ink');
    // The green belongs to the initial only, so a transparent photo never shows it.
    expect(fallback.parentElement).not.toHaveClass('bg-brand');
  });

  it('Separator is announced only when it is not decorative', () => {
    render(<><Separator /><Separator decorative={false} orientation="vertical" /></>);
    const separators = screen.getAllByRole('separator');
    expect(separators).toHaveLength(1);
    expect(separators[0]).toHaveAttribute('aria-orientation', 'vertical');
  });
});
