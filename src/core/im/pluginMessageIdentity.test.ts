import { describe, expect, it } from 'vitest';
import { extractPluginInboundMessageId } from './pluginMessageIdentity';

describe('extractPluginInboundMessageId', () => {
  it('uses an explicit manifest mapping before common fallback fields', () => {
    expect(extractPluginInboundMessageId({
      event: { message: { id: 'mapped-id' } },
      messageId: 'camel-fallback',
      MsgId: 'upper-fallback',
    }, 'event.message.id')).toBe('mapped-id');
  });

  it.each([
    ['message_key', 'message-key-id'],
    ['message_id', 'snake-message-id'],
    ['msg_id', 'snake-msg-id'],
  ] as const)('falls back to common snake-case %s', (field, value) => {
    expect(extractPluginInboundMessageId({ [field]: value })).toBe(value);
  });

  it.each([
    ['messageId', 'camel-message-id'],
    ['msgId', 'camel-msg-id'],
    ['msgid', 'lower-msg-id'],
  ] as const)('falls back to common camel/lowercase %s', (field, value) => {
    expect(extractPluginInboundMessageId({ [field]: value })).toBe(value);
  });

  it.each([
    ['MessageId', 'upper-camel-message-id'],
    ['MessageID', 'upper-id-message-id'],
    ['MsgId', 'upper-camel-msg-id'],
    ['MsgID', 'upper-id-msg-id'],
  ] as const)('falls back to common uppercase %s', (field, value) => {
    expect(extractPluginInboundMessageId({ [field]: value })).toBe(value);
  });

  it('returns undefined when no mapped or fallback ID exists', () => {
    expect(extractPluginInboundMessageId({ text: 'hello' }, 'event.missing.id')).toBeUndefined();
  });

  it('treats empty mapped and fallback values as missing', () => {
    expect(extractPluginInboundMessageId({
      event: { message: { id: '' } },
      messageId: '',
      MsgId: null,
      msg_id: undefined,
    }, 'event.message.id')).toBeUndefined();
  });
});
