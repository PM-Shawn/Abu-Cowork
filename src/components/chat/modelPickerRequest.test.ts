import { describe, expect, it, vi } from 'vitest';
import { requestModelPicker, subscribeModelPickerRequest } from './modelPickerRequest';

describe('model picker request', () => {
  it('reaches every subscriber and stops after unsubscribing', () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeModelPickerRequest(first);
    subscribeModelPickerRequest(second);

    requestModelPicker();
    stopFirst();
    requestModelPicker();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('is a no-op with nobody listening', () => {
    expect(() => requestModelPicker()).not.toThrow();
  });
});
