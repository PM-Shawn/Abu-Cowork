import { beforeEach, describe, expect, it } from 'vitest';
import { resolveTriggerCallbacks } from './triggerPermission';
import { matchesToolName } from '../skill/toolFilter';
import { checkReadPath, checkWritePath, revokeWorkspace } from '../tools/pathSafety';

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

  // b4ce62e8 closed this hole on the scheduler side and its own note flagged
  // the trigger path as still open: `authorizeWorkspace(path)` defaults to
  // read+write, and an authorized workspace short-circuits `checkWritePath`
  // inside registry.ts BEFORE `filePermissionCallback` is consulted — so the
  // read-only callback below never gets a say about writes into the trigger's
  // own workspace.
  describe('workspace pre-authorization follows the tier', () => {
    const WS = '/Users/testuser/Projects/trigger-ws';

    beforeEach(() => {
      revokeWorkspace(WS);
    });

    it('read_tools authorizes its workspace read-only — writes inside it stay blocked', async () => {
      resolveTriggerCallbacks({ prompt: 'read', capability: 'read_tools', workspacePath: WS });

      expect((await checkReadPath(`${WS}/notes.md`)).allowed).toBe(true);
      expect((await checkWritePath(`${WS}/evil.sh`)).allowed).toBe(false);
    });

    it('a trigger with no capability field (defaults to read_tools) gets the same read-only grant', async () => {
      resolveTriggerCallbacks({ prompt: 'read', workspacePath: WS });

      expect((await checkWritePath(`${WS}/evil.sh`)).allowed).toBe(false);
    });

    it('safe_tools and full still get read+write in their workspace', async () => {
      for (const capability of ['safe_tools', 'full'] as const) {
        revokeWorkspace(WS);
        resolveTriggerCallbacks({ prompt: 'x', capability, workspacePath: WS });
        expect((await checkWritePath(`${WS}/out.txt`)).allowed, capability).toBe(true);
      }
    });
  });

  // A standing "always allow this site" grant makes registry.ts resolve the
  // browser gate to 'allow' without consulting commandConfirmCallback at all,
  // so the read-only tier cannot be enforced by the callback alone — the tools
  // have to be off the table. read_tools carries no browser capability at all
  // (a user correction reversed the earlier design that kept `navigate`
  // available for "view web pages") — the rule is now one sentence: the
  // read-only tier has no browser access, period.
  describe('read_tools browser ceiling', () => {
    it('blocks every browser-automation tool via a namespace wildcard — including navigate and read-only tools', () => {
      const { blockedTools } = resolveTriggerCallbacks({ prompt: 'read', capability: 'read_tools' });

      // click/fill/select/keyboard/execute_js/navigate are the enumerated
      // STATE_CHANGING_TOOLS; snapshot/screenshot/get_tabs stand in for the
      // read-only tools this module never enumerates (they're registered
      // dynamically by the browser servers) — the wildcard has to catch
      // those too, not just the known state-changing set.
      for (const tool of ['click', 'fill', 'select', 'keyboard', 'execute_js', 'navigate', 'snapshot', 'screenshot', 'get_tabs']) {
        expect(blockedTools.some((p) => matchesToolName(`abu-browser__${tool}`, p)), tool).toBe(true);
        expect(blockedTools.some((p) => matchesToolName(`abu-browser-bridge__${tool}`, p)), tool).toBe(true);
      }
    });

    it('leaves the higher tiers untouched', () => {
      for (const capability of ['safe_tools', 'full'] as const) {
        const { blockedTools } = resolveTriggerCallbacks({ prompt: 'x', capability });
        expect(blockedTools.some((p) => matchesToolName('abu-browser__click', p)), capability).toBe(false);
        expect(blockedTools.some((p) => matchesToolName('abu-browser__navigate', p)), capability).toBe(false);
      }
    });

    it('applies to a task that predates the capability field (defaults to read_tools)', () => {
      const { blockedTools } = resolveTriggerCallbacks({ prompt: 'x' });
      expect(blockedTools.some((p) => matchesToolName('abu-browser__click', p))).toBe(true);
    });
  });
});
