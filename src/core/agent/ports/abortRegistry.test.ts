import { describe, it, expect, afterEach } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import {
  createInProcessAbortRegistry,
  getAbortRegistry,
  setAbortRegistry,
  type AbortRegistry,
} from './abortRegistry';

describe('createInProcessAbortRegistry', () => {
  afterEach(() => {
    // abortControllers is a module-level Map in chatStore.ts (not Zustand
    // state), so clean up explicitly per conversation id used below.
    useChatStore.getState().clearAbortController('conv-abort-a');
    useChatStore.getState().clearAbortController('conv-abort-b');
  });

  it('hasAbortController() is false before any controller is requested', () => {
    const registry = createInProcessAbortRegistry();
    expect(registry.hasAbortController('conv-abort-a')).toBe(false);
  });

  it('getAbortController() lazily creates a controller, then hasAbortController() sees it', () => {
    const registry = createInProcessAbortRegistry();
    const controller = registry.getAbortController('conv-abort-a');
    expect(controller).toBeInstanceOf(AbortController);
    expect(registry.hasAbortController('conv-abort-a')).toBe(true);
  });

  it('getAbortController() returns the SAME controller instance on repeated calls (no signal loss)', () => {
    const registry = createInProcessAbortRegistry();
    const first = registry.getAbortController('conv-abort-a');
    const second = registry.getAbortController('conv-abort-a');
    expect(second).toBe(first);
  });

  it('clearAbortController() removes the registered controller', () => {
    const registry = createInProcessAbortRegistry();
    registry.getAbortController('conv-abort-a');
    expect(registry.hasAbortController('conv-abort-a')).toBe(true);
    registry.clearAbortController('conv-abort-a');
    expect(registry.hasAbortController('conv-abort-a')).toBe(false);
  });

  it('clearAbortController(convId, owned) leaves a NEWER run\'s controller registered', () => {
    // Regression: a run tearing down asynchronously (its visible terminal
    // already published) must not delete the controller a newer run has since
    // registered for the same conversation — that would leave the live run's
    // Stop button inert.
    const registry = createInProcessAbortRegistry();
    const dying = registry.getAbortController('conv-abort-a');
    registry.clearAbortController('conv-abort-a');
    const replacement = registry.getAbortController('conv-abort-a');
    expect(replacement).not.toBe(dying);

    registry.clearAbortController('conv-abort-a', dying);

    expect(registry.hasAbortController('conv-abort-a')).toBe(true);
    expect(registry.getAbortController('conv-abort-a')).toBe(replacement);
  });

  it('clearAbortController(convId, owned) still clears while that controller is the registered one', () => {
    const registry = createInProcessAbortRegistry();
    const controller = registry.getAbortController('conv-abort-a');
    registry.clearAbortController('conv-abort-a', controller);
    expect(registry.hasAbortController('conv-abort-a')).toBe(false);
  });

  it('is scoped per conversation id', () => {
    const registry = createInProcessAbortRegistry();
    registry.getAbortController('conv-abort-a');
    expect(registry.hasAbortController('conv-abort-b')).toBe(false);
  });

  it('reflects registrations made outside the port on the next call (not cached)', () => {
    const registry = createInProcessAbortRegistry();
    expect(registry.hasAbortController('conv-abort-a')).toBe(false);
    useChatStore.getState().getAbortController('conv-abort-a');
    expect(registry.hasAbortController('conv-abort-a')).toBe(true);
  });
});

describe('getAbortRegistry / setAbortRegistry', () => {
  const defaultRegistry = getAbortRegistry();

  afterEach(() => {
    // restore the default in-process registry so other test files aren't affected
    setAbortRegistry(defaultRegistry);
  });

  it('getAbortRegistry() returns a working in-process registry by default', () => {
    const registry = getAbortRegistry();
    expect(typeof registry.hasAbortController).toBe('function');
    expect(typeof registry.getAbortController).toBe('function');
    expect(typeof registry.clearAbortController).toBe('function');
  });

  it('setAbortRegistry() swaps the module-level registry returned by getAbortRegistry()', () => {
    const stub: AbortRegistry = {
      hasAbortController: () => true,
      getAbortController: () => new AbortController(),
      clearAbortController: () => {},
    };
    setAbortRegistry(stub);
    expect(getAbortRegistry()).toBe(stub);
    expect(getAbortRegistry().hasAbortController('anything')).toBe(true);
  });
});
