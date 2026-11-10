import { describe, expect, it } from 'vitest';
import { describeConnectorTarget, shownRecipients } from './connectorActionTarget';
import { __resetTaskGrantsForTests, grantTask, hasTaskGrant } from './taskGrants';

describe('connectorActionTarget', () => {
  describe('describeConnectorTarget', () => {
    it('reads the recipients and the content of a mail', () => {
      const target = describeConnectorTarget({ to: 'client@partner.com', cc: ['boss@corp.com'], subject: '报价', body: '您好，附件是报价单。' });
      expect(target.recipients).toEqual(['client@partner.com', 'boss@corp.com']);
      expect(target.preview).toBe('报价 您好，附件是报价单。');
    });

    it('reads chat ids, Feishu receive ids and phone numbers', () => {
      expect(describeConnectorTarget({ chat_id: 'oc_123', text: 'hi' }).recipients).toEqual(['oc_123']);
      expect(describeConnectorTarget({ receive_id: 'ou_9', receive_id_type: 'open_id', content: '{"text":"x"}', msg_type: 'text' }).recipients)
        .toEqual(['ou_9']);
      expect(describeConnectorTarget({ phoneNumber: 13800138000, message: '验证码 1234' }).recipients).toEqual(['13800138000']);
      expect(describeConnectorTarget({ channel: '#sales', text: 'x' }).recipients).toEqual(['#sales']);
    });

    it('does not take a setting of a field for the content or a recipient', () => {
      const target = describeConnectorTarget({ receive_id: 'ou_9', receive_id_type: 'open_id', msg_type: 'text', content: '周报已发' });
      expect(target.preview).toBe('周报已发');
      expect(target.recipients).toEqual(['ou_9']);
    });

    it('splits a comma-separated list and reads address objects', () => {
      expect(describeConnectorTarget({ to: 'a@x.com, b@y.com；c@z.com' }).recipients).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
      expect(describeConnectorTarget({ recipients: [{ name: '张三', email: 'zs@x.com' }, { emailAddress: 'ls@x.com' }] }).recipients)
        .toEqual(['zs@x.com', 'ls@x.com']);
    });

    it('reads a message object one level down', () => {
      const target = describeConnectorTarget({ message: { to: ['a@x.com'], subject: 'Hi', body: { content: 'Hello there' } } });
      expect(target.recipients).toEqual(['a@x.com']);
      expect(target.preview).toBe('Hi Hello there');
    });

    it('keys the same recipients the same way, whatever the order, case or content', () => {
      const a = describeConnectorTarget({ to: ['A@x.com', 'b@y.com'], body: 'one' });
      const b = describeConnectorTarget({ to: ['b@y.com', 'a@x.com'], body: 'two' });
      expect(a.recipientKey).toBe(b.recipientKey);
      expect(describeConnectorTarget({ to: 'c@z.com', body: 'one' }).recipientKey).not.toBe(a.recipientKey);
    });

    it('keys a call with no recipient field by its other fields, never by its content', () => {
      const first = describeConnectorTarget({ text: 'hi' });
      expect(first.recipients).toEqual([]);
      expect(describeConnectorTarget({ text: 'again' }).recipientKey).toBe(first.recipientKey);
      // An unknown target field still separates two sends.
      expect(describeConnectorTarget({ dst: 'room-1', text: 'x' }).recipientKey)
        .not.toBe(describeConnectorTarget({ dst: 'room-2', text: 'x' }).recipientKey);
    });

    it('puts the content on one line and cuts it short', () => {
      const target = describeConnectorTarget({ to: 'a@x.com', text: `line one\n\nline two ${'字'.repeat(200)}` });
      expect(target.preview.startsWith('line one line two ')).toBe(true);
      expect(target.preview.length).toBe(81);
      expect(target.preview.endsWith('…')).toBe(true);
    });

    it('returns nothing for an empty input', () => {
      expect(describeConnectorTarget({})).toEqual({ recipients: [], preview: '', recipientKey: '[]' });
    });
  });

  describe('shownRecipients', () => {
    it('shows five and counts the rest', () => {
      const target = describeConnectorTarget({ to: Array.from({ length: 8 }, (_, i) => `u${i}@x.com`) });
      expect(shownRecipients(target)).toEqual({ shown: ['u0@x.com', 'u1@x.com', 'u2@x.com', 'u3@x.com', 'u4@x.com'], more: 3 });
    });

    it('cuts a long recipient short', () => {
      const shown = shownRecipients(describeConnectorTarget({ to: `${'a'.repeat(100)}@x.com` })).shown[0];
      expect(shown.length).toBe(61);
    });
  });
});

const key = (input: Record<string, unknown>) => describeConnectorTarget(input).recipientKey;

describe('connector send grant · more cases', () => {
  it('keys the same recipients to the same grant in any order and case', () => {
    expect(key({ to: ['b@x.com', 'a@x.com'], text: 'hi' })).toBe(key({ to: ['A@x.com', 'b@x.com'], text: 'other text' }));
  });

  it('asks again for an added recipient, a cc or a bcc', () => {
    const base = key({ to: 'a@x.com', text: 'hi' });
    expect(key({ to: ['a@x.com', 'c@x.com'], text: 'hi' })).not.toBe(base);
    expect(key({ to: 'a@x.com', cc: 'c@x.com', text: 'hi' })).not.toBe(base);
    expect(key({ to: 'a@x.com', bcc: 'c@x.com', text: 'hi' })).not.toBe(base);
  });

  it('reads a Graph-style toRecipients list and a recipient one object down', () => {
    expect(describeConnectorTarget({ message: { toRecipients: [{ emailAddress: { address: 'a@x.com' } }], subject: 's' } }).recipients)
      .toEqual(['a@x.com']);
    expect(describeConnectorTarget({ message: { to: 'a@x.com', text: 'hi' } }).recipients).toEqual(['a@x.com']);
  });

  it('covers a second message to the same person within the half hour, not another tool or another person', () => {
    __resetTaskGrantsForTests();
    const subject = (tool: string, input: Record<string, unknown>) => JSON.stringify([tool, key(input)]);
    grantTask('connector-tool', 'c1', subject('srv__send_email', { to: 'a@x.com', text: 'one' }), 0);
    expect(hasTaskGrant('connector-tool', 'c1', subject('srv__send_email', { to: 'a@x.com', text: 'two' }), 1000)).toBe(true);
    expect(hasTaskGrant('connector-tool', 'c1', subject('srv__send_email', { to: 'z@x.com', text: 'two' }), 1000)).toBe(false);
    expect(hasTaskGrant('connector-tool', 'c1', subject('srv__send_sms', { to: 'a@x.com', text: 'two' }), 1000)).toBe(false);
    expect(hasTaskGrant('connector-tool', 'c2', subject('srv__send_email', { to: 'a@x.com', text: 'two' }), 1000)).toBe(false);
    expect(hasTaskGrant('connector-tool', 'c1', subject('srv__send_email', { to: 'a@x.com', text: 'two' }), 30 * 60 * 1000)).toBe(false);
  });

  // the recipient is looked for at the top of the input and one object
  // down. A call shaped `{ request: { message: { to } } }` yields no recipient and the key `[]`,
  // so approving a send to one person lets the same tool send to anyone else for 30 minutes,
  // and the ask names nobody. When no recipient is found, the key should be built from the
  // whole input without the content fields (at any depth), as it is for a flat input.
  it('asks again for a different recipient two objects down', () => {
    expect(key({ request: { message: { to: 'a@x.com', text: 'hi' } } }))
      .not.toBe(key({ request: { message: { to: 'b@x.com', text: 'hi' } } }));
  });
});
