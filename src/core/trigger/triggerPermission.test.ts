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

  // A standing "always allow this site" grant makes registry.ts resolve the
  // browser gate to 'allow' without consulting commandConfirmCallback at all,
  // so the read-only tier cannot be enforced by the callback alone — the tools
  // have to be off the table. Otherwise "reads information, changes nothing"
  // silently permits clicking and typing on every site the user ever allowed.
  describe('read_tools browser ceiling', () => {
    it('removes the page-mutating browser tools from a read-only run', () => {
      const { blockedTools } = resolveTriggerCallbacks({ prompt: 'read', capability: 'read_tools' });

      for (const tool of ['click', 'fill', 'select', 'keyboard', 'execute_js']) {
        expect(blockedTools, tool).toContain(`abu-browser__${tool}`);
        expect(blockedTools, tool).toContain(`abu-browser-bridge__${tool}`);
      }
    });

    it('keeps navigate available — "view web pages" is part of the tier', () => {
      const { blockedTools } = resolveTriggerCallbacks({ prompt: 'read', capability: 'read_tools' });

      expect(blockedTools).not.toContain('abu-browser__navigate');
      expect(blockedTools).not.toContain('abu-browser__snapshot');
    });

    it('leaves the higher tiers untouched', () => {
      for (const capability of ['safe_tools', 'full'] as const) {
        const { blockedTools } = resolveTriggerCallbacks({ prompt: 'x', capability });
        expect(blockedTools, capability).not.toContain('abu-browser__click');
      }
    });

    it('applies to a task that predates the capability field (defaults to read_tools)', () => {
      expect(resolveTriggerCallbacks({ prompt: 'x' }).blockedTools).toContain('abu-browser__click');
    });
  });
});
