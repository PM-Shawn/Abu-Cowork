import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLogs, getRecentLogs } from '../logging/logger';
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
    setUnattendedConfirmationResolver(async () => ({ approved: true, reason: 'ok', audit: {} }));

    await expect(resolveUnattendedConfirmation({ info: command, source: 'im' }))
      .resolves.toEqual({ approved: true, reason: 'ok', audit: {} });
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

  // U7 / G2 — the boundary is a whitelist, so the audit fields have to be
  // copied deliberately. These pin BOTH halves: that they survive at all (the
  // silent-drop failure that made the feature a no-op the first time), and
  // that they cannot contradict the decision.
  describe('audit fields at the boundary', () => {
    it('carries a valid outcome through to the caller', async () => {
      setUnattendedConfirmationResolver(async () => ({
        approved: true, reason: 'ok', audit: { outcome: 'approved', fresh: true },
      }));
      await expect(resolveUnattendedConfirmation({ info: command, source: 'im' }))
        .resolves.toMatchObject({ audit: { outcome: 'approved', fresh: true } });
    });

    it('drops an outcome that contradicts the decision', async () => {
      // A resolver that refuses while claiming a human approved must not be
      // able to write "you approved this" into the audit trail.
      setUnattendedConfirmationResolver(async () => ({
        approved: false, reason: 'no', audit: { outcome: 'approved', fresh: true },
      }));
      const result = await resolveUnattendedConfirmation({ info: command, source: 'im' });
      expect(result.approved).toBe(false);
      expect(result.audit.outcome).toBeUndefined();
    });

    it('says so out loud when it discards a contradictory outcome', async () => {
      // Dropping it silently is the same blindness class as dropping the
      // field: a resolver that disagrees with itself is a bug in the approval
      // channel, and the audit trail is where nobody would ever notice.
      clearLogs();
      setUnattendedConfirmationResolver(async () => ({
        approved: false, reason: 'no', audit: { outcome: 'approved', fresh: true },
      }));

      await resolveUnattendedConfirmation({ info: command, source: 'im' });

      const warned = getRecentLogs({ module: 'unattendedConfirmation', level: 'warn' });
      expect(warned).toHaveLength(1);
      expect(warned[0].message).toContain('contradicts');
      expect(warned[0].data).toMatchObject({ outcome: 'approved', approved: false });
    });

    it('stays quiet when the outcome agrees with the decision', async () => {
      clearLogs();
      setUnattendedConfirmationResolver(async () => ({
        approved: true, reason: 'ok', audit: { outcome: 'approved', fresh: true },
      }));

      await resolveUnattendedConfirmation({ info: command, source: 'im' });

      expect(getRecentLogs({ module: 'unattendedConfirmation', level: 'warn' })).toHaveLength(0);
    });

    it('drops an approval whose outcome says it was refused', async () => {
      setUnattendedConfirmationResolver(async () => ({
        approved: true, reason: 'ok', audit: { outcome: 'declined', fresh: true },
      }));
      const result = await resolveUnattendedConfirmation({ info: command, source: 'im' });
      expect(result.approved).toBe(true);
      expect(result.audit.outcome).toBeUndefined();
    });

    it('drops an unrecognised outcome string', async () => {
      setUnattendedConfirmationResolver((async () => ({
        approved: true, reason: 'ok', audit: { outcome: 'rubber-stamped', fresh: true },
      })) as never);
      const result = await resolveUnattendedConfirmation({ info: command, source: 'im' });
      expect(result.audit.outcome).toBeUndefined();
    });

    it('treats a non-boolean freshness claim as not fresh', async () => {
      setUnattendedConfirmationResolver((async () => ({
        approved: true, reason: 'ok', audit: { outcome: 'approved', fresh: 'yes' },
      })) as never);
      const result = await resolveUnattendedConfirmation({ info: command, source: 'im' });
      expect(result.audit.fresh).toBeUndefined();
    });
  });

  it('restores the fail-closed default when the resolver is cleared', async () => {
    setUnattendedConfirmationResolver(async () => ({ approved: true, reason: 'ok', audit: {} }));
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

  it('refuses scripting under the default policy — that cell ships as deny', () => {
    expect(mayUnattendedTierApproveBrowser(browserInfo({ browserOperationClass: 'scripting' }))).toBe(false);
  });

  /**
   * RETARGETED (2026-09-04 ruling). This used to read "refuses an
   * unclassified browser confirmation (treated as scripting)": defaulting the
   * missing class to `'scripting'` was itself the refusal, because that cell
   * had no allow tier. It has one now, so the fallback must refuse on its own
   * — otherwise a call nobody classified would inherit the opt-in.
   */
  it('refuses an unclassified browser confirmation even when scripting is opted in', () => {
    expect(mayUnattendedTierApproveBrowser(browserInfo())).toBe(false);

    useSettingsStore.setState({
      browserOperationPolicy: {
        attended: DEFAULT_BROWSER_OPERATION_POLICY.attended,
        unattended: { readOnly: 'allow', interactive: 'allow', scripting: 'allow' },
      },
    });
    expect(mayUnattendedTierApproveBrowser(browserInfo())).toBe(false);
    // ...while the class the user actually opted in IS approved by the tier.
    expect(mayUnattendedTierApproveBrowser(browserInfo({ browserOperationClass: 'scripting' })))
      .toBe(true);
  });

  // The tier reports what the policy says; the opt-in's site scoping lives in
  // `decideBrowserOperation` and must show through here unchanged.
  it('refuses an opted-in script on a site with no standing grant', () => {
    useSettingsStore.setState({
      browserOperationPolicy: {
        attended: DEFAULT_BROWSER_OPERATION_POLICY.attended,
        unattended: { readOnly: 'allow', interactive: 'allow', scripting: 'allow' },
      },
    });

    expect(mayUnattendedTierApproveBrowser(browserInfo({
      browserOperationClass: 'scripting',
      browserOrigin: 'https://never-granted.example',
    }))).toBe(false);
    expect(mayUnattendedTierApproveBrowser(browserInfo({
      browserOperationClass: 'scripting',
      browserOrigin: 'https://evil.com',
    }))).toBe(false);
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
