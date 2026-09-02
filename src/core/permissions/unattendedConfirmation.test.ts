import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetUnattendedConfirmationForTests,
  createUnattendedConfirmation,
  mayUnattendedTierApproveBrowser,
  resolveUnattendedConfirmation,
  setUnattendedConfirmationResolver,
} from './unattendedConfirmation';
import { useSettingsStore } from '../../stores/settingsStore';
import { DEFAULT_BROWSER_OPERATION_POLICY } from './browserToolPolicy';

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
