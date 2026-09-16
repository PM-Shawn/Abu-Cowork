// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
        item={{ ...item, badge: <span>未签名</span>, toggle: <button>安装</button> }}
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
  });
});
