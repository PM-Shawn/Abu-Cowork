import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetUnattendedConfirmationForTests,
  createUnattendedConfirmation,
  mayUnattendedTierApproveBrowser,
  notifyUnattendedDenial,
  resolveUnattendedConfirmation,
  setUnattendedConfirmationResolver,
} from './unattendedConfirmation';
import { useSettingsStore } from '../../stores/settingsStore';
import { DEFAULT_BROWSER_OPERATION_POLICY } from './browserToolPolicy';
import { clearLoopContext, setLoopContext } from '../agent/permissionBridge';

const command = { command: 'ls', level: 'safe' as const, reason: '' };

describe('resolveUnattendedConfirmation', () => {
  afterEach(() => {
    __resetUnattendedConfirmationForTests();
  });

  it('fails closed by default, naming the run source in the reason', async () => {
    const result = await resolveUnattendedConfirmation({ info: command, source: 'scheduler' });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('scheduler');
  });

  it('uses an installed resolver', async () => {
    setUnattendedConfirmationResolver(async () => ({ approved: true, reason: 'ok' }));

    await expect(resolveUnattendedConfirmation({ info: command, source: 'im' }))
      .resolves.toEqual({ approved: true, reason: 'ok' });
  });

  it('treats a rejected resolver as a refusal — a broken channel is not an open one', async () => {
    setUnattendedConfirmationResolver(async () => { throw new Error('boom'); });

    const result = await resolveUnattendedConfirmation({ info: command, source: 'trigger' });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('boom');
  });

  it('treats a malformed resolver result as a refusal', async () => {
    // A resolver returning a truthy non-approval (or nothing at all) must not
    // read as approval just because the value is not literally `false`.
    setUnattendedConfirmationResolver((async () => undefined) as never);

    await expect(resolveUnattendedConfirmation({ info: command, source: 'im' }))
      .resolves.toMatchObject({ approved: false });
  });

  it('restores the fail-closed default when the resolver is cleared', async () => {
    setUnattendedConfirmationResolver(async () => ({ approved: true, reason: 'ok' }));
    setUnattendedConfirmationResolver(null);

    await expect(resolveUnattendedConfirmation({ info: command, source: 'im' }))
      .resolves.toMatchObject({ approved: false });
  });
});

describe('createUnattendedConfirmation', () => {
  afterEach(() => {
    __resetUnattendedConfirmationForTests();
  });

  it('resolves false today and reports the reason to the caller\'s denial log', async () => {
    const onDenied = vi.fn();
    const callback = createUnattendedConfirmation({ source: 'scheduler', onDenied });

    await expect(callback(command)).resolves.toBe(false);
    expect(onDenied).toHaveBeenCalledTimes(1);
    expect(onDenied.mock.calls[0][1]).toBe(command);
  });

  it('does not call the denial hook when the request is approved', async () => {
    setUnattendedConfirmationResolver(async () => ({ approved: true, reason: 'ok' }));
    const onDenied = vi.fn();
    const callback = createUnattendedConfirmation({ source: 'im', onDenied });

    await expect(callback(command)).resolves.toBe(true);
    expect(onDenied).not.toHaveBeenCalled();
  });

  it('forwards the run provenance the approval channel will need', async () => {
    const seen: unknown[] = [];
    setUnattendedConfirmationResolver(async (request) => {
      seen.push(request);
      return { approved: false, reason: 'no' };
    });
    const callback = createUnattendedConfirmation({
      source: 'im',
      conversationId: 'conv-1',
      imTarget: { platform: 'feishu', chatId: 'chat-1' },
    });

    await callback(command);

    expect(seen).toEqual([{
      info: command,
      source: 'im',
      conversationId: 'conv-1',
      imTarget: { platform: 'feishu', chatId: 'chat-1' },
    }]);
  });

  // [I3 residual] The registry hands the callback `(info, loopId)` on the
  // run_command and self-extension paths. The wrapper used to drop the loop
  // id, so those confirmations reached the IM channel with no run key (no
  // coalescing) and no abort signal (Stop could not cancel the prompt).
  it('forwards the run key and the run\'s abort signal for the loop it is called with', async () => {
    const seen: unknown[] = [];
    setUnattendedConfirmationResolver(async (request) => {
      seen.push(request);
      return { approved: false, reason: 'no' };
    });
    const controller = new AbortController();
    setLoopContext('loop-9', {
      loopId: 'loop-9',
      conversationId: 'conv-1',
      signal: controller.signal,
      commandConfirmCallback: async () => true,
      filePermissionCallback: async () => true,
      eventRouter: {} as never,
      toolCallToStepId: new Map(),
    });
    try {
      const callback = createUnattendedConfirmation({ source: 'im', conversationId: 'conv-1' });
      await callback(command, 'loop-9');
    } finally {
      clearLoopContext('loop-9');
    }

    expect(seen).toEqual([{
      info: command,
      source: 'im',
      conversationId: 'conv-1',
      runKey: 'loop-9',
      abortSignal: controller.signal,
    }]);
  });

  it('still forwards the run key when no loop context is registered for it', async () => {
    const seen: unknown[] = [];
    setUnattendedConfirmationResolver(async (request) => {
      seen.push(request);
      return { approved: false, reason: 'no' };
    });
    const callback = createUnattendedConfirmation({ source: 'scheduler' });

    await callback(command, 'loop-unregistered');

    expect(seen).toEqual([{ info: command, source: 'scheduler', runKey: 'loop-unregistered' }]);
  });
});

describe('denial notices (accounting without a vote)', () => {
  afterEach(() => {
    __resetUnattendedConfirmationForTests();
  });

  it('records a notice without ever consulting the approval resolver', async () => {
    const resolver = vi.fn(async () => ({ approved: true, reason: 'yes' }));
    setUnattendedConfirmationResolver(resolver);
    const onDenied = vi.fn();
    const callback = createUnattendedConfirmation({ source: 'scheduler', onDenied });

    const answer = await callback({ ...command, deniedNotice: 'master switch is off' });

    expect(answer).toBe(false);
    expect(onDenied).toHaveBeenCalledWith('master switch is off', expect.objectContaining({
      deniedNotice: 'master switch is off',
    }));
    // Asking a human to approve something already refused would be a lie —
    // and once the resolver is a real IM round-trip, chat spam.
    expect(resolver).not.toHaveBeenCalled();
  });

  it('notifyUnattendedDenial is a no-op without a callback', async () => {
    await expect(notifyUnattendedDenial(undefined, { ...command, deniedNotice: 'x' }))
      .resolves.toBeUndefined();
  });

  it('swallows a throwing callback — accounting must not break the refusal', async () => {
    const callback = vi.fn(async () => { throw new Error('recorder exploded'); });

    await expect(notifyUnattendedDenial(callback, { ...command, deniedNotice: 'x' }))
      .resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe('mayUnattendedTierApproveBrowser', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      browserSitePermissions: { 'https://allowed.com': 'allowed', 'https://evil.com': 'denied' },
      browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
      allowUnattendedBrowser: true,
    });
  });

  const browserInfo = (overrides: Record<string, unknown> = {}) => ({
    command: 'Browser action',
    level: 'warn' as const,
    reason: '',
    kind: 'browser' as const,
    browserOrigin: 'https://allowed.com',
    ...overrides,
  });

  it('refuses scripting — the strongest class is denied in the unattended column', () => {
    expect(mayUnattendedTierApproveBrowser(browserInfo({ browserOperationClass: 'scripting' }))).toBe(false);
  });

  it('refuses an unclassified browser confirmation (treated as scripting)', () => {
    expect(mayUnattendedTierApproveBrowser(browserInfo())).toBe(false);
  });

  it('allows an interactive action the unattended column allows', () => {
    expect(mayUnattendedTierApproveBrowser(browserInfo({ browserOperationClass: 'interactive' }))).toBe(true);
  });

  it('refuses everything when the master switch is off', () => {
    useSettingsStore.setState({ allowUnattendedBrowser: false });
    expect(mayUnattendedTierApproveBrowser(browserInfo({ browserOperationClass: 'read-only' }))).toBe(false);
  });

  it('refuses on a site the user blocked', () => {
    expect(mayUnattendedTierApproveBrowser(browserInfo({
      browserOperationClass: 'interactive',
      browserOrigin: 'https://evil.com',
    }))).toBe(false);
  });

  it('refuses an "ask" cell — the tier is not an approval channel', () => {
    useSettingsStore.setState({
      browserOperationPolicy: {
        ...DEFAULT_BROWSER_OPERATION_POLICY,
        unattended: { ...DEFAULT_BROWSER_OPERATION_POLICY.unattended, interactive: 'ask' },
      },
    });
    expect(mayUnattendedTierApproveBrowser(browserInfo({ browserOperationClass: 'interactive' }))).toBe(false);
  });
});
