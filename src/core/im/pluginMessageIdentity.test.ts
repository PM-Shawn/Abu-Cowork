import { describe, it, expect } from 'vitest';
import { extractPluginInboundMessageId } from './pluginMessageIdentity';

describe('extractPluginInboundMessageId', () => {
  it('prefers the manifest-declared path, including a nested one', () => {
    expect(extractPluginInboundMessageId({ custom: { id: 'declared' }, msg_id: 'common' }, 'custom.id')).toBe('declared');
    expect(extractPluginInboundMessageId({ msg_id: 'common' }, 'custom.id')).toBe('common');
  });

  it('accepts the spellings that used to yield nothing, and stringifies scalars', () => {
    expect(extractPluginInboundMessageId({ msgId: 'a1' })).toBe('a1');
    expect(extractPluginInboundMessageId({ MsgID: 'a2' })).toBe('a2');
    expect(extractPluginInboundMessageId({ messageId: 'a3' })).toBe('a3');
    expect(extractPluginInboundMessageId({ event: { message: { message_id: 'a4' } } })).toBe('a4');
    expect(extractPluginInboundMessageId({ message_id: 12345 })).toBe('12345');
  });

  it('yields undefined rather than a junk id, so the caller keeps its fallback', () => {
    expect(extractPluginInboundMessageId({})).toBeUndefined();
    expect(extractPluginInboundMessageId({ msg_id: '   ' })).toBeUndefined();
    expect(extractPluginInboundMessageId({ msg_id: { nested: 1 } })).toBeUndefined();
    expect(extractPluginInboundMessageId({ msg_id: null, message_id: undefined })).toBeUndefined();
  });

  it('takes the first spelling that has a value, in declared order', () => {
    expect(extractPluginInboundMessageId({ message_key: 'k', msg_id: 'm' })).toBe('k');
  });
});
