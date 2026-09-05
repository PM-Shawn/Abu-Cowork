/**
 * The run-settlement notification handler: the bridge's half of the channel
 * that releases a finished run's extension tab claims.
 *
 * What these pin, in order of how badly getting them wrong would hurt:
 *  - a settlement NEVER releases the whole conversation (a bare `ownerId` is
 *    read as the run key `main`, not as "every run") — the scope rule
 *    `releaseExtensionTabs`' own doc states;
 *  - only this method is answered; anything else the app ever notifies about
 *    falls through untouched;
 *  - a notification with no owner releases nothing, since an owner-less
 *    release would be unbounded.
 */
import { describe, expect, it, vi } from 'vitest';
import { ABU_RUN_SETTLED_NOTIFICATION } from './types.js';
import {
  MAIN_RUN_KEY,
  parseRunSettledParams,
  registerRunSettledHandler,
  type NotificationFallbackTarget,
} from './runSettled.js';

function targetWithHandler(release: (ownerId: unknown, runId?: unknown) => void) {
  const target: NotificationFallbackTarget = {};
  registerRunSettledHandler(target, release);
  return {
    target,
    notify: (method: string, params?: Record<string, unknown>) =>
      target.fallbackNotificationHandler!({ method, params }),
  };
}

describe('parseRunSettledParams', () => {
  it('keeps an explicit run key', () => {
    expect(parseRunSettledParams({ ownerId: 'conversation-a', runId: 'sar-1' }))
      .toEqual({ ownerId: 'conversation-a', runId: 'sar-1' });
  });

  it('reads a missing run key as the conversation\'s own loop, never as every run', () => {
    // The distinction this file exists for: `releaseExtensionTabs(ownerId)`
    // with no run key wipes EVERY run of the conversation — sibling
    // delegations and the main loop included, while they are still driving
    // their tabs. A run settling may only ever release itself.
    for (const params of [
      { ownerId: 'conversation-a' },
      { ownerId: 'conversation-a', runId: '' },
      { ownerId: 'conversation-a', runId: 42 },
      { ownerId: 'conversation-a', runId: null },
    ]) {
      expect(parseRunSettledParams(params)).toEqual({
        ownerId: 'conversation-a',
        runId: MAIN_RUN_KEY,
      });
    }
  });

  it('refuses a notification with no owner to release', () => {
    for (const params of [undefined, null, {}, { ownerId: '' }, { ownerId: 7 }, { runId: 'sar-1' }]) {
      expect(parseRunSettledParams(params)).toBeNull();
    }
  });
});

describe('registerRunSettledHandler', () => {
  it('releases exactly the settling run', async () => {
    const release = vi.fn();
    const { notify } = targetWithHandler(release);

    await notify(ABU_RUN_SETTLED_NOTIFICATION, { ownerId: 'conversation-a', runId: 'sar-1' });

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('conversation-a', 'sar-1');
  });

  it('releases the `main` pool, not the conversation, when the run key is missing', async () => {
    const release = vi.fn();
    const { notify } = targetWithHandler(release);

    await notify(ABU_RUN_SETTLED_NOTIFICATION, { ownerId: 'conversation-a' });

    expect(release).toHaveBeenCalledWith('conversation-a', MAIN_RUN_KEY);
    // The undefined-runId form is the conversation-wide release; a settlement
    // must never produce it.
    expect(release).not.toHaveBeenCalledWith('conversation-a', undefined);
  });

  it('releases nothing when the notification carries no owner', async () => {
    const release = vi.fn();
    const { notify } = targetWithHandler(release);

    await notify(ABU_RUN_SETTLED_NOTIFICATION, {});
    await notify(ABU_RUN_SETTLED_NOTIFICATION, undefined);

    expect(release).not.toHaveBeenCalled();
  });

  it('ignores every other notification method', async () => {
    const release = vi.fn();
    const { notify } = targetWithHandler(release);

    await notify('notifications/cancelled', { ownerId: 'conversation-a', runId: 'sar-1' });
    await notify('notifications/abu/somethingElse', { ownerId: 'conversation-a' });

    expect(release).not.toHaveBeenCalled();
  });

  it('leaves an already-installed fallback handler in charge of other methods', async () => {
    const release = vi.fn();
    const previous = vi.fn().mockResolvedValue(undefined);
    const target: NotificationFallbackTarget = { fallbackNotificationHandler: previous };
    registerRunSettledHandler(target, release);

    await target.fallbackNotificationHandler!({ method: 'notifications/other' });
    expect(previous).toHaveBeenCalledTimes(1);

    await target.fallbackNotificationHandler!({
      method: ABU_RUN_SETTLED_NOTIFICATION,
      params: { ownerId: 'conversation-a', runId: 'sar-1' },
    });
    expect(previous).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
