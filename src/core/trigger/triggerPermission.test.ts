import { describe, expect, it } from 'vitest';
import { resolveTriggerCallbacks } from './triggerPermission';

describe('resolveTriggerCallbacks', () => {
  it('carries a custom trigger tool whitelist to the agent run', () => {
    const callbacks = resolveTriggerCallbacks({
      prompt: 'read only',
      capability: 'custom',
      permissions: { allowedTools: ['read_*', 'http_fetch'] },
    });

    expect(callbacks.allowedTools).toEqual(['read_*', 'http_fetch']);
    expect(callbacks.blockedTools).toContain('request_workspace');
  });

  it('does not create a whitelist for the predefined capability levels', () => {
    expect(resolveTriggerCallbacks({ prompt: 'safe', capability: 'safe_tools' }).allowedTools).toBeUndefined();
  });
});
