import { describe, expect, it, vi } from 'vitest';
import {
  activateExclusiveAccountSession,
  registerAccountSessionDeactivator,
} from '@/core/account/sessionCoordinator';

describe('account session coordinator', () => {
  it('clears the other account before activating the new session', async () => {
    const order: string[] = [];
    const unregister = registerAccountSessionDeactivator('enterprise', async () => {
      order.push('clear-enterprise');
    });

    try {
      await activateExclusiveAccountSession('personal', async () => {
        order.push('save-personal');
      });
      expect(order).toEqual(['clear-enterprise', 'save-personal']);
    } finally {
      unregister();
    }
  });

  it('serializes competing account activations', async () => {
    const order: string[] = [];
    let releasePersonal!: () => void;
    const personalBlocked = new Promise<void>((resolve) => { releasePersonal = resolve; });
    const unregisterPersonal = registerAccountSessionDeactivator('personal', async () => {
      order.push('clear-personal');
    });
    const unregisterEnterprise = registerAccountSessionDeactivator('enterprise', async () => {
      order.push('clear-enterprise');
    });

    try {
      const personal = activateExclusiveAccountSession('personal', async () => {
        order.push('personal-start');
        await personalBlocked;
        order.push('personal-saved');
      });
      const enterprise = activateExclusiveAccountSession('enterprise', async () => {
        order.push('enterprise-saved');
      });

      await vi.waitFor(() => expect(order).toEqual(['clear-enterprise', 'personal-start']));
      releasePersonal();
      await Promise.all([personal, enterprise]);

      expect(order).toEqual([
        'clear-enterprise',
        'personal-start',
        'personal-saved',
        'clear-personal',
        'enterprise-saved',
      ]);
    } finally {
      unregisterPersonal();
      unregisterEnterprise();
    }
  });

  it('does not activate a new session when the old one cannot be cleared', async () => {
    const activate = vi.fn();
    const unregister = registerAccountSessionDeactivator('enterprise', async () => {
      throw new Error('storage unavailable');
    });

    try {
      await expect(activateExclusiveAccountSession('personal', activate)).rejects.toThrow('storage unavailable');
      expect(activate).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('restores the previous session when the new credential cannot be saved', async () => {
    const order: string[] = [];
    const unregister = registerAccountSessionDeactivator('enterprise', async () => {
      order.push('clear-enterprise');
      return {
        rollback: async () => { order.push('restore-enterprise'); },
        commit: async () => { order.push('revoke-enterprise'); },
      };
    });

    try {
      await expect(activateExclusiveAccountSession('personal', async () => {
        order.push('save-personal');
        throw new Error('personal storage unavailable');
      })).rejects.toThrow('personal storage unavailable');
      expect(order).toEqual(['clear-enterprise', 'save-personal', 'restore-enterprise']);
    } finally {
      unregister();
    }
  });

  it('restores the previous session when the pending login is cancelled during cleanup', async () => {
    const activate = vi.fn();
    const restore = vi.fn().mockResolvedValue(undefined);
    let current = true;
    const unregister = registerAccountSessionDeactivator('enterprise', async () => {
      current = false;
      return { rollback: restore };
    });

    try {
      await expect(activateExclusiveAccountSession('personal', activate, () => current)).resolves.toBe(false);
      expect(activate).not.toHaveBeenCalled();
      expect(restore).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });
});
