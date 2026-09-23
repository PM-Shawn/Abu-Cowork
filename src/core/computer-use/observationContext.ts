import type { ComputerUseRunKey } from '@/core/agent/computerUseController';

export interface ComputerObservationContext {
  windowRef: string | null;
  stateId: string | null;
  screenshotId: string | null;
  scaleFactor: number;
  origin: { x: number; y: number };
}

export interface ComputerObservationBinding {
  windowRef: string | null;
  stateId: string | null;
}

function taskKey(key: ComputerUseRunKey): string {
  return `${key.conversationId}\u0000${key.loopId}`;
}

function validOptionalId(value: string | null): boolean {
  return value === null || (typeof value === 'string' && value.length > 0);
}

export function createComputerObservationContexts() {
  const contexts = new Map<string, ComputerObservationContext>();

  function record(
    key: ComputerUseRunKey,
    input: ComputerObservationContext,
  ): ComputerObservationContext {
    if (
      !validOptionalId(input.windowRef)
      || !validOptionalId(input.stateId)
      || !validOptionalId(input.screenshotId)
      || !Number.isFinite(input.scaleFactor)
      || input.scaleFactor <= 0
      || !Number.isFinite(input.origin?.x)
      || !Number.isFinite(input.origin?.y)
    ) {
      throw new Error('Computer Use observation context is invalid');
    }
    const context: ComputerObservationContext = {
      windowRef: input.windowRef,
      stateId: input.stateId,
      screenshotId: input.screenshotId,
      scaleFactor: input.scaleFactor,
      origin: { x: input.origin.x, y: input.origin.y },
    };
    contexts.set(taskKey(key), context);
    return context;
  }

  function get(key: ComputerUseRunKey): ComputerObservationContext | null {
    return contexts.get(taskKey(key)) ?? null;
  }

  function requireScreenshot(
    key: ComputerUseRunKey,
    screenshotId: string | null | undefined,
    binding?: ComputerObservationBinding,
  ): ComputerObservationContext {
    const context = get(key);
    if (!context || context.screenshotId === null) throw new Error('screenshot-required');
    if (typeof screenshotId !== 'string' || !screenshotId || screenshotId !== context.screenshotId) {
      throw new Error('screenshot-stale');
    }
    if (
      binding
      && (
        binding.windowRef !== context.windowRef
        || binding.stateId !== context.stateId
      )
    ) {
      throw new Error('screenshot-stale');
    }
    return context;
  }

  function toScreenCoords(
    key: ComputerUseRunKey,
    x: number,
    y: number,
  ): { x: number; y: number } {
    const context = get(key);
    if (!context) throw new Error('screenshot-required');
    return {
      x: Math.round(context.origin.x + x * context.scaleFactor),
      y: Math.round(context.origin.y + y * context.scaleFactor),
    };
  }

  function clear(key: ComputerUseRunKey): void {
    contexts.delete(taskKey(key));
  }

  function clearAll(): void {
    contexts.clear();
  }

  return { record, get, requireScreenshot, toScreenCoords, clear, clearAll };
}

export const computerObservationContexts = createComputerObservationContexts();
