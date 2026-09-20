import { describe, expect, it } from 'vitest';
import { acceptConversationPermissionMode, withAcceptedPermissionMode } from './conversationPermissionMode';

describe('acceptConversationPermissionMode', () => {
  it('returns a member of the closed set and nothing else', () => {
    expect(acceptConversationPermissionMode('standard')).toBe('standard');
    expect(acceptConversationPermissionMode('smart')).toBe('smart');
    expect(acceptConversationPermissionMode('autonomous')).toBe('autonomous');
    for (const value of ['strict', 'Autonomous', '', null, undefined, 3, { mode: 'autonomous' }, ['autonomous']]) {
      expect(acceptConversationPermissionMode(value)).toBeUndefined();
    }
  });
});

describe('withAcceptedPermissionMode', () => {
  it('returns the same object for an entry without the key and for an entry with an accepted mode', () => {
    const plain = { id: 'c', title: 't' };
    const valid = { id: 'c', title: 't', permissionMode: 'smart' };
    expect(withAcceptedPermissionMode(plain)).toBe(plain);
    expect(withAcceptedPermissionMode(valid)).toBe(valid);
  });

  it('leaves out a refused mode and keeps every other field', () => {
    const entry = { id: 'c', title: 't', teamId: 'team-1', model: { providerId: 'p', modelId: 'm' }, permissionMode: 'strict' };
    const read = withAcceptedPermissionMode(entry);
    expect(read).toEqual({ id: 'c', title: 't', teamId: 'team-1', model: { providerId: 'p', modelId: 'm' } });
    expect('permissionMode' in read).toBe(false);
    expect(entry.permissionMode).toBe('strict');
  });
});
