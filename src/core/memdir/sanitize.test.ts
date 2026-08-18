import { describe, it, expect } from 'vitest';
import { sanitizeMemoryText, sanitizeMemoryFields } from './sanitize';

describe('sanitizeMemoryText', () => {
  it('redacts vendor-prefixed keys via the shared credential rules', () => {
    const r = sanitizeMemoryText('my key is sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCD');
    expect(r.text).toContain('[REDACTED:anthropic-key]');
    expect(r.text).not.toContain('sk-ant-abcdefghijk');
    expect(r.redactions).toContain('anthropic-key');
  });

  it('redacts bare contextual credentials (the real-world miss: unquoted API Key:value)', () => {
    // The exact shape found in a real user memory: keyword + colon + bare
    // vendor-prefixed token that no vendor rule knows about.
    const r = sanitizeMemoryText('自定义API地址:https://example.com/v1,API Key:tp-fak3key0fak3key1xyz');
    expect(r.text).toContain('[REDACTED:credential]');
    expect(r.text).not.toContain('tp-fak3key0fak3key1xyz');
    // The URL survives — only the secret value is replaced.
    expect(r.text).toContain('https://example.com/v1');
    expect(r.redactions).toContain('credential');
  });

  it('redacts Chinese keyword forms (密钥/令牌)', () => {
    const r = sanitizeMemoryText('服务密钥: abc123def456ghi789');
    expect(r.text).toContain('[REDACTED:credential]');
    expect(r.text).not.toContain('abc123def456ghi789');
  });

  it('matches the full-width colon Chinese users actually type (密钥：value)', () => {
    const r = sanitizeMemoryText('服务密钥：tp-fak3key0fak3key1xyz');
    expect(r.text).toContain('[REDACTED:credential]');
    expect(r.text).not.toContain('tp-fak3key0fak3key1xyz');
  });

  it('does not over-redact when the only digit sits outside the value run', () => {
    // Regression: the lookaheads must be bounded to the value charset — a
    // stray digit after a comma must not turn prose into a "credential".
    const prose = 'token:introduction,2 和 password:examplenotreal,v2 都是散文';
    const r = sanitizeMemoryText(prose);
    expect(r.text).toBe(prose);
    expect(r.redactions).toHaveLength(0);
  });

  it('keeps prose, URLs, paths, and digit-less phrases untouched', () => {
    const clean = '在 /Users/shawn/Documents 下有个 token 概念的笔记,讨论 tokenizer 设计';
    expect(sanitizeMemoryText(clean).text).toBe(clean);
    // Value without digits (prose after "token:") is not credential-shaped.
    const prose = 'token: 指的是分词单位而非密钥';
    expect(sanitizeMemoryText(prose).redactions).toHaveLength(0);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const once = sanitizeMemoryText('API Key: tp-fak3key0fak3key1xyz and sk-abcdefghijklmnopqrstuv123');
    const twice = sanitizeMemoryText(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.redactions).toHaveLength(0);
  });
});

describe('sanitizeMemoryFields', () => {
  it('covers name, description, and content — description was the real gap', () => {
    const r = sanitizeMemoryFields({
      name: '模型配置',
      description: '自定义端点,API Key:tp-fak3key0fak3key1xyz',
      content: '正文没有密钥',
    });
    expect(r.description).toContain('[REDACTED:credential]');
    expect(r.content).toBe('正文没有密钥');
    expect(r.redactions).toEqual(['credential']);
  });

  it('unions redaction labels across fields without duplicates', () => {
    const r = sanitizeMemoryFields({
      name: 'k: token=abc123def456ghi',
      description: 'token=abc123def456ghi',
      content: 'x',
    });
    expect(r.redactions).toEqual(['credential']);
  });
});
