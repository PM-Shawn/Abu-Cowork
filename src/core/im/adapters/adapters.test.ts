/**
 * IM Adapter Tests — formatOutbound, chunkContent, registry
 */
import { describe, it, expect } from 'vitest';
import type { AbuMessage } from './types';
import { DchatAdapter } from './dchat';
import { FeishuAdapter } from './feishu';
import { DingtalkAdapter } from './dingtalk';
import { WecomAdapter } from './wecom';
import { SlackAdapter } from './slack';
import { CustomAdapter } from './custom';
import { getAdapter, getAvailablePlatforms, registerAdapter } from './registry';
import { BaseAdapter } from './base';
import type { AdapterConfig } from './types';

// ── D-Chat ──

describe('DchatAdapter', () => {
  const adapter = new DchatAdapter();

  it('short message → plain text', () => {
    const msg: AbuMessage = { content: 'hello' };
    const payload = adapter.formatOutbound(msg) as { text: string; attachments?: unknown };
    expect(payload.text).toBe('hello');
    expect(payload.attachments).toBeUndefined();
  });

  it('long message → attachment format', () => {
    const msg: AbuMessage = {
      content: 'a'.repeat(3001),
      title: 'Test',
      color: 'danger',
      footer: 'Abu AI',
    };
    const payload = adapter.formatOutbound(msg) as {
      text: string;
      attachments: { title: string; text: string; color: string; footer: string }[];
    };
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].title).toBe('Test');
    expect(payload.attachments[0].color).toBe('#e53935');
    expect(payload.attachments[0].footer).toBe('Abu AI');
  });

  it('message with title → attachment format even if short', () => {
    const msg: AbuMessage = { content: 'short', title: 'Title' };
    const payload = adapter.formatOutbound(msg) as { attachments?: unknown };
    expect(payload.attachments).toBeDefined();
  });
});

// ── Feishu ──

describe('FeishuAdapter', () => {
  const adapter = new FeishuAdapter();

  it('formats interactive card', () => {
    const msg: AbuMessage = { content: 'hello', title: 'Title', color: 'success', footer: 'ft' };
    const payload = adapter.formatOutbound(msg) as {
      msg_type: string;
      card: {
        header: { title: { content: string }; template: string };
        elements: { tag: string; content?: string; elements?: { content: string }[] }[];
      };
    };
    expect(payload.msg_type).toBe('interactive');
    expect(payload.card.header.title.content).toBe('Title');
    expect(payload.card.header.template).toBe('green');
    expect(payload.card.elements[0].tag).toBe('markdown');
    expect(payload.card.elements[0].content).toBe('hello');
    // footer → note element
    expect(payload.card.elements[1].tag).toBe('note');
  });

  it('no title → no header', () => {
    const msg: AbuMessage = { content: 'text' };
    const payload = adapter.formatOutbound(msg) as { card: { header?: unknown } };
    expect(payload.card.header).toBeUndefined();
  });
});

// ── DingTalk ──

describe('DingtalkAdapter', () => {
  const adapter = new DingtalkAdapter();

  it('formats markdown message', () => {
    const msg: AbuMessage = { content: 'body', title: 'Alert', footer: 'Abu AI' };
    const payload = adapter.formatOutbound(msg) as {
      msgtype: string;
      markdown: { title: string; text: string };
    };
    expect(payload.msgtype).toBe('markdown');
    expect(payload.markdown.title).toBe('Alert');
    expect(payload.markdown.text).toContain('### Alert');
    expect(payload.markdown.text).toContain('body');
    expect(payload.markdown.text).toContain('Abu AI');
  });

  it('no title → default title', () => {
    const msg: AbuMessage = { content: 'text' };
    const payload = adapter.formatOutbound(msg) as { markdown: { title: string; text: string } };
    expect(payload.markdown.title).toBe('Abu AI');
    expect(payload.markdown.text).not.toContain('###');
  });
});

// ── WeCom ──

describe('WecomAdapter', () => {
  const adapter = new WecomAdapter();

  it('formats markdown message', () => {
    const msg: AbuMessage = { content: 'text', title: 'T', footer: 'F' };
    const payload = adapter.formatOutbound(msg) as {
      msgtype: string;
      markdown: { content: string };
    };
    expect(payload.msgtype).toBe('markdown');
    expect(payload.markdown.content).toContain('### T');
    expect(payload.markdown.content).toContain('text');
    expect(payload.markdown.content).toContain('> F');
  });

  it('byte-level chunking for Chinese text', () => {
    // Each Chinese char = 3 bytes in UTF-8
    // 4096 bytes ≈ 1365 Chinese chars
    const longContent = '你'.repeat(2000); // 6000 bytes > 4096
    const chunks = adapter.chunkContent(longContent);
    expect(chunks.length).toBeGreaterThan(1);

    const encoder = new TextEncoder();
    for (const chunk of chunks) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(4096);
    }
  });

  it('short content returns single chunk', () => {
    const chunks = adapter.chunkContent('短文本');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('短文本');
  });
});

// ── Slack ──

describe('SlackAdapter', () => {
  const adapter = new SlackAdapter();

  it('formats Block Kit payload', () => {
    const msg: AbuMessage = { content: '**bold**', title: 'Title', footer: 'footer' };
    const payload = adapter.formatOutbound(msg) as {
      blocks: { type: string; text?: { type: string; text: string }; elements?: unknown[] }[];
    };
    expect(payload.blocks).toHaveLength(3); // header + section + context
    expect(payload.blocks[0].type).toBe('header');
    expect(payload.blocks[1].type).toBe('section');
    expect(payload.blocks[2].type).toBe('context');
  });

  it('converts Markdown to mrkdwn', () => {
    const msg: AbuMessage = { content: '## Heading\n**bold**\n[link](http://x)\n~~del~~\n- item' };
    const payload = adapter.formatOutbound(msg) as {
      blocks: { text?: { text: string } }[];
    };
    const text = payload.blocks[0].text!.text;
    expect(text).toContain('*Heading*'); // ## → *bold*
    expect(text).toContain('*bold*'); // **bold** → *bold*
    expect(text).toContain('<http://x|link>'); // [link](url) → <url|text>
    expect(text).toContain('~del~'); // ~~del~~ → ~del~
    expect(text).toContain('• item'); // - → •
  });
});

// ── Custom ──

describe('CustomAdapter', () => {
  const adapter = new CustomAdapter();

  it('formats raw JSON', () => {
    const msg: AbuMessage = { content: 'data', title: 'T', color: 'warning', footer: 'F' };
    const payload = adapter.formatOutbound(msg) as {
      title: string;
      content: string;
      color: string;
      footer: string;
      timestamp: string;
    };
    expect(payload.content).toBe('data');
    expect(payload.title).toBe('T');
    expect(payload.color).toBe('warning');
    expect(payload.timestamp).toBeDefined();
  });
});

// ── BaseAdapter chunking ──

describe('BaseAdapter chunking', () => {
  // Concrete test adapter with small maxLength
  class TestAdapter extends BaseAdapter {
    readonly config: AdapterConfig = {
      platform: 'test',
      displayName: 'Test',
      maxLength: 50,
      chunkMode: 'newline',
      supportsMarkdown: false,
      supportsCard: false,
    };
    formatOutbound(message: AbuMessage): unknown {
      return { text: message.content };
    }
  }

  const adapter = new TestAdapter();

  it('short content → single chunk', () => {
    expect(adapter.chunkContent('hello')).toEqual(['hello']);
  });

  it('newline-aware chunking', () => {
    const content = 'line1\nline2\nline3\n' + 'a'.repeat(40) + '\n' + 'line4';
    const chunks = adapter.chunkContent(content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it('single long line → hard-cut fallback', () => {
    const longLine = 'x'.repeat(120);
    const chunks = adapter.chunkContent(longLine);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('length-mode chunking', () => {
    class LengthAdapter extends BaseAdapter {
      readonly config: AdapterConfig = {
        platform: 'test',
        displayName: 'Test',
        maxLength: 30,
        chunkMode: 'length',
        supportsMarkdown: false,
        supportsCard: false,
      };
      formatOutbound(message: AbuMessage): unknown {
        return { text: message.content };
      }
    }

    const la = new LengthAdapter();
    const chunks = la.chunkContent('a'.repeat(80));
    expect(chunks.length).toBeGreaterThan(1);
    // Non-last chunks should end with continuation marker
    expect(chunks[0]).toContain('...(续)');
    // Last chunk should NOT have the marker
    expect(chunks[chunks.length - 1]).not.toContain('...(续)');
  });
});

// ── Registry ──

describe('Adapter Registry', () => {
  it('getAdapter returns known adapters', () => {
    expect(getAdapter('dchat')).toBeDefined();
    expect(getAdapter('feishu')).toBeDefined();
    expect(getAdapter('dingtalk')).toBeDefined();
    expect(getAdapter('wecom')).toBeDefined();
    expect(getAdapter('slack')).toBeDefined();
    expect(getAdapter('custom')).toBeDefined();
  });

  it('getAdapter returns undefined for unknown', () => {
    expect(getAdapter('telegram')).toBeUndefined();
  });

  it('getAvailablePlatforms returns all 6', () => {
    const platforms = getAvailablePlatforms();
    expect(platforms).toHaveLength(6);
    const names = platforms.map((p) => p.platform);
    expect(names).toContain('dchat');
    expect(names).toContain('feishu');
    expect(names).toContain('slack');
  });

  it('registerAdapter adds a new platform', () => {
    class TestAdapter extends BaseAdapter {
      readonly config: AdapterConfig = {
        platform: 'test-reg',
        displayName: 'Test',
        maxLength: 1000,
        chunkMode: 'length',
        supportsMarkdown: false,
        supportsCard: false,
      };
      formatOutbound(message: AbuMessage) {
        return { text: message.content };
      }
    }

    registerAdapter(new TestAdapter());
    expect(getAdapter('test-reg')).toBeDefined();
    expect(getAdapter('test-reg')!.config.displayName).toBe('Test');
  });
});
