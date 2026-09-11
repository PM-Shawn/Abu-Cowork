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

  it('uses the released card geometry and keeps the title readable with actions and chips', () => {
    render(<MarketplaceEntryRow testId="card" nameTestId="name" name="long-plugin-name" chips={[<span key="s">未签名</span>]} actions={<button>安装</button>} />);
    const name = screen.getByTestId('name');
    expect(name).toHaveAttribute('title', 'long-plugin-name');
    expect(name.className).toContain('min-w-10');
    expect(screen.getByTestId('card').firstElementChild?.className).toContain('min-h-[120px]');
    expect(screen.getByRole('button', { name: '安装' })).toBeVisible();
    expect(screen.getByText('未签名').closest('.line-clamp-2')).toBeNull();
  });
});
