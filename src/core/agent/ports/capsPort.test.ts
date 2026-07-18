import { describe, it, expect, afterEach } from 'vitest';
import { useDiscoveredCapsStore } from '@/stores/discoveredCapabilitiesStore';
import {
  createInProcessCapsPort,
  getCapsPort,
  setCapsPort,
  type CapsPort,
} from './capsPort';

describe('createInProcessCapsPort', () => {
  afterEach(() => {
    useDiscoveredCapsStore.setState({ capabilities: {} });
  });

  it('get() returns undefined when nothing has been recorded', () => {
    const port = createInProcessCapsPort();
    expect(port.get('openai', 'gpt-4o')).toBeUndefined();
  });

  it('recordMaxOutputTokens() then get() reflects the write on the very next call', () => {
    const port = createInProcessCapsPort();
    port.recordMaxOutputTokens('openai', 'gpt-4o', 4096);
    expect(port.get('openai', 'gpt-4o')?.maxOutputTokens).toBe(4096);
  });

  it('recordContextWindow() then get() reflects the write', () => {
    const port = createInProcessCapsPort();
    port.recordContextWindow('anthropic', 'claude-x', 128000);
    expect(port.get('anthropic', 'claude-x')?.contextWindow).toBe(128000);
  });

  it('recordReasoningObserved() then get() reflects the write', () => {
    const port = createInProcessCapsPort();
    port.recordReasoningObserved('deepseek', 'deepseek-r1');
    expect(port.get('deepseek', 'deepseek-r1')?.isReasoningModel).toBe(true);
  });

  it('reflects store updates made outside the port on the next get() call (not cached)', () => {
    const port = createInProcessCapsPort();
    expect(port.get('p', 'm')).toBeUndefined();
    useDiscoveredCapsStore.getState().recordMaxOutputTokens('p', 'm', 2048);
    expect(port.get('p', 'm')?.maxOutputTokens).toBe(2048);
  });
});

describe('getCapsPort / setCapsPort', () => {
  const defaultPort = getCapsPort();

  afterEach(() => {
    // restore the default in-process port so other test files aren't affected
    setCapsPort(defaultPort);
  });

  it('getCapsPort() returns a working in-process port by default', () => {
    const port = getCapsPort();
    expect(typeof port.get).toBe('function');
    expect(typeof port.recordMaxOutputTokens).toBe('function');
    expect(typeof port.recordContextWindow).toBe('function');
    expect(typeof port.recordReasoningObserved).toBe('function');
  });

  it('setCapsPort() swaps the module-level port returned by getCapsPort()', () => {
    const stub: CapsPort = {
      get: () => ({ maxOutputTokens: 111, source: 'probed', updatedAt: 0 }),
      recordMaxOutputTokens: () => {},
      recordContextWindow: () => {},
      recordReasoningObserved: () => {},
    };
    setCapsPort(stub);
    expect(getCapsPort()).toBe(stub);
    expect(getCapsPort().get('a', 'b')?.maxOutputTokens).toBe(111);
  });
});
