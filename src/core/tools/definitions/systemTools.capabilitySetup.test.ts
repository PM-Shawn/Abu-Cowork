import { beforeEach, describe, expect, it } from 'vitest';
import { initLanguage } from '../../../i18n';
import { useSettingsStore } from '../../../stores/settingsStore';
import { manageMCPServerTool } from './systemTools';
import {
  drainCapabilitySetupRequests,
  getPendingCapabilitySetup,
  resolveCapabilitySetup,
} from '../../capabilityPlugins/setupBridge';

describe('manage_mcp_server first-party setup', () => {
  beforeEach(() => {
    drainCapabilitySetupRequests();
    initLanguage('en-US');
    useSettingsStore.setState({
      activeSystemTab: 'general',
      capabilitySetupTarget: null,
      systemSettingsOpen: false,
    });
  });

  it('waits for task-local My Chrome setup and resumes the same tool call once', async () => {
    const resultPromise = manageMCPServerTool.execute(
      {
        action: 'open_setup',
        name: 'abu-browser-bridge',
      },
      {
        conversationId: 'conversation-1',
        loopId: 'loop-1',
        toolCallId: 'tool-1',
        interactionMode: 'foreground',
      },
    );

    const request = getPendingCapabilitySetup();
    expect(request).toMatchObject({
      target: 'chrome',
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
    });
    expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);

    resolveCapabilitySetup(request!.id, true);
    await expect(resultPromise).resolves.toContain('connected');
    expect(getPendingCapabilitySetup()).toBeNull();
  });

  it('opens the My Chrome guide without exposing MCP setup to the user', async () => {
    const result = await manageMCPServerTool.execute({
      action: 'open_setup',
      name: 'abu-browser-bridge',
    });

    expect(result).toContain('My Chrome');
    expect(useSettingsStore.getState()).toMatchObject({
      activeSystemTab: 'capabilities',
      capabilitySetupTarget: 'chrome',
      systemSettingsOpen: true,
    });
  });

  it('rejects setup requests for non-first-party servers', async () => {
    const result = await manageMCPServerTool.execute({
      action: 'open_setup',
      name: 'github',
    });

    expect(result).toContain('no Abu capability setup page');
    expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
  });
});
