// @vitest-environment happy-dom
/**
 * 「这个应用里有什么」 (product spec §5.2): a plugin that brought an app is
 * worth keeping for its scenes, so the detail lists every mode and scene with
 * whoever runs it — the same names the app home shows, never a team id.
 */

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([]),
  readInstalledResult: vi.fn().mockResolvedValue({ ok: true, plugins: [] }),
  upsertInstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/permissions/pluginToolPolicy', () => ({ setPluginServerNames: vi.fn() }));

import type { InstalledPlugin } from '@/core/plugin/installedStore';
import type { AppConfig } from '@/types/app';
import { useAppStore } from '@/stores/appStore';
import { useTeamStore } from '@/stores/teamStore';
import { initLanguage } from '@/i18n';
import InstalledPluginDetail from './InstalledPluginDetail';

const shop: InstalledPlugin = {
  key: 'shop@official',
  marketplace: 'official',
  name: 'shop',
  version: '1.0.0',
  installedAt: '2026-09-19T00:00:00.000Z',
  contributed: { skills: ['product-listing'], mcpServers: ['shop-api'], agents: [], teams: ['store-ops'] },
};

const config: AppConfig = {
  version: 1,
  defaultRun: { team: 'store-ops' },
  home: {
    modes: {
      items: [{
        modeId: 'sourcing',
        title: { 'zh-CN': '选品', 'en-US': 'Sourcing' },
        scenes: [
          { id: 'shortlist', title: { 'zh-CN': '选品清单', 'en-US': 'Shortlist' }, templates: [] },
          { id: 'listing', title: { 'zh-CN': '写商品页', 'en-US': 'Write the listing' }, run: { skill: 'product-listing' }, templates: [] },
        ],
      }],
    },
  },
};

function renderDetail() {
  render(
    <InstalledPluginDetail home="/Users/tester" plugin={shop} onClose={() => {}} onUninstall={() => {}} />,
  );
}

afterEach(() => {
  useAppStore.setState({ installedApps: [] });
  useTeamStore.setState({ teams: [] });
});

describe('InstalledPluginDetail', () => {
  it('lists the app modes, scenes and whoever runs each one, by name', () => {
    initLanguage('zh-CN');
    useTeamStore.setState({
      teams: [{
        id: 'plugin-team:shop@official/store-ops',
        name: '店铺运营小组',
        leaderRoleId: 'plugin:advisor',
        memberRoleIds: ['plugin:advisor'],
        requirePlanApproval: false,
        createdAt: 0,
      }],
    });
    useAppStore.setState({
      installedApps: [{ appId: shop.key, name: '店铺运营', config, pluginKey: shop.key, pluginVersion: '1.0.0' }],
    });
    renderDetail();

    const block = screen.getByTestId('plugin-detail-app');
    expect(block).toHaveTextContent('选品');
    expect(block).toHaveTextContent('选品清单');
    expect(block).toHaveTextContent('店铺运营小组');
    expect(block).toHaveTextContent('product-listing');
    expect(block.textContent).not.toContain('plugin-team:');
  });

  it('says nothing about an app for a plugin that brought none', () => {
    initLanguage('zh-CN');
    renderDetail();
    expect(screen.queryByTestId('plugin-detail-app')).toBeNull();
  });
});
