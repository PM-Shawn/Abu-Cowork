import { describe, expect, it } from 'vitest';
import { classifyConnectorAction, connectorServerWrites, toolNameWords } from './connectorActionPolicy';

describe('connectorActionPolicy', () => {
  describe('toolNameWords', () => {
    it('splits snake, camel, dotted and kebab names into lower-case words', () => {
      expect(toolNameWords('outlook_send_mail')).toEqual(['outlook', 'send', 'mail']);
      expect(toolNameWords('chat.postMessage')).toEqual(['chat', 'post', 'message']);
      expect(toolNameWords('im.v1.message.create')).toEqual(['im', 'v1', 'message', 'create']);
      expect(toolNameWords('HTTPSendRequest')).toEqual(['http', 'send', 'request']);
      expect(toolNameWords('send-dm')).toEqual(['send', 'dm']);
    });

    it('returns nothing for an empty or symbol-only name', () => {
      expect(toolNameWords('')).toEqual([]);
      expect(toolNameWords('__')).toEqual([]);
    });
  });

  describe('sending to other people', () => {
    it.each([
      'corpmail__send_email',
      'gmail__sendMessage',
      'slack__chat.postMessage',
      'feishu__im.v1.message.create',
      'dingtalk__create_message',
      'wecom__send_text',
      'twitter__post_tweet',
      'mail__reply_to_thread',
      'mail__forward_email',
      'drive__share_file',
      'calendar__invite_attendees',
      'outlook__send_draft',
    ])('%s asks as a send', (name) => {
      expect(classifyConnectorAction(name)).toBe('send');
    });

    it('does not count a draft saved in the user\'s own mailbox as a send', () => {
      expect(classifyConnectorAction('gmail__create_draft')).toBeNull();
      expect(classifyConnectorAction('outlook__update_draft')).toBeNull();
    });
  });

  describe('deleting and money', () => {
    it.each([
      ['drive__delete_file', 'destructive'],
      ['mail__trash_message', 'destructive'],
      ['db__drop_table', 'destructive'],
      ['crm__purge_records', 'destructive'],
      ['pay__transfer_funds', 'money'],
      ['shop__refund_order', 'money'],
      ['wallet__pay_invoice', 'money'],
    ] as const)('%s → %s', (name, expected) => {
      expect(classifyConnectorAction(name)).toBe(expected);
    });

    it('ranks money above deleting and sending when a name says several', () => {
      expect(classifyConnectorAction('bank__pay_and_delete')).toBe('money');
      expect(classifyConnectorAction('mail__delete_sent_messages')).toBe('destructive');
    });

    it('reads an organization connector the same way', () => {
      expect(classifyConnectorAction('enterprise__oa__send_notice')).toBe('send');
      expect(classifyConnectorAction('enterprise__oa__list_notices')).toBeNull();
    });
  });

  describe('reading', () => {
    it.each([
      'gmail__get_message',
      'gmail__list_messages',
      'gmail__search_emails',
      'slack__read_channel_posts',
      'feishu__fetch_reply',
      'drive__download_file',
      'mail__count_sent_messages',
      'crm__find_deleted_records',
      'shop__export_payments',
    ])('%s does not ask', (name) => {
      expect(classifyConnectorAction(name)).toBeNull();
    });

    it('does not ask for a tool whose name is about nothing it sends', () => {
      expect(classifyConnectorAction('weather__forecast')).toBeNull();
    });
  });

  describe('failing closed: an action verb anywhere in the name asks', () => {
    it.each([
      ['mail__check_and_send_email', 'send'],
      ['db__read_then_delete', 'destructive'],
      ['db__get_and_publish', 'send'],
      ['files__overwrite_file', 'destructive'],
      ['db__execute_sql', 'destructive'],
      ['shop__cancel_order', 'destructive'],
      ['mail__archive_thread', 'destructive'],
      ['git__merge_pull_request', 'destructive'],
      ['cache__clear_cache', 'destructive'],
      ['cloud__terminate_instance', 'destructive'],
      ['files__replace_in_file', 'destructive'],
      ['crm__update_record', 'change'],
      ['notes__create_note', 'change'],
      ['sheet__update_cell', 'change'],
      ['sheet__update_sort_order', 'change'],
      ['crm__get_and_update_contact', 'change'],
      ['bank__check_balance_then_transfer', 'money'],
      ['oa__查询并删除', 'destructive'],
      ['oa__获取后覆盖', 'destructive'],
      ['oa__合并文档', 'destructive'],
      ['oa__更新记录', 'change'],
    ] as const)('%s → %s', (name, expected) => {
      expect(classifyConnectorAction(name)).toBe(expected);
    });

    it('keeps a name that only reads, or only names a noun of an action, free', () => {
      for (const name of [
        'git__get_merge_request', 'shop__get_charge', 'mail__list_archive', 'chat__list_posts',
        'chat__get_reply', 'mail__search_sent', 'db__find_deleted_records', 'shop__list_orders',
        'git__list_pull_requests',
      ]) {
        expect(classifyConnectorAction(name), name).toBeNull();
      }
    });

    it('asks about an unknown verb when the connector has tools that write, and not when it only reads', () => {
      expect(classifyConnectorAction('crm__sync_contacts_now2')).toBe('change');
      expect(classifyConnectorAction('crm__frobnicate', { serverWrites: true })).toBe('change');
      expect(classifyConnectorAction('crm__frobnicate', { serverWrites: false })).toBeNull();
      expect(classifyConnectorAction('crm__frobnicate')).toBeNull();
      // A read verb alone never asks, even on a connector that writes.
      expect(classifyConnectorAction('crm__list_contacts', { serverWrites: true })).toBeNull();
      // The server's own word that a tool is read-only is no reason to relax: it is not an input here.
    });

    it('tells a connector that writes from one that only reads', () => {
      expect(connectorServerWrites([{ name: 'crm__list_contacts' }, { name: 'crm__get_contact' }])).toBe(false);
      expect(connectorServerWrites([{ name: 'crm__list_contacts' }, { name: 'crm__delete_contact' }])).toBe(true);
      expect(connectorServerWrites([{ name: 'crm__weather', description: 'Updates the forecast cache' }])).toBe(true);
    });
  });

  describe('synonyms and Chinese names', () => {
    it.each([
      ['bank__wire_funds', 'money'],
      ['pay__create_payment', 'money'],
      ['stripe__create_charge', 'money'],
      ['shop__place_order', 'money'],
      ['wallet__make_payment', 'money'],
      ['billing__send_invoice', 'money'],
      ['shop__checkout_cart', 'money'],
      ['push__push_notification', 'send'],
      ['mq__dispatch_message', 'send'],
      ['mail__deliver', 'send'],
      ['cms__publish_article', 'send'],
      ['oss__upload_report', 'send'],
      ['crm__remove_record', 'destructive'],
      ['drive__revoke_access', 'destructive'],
      ['db__destroy_instance', 'destructive'],
    ] as const)('%s → %s', (name, expected) => {
      expect(classifyConnectorAction(name)).toBe(expected);
    });

    it('keeps a word about orders or payments that makes nothing a payment', () => {
      expect(classifyConnectorAction('shop__list_orders')).toBeNull();
      expect(classifyConnectorAction('shop__get_payment_status')).toBeNull();
    });
  });

  describe('Chinese and pinyin names', () => {
    it.each([
      ['qiyeweixin__发送消息', 'send'],
      ['dingtalk__发群公告', 'send'],
      ['feishu__回复评论', 'send'],
      ['oa__转发公文', 'send'],
      ['oa__删除文件', 'destructive'],
      ['oa__清空回收站', 'destructive'],
      ['oa__撤销审批', 'destructive'],
      ['pay__支付订单', 'money'],
      ['bank__转账', 'money'],
      ['shop__下单', 'money'],
      ['shop__退款', 'money'],
      ['wecom__fasong_xiaoxi', 'send'],
      ['oa__shanchu_wenjian', 'destructive'],
      ['pay__zhifu', 'money'],
      ['bank__zhuanzhang', 'money'],
      ['shop__xiadan', 'money'],
    ] as const)('%s → %s', (name, expected) => {
      expect(classifyConnectorAction(name)).toBe(expected);
    });

    it('reads a name that starts by reading as reading', () => {
      expect(classifyConnectorAction('oa__查询发送记录')).toBeNull();
      expect(classifyConnectorAction('oa__获取删除日志')).toBeNull();
      expect(classifyConnectorAction('oa__chaxun_fasong_jilu')).toBeNull();
    });

    it('does not read the 发 of an invoice or of discovering as sending', () => {
      expect(classifyConnectorAction('tax__发票验真')).toBeNull();
      expect(classifyConnectorAction('kb__发现热点')).toBeNull();
    });
  });

  describe('the description, when the name says nothing', () => {
    it('takes the action its opening names', () => {
      expect(classifyConnectorAction('im__msg_tool', { description: 'Sends a message to a group chat.' })).toBe('send');
      expect(classifyConnectorAction('im__tool_1', { description: '发送消息到指定群聊。参数：chat_id' })).toBe('send');
      expect(classifyConnectorAction('fs__entry', { description: 'Deletes the given entry permanently' })).toBe('destructive');
      expect(classifyConnectorAction('im__do', { description: 'Use this tool to send a reply to the user.' })).toBe('send');
    });

    it('does not let a description overrule the name', () => {
      // The name reads: what its description goes on about does not matter.
      expect(classifyConnectorAction('mail__list_messages', { description: 'Sends nothing; lists messages.' })).toBeNull();
      expect(classifyConnectorAction('mail__send_email', { description: 'Lists the outbox.' })).toBe('send');
    });

    it('does not read a later clause of the description', () => {
      expect(classifyConnectorAction('im__history', { description: 'Returns the chat history. Each item says who sent it.' })).toBeNull();
      // Creating an event is a change; what the later clause says about invitations does not make it a send.
      expect(classifyConnectorAction('cal__event', { description: 'Creates an event. Attendees get an invitation sent to them.' })).toBe('change');
    });
  });

  describe('openWorldHint', () => {
    it('never makes a tool ask by itself', () => {
      expect(classifyConnectorAction('tracker__create_ticket', { openWorldHint: true })).toBe('change');
      expect(classifyConnectorAction('docs__update_page', { openWorldHint: true, description: 'Updates a page.' })).toBe('change');
      expect(classifyConnectorAction('misc__frobnicate', { openWorldHint: true })).toBeNull();
    });

    it('confirms a description that speaks of sending past its opening', () => {
      const description = 'Creates a calendar event. Each attendee gets an invitation that the server sends by email.';
      expect(classifyConnectorAction('cal__create_event', { description })).toBe('change');
      expect(classifyConnectorAction('cal__create_event', { description, openWorldHint: true })).toBe('send');
    });

    it('does not turn a reading tool into a send', () => {
      expect(classifyConnectorAction('mail__get_thread', { openWorldHint: true, description: 'Gets a thread. Replies are sent later.' })).toBeNull();
    });
  });

  describe('the server annotation only tightens', () => {
    it('asks when the server says a tool destroys something', () => {
      expect(classifyConnectorAction('notes__archive_all', { destructiveHint: true })).toBe('destructive');
      // A read verb in front does not let a server-declared destructive tool through.
      expect(classifyConnectorAction('cache__get_and_clear', { destructiveHint: true })).toBe('destructive');
    });

    it('still asks for a send the server calls harmless', () => {
      expect(classifyConnectorAction('mail__send_email', { destructiveHint: false })).toBe('send');
    });

    it('keeps the name verdict when the hint is absent', () => {
      expect(classifyConnectorAction('notes__archive_all', {})).toBe('destructive');
      expect(classifyConnectorAction('notes__archive_all', undefined)).toBe('destructive');
    });
  });

  describe('what it does not classify', () => {
    it('leaves the browser servers to their own gate', () => {
      expect(classifyConnectorAction('abu-browser__click')).toBeNull();
      expect(classifyConnectorAction('abu-browser-bridge__fill', { destructiveHint: true })).toBeNull();
    });

    it('leaves built-in tools and unparseable names alone', () => {
      expect(classifyConnectorAction('send_file')).toBeNull();
      expect(classifyConnectorAction('write_file')).toBeNull();
      expect(classifyConnectorAction('')).toBeNull();
    });
  });
});

describe('connectorActionPolicy — misleading names', () => {
  describe('caught, as it should be', () => {
    it.each([
      ['a chat post', 'slack__post_message', 'send'],
      ['camelCase send', 'mail__sendMessage', 'send'],
      ['dotted create-message (Feishu)', 'feishu__im.v1.message.create', 'send'],
      ['send a draft that waits in the mailbox', 'mail__send_draft', 'send'],
      ['share to the outside', 'drive__share_externally', 'send'],
      ['notify a team', 'bot__notifyTeam', 'send'],
      ['a refund', 'pay__refund_order', 'money'],
      ['a delete', 'drive__delete_file', 'destructive'],
      ['a purge', 'db__purge_rows', 'destructive'],
    ])('%s', (_label, name, kind) => {
      expect(classifyConnectorAction(name)).toBe(kind);
    });

    it('saving a draft is not sending it', () => {
      expect(classifyConnectorAction('mail__create_draft')).toBeNull();
      expect(classifyConnectorAction('mail__save_draft')).toBeNull();
    });

    it('a server annotation only tightens, never relaxes', () => {
      // destructiveHint:false cannot un-ask a name that reads as a send.
      expect(classifyConnectorAction('mail__send_message', { destructiveHint: false })).toBe('send');
      // destructiveHint:true makes an otherwise-quiet read ask.
      expect(classifyConnectorAction('mail__get_messages', { destructiveHint: true })).toBe('destructive');
    });
  });

  describe('names that look like gaps, and how they are classified now', () => {
    // Each of these asks.
    const closed: Array<[string, string, string]> = [
      ['submit_form (a filing/order submit)', 'gov__submit_form', 'send'],
      ['upload_report (data leaves for a service)', 'oss__upload_report', 'send'],
      ['push_to_partner', 'edi__push_to_partner', 'send'],
      ['dispatch (send synonym)', 'mail__dispatch_message', 'send'],
      ['deliver (send synonym)', 'mail__deliver', 'send'],
      ['transmit (send synonym)', 'fax__transmit', 'send'],
      ['remove_record (delete synonym)', 'crm__remove_record', 'destructive'],
    ];
    for (const [label, name, kind] of closed) {
      it(`classifies ${label}`, () => {
        expect(classifyConnectorAction(name)).toBe(kind);
      });
    }

    // "sync" says nothing about who receives what, so it is a change that asks
    // once per task (a backup sync to the user's own cloud is the common case).
    it('asks for sync_to_cloud as a change', () => {
      expect(classifyConnectorAction('backup__sync_to_cloud')).toBe('change');
    });

    // "wire" is money on the browser side too, so `wire_funds` must ask.
    it('a connector "wire" money tool asks like a "transfer" one', () => {
      expect(classifyConnectorAction('bank__wire_funds')).toBe('money');
    });

    // The verb lists are not ASCII-only: a Chinese-named tool is gated too.
    it('a Chinese-named send tool is classified as a send', () => {
      expect(classifyConnectorAction('qiyeweixin__发送消息')).toBe('send');
    });
  });
});

const kindOf = (tool: string, hints?: Parameters<typeof classifyConnectorAction>[1]) => classifyConnectorAction(`srv__${tool}`, hints);

describe('classifyConnectorAction · more cases', () => {
  it.each([
    'get_order', 'list_invoices', 'query_payment_status', 'search_orders', 'read_mail', 'fetch_upload_status',
    'list_sent_messages', 'get_payment_receipt', 'check_payment', 'export_invoices', 'count_orders', 'download_upload',
    'verify_payment', 'retrieve_charge', 'preview_transfer', 'create_draft', 'draft_email', 'payment_status',
  ])('lets the read tool %s through', (tool) => {
    expect(kindOf(tool)).toBeNull();
  });

  it.each([
    ['send_email', 'send'], ['upload_file', 'send'], ['chat.postMessage', 'send'], ['im.v1.message.create', 'send'],
    ['send_draft', 'send'], ['create_payment', 'money'], ['submit_order', 'money'], ['transfer_funds', 'money'],
    ['wire_funds', 'money'], ['place_order', 'money'], ['send_invoice', 'money'], ['create_charge', 'money'],
    ['delete_file', 'destructive'], ['revoke_token', 'destructive'], ['remove_label', 'destructive'],
  ] as const)('asks for %s as a %s', (tool, expected) => {
    expect(kindOf(tool)).toBe(expected);
  });

  it.each([
    ['发送消息', 'send'], ['发送邮件', 'send'], ['发起审批', 'send'], ['删除文件', 'destructive'], ['撤销授权', 'destructive'],
    ['支付订单', 'money'], ['转账', 'money'], ['下单', 'money'],
    ['fasong_xiaoxi', 'send'], ['shanchu_wenjian', 'destructive'], ['zhifu_dingdan', 'money'], ['zhuanzhang', 'money'], ['xiadan', 'money'],
  ] as const)('classifies the Chinese or pinyin name %s as %s', (tool, expected) => {
    expect(kindOf(tool)).toBe(expected);
  });

  it.each([
    '查询订单', '查询发送记录', '获取支付状态', '获取上传状态', '发票查询', '开发文档', '发现', '发票管理',
    'chaxun_dingdan', 'chaxun_fasong', 'huoqu_zhifu',
  ])('lets the Chinese or pinyin read name %s through', (tool) => {
    expect(kindOf(tool)).toBeNull();
  });

  it('reads the description when the name says nothing, and not when it only reads', () => {
    expect(kindOf('run', { description: 'Sends a message to a channel' })).toBe('send');
    expect(kindOf('run', { description: '发送消息到群聊' })).toBe('send');
    expect(kindOf('run', { description: 'Deletes the file' })).toBe('destructive');
    expect(kindOf('run', { description: 'Get the list of orders' })).toBeNull();
    expect(kindOf('run', {})).toBeNull();
  });

  it('never asks on openWorldHint alone, and lets destructiveHint only add an ask', () => {
    expect(kindOf('run', { openWorldHint: true })).toBeNull();
    expect(kindOf('get_x', { destructiveHint: true })).toBe('destructive');
    expect(kindOf('send_message', { description: 'read only', destructiveHint: false })).toBe('send');
  });

  it('classifies a name with no tool part (an empty tool name) as nothing, whatever its description says', () => {
    expect(classifyConnectorAction('srv__', { description: 'Sends a message to a channel' })).toBeNull();
  });

  // A read verb clears a tool only when no action verb follows it:
  // `get_and_delete_file`, `list_then_send`, 「查询并发送」 read data and then act on it.
  it.each([['get_and_delete_file', 'destructive'], ['list_then_send', 'send'], ['查询并发送', 'send']] as const)(
    'asks for %s although it opens with a read verb',
    (tool, expected) => {
      expect(kindOf(tool)).toBe(expected);
    },
  );
});
