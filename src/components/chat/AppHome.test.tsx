// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesignSystemProvider } from '@/components/ds/provider';
import { agentRegistry } from '@/core/agent/registry';
import { redactFailureText } from '@/core/diagnostic/scrub';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import { format, getI18n } from '@/i18n';
import { useAppStore } from '@/stores/appStore';
import type { AppDefinition } from '@/types/app';
import { AppHomeScenes } from './AppHome';

// Who a scene resolves to is the subject of `appRefs`' own tests; here the scene's owner is an
// organization expert that still has to be set up.
vi.mock('@/core/app/appRefs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/app/appRefs')>()),
  resolveRun: vi.fn(() => ({ owner: { status: 'needs-preparation', roleIds: ['enterprise:support'], label: '客服专家' } })),
}));

const templates = [
  { id: 'reply', title: '回复买家', prompt: '帮我回复这位买家：' },
  { id: 'refund', title: '处理退款', prompt: '帮我处理这笔退款：' },
  { id: 'review', title: '回应差评', prompt: '帮我回应这条差评：' },
];
const shop: AppDefinition = {
  appId: 'enterprise-app:shop', name: '店铺运营', version: '1.0.0', origin: { kind: 'enterprise' }, plugins: [],
  config: {
    ...DEFAULT_APP_CONFIG,
    home: { modes: { items: [{ modeId: 'service', title: '客服', scenes: [{ id: 'support', title: '客服回复', run: { expert: 'enterprise:support' }, templates }] }] } },
  },
};
const HOST_REASON = 'GET https://console.example.test/api/skills?token=abc123secret answered 403';

describe('AppHomeScenes', () => {
  beforeEach(() => {
    useAppStore.setState({ expandedSceneIdByApp: { [shop.appId]: 'support' }, selectedModeIdByApp: {} });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useAppStore.setState({ expandedSceneIdByApp: {}, selectedModeIdByApp: {} });
  });

  describe('a scene whose organization expert cannot be set up', () => {
    it('says so in plain words with what to do, and sends the host\'s reason to the console only', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const prepare = vi.spyOn(agentRegistry, 'prepareManagedAgent').mockRejectedValue(new Error(HOST_REASON));
      render(<AppHomeScenes app={shop} visible />, { wrapper: DesignSystemProvider });

      fireEvent.click(screen.getByTestId('app-home-template-reply'));

      const status = await screen.findByTestId('app-home-preparing');
      await waitFor(() => expect(status).toHaveAttribute('data-state', 'failed'));
      expect(status).toHaveTextContent(format(getI18n().appHome.scenePrepareFailed, { name: '客服专家' }));
      expect(status.textContent).toBe(format(getI18n().appHome.scenePrepareFailed, { name: '客服专家' }));
      expect(document.body.innerHTML).not.toContain('console.example.test');
      expect(prepare).toHaveBeenCalledExactlyOnceWith('enterprise:support');
      expect(redactFailureText(HOST_REASON)).not.toContain('abc123secret');
      expect(warn).toHaveBeenCalledExactlyOnceWith('[app] prepare scene failed:', redactFailureText(HOST_REASON));
    });
  });
});
