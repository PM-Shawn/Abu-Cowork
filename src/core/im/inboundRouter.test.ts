/**
 * InboundRouter Tests — platform-specific payload parsing
 */
import { describe, it, expect } from 'vitest';
import { parseInboundMessage } from './inboundRouter';

describe('parseInboundMessage', () => {
  describe('D-Chat', () => {
    it('parses basic message', () => {
      const msg = parseInboundMessage('dchat', {
        sender: { uid: 'u1', nickname: '张三' },
        message: { text: 'hello world', vchannel_id: 'vc1', vchannel_name: '技术群' },
      });
      expect(msg).not.toBeNull();
      expect(msg!.senderId).toBe('u1');
      expect(msg!.senderName).toBe('张三');
      expect(msg!.text).toBe('hello world');
      expect(msg!.platform).toBe('dchat');
      expect(msg!.replyContext.vchannelId).toBe('vc1');
    });

    it('detects @Abu mention and strips it', () => {
      const msg = parseInboundMessage('dchat', {
        sender: { uid: 'u1', nickname: '张三' },
        message: { text: '@Abu 帮我查日志', vchannel_id: 'vc1' },
      });
      expect(msg!.isMention).toBe(true);
      expect(msg!.text).toBe('帮我查日志');
    });

    it('skips bot messages', () => {
      const msg = parseInboundMessage('dchat', {
        sender: { uid: 'bot1', nickname: 'Bot', is_bot: true },
        message: { text: 'auto reply', vchannel_id: 'vc1' },
      });
      expect(msg).toBeNull();
    });

    it('detects direct messages', () => {
      const msg = parseInboundMessage('dchat', {
        sender: { uid: 'u1', nickname: '张三' },
        message: { text: 'hello', vchannel_id: 'vc1' },
        chat_type: 'direct',
      });
      expect(msg!.isDirect).toBe(true);
    });
  });

  describe('Feishu', () => {
    it('parses event callback format', () => {
      const msg = parseInboundMessage('feishu', {
        event: {
          message: {
            chat_id: 'oc_123',
            message_id: 'om_456',
            content: JSON.stringify({ text: '帮我分析告警' }),
            chat_type: 'group',
          },
          sender: {
            sender_id: { open_id: 'ou_abc' },
            sender_type: 'user',
          },
        },
      });
      expect(msg).not.toBeNull();
      expect(msg!.senderId).toBe('ou_abc');
      expect(msg!.text).toBe('帮我分析告警');
      expect(msg!.platform).toBe('feishu');
      expect(msg!.replyContext.chatId).toBe('oc_123');
      expect(msg!.replyContext.messageId).toBe('om_456');
    });

    it('detects p2p (direct) messages', () => {
      const msg = parseInboundMessage('feishu', {
        event: {
          message: {
            chat_id: 'oc_123',
            message_id: 'om_456',
            content: JSON.stringify({ text: 'hello' }),
            chat_type: 'p2p',
          },
          sender: {
            sender_id: { open_id: 'ou_abc' },
            sender_type: 'user',
          },
        },
      });
      expect(msg!.isDirect).toBe(true);
    });
  });

  describe('DingTalk', () => {
    it('parses robot callback format', () => {
      const msg = parseInboundMessage('dingtalk', {
        text: { content: '查看发布记录' },
        senderNick: '李四',
        senderStaffId: 'staff123',
        conversationType: '2', // group
        conversationId: 'conv1',
        sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=xxx',
        atUsers: [{ dingtalkId: 'bot1' }],
      });
      expect(msg).not.toBeNull();
      expect(msg!.senderId).toBe('staff123');
      expect(msg!.senderName).toBe('李四');
      expect(msg!.text).toBe('查看发布记录');
      expect(msg!.isMention).toBe(true);
      expect(msg!.isDirect).toBe(false);
      expect(msg!.replyContext.sessionWebhook).toContain('sendBySession');
    });

    it('detects private messages', () => {
      const msg = parseInboundMessage('dingtalk', {
        text: { content: 'hello' },
        senderNick: '李四',
        senderStaffId: 'staff123',
        conversationType: '1', // private
        conversationId: 'conv1',
      });
      expect(msg!.isDirect).toBe(true);
    });
  });

  describe('Slack', () => {
    it('parses Events API message', () => {
      const msg = parseInboundMessage('slack', {
        event: {
          type: 'message',
          text: '<@U12345> help me debug',
          user: 'U67890',
          channel: 'C111',
          thread_ts: '1234567890.123456',
          channel_type: 'channel',
        },
      });
      expect(msg).not.toBeNull();
      expect(msg!.senderId).toBe('U67890');
      expect(msg!.text).toBe('help me debug');
      expect(msg!.isMention).toBe(true);
      expect(msg!.replyContext.channelId).toBe('C111');
      expect(msg!.replyContext.threadTs).toBe('1234567890.123456');
    });

    it('skips bot messages (subtype)', () => {
      const msg = parseInboundMessage('slack', {
        event: {
          type: 'message',
          subtype: 'bot_message',
          text: 'auto reply',
          user: 'U_BOT',
          channel: 'C111',
        },
      });
      expect(msg).toBeNull();
    });

    it('detects DM', () => {
      const msg = parseInboundMessage('slack', {
        event: {
          type: 'message',
          text: 'hello',
          user: 'U67890',
          channel: 'D111',
          channel_type: 'im',
        },
      });
      expect(msg!.isDirect).toBe(true);
    });
  });

  describe('WeCom', () => {
    it('parses text message', () => {
      const msg = parseInboundMessage('wecom', {
        MsgType: 'text',
        Content: '@Abu 检查服务状态',
        From: { UserId: 'wx_user1', Name: '王五' },
        ChatId: 'chat_group1',
      });
      expect(msg).not.toBeNull();
      expect(msg!.senderId).toBe('wx_user1');
      expect(msg!.senderName).toBe('王五');
      expect(msg!.text).toBe('检查服务状态');
      expect(msg!.isMention).toBe(true);
      expect(msg!.replyContext.chatid).toBe('chat_group1');
    });

    it('skips non-text messages', () => {
      const msg = parseInboundMessage('wecom', {
        MsgType: 'image',
        Content: '',
      });
      expect(msg).toBeNull();
    });
  });

  describe('unknown platform', () => {
    it('returns null', () => {
      const msg = parseInboundMessage('telegram', { text: 'hello' });
      expect(msg).toBeNull();
    });
  });
});
