import { describe, expect, it } from 'vitest';
import { createRunResourceSettlement } from './runResourceSettlement';

describe('runResourceSettlement', () => {
  it('resolves only after sealing and every already-started operation settles', async () => {
    let finish!: () => void;
    const underlying = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const owner = createRunResourceSettlement();
    const operation = owner.run(() => underlying);
    let settled = false;
    void owner.settlement.then(() => { settled = true; });

    owner.seal();
    await Promise.resolve();
    expect(settled).toBe(false);

    finish();
    await operation;
    await owner.settlement;
    expect(settled).toBe(true);
  });

  it('fails closed when a new operation arrives after sealing', async () => {
    const owner = createRunResourceSettlement();
    owner.seal();

    await expect(owner.run(async () => 'late')).rejects.toEqual(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });
});
