import { describe, expect, it } from 'vitest';
import { isPluginOwnedAgent } from './agentSource';

describe('isPluginOwnedAgent', () => {
  it('claims only an agent whose source is a plugin', () => {
    expect(isPluginOwnedAgent({ source: { kind: 'plugin', plugin: 'weather@official' } })).toBe(true);
    expect(isPluginOwnedAgent({})).toBe(false);
    expect(isPluginOwnedAgent({ source: undefined })).toBe(false);
  });
});
