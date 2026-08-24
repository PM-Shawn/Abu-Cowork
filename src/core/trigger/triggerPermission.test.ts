import { beforeEach, describe, expect, it } from 'vitest';
import { resolveTriggerCallbacks } from './triggerPermission';
import { matchesToolName } from '../skill/toolFilter';
import {
  authorizeWorkspace,
  checkReadPath,
  checkWritePath,
  createAuthorizationScope,
  disposeAuthorizationScope,
  revokeWorkspace,
} from '../tools/pathSafety';
import { usePermissionStore } from '../../stores/permissionStore';

describe('resolveTriggerCallbacks', () => {
  function resolveForTest(action: Parameters<typeof resolveTriggerCallbacks>[0]) {
    const scopeId = createAuthorizationScope();
    const callbacks = resolveTriggerCallbacks(action, { authorizationScopeId: scopeId });
    return {
      callbacks,
      scopeId,
      dispose: () => disposeAuthorizationScope(scopeId),
    };
  }

  it('carries a custom trigger tool whitelist to the agent run', () => {
    const { callbacks, dispose } = resolveForTest({
        prompt: 'read only',
        capability: 'custom',
        permissions: { allowedTools: ['read_*', 'http_fetch'] },
      });
    try {
      expect(callbacks.allowedTools).toEqual(['read_*', 'http_fetch']);
      expect(callbacks.blockedTools).toContain('request_workspace');
    } finally {
      dispose();
    }
  });

  it('caps safe_tools at a shared positive roster while leaving full unrestricted', () => {
    const safe = resolveForTest({ prompt: 'safe', capability: 'safe_tools' });
    const full = resolveForTest({ prompt: 'full', capability: 'full' });
    try {
      expect(safe.callbacks.allowedTools).not.toContain('run_command');
      expect(safe.callbacks.allowedTools).toContain('write_file');
      expect(safe.callbacks.allowedTools).not.toContain('manage_mcp_server');
      expect(full.callbacks.allowedTools).toBeUndefined();
    } finally {
      safe.dispose();
      full.dispose();
    }
  });

  it('fails closed for source-invalid persisted capabilities', () => {
    const { callbacks, dispose } = resolveForTest({ prompt: 'read', capability: 'chat_only' as never });
    try {
      expect(callbacks.allowedTools).toContain('read_file');
      expect(callbacks.allowedTools).not.toContain('run_command');
      expect(callbacks.blockedTools.some((p) => matchesToolName('abu-browser__navigate', p))).toBe(true);
    } finally {
      dispose();
    }
  });

  it('fails closed for malformed persisted custom arrays without throwing matchers', async () => {
    const malformedTools = resolveForTest({
      prompt: 'custom',
      capability: 'custom',
      permissions: { allowedTools: [42] as never },
    });
    const malformedCommands = resolveForTest({
      prompt: 'custom',
      capability: 'custom',
      permissions: { allowedCommands: [42] as never },
    });
    try {
      const allowedTools = malformedTools.callbacks.allowedTools ?? [];
      expect(allowedTools.some((p) => matchesToolName('read_file', p))).toBe(false);
      await expect(malformedCommands.callbacks.commandConfirmCallback({
        command: 'npm run build',
        level: 'safe',
        reason: 'safe',
      })).resolves.toBe(false);
    } finally {
      malformedTools.dispose();
      malformedCommands.dispose();
    }
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
      const { scopeId, dispose } = resolveForTest({ prompt: 'read', capability: 'read_tools', workspacePath: WS });

      try {
        expect((await checkReadPath(`${WS}/notes.md`, scopeId)).allowed).toBe(true);
        expect((await checkWritePath(`${WS}/evil.sh`, scopeId)).allowed).toBe(false);
      } finally {
        dispose();
      }
    });

    it('a trigger with no capability field (defaults to read_tools) gets the same read-only grant', async () => {
      const { scopeId, dispose } = resolveForTest({ prompt: 'read', workspacePath: WS });

      try {
        expect((await checkWritePath(`${WS}/evil.sh`, scopeId)).allowed).toBe(false);
      } finally {
        dispose();
      }
    });

    it('safe_tools and full still get read+write in their workspace', async () => {
      for (const capability of ['safe_tools', 'full'] as const) {
        revokeWorkspace(WS);
        const { scopeId, dispose } = resolveForTest({ prompt: 'x', capability, workspacePath: WS });
        try {
          expect((await checkWritePath(`${WS}/out.txt`, scopeId)).allowed, capability).toBe(true);
        } finally {
          dispose();
        }
      }
    });

    it('read_tools uses its run scope instead of inheriting a standing global write grant', async () => {
      const scopeId = createAuthorizationScope();
      authorizeWorkspace(WS, ['read', 'write']);
      try {
        resolveTriggerCallbacks(
          { prompt: 'read', capability: 'read_tools', workspacePath: WS },
          { authorizationScopeId: scopeId },
        );

        expect((await checkReadPath(`${WS}/notes.md`, scopeId)).allowed).toBe(true);
        expect((await checkWritePath(`${WS}/evil.sh`, scopeId)).allowed).toBe(false);
        expect((await checkWritePath(`${WS}/interactive.md`)).allowed).toBe(true);
      } finally {
        disposeAuthorizationScope(scopeId);
        revokeWorkspace(WS);
      }
    });
  });

  describe('run-scoped file callbacks do not import standing global grants', () => {
    beforeEach(() => {
      usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {}, pendingRequest: null });
    });

    it('read_tools refuses a globally granted read outside its declared workspace', async () => {
      const path = '/Users/testuser/Desktop/trigger-read-only.md';
      const { callbacks, scopeId, dispose } = resolveForTest({
        prompt: 'read',
        capability: 'read_tools',
        workspacePath: '/Users/testuser/Projects/trigger-read-workspace',
      });
      usePermissionStore.getState().grantPermission(path, ['read'], 'session');

      try {
        await expect(callbacks.filePermissionCallback({
          path,
          capability: 'read',
          toolName: 'read_file',
        })).resolves.toBe(false);

        expect((await checkReadPath(path, scopeId)).allowed).toBe(false);
      } finally {
        dispose();
        revokeWorkspace(path);
        usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {}, pendingRequest: null });
      }
    });

    it('safe_tools refuses a globally granted path outside its declared workspace', async () => {
      const path = '/Users/testuser/Desktop/trigger-safe-read.md';
      const { callbacks, scopeId, dispose } = resolveForTest({
        prompt: 'safe',
        capability: 'safe_tools',
        workspacePath: '/Users/testuser/Projects/trigger-safe-workspace',
      });
      usePermissionStore.getState().grantPermission(path, ['read', 'write'], 'session');

      try {
        await expect(callbacks.filePermissionCallback({
          path,
          capability: 'write',
          toolName: 'write_file',
        })).resolves.toBe(false);

        expect((await checkReadPath(path, scopeId)).allowed).toBe(false);
        expect((await checkWritePath(path, scopeId)).allowed).toBe(false);
      } finally {
        dispose();
        revokeWorkspace(path);
        usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {}, pendingRequest: null });
      }
    });

    it('custom refuses a globally granted path outside its explicit allowlist', async () => {
      const path = '/Users/testuser/Desktop/trigger-custom-write.md';
      const { callbacks, scopeId, dispose } = resolveForTest({
        prompt: 'custom',
        capability: 'custom',
        permissions: {
          allowedPaths: ['/Users/testuser/Projects/only-this-path'],
          allowedTools: ['write_file'],
        },
      });
      usePermissionStore.getState().grantPermission(path, ['read', 'write'], 'session');

      try {
        await expect(callbacks.filePermissionCallback({
          path,
          capability: 'write',
          toolName: 'write_file',
        })).resolves.toBe(false);

        expect((await checkReadPath(path, scopeId)).allowed).toBe(false);
        expect((await checkWritePath(path, scopeId)).allowed).toBe(false);
      } finally {
        dispose();
        revokeWorkspace(path);
        usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {}, pendingRequest: null });
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
      const { callbacks: { blockedTools }, dispose } = resolveForTest({ prompt: 'read', capability: 'read_tools' });

      try {
        // click/fill/select/keyboard/execute_js/navigate are the enumerated
        // STATE_CHANGING_TOOLS; snapshot/screenshot/get_tabs stand in for the
        // read-only tools this module never enumerates (they're registered
        // dynamically by the browser servers) — the wildcard has to catch
        // those too, not just the known state-changing set.
        for (const tool of ['click', 'fill', 'select', 'keyboard', 'execute_js', 'navigate', 'snapshot', 'screenshot', 'get_tabs']) {
          expect(blockedTools.some((p) => matchesToolName(`abu-browser__${tool}`, p)), tool).toBe(true);
          expect(blockedTools.some((p) => matchesToolName(`abu-browser-bridge__${tool}`, p)), tool).toBe(true);
        }
      } finally {
        dispose();
      }
    });

    it('leaves the higher tiers untouched', () => {
      for (const capability of ['safe_tools', 'full'] as const) {
        const { callbacks: { blockedTools }, dispose } = resolveForTest({ prompt: 'x', capability });
        try {
          expect(blockedTools.some((p) => matchesToolName('abu-browser__click', p)), capability).toBe(false);
          expect(blockedTools.some((p) => matchesToolName('abu-browser__navigate', p)), capability).toBe(false);
        } finally {
          dispose();
        }
      }
    });

    it('applies to a task that predates the capability field (defaults to read_tools)', () => {
      const { callbacks: { blockedTools }, dispose } = resolveForTest({ prompt: 'x' });
      try {
        expect(blockedTools.some((p) => matchesToolName('abu-browser__click', p))).toBe(true);
      } finally {
        dispose();
      }
    });
  });

  // RB-02. The tier's deny callback is only reached when the permission
  // strategy resolves to `confirm`; a workspace-internal command that
  // `commandSafety` calls `safe` resolves to `allow` outright, so the
  // callback never runs and `touch` / `mkdir` / `cp` wrote unasked. The
  // roster is what actually holds the "changes nothing" promise.
  describe('read_tools write ceiling', () => {
    const allowedFor = (capability: 'read_tools' | 'safe_tools' | 'full') => {
      const { callbacks, dispose } = resolveForTest({ prompt: 'x', capability });
      const allowedTools = callbacks.allowedTools;
      dispose();
      return allowedTools;
    };

    it('caps the tier at a positive roster instead of relying on the deny callback', () => {
      const allowed = allowedFor('read_tools');
      expect(allowed?.length).toBeGreaterThan(0);
      // Non-empty matters on its own: every enforcement point reads an empty
      // array as "unrestricted", so an accidentally-empty roster would be a
      // silent regression back to the RB-02 behaviour.
      expect(allowed).toContain('read_file');
    });

    it('keeps every write and self-extension tool off the roster', () => {
      const allowed = allowedFor('read_tools') ?? [];
      for (const tool of [
        'run_command', 'write_file', 'edit_file', 'delete_file', 'http_fetch',
        'update_memory', 'update_soul', 'clipboard_write', 'skill_manage',
        'save_agent', 'manage_scheduled_task', 'manage_trigger',
        'manage_file_watch', 'manage_mcp_server', 'computer', 'generate_image',
        'delegate_to_agent', 'run_agent_batch',
      ]) {
        expect(allowed.some((p) => matchesToolName(tool, p)), tool).toBe(false);
      }
    });

    it('still admits the reads the tier advertises', () => {
      const allowed = allowedFor('read_tools') ?? [];
      for (const tool of [
        'read_file', 'list_directory', 'search_files', 'find_files',
        'recall', 'read_memory', 'web_search', 'get_system_info',
      ]) {
        expect(allowed.some((p) => matchesToolName(tool, p)), tool).toBe(true);
      }
    });

    it('applies to a task that predates the capability field (defaults to read_tools)', () => {
      const { callbacks, dispose } = resolveForTest({ prompt: 'x' });
      const allowed = callbacks.allowedTools ?? [];
      dispose();
      expect(allowed.some((p) => matchesToolName('run_command', p))).toBe(false);
    });
  });
});
