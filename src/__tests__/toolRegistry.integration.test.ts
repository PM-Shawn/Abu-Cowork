/**
 * Integration test: toolRegistry + commandSafety + pathSafety
 * Tests the full safety check pipeline through executeAnyTool
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, stat } from '@tauri-apps/plugin-fs';
import { toolRegistry, executeAnyTool } from '../core/tools/registry';
import {
  authorizeWorkspace,
  checkReadPath,
  checkWritePath,
  createAuthorizationScope,
  disposeAuthorizationScope,
  revokeWorkspace,
  scopedAuthorizeWorkspace,
} from '../core/tools/pathSafety';
import { useSettingsStore } from '../stores/settingsStore';
import { setPlatformForTest as _setPlatformForTest } from '../test/helpers';
import { resolveTriggerCallbacks } from '../core/trigger/triggerPermission';
import { buildTriggerRunPermissionCeiling } from '../core/permissions/runPermissionCeiling';
import { canonicalizeElectronPathForPolicy } from '../utils/electronHost';

vi.mock('../utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: vi.fn().mockResolvedValue(null),
}));

// Mock i18n. commandSafety resolves reason/label strings via
// getI18n().toolResult.commandSafety.<key> at analysis time; this test only
// asserts on the commandConfirm strings, so a proxy that echoes the key name is
// enough to keep command analysis from crashing on the missing namespace.
vi.mock('../i18n', () => ({
  getI18n: () => ({
    commandConfirm: {
      blocked: '已阻止',
      userCancelled: '用户取消了操作',
    },
    toolResult: {
      commandSafety: new Proxy({}, { get: (_t, key) => String(key) }),
    },
    toolErrors: {
      userDeniedAccess: 'user denied access',
      pathAccessDenied: 'path access denied',
      needsAuthorization: 'needs authorization',
      scopedRunNoWorkspaceCommand: 'Error: this unattended run has no write-authorized working directory. Choose Full Autonomy, configure a workspace path for this task, or pass an absolute cwd inside an authorized directory.',
    },
  }),
}));

// Mock MCP manager
vi.mock('../core/mcp/client', () => ({
  mcpManager: {
    listTools: () => [],
    isConnected: () => false,
    callTool: vi.fn(),
  },
}));

describe('toolRegistry integration', () => {
  beforeEach(() => {
    // Clean up workspace authorizations
    revokeWorkspace('/Users/testuser/Projects/myapp');
    vi.mocked(exists).mockReset().mockResolvedValue(false);
    vi.mocked(stat).mockReset().mockResolvedValue({ size: 0 } as never);
    vi.mocked(canonicalizeElectronPathForPolicy).mockReset().mockResolvedValue(null);
  });

  // ── Command safety through executeAnyTool ──
  describe('command safety pipeline', () => {
    it('blocks dangerous commands via executeAnyTool', async () => {
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: vi.fn().mockResolvedValue('executed'),
      });

      const result = await executeAnyTool('run_command', { command: 'rm -rf /' });
      expect(result).toContain('已阻止');
      // The underlying execute should NOT have been called
    });

    it('allows safe commands through', async () => {
      const executeFn = vi.fn().mockResolvedValue('file list');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      const result = await executeAnyTool('run_command', { command: 'ls -la' });
      expect(result).toBe('file list');
      expect(executeFn).toHaveBeenCalled();
    });

    it('refuses detached background commands owned by a scoped unattended run', async () => {
      const scopeId = createAuthorizationScope();
      const executeFn = vi.fn().mockResolvedValue('background process started');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        for (const background of [true, 'true', 1]) {
          const result = await executeAnyTool(
            'run_command',
            { command: 'ls -la', background },
            undefined,
            undefined,
            { authorizationScopeId: scopeId, interactionMode: 'background' },
          );

          expect(result).toContain('background commands are not allowed');
          expect(executeFn).not.toHaveBeenCalled();
        }
      } finally {
        disposeAuthorizationScope(scopeId);
      }
    });

    it('requests confirmation for warn-level commands', async () => {
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: vi.fn().mockResolvedValue('pushed'),
      });

      const onConfirm = vi.fn().mockResolvedValue(true);
      const result = await executeAnyTool(
        'run_command',
        { command: 'git push origin main' },
        onConfirm
      );
      expect(onConfirm).toHaveBeenCalled();
      expect(result).toBe('pushed');
    });

    it('does not start a tool when abort wins while its approval is pending', async () => {
      const executeFn = vi.fn().mockResolvedValue('must not execute');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });
      let approve!: (allowed: boolean) => void;
      const onConfirm = vi.fn(() => new Promise<boolean>((resolve) => {
        approve = resolve;
      }));
      const controller = new AbortController();

      const execution = executeAnyTool(
        'run_command',
        { command: 'git push origin main' },
        onConfirm,
        undefined,
        { abortSignal: controller.signal } as never,
      );
      await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());

      controller.abort();
      approve(true);

      await expect(execution).rejects.toEqual(expect.objectContaining({ name: 'AbortError' }));
      expect(executeFn).not.toHaveBeenCalled();
    });

    it('cancels when user declines confirmation', async () => {
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: vi.fn().mockResolvedValue('should not reach'),
      });

      const onConfirm = vi.fn().mockResolvedValue(false);
      const result = await executeAnyTool(
        'run_command',
        { command: 'sudo rm something' },
        onConfirm
      );
      expect(result).toContain('用户取消');
    });

    it('fails closed for scoped non-read-only commands whose effective cwd is read-only', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope();
      const readOnlyWs = '/Users/testuser/Projects/scoped-readonly-command';
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'standard' });
        scopedAuthorizeWorkspace(scopeId, readOnlyWs, ['read']);

        const result = await executeAnyTool(
          'run_command',
          { command: 'touch pwned.txt', cwd: readOnlyWs },
          undefined,
          undefined,
          { authorizationScopeId: scopeId, workspacePath: readOnlyWs },
        );

        expect(String(result)).toContain('Error');
        expect(executeFn).not.toHaveBeenCalled();
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it('fails closed for scoped non-read-only commands whose cwd is path-safe but not scope-writable', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope();
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'standard' });

        const result = await executeAnyTool(
          'run_command',
          { command: 'touch pwned.txt', cwd: '/Applications' },
          undefined,
          undefined,
          { authorizationScopeId: scopeId, workspacePath: '/Applications' },
        );

        expect(String(result)).toContain('Error');
        expect(executeFn).not.toHaveBeenCalled();
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it('fails closed when scoped command cwd escapes a write-authorized directory via traversal', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope();
      const writableWs = '/Users/testuser/Projects/scoped-traversal/ws';
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'standard' });
        scopedAuthorizeWorkspace(scopeId, writableWs, ['read', 'write']);

        for (const cwd of [
          `${writableWs}/../outside`,
          `${writableWs}/../Applications`,
          '/authorized/../Applications',
        ]) {
          if (cwd.startsWith('/authorized/')) {
            scopedAuthorizeWorkspace(scopeId, '/authorized', ['read', 'write']);
          }
          const result = await executeAnyTool(
            'run_command',
            { command: 'touch pwned.txt', cwd },
            undefined,
            undefined,
            { authorizationScopeId: scopeId, workspacePath: writableWs },
          );
          expect(String(result)).toContain('Error');
        }
        expect(executeFn).not.toHaveBeenCalled();
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it('allows scoped non-read-only commands when cwd is write-authorized or temp', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope();
      const writableWs = '/Users/testuser/Projects/scoped-writable-command';
      const executeFn = vi.fn().mockResolvedValue('executed');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'standard' });
        scopedAuthorizeWorkspace(scopeId, writableWs, ['read', 'write']);

        await expect(executeAnyTool(
          'run_command',
          { command: 'touch ok.txt', cwd: writableWs },
          undefined,
          undefined,
          { authorizationScopeId: scopeId, workspacePath: writableWs },
        )).resolves.toBe('executed');
        await expect(executeAnyTool(
          'run_command',
          { command: 'touch scratch.txt', cwd: '/tmp' },
          undefined,
          undefined,
          { authorizationScopeId: scopeId, workspacePath: writableWs },
        )).resolves.toBe('executed');
        expect(executeFn).toHaveBeenCalledTimes(2);
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it('tells a workspace-less unattended run how to get a writable cwd instead of a bare refusal', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope();
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        // Most permissive tier an unattended run can have — the refusal below
        // is about having no judgeable cwd at all, not about the tier.
        useSettingsStore.setState({ permissionMode: 'autonomous' });

        const result = String(await executeAnyTool(
          'run_command',
          { command: 'touch /tmp/report.json' },
          undefined,
          undefined,
          { authorizationScopeId: scopeId },
        ));

        expect(executeFn).not.toHaveBeenCalled();
        // Distinct from the "cwd exists but is not writable" refusal, and it
        // names both remedies so an unattended run fails loudly, not opaquely.
        expect(result).toContain('no write-authorized working directory');
        expect(result).toContain('workspace path');
        expect(result).toContain('cwd');
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it.each(['standard', 'smart'] as const)(
      'guides a workspace-less %s run to Full Autonomy or a workspace path',
      async (permissionMode) => {
        const previousMode = useSettingsStore.getState().permissionMode;
        const scopeId = createAuthorizationScope();
        const executeFn = vi.fn().mockResolvedValue('should not execute');
        toolRegistry.register({
          name: 'run_command',
          description: 'Run shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
          execute: executeFn,
        });

        try {
          useSettingsStore.setState({ permissionMode });

          const result = String(await executeAnyTool(
            'run_command',
            { command: 'touch /tmp/report.json' },
            undefined,
            undefined,
            { authorizationScopeId: scopeId },
          ));

          expect(executeFn).not.toHaveBeenCalled();
          expect(result).toContain('Full Autonomy');
          expect(result).toContain('workspace path');
        } finally {
          useSettingsStore.setState({ permissionMode: previousMode });
          disposeAuthorizationScope(scopeId);
        }
      },
    );

    it('allows a full scoped run without a workspace to write to temp paths', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope({ shell: 'full' });
      const executeFn = vi.fn().mockResolvedValue('executed');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });

        const result = await executeAnyTool(
          'run_command',
          { command: 'touch /tmp/report.json' },
          undefined,
          undefined,
          { authorizationScopeId: scopeId },
        );

        expect(result).toBe('executed');
        expect(executeFn).toHaveBeenCalledOnce();
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it('still blocks a full scoped run without a workspace from writing Abu self-managed paths', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope({ shell: 'full' });
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });

        const result = String(await executeAnyTool(
          'run_command',
          { command: 'touch /Users/testuser/.AbU/mcp/config.json' },
          undefined,
          undefined,
          { authorizationScopeId: scopeId },
        ));

        expect(result).toContain('Error');
        expect(result).toContain('阿布');
        expect(executeFn).not.toHaveBeenCalled();
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it.each([
      'touch /Users/testuser && touch /Users/testuser/.AbU/mcp/config.json',
      'Set-Content -Path "$HOME/.AbU/mcp/config.json" -Value x',
    ])('keeps the Abu hard floor across compound and PowerShell writes: %s', async (command) => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope({ shell: 'full' });
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });
        const result = String(await executeAnyTool(
          'run_command',
          { command },
          undefined,
          undefined,
          { authorizationScopeId: scopeId },
        ));

        expect(result).toContain('禁止写入阿布');
        expect(executeFn).not.toHaveBeenCalled();
        expect((await checkWritePath('/Users/testuser/Documents/not-granted.txt', scopeId)).allowed).toBe(false);
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it.each([
      ['macos', 'Set-Content -Path "$HOME/.ssh/authorized_keys" -Value x', '/Users/testuser/.ssh/authorized_keys'],
      ['macos', 'Set-Content -Path "$HOME/tmp/../.AbU/mcp/config.json" -Value x', '/Users/testuser/.AbU/mcp/config.json'],
      ['windows', 'Set-Content -Path "$env:APPDATA/Abu/config.json" -Value x', '/Users/testuser/AppData/Roaming/Abu/config.json'],
      ['windows', 'cmd /c echo x > %USERPROFILE%\\.ssh\\authorized_keys', '/Users/testuser/.ssh/authorized_keys'],
    ] as const)('checks expanded %s hard-floor path for %s', async (platform, command, expectedTarget) => {
      const restorePlatform = _setPlatformForTest(platform);
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope({ shell: 'full' });
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });
        expect((await checkWritePath(expectedTarget, scopeId)).allowed).toBe(false);
        const result = String(await executeAnyTool(
          'run_command',
          { command },
          undefined,
          undefined,
          { authorizationScopeId: scopeId },
        ));

        expect(result).toContain('Error');
        expect(executeFn).not.toHaveBeenCalled();
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
        restorePlatform();
      }
    });

    it('does not extend the new target preflight to full scoped runs that have a workspace', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope({ shell: 'full' });
      const workspace = '/Users/testuser/Projects/myapp';
      const outsideTarget = '/Users/testuser/Documents/outside.txt';
      const executeFn = vi.fn().mockResolvedValue('executed');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });
      scopedAuthorizeWorkspace(scopeId, workspace, ['read', 'write']);

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });
        await expect(executeAnyTool(
          'run_command',
          { command: `touch ${outsideTarget}`, cwd: workspace },
          undefined,
          undefined,
          { authorizationScopeId: scopeId, workspacePath: workspace },
        )).resolves.toBe('executed');

        expect(executeFn).toHaveBeenCalledOnce();
        const outsideCheck = await checkWritePath(outsideTarget, scopeId);
        expect(outsideCheck.allowed).toBe(false);
        expect(outsideCheck.needsPermission).toBe(true);
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });
  });

  // A run-level capability is a ceiling, not a hint to the ambient chat
  // strategy. In particular, a trigger/IM run must not become more powerful
  // just because the global setting is `autonomous` — callbacks are normally
  // consulted only when that strategy returns `confirm`, while autonomous
  // returns `allow` directly.
  describe('unattended capability ceiling', () => {
    const workspace = '/Users/testuser/Projects/unattended-ceiling';

    it('blocks shell commands for safe_tools even when global mode is autonomous', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope();
      const callbacks = resolveTriggerCallbacks(
        { prompt: 'safe', capability: 'safe_tools', workspacePath: workspace },
        { authorizationScopeId: scopeId },
      );
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });
        const result = await executeAnyTool(
          'run_command',
          { command: 'git status', cwd: workspace },
          callbacks.commandConfirmCallback,
          callbacks.filePermissionCallback,
          {
            authorizationScopeId: scopeId,
            workspacePath: workspace,
            runPermissionCeiling: buildTriggerRunPermissionCeiling({ prompt: 'safe', capability: 'safe_tools' }),
          } as never,
        );

        expect(String(result)).toContain('Error');
        expect(executeFn).not.toHaveBeenCalled();
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it('lets safe_tools send a workspace file but denies an out-of-scope file before delivery', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope();
      const callbacks = resolveTriggerCallbacks(
        { prompt: 'safe', capability: 'safe_tools', workspacePath: workspace },
        { authorizationScopeId: scopeId },
      );
      const executeFn = vi.fn().mockResolvedValue('sent');
      toolRegistry.register({
        name: 'send_file',
        description: 'Send IM file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });
        const context = {
          authorizationScopeId: scopeId,
          workspacePath: workspace,
          runPermissionCeiling: buildTriggerRunPermissionCeiling({ prompt: 'safe', capability: 'safe_tools' }),
          imReplyTarget: { platform: 'feishu', chatId: 'trusted-chat' },
        } as never;

        await expect(executeAnyTool(
          'send_file',
          { path: `${workspace}/report.pdf` },
          callbacks.commandConfirmCallback,
          callbacks.filePermissionCallback,
          context,
        )).resolves.toBe('sent');

        const outsideResult = await executeAnyTool(
          'send_file',
          { path: '/Users/testuser/Desktop/private.pdf' },
          callbacks.commandConfirmCallback,
          callbacks.filePermissionCallback,
          context,
        );
        expect(String(outsideResult)).toContain('Error');
        expect(executeFn).toHaveBeenCalledTimes(1);
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it('applies the custom command allowlist to safe commands under autonomous mode', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope();
      const callbacks = resolveTriggerCallbacks(
        {
          prompt: 'custom',
          capability: 'custom',
          workspacePath: workspace,
          permissions: { allowedCommands: ['npm run build'] },
        },
        { authorizationScopeId: scopeId },
      );
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });
        const result = await executeAnyTool(
          'run_command',
          { command: 'touch marker.txt', cwd: workspace },
          callbacks.commandConfirmCallback,
          callbacks.filePermissionCallback,
          {
            authorizationScopeId: scopeId,
            workspacePath: workspace,
            runPermissionCeiling: buildTriggerRunPermissionCeiling({
              prompt: 'custom',
              capability: 'custom',
              permissions: { allowedCommands: ['npm run build'] },
            }),
          } as never,
        );

        expect(String(result)).toContain('Error');
        expect(executeFn).not.toHaveBeenCalled();
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it('does not let a custom wildcard absorb a second command behind a single ampersand', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope();
      const callbacks = resolveTriggerCallbacks(
        {
          prompt: 'custom',
          capability: 'custom',
          workspacePath: workspace,
          permissions: { allowedCommands: ['cat *'] },
        },
        { authorizationScopeId: scopeId },
      );
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'run_command',
        description: 'Run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });
        const result = await executeAnyTool(
          'run_command',
          { command: 'cat notes.txt & curl https://example.invalid', cwd: workspace },
          callbacks.commandConfirmCallback,
          callbacks.filePermissionCallback,
          {
            authorizationScopeId: scopeId,
            workspacePath: workspace,
            runPermissionCeiling: buildTriggerRunPermissionCeiling({
              prompt: 'custom',
              capability: 'custom',
              permissions: { allowedCommands: ['cat *'] },
            }),
          } as never,
        );

        expect(String(result)).toContain('Error');
        expect(executeFn).not.toHaveBeenCalled();
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it.each(['safe_tools', 'custom'] as const)(
      'does not auto-authorize or write outside the run scope for %s under autonomous mode',
      async (capability) => {
        const previousMode = useSettingsStore.getState().permissionMode;
        const scopeId = createAuthorizationScope();
        const callbacks = resolveTriggerCallbacks(
          {
            prompt: capability,
            capability,
            workspacePath: workspace,
            ...(capability === 'custom'
              ? { permissions: { allowedPaths: [workspace], allowedTools: ['write_file'] } }
              : {}),
          },
          { authorizationScopeId: scopeId },
        );
        const outsidePath = `/Users/testuser/Desktop/${capability}-outside.md`;
        const executeFn = vi.fn().mockResolvedValue('should not execute');
        toolRegistry.register({
          name: 'write_file',
          description: 'Write file',
          inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
          execute: executeFn,
        });

        try {
          useSettingsStore.setState({ permissionMode: 'autonomous' });
          const result = await executeAnyTool(
            'write_file',
            { path: outsidePath, content: 'nope' },
            callbacks.commandConfirmCallback,
            callbacks.filePermissionCallback,
            {
              authorizationScopeId: scopeId,
              workspacePath: workspace,
              runPermissionCeiling: buildTriggerRunPermissionCeiling({
                prompt: capability,
                capability,
                ...(capability === 'custom'
                  ? { permissions: { allowedPaths: [workspace], allowedTools: ['write_file'] } }
                  : {}),
              }),
            } as never,
          );

          expect(String(result)).toContain('Error');
          expect(executeFn).not.toHaveBeenCalled();
          expect((await checkWritePath(outsidePath, scopeId)).allowed).toBe(false);
        } finally {
          useSettingsStore.setState({ permissionMode: previousMode });
          disposeAuthorizationScope(scopeId);
        }
      },
    );

    it('does not let safe_tools write to default-allowed temp paths outside the run scope', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope();
      const callbacks = resolveTriggerCallbacks(
        { prompt: 'safe', capability: 'safe_tools', workspacePath: workspace },
        { authorizationScopeId: scopeId },
      );
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'write_file',
        description: 'Write file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });
        const result = await executeAnyTool(
          'write_file',
          { path: '/tmp/unattended-ceiling-outside.md', content: 'nope' },
          callbacks.commandConfirmCallback,
          callbacks.filePermissionCallback,
          {
            authorizationScopeId: scopeId,
            workspacePath: workspace,
            runPermissionCeiling: buildTriggerRunPermissionCeiling({ prompt: 'safe', capability: 'safe_tools' }),
          } as never,
        );

        expect(String(result)).toContain('Error');
        expect(executeFn).not.toHaveBeenCalled();
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it('rechecks the large-overwrite guard after full mode grants a new path but before execute', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope();
      const callbacks = resolveTriggerCallbacks(
        { prompt: 'full', capability: 'full', workspacePath: workspace },
        { authorizationScopeId: scopeId },
      );
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'write_file',
        description: 'Write file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });
        vi.mocked(exists).mockResolvedValueOnce(true);
        vi.mocked(stat).mockResolvedValueOnce({ size: 16 * 1024 } as never);
        const outsidePath = '/Users/testuser/Desktop/existing-large.html';
        const result = await executeAnyTool(
          'write_file',
          { path: outsidePath, content: '<html>replacement</html>' },
          callbacks.commandConfirmCallback,
          callbacks.filePermissionCallback,
          {
            authorizationScopeId: scopeId,
            workspacePath: workspace,
            runPermissionCeiling: buildTriggerRunPermissionCeiling({ prompt: 'full', capability: 'full' }),
          } as never,
        );

        expect(String(result)).toContain('write_file rejected');
        expect(executeFn).not.toHaveBeenCalled();
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it('fails closed without probing metadata when a full IM-style scope grants write but not read', async () => {
      const scopeId = createAuthorizationScope();
      const outsidePath = '/Users/testuser/Desktop/write-only-existing.html';
      const executeFn = vi.fn().mockResolvedValue('should not execute');
      toolRegistry.register({
        name: 'write_file',
        description: 'Write file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });

      try {
        scopedAuthorizeWorkspace(scopeId, outsidePath, ['write']);
        expect((await checkWritePath(outsidePath, scopeId)).allowed).toBe(true);
        expect((await checkReadPath(outsidePath, scopeId)).allowed).toBe(false);
        vi.mocked(exists).mockClear();
        vi.mocked(stat).mockClear();
        vi.mocked(exists).mockResolvedValueOnce(true);
        vi.mocked(stat).mockResolvedValueOnce({ size: 16 * 1024 } as never);

        const result = await executeAnyTool(
          'write_file',
          { path: outsidePath, content: '<html>replacement</html>' },
          undefined,
          undefined,
          {
            authorizationScopeId: scopeId,
            runPermissionCeiling: { version: 1, source: 'im', capability: 'full' },
          } as never,
        );

        expect(String(result)).toContain('read authorization');
        expect(executeFn).not.toHaveBeenCalled();
        expect(exists).not.toHaveBeenCalled();
        expect(stat).not.toHaveBeenCalled();
      } finally {
        disposeAuthorizationScope(scopeId);
      }
    });
  });

  // ── Path safety through executeAnyTool ──
  describe('path safety pipeline', () => {
    it('executes a scoped file tool against the canonical path that was approved', async () => {
      const scopeId = createAuthorizationScope();
      const workspace = '/Users/testuser/Documents/canonical-execution';
      const canonicalWorkspace = '/Users/testuser/Projects/canonical-execution-real';
      const lexicalPath = `${workspace}/link/report.md`;
      const canonicalPath = `${canonicalWorkspace}/real/report.md`;
      vi.mocked(canonicalizeElectronPathForPolicy).mockImplementation(async (candidate) => {
        const value = String(candidate);
        if (value === lexicalPath) return canonicalPath;
        if (value === workspace) return canonicalWorkspace;
        return value;
      });
      const executeFn = vi.fn().mockResolvedValue('file content');
      toolRegistry.register({
        name: 'read_file',
        description: 'Read file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });
      scopedAuthorizeWorkspace(scopeId, workspace, ['read']);

      try {
        await expect(executeAnyTool(
          'read_file',
          { path: lexicalPath },
          undefined,
          undefined,
          { authorizationScopeId: scopeId },
        )).resolves.toBe('file content');
        expect(executeFn).toHaveBeenCalledWith(
          { path: canonicalPath },
          expect.objectContaining({ authorizationScopeId: scopeId }),
        );
      } finally {
        disposeAuthorizationScope(scopeId);
      }
    });

    it('rechecks a callback grant against its pinned root before executing', async () => {
      const scopeId = createAuthorizationScope();
      const grantRoot = '/Users/testuser/Desktop';
      const lexicalPath = `${grantRoot}/link/report.md`;
      const targetA = '/Users/testuser/Projects/granted-a';
      const targetB = '/Users/testuser/Documents/retargeted-b';
      let target = targetA;
      vi.mocked(canonicalizeElectronPathForPolicy).mockImplementation(async (candidate) => {
        const value = String(candidate);
        return value === grantRoot || value.startsWith(`${grantRoot}/`)
          ? value.replace(grantRoot, target)
          : value;
      });
      const executeFn = vi.fn().mockResolvedValue('must not execute');
      toolRegistry.register({
        name: 'read_file',
        description: 'Read file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });
      const grant = vi.fn(async ({ path, capability }) => {
        scopedAuthorizeWorkspace(scopeId, path, [capability]);
        target = targetB;
        return true;
      });

      try {
        const result = await executeAnyTool(
          'read_file',
          { path: lexicalPath },
          undefined,
          grant,
          { authorizationScopeId: scopeId },
        );
        expect(String(result)).toContain('Error');
        expect(executeFn).not.toHaveBeenCalled();
      } finally {
        disposeAuthorizationScope(scopeId);
      }
    });

    it('blocks read of sensitive paths', async () => {
      toolRegistry.register({
        name: 'read_file',
        description: 'Read file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: vi.fn().mockResolvedValue('secret data'),
      });

      const result = await executeAnyTool('read_file', { path: '/Users/testuser/.ssh/id_rsa' });
      expect(result).toContain('Error');
    });

    it('allows authorized workspace paths', async () => {
      authorizeWorkspace('/Users/testuser/Projects/myapp');
      const executeFn = vi.fn().mockResolvedValue('file content');
      toolRegistry.register({
        name: 'read_file',
        description: 'Read file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });

      const result = await executeAnyTool('read_file', { path: '/Users/testuser/Projects/myapp/src/main.ts' });
      expect(result).toBe('file content');
    });

    it('requests file permission when path needs authorization', async () => {
      const executeFn = vi.fn().mockResolvedValue('file data');
      toolRegistry.register({
        name: 'read_file',
        description: 'Read file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });

      const onFilePermission = vi.fn().mockImplementation(async ({ path }) => {
        // Simulate granting permission by authorizing the workspace
        authorizeWorkspace(path);
        return true;
      });

      await executeAnyTool(
        'read_file',
        { path: '/Users/testuser/Desktop/report.pdf' },
        undefined,
        onFilePermission
      );
      expect(onFilePermission).toHaveBeenCalled();
    });

    it('executes the canonical escape target after the user approves that exact target', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const lexicalRoot = '/Users/testuser/Documents/registry-canonical-source';
      const lexicalPath = `${lexicalRoot}/link/report.md`;
      const canonicalPath = '/Volumes/External/r3b-canonical-target/report.md';
      const executeFn = vi.fn().mockResolvedValue('file content');
      vi.mocked(canonicalizeElectronPathForPolicy).mockImplementation(async (candidate) => {
        const value = String(candidate);
        return value === lexicalPath ? canonicalPath : value;
      });
      toolRegistry.register({
        name: 'read_file',
        description: 'Read file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });
      authorizeWorkspace(lexicalRoot, ['read']);
      const onFilePermission = vi.fn(async ({ path, capability }) => {
        authorizeWorkspace(path, [capability]);
        return true;
      });

      try {
        useSettingsStore.setState({ permissionMode: 'standard' });
        await expect(executeAnyTool(
          'read_file',
          { path: lexicalPath },
          undefined,
          onFilePermission,
        )).resolves.toBe('file content');
        expect(onFilePermission).toHaveBeenCalledWith({
          path: canonicalPath,
          capability: 'read',
          toolName: 'read_file',
        }, undefined);
        expect(executeFn).toHaveBeenCalledWith({ path: canonicalPath }, undefined);
        expect((await checkWritePath(canonicalPath)).allowed).toBe(false);
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        revokeWorkspace(lexicalRoot);
        revokeWorkspace(canonicalPath);
      }
    });

    it('checks, rechecks, and auto-authorizes inside the explicit run scope without falling back to global writes', async () => {
      const ws = '/Users/testuser/Projects/scoped-registry';
      revokeWorkspace(ws);
      authorizeWorkspace(ws, ['read', 'write']);
      const scopeId = createAuthorizationScope();
      const executeFn = vi.fn().mockResolvedValue('written');
      toolRegistry.register({
        name: 'write_file',
        description: 'Write file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });

      try {
        scopedAuthorizeWorkspace(scopeId, ws, ['read']);

        const denied = await executeAnyTool(
          'write_file',
          { path: `${ws}/out.md` },
          undefined,
          undefined,
          { authorizationScopeId: scopeId },
        );
        expect(String(denied)).toContain('needs authorization');
        expect(executeFn).not.toHaveBeenCalled();

        const filePermission = vi.fn(async ({ path, capability }) => {
          scopedAuthorizeWorkspace(scopeId, path, [capability]);
          return true;
        });
        const allowed = await executeAnyTool(
          'write_file',
          { path: `${ws}/out.md` },
          undefined,
          filePermission,
          { authorizationScopeId: scopeId },
        );
        expect(allowed).toBe('written');
        expect(filePermission).toHaveBeenCalledWith({
          path: '/Users/testuser/Projects',
          capability: 'write',
          toolName: 'write_file',
        }, undefined);

        const filePermissionWithLoop = vi.fn(async ({ path, capability }) => {
          scopedAuthorizeWorkspace(scopeId, path, [capability]);
          return true;
        });
        const allowedWithLoop = await executeAnyTool(
          'write_file',
          { path: '/Users/testuser/Desktop/scoped-registry-loop.md' },
          undefined,
          filePermissionWithLoop,
          { authorizationScopeId: scopeId, loopId: 'loop-owned' },
        );
        expect(allowedWithLoop).toBe('written');
        expect(filePermissionWithLoop).toHaveBeenNthCalledWith(1, {
          path: '/Users/testuser/Desktop',
          capability: 'write',
          toolName: 'write_file',
        }, 'loop-owned');
        expect(filePermissionWithLoop).toHaveBeenNthCalledWith(2, {
          path: '/Users/testuser/Desktop',
          capability: 'read',
          toolName: 'write_file',
        }, 'loop-owned');
      } finally {
        disposeAuthorizationScope(scopeId);
        revokeWorkspace(ws);
      }
    });

    it('auto-authorizes scoped read access without upgrading the scope to write', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const scopeId = createAuthorizationScope();
      const path = '/Users/testuser/Desktop/scoped-auto-read.md';
      const executeFn = vi.fn().mockResolvedValue('read');
      toolRegistry.register({
        name: 'read_file',
        description: 'Read file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });

        const result = await executeAnyTool(
          'read_file',
          { path },
          undefined,
          undefined,
          { authorizationScopeId: scopeId },
        );

        expect(result).toBe('read');
        expect(executeFn).toHaveBeenCalled();
        expect((await checkWritePath(path, scopeId)).allowed).toBe(false);
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        disposeAuthorizationScope(scopeId);
      }
    });

    it('auto-authorizes global read access without upgrading it to write', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const path = '/Volumes/External/global-auto-read.md';
      const executeFn = vi.fn().mockResolvedValue('read');
      toolRegistry.register({
        name: 'read_file',
        description: 'Read file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });
        await expect(executeAnyTool('read_file', { path })).resolves.toBe('read');
        expect(executeFn).toHaveBeenCalledWith({ path }, undefined);
        expect((await checkWritePath(path)).allowed).toBe(false);
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        revokeWorkspace(path);
      }
    });

    it('treats an empty explicit scope as fail-closed instead of auto-authorizing globally', async () => {
      const previousMode = useSettingsStore.getState().permissionMode;
      const path = '/Users/testuser/Desktop/empty-scope-auto-read.md';
      revokeWorkspace('/Users/testuser/Desktop');
      const executeFn = vi.fn().mockResolvedValue('read');
      toolRegistry.register({
        name: 'read_file',
        description: 'Read file',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } } },
        execute: executeFn,
      });

      try {
        useSettingsStore.setState({ permissionMode: 'autonomous' });

        const result = await executeAnyTool(
          'read_file',
          { path },
          undefined,
          undefined,
          { authorizationScopeId: '' },
        );

        expect(String(result)).toContain('Error');
        expect(executeFn).not.toHaveBeenCalled();
        expect((await checkWritePath(path)).allowed).toBe(false);
        expect((await checkWritePath(path, '')).allowed).toBe(false);
      } finally {
        useSettingsStore.setState({ permissionMode: previousMode });
        revokeWorkspace('/Users/testuser/Desktop');
      }
    });
  });

  // ── Tool registry basics ──
  describe('registry operations', () => {
    it('registers and retrieves tools', () => {
      toolRegistry.register({
        name: 'test_tool',
        description: 'Test tool',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => 'ok',
      });
      expect(toolRegistry.has('test_tool')).toBe(true);
      expect(toolRegistry.get('test_tool')?.name).toBe('test_tool');
    });

    it('returns error for unknown tools', async () => {
      const result = await executeAnyTool('nonexistent_tool', {});
      expect(result).toContain('Unknown tool');
    });

    it('handles execution errors gracefully', async () => {
      toolRegistry.register({
        name: 'error_tool',
        description: 'Tool that throws',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => { throw new Error('Tool broke'); },
      });
      const result = await toolRegistry.execute('error_tool', {});
      expect(result).toContain('Error');
      expect(result).toContain('Tool broke');
    });
  });
});
