// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/ds/button';
import SourceBadge from './SourceBadge';
import ToolCard from './ToolCard';

/**
 * The card's NAME ROW is a width negotiation, and it went wrong once in a way
 * nothing caught: the name was the only flexible item between two `shrink-0`
 * groups, so a caller that filled the badge and the action (the organization
 * plugin catalog: 未签名 + 组织审核 + 安装, in a ~240px grid column) left the
 * title exactly 0px wide. It was still in the DOM with its full text, so every
 * DOM-level assertion passed while the user — and Playwright — saw nothing.
 *
 * jsdom has no layout engine, so the invariant cannot be measured here; the
 * real proof is tests/e2e/plugin-enterprise-install.spec.ts, which asserts the
 * plugin name is VISIBLE in a real Electron window. What this pins instead is
 * the mechanism that produces it, so a future edit cannot quietly take the
 * floor away or make the action the thing that gives:
 *   name   — flexible, but with a minimum width, so it truncates not vanishes
 *   badge  — the only shrinkable item, and clipped rather than overflowing
 *   toggle — never shrinks: it is the action
 */
describe('ToolCard name row width priority', () => {
  const item = { id: 'p', name: 'abu-prd-doctor', description: 'd' };

  it('keeps a minimum width for the name so it can never collapse to nothing', () => {
    render(<ToolCard item={item} />);

    const name = screen.getByTitle('abu-prd-doctor');
    expect(name.className).toContain('flex-1');
    // The floor. `min-w-0` here is what let the name reach 0px.
    expect(name.className).toContain('min-w-10');
    expect(name.className).not.toContain('min-w-0');
    expect(name.className).toContain('truncate');
  });

  it('makes the badge the item that yields, and never the action', () => {
    render(
      <ToolCard
        item={{ ...item, badge: <span>未签名</span>, toggle: <Button>安装</Button> }}
      />,
    );

    const badgeWrapper = screen.getByText('未签名').parentElement!;
    expect(badgeWrapper.className).toContain('shrink');
    expect(badgeWrapper.className).not.toContain('shrink-0');
    // Without min-w-0 a flex item cannot shrink below its content.
    expect(badgeWrapper.className).toContain('min-w-0');
    expect(badgeWrapper.className).toContain('overflow-hidden');

    const toggleWrapper = screen.getByRole('button', { name: '安装' }).parentElement!;
    expect(toggleWrapper.className).toContain('shrink-0');
  });

  it('names itself in `title` so a truncated name is still readable on hover', () => {
    render(<ToolCard item={item} />);
    expect(screen.getByTitle('abu-prd-doctor').textContent).toBe('abu-prd-doctor');
  });

  it('opens on click and on Enter, but not on a keypress inside a nested control', async () => {
    const onClick = vi.fn();
    render(
      <ToolCard
        item={{ ...item, toggle: <span data-testid="switch" tabIndex={0} /> }}
        onClick={onClick}
      />,
    );

    const card = screen.getByRole('button', { name: /abu-prd-doctor/ });
    await userEvent.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);

    card.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);

    // A keydown on the nested control bubbles to the card; it must not open it
    // on top of whatever that control just did.
    screen.getByTestId('switch').focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);

    // Space opens it as well, like any button.
    card.focus();
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(3);
  });
});

describe('ToolCard shell', () => {
  const item = { id: 'p', name: 'abu-prd-doctor', description: 'd', testId: 'card' };
  const classes = (el: HTMLElement) => el.className.split(/\s+/);

  it('is a flat card: panel corners, a separator line, the surface fill, one fixed height', () => {
    render(<ToolCard item={item} />);
    const card = screen.getByTestId('card');
    expect(classes(card)).toContain('rounded-panel');
    expect(classes(card)).toContain('border-separator');
    expect(classes(card)).toContain('bg-surface');
    expect(classes(card)).toContain('h-30');
    expect(card.className).not.toContain('clay');
  });

  it('is a keyboard target with a focus ring and a hover fill when it opens something', () => {
    render(<ToolCard item={item} onClick={vi.fn()} />);
    const card = screen.getByTestId('card');
    expect(card).toHaveAttribute('role', 'button');
    expect(card).toHaveAttribute('tabindex', '0');
    expect(card.tagName).toBe('DIV');
    expect(classes(card)).toContain('rounded-panel');
    expect(classes(card)).toContain('focus-visible:ring-focus');
    expect(classes(card)).toContain('hover:bg-fill-hover');
  });

  it('has no role, no tab stop and no hover fill when it opens nothing', () => {
    render(<ToolCard item={item} />);
    const card = screen.getByTestId('card');
    expect(card).not.toHaveAttribute('role');
    expect(card).not.toHaveAttribute('tabindex');
    expect(classes(card)).not.toContain('hover:bg-fill-hover');
  });

  it('grows with a footer and keeps the footer at the bottom', () => {
    render(<ToolCard item={{ ...item, footer: <span>Footer line</span> }} />);
    const card = screen.getByTestId('card');
    expect(classes(card)).toContain('min-h-30');
    expect(classes(card)).not.toContain('h-30');
    expect(classes(screen.getByText('Footer line').parentElement!)).toContain('mt-auto');
  });

  it('shows the default mark when the caller gives no avatar', () => {
    render(<ToolCard item={item} />);
    expect(screen.getByTestId('card')).toHaveTextContent('🤖');
  });
});

describe('SourceBadge', () => {
  it('shows a plugin source as a neutral tag whose full text is readable on hover', () => {
    render(<SourceBadge source={{ kind: 'plugin', plugin: 'Weather Pack' }} />);
    const badge = screen.getByTestId('source-badge');
    expect(badge).toHaveAttribute('data-source-kind', 'plugin');
    const text = badge.querySelector('[title]')!;
    expect(text.getAttribute('title')).toBe(badge.textContent);
    expect(badge.textContent).toContain('Weather Pack');
    expect(text.className.split(/\s+/)).toContain('truncate');
    // The design-system tag: neutral fill, control corners.
    expect(text.parentElement!.className.split(/\s+/)).toContain('bg-fill');
    expect(text.parentElement!.className.split(/\s+/)).toContain('rounded-control');
  });

  it('labels the organization source and draws nothing for the user\'s own items', () => {
    const { rerender } = render(<SourceBadge source={{ kind: 'enterprise' }} />);
    expect(screen.getByTestId('source-badge')).toHaveAttribute('data-source-kind', 'enterprise');
    rerender(<SourceBadge source={{ kind: 'user' }} />);
    expect(screen.queryByTestId('source-badge')).toBeNull();
  });
});
