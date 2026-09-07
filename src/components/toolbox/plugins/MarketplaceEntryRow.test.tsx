// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import MarketplaceEntryRow from './MarketplaceEntryRow';

/**
 * The row is shared by the OSS 插件 市场 and the enterprise organization
 * catalog, so what it guarantees is a CONTRACT, not one panel's styling:
 * every slot reaches the DOM, and the title line can never lay the name out
 * at 0px the way the old 240px card grid did (see `ToolCard.test.tsx`).
 * jsdom has no layout engine, so the width invariant is pinned as the
 * mechanism that produces it; the visible proof lives in the Electron E2E.
 */
describe('MarketplaceEntryRow', () => {
  it('renders every slot it is given, under the testids it is given', () => {
    render(
      <MarketplaceEntryRow
        testId="row"
        nameTestId="row-name"
        name="abu-prd-doctor"
        description="A plugin that reviews PRDs."
        chips={[<span key="a">未签名</span>, <span key="b">组织审核</span>]}
        meta="1 个技能 · 0 个连接器 · 最新 v1.0.0"
        icon={<span data-testid="row-icon">📦</span>}
        actions={<button type="button">安装</button>}
      />,
    );

    const row = screen.getByTestId('row');
    expect(screen.getByTestId('row-name')).toHaveTextContent('abu-prd-doctor');
    expect(row).toHaveTextContent('A plugin that reviews PRDs.');
    expect(row).toHaveTextContent('未签名');
    expect(row).toHaveTextContent('组织审核');
    expect(row).toHaveTextContent('1 个技能 · 0 个连接器 · 最新 v1.0.0');
    expect(screen.getByTestId('row-icon')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '安装' })).toBeInTheDocument();
  });

  it('omits the optional lines entirely rather than rendering empty ones', () => {
    render(<MarketplaceEntryRow testId="row" name="bare" />);
    expect(screen.getByTestId('row').querySelectorAll('p')).toHaveLength(0);
  });

  it('keys the chips itself, so a caller can pass a plain array', () => {
    // No key on either element — React would warn if the row did not wrap them.
    render(
      <MarketplaceEntryRow testId="row" name="n" chips={[<span>a</span>, <span>b</span>]} />,
    );
    expect(screen.getByTestId('row')).toHaveTextContent('ab');
  });

  it('lets the chips wrap instead of squeezing the name off the title line', () => {
    render(
      <MarketplaceEntryRow
        testId="row"
        nameTestId="row-name"
        name="abu-prd-doctor"
        chips={[<span key="a">未签名</span>]}
        actions={<button type="button">安装</button>}
      />,
    );

    const name = screen.getByTestId('row-name');
    const titleLine = name.parentElement!;
    // The chips are the name's siblings on this line, and the line wraps: a
    // chip that does not fit costs a line, never the name's width.
    expect(titleLine.className).toContain('flex-wrap');
    expect(name.parentElement).toBe(screen.getByText('未签名').parentElement);
    // `flex-basis: auto` (i.e. NOT `flex-1`) is what lets a long name claim the
    // whole line and push the chips down; `flex-1`'s 0% basis would leave the
    // name whatever the chips did not take — the 0px bug all over again.
    expect(name.className).not.toContain('flex-1');
    expect(name.className).toContain('min-w-0');
    expect(name.className).toContain('truncate');
    // Truncation is only ever the last resort, and it stays readable on hover.
    expect(name.getAttribute('title')).toBe('abu-prd-doctor');

    // The action is outside the flexible content column and never shrinks.
    const actionWrapper = screen.getByRole('button', { name: '安装' }).parentElement!;
    expect(actionWrapper.className).toContain('shrink-0');
    expect(name.closest('[data-testid="row"]')!.querySelector('.min-w-0.flex-1')).toBe(
      titleLine.parentElement,
    );
  });
});
