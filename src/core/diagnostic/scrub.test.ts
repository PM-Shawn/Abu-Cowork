import { describe, it, expect } from 'vitest';
import { scrubSecrets, stripBinaryContent, scrubMessage } from './scrub';
import type { Message, MessageContent } from '@/types';

// ─── Secret field detection ─────────────────────────────────────────────

describe('scrubSecrets — field-name redaction', () => {
  it('redacts apiKey at any nesting level', () => {
    const input = { providers: [{ id: 'a', apiKey: 'sk-real-key' }] };
    const out = scrubSecrets(input) as { providers: { apiKey: string }[] };
    expect(out.providers[0].apiKey).toBe('[REDACTED]');
  });

  it('matches all known secret-shaped field names', () => {
    const fields = ['apiKey', 'API_KEY', 'token', 'access_token', 'secret',
                    'mySecret', 'password', 'auth', 'authorization',
                    'credential', 'private_key'];
    for (const f of fields) {
      const out = scrubSecrets({ [f]: 'realvalue' }) as Record<string, string>;
      expect(out[f]).toBe('[REDACTED]');
    }
  });

  it('does NOT redact innocuous field names that contain a substring', () => {
    // `key` alone is too common (e.g. `cacheKey`, `dictKey`); we don't match it.
    const out = scrubSecrets({ cacheKey: 'just-a-cache-id', dictKey: 'k1' }) as Record<string, string>;
    expect(out.cacheKey).toBe('just-a-cache-id');
    expect(out.dictKey).toBe('k1');
  });

  it('preserves non-secret fields untouched', () => {
    const input = { name: 'Alice', age: 30, enabled: true };
    expect(scrubSecrets(input)).toEqual(input);
  });

  it('handles null and undefined gracefully', () => {
    expect(scrubSecrets(null)).toBe(null);
    expect(scrubSecrets(undefined)).toBe(undefined);
    expect(scrubSecrets({ apiKey: null })).toEqual({ apiKey: '[REDACTED]' });
  });
});

// ─── Value pattern detection ────────────────────────────────────────────

describe('scrubSecrets — value pattern redaction', () => {
  it('redacts OpenAI-style sk- keys embedded in strings', () => {
    const out = scrubSecrets('Error: bad key sk-abc123def456ghi789jkl012mno345pqr');
    expect(out).toBe('Error: bad key [REDACTED]');
  });

  it('redacts JWTs in arbitrary strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = scrubSecrets(`Authorization: ${jwt}`);
    expect(out).toBe('Authorization: [REDACTED]');
  });

  it('redacts Bearer headers case-insensitively', () => {
    expect(scrubSecrets('bearer  abcdef1234567890XYZ')).toContain('[REDACTED]');
    expect(scrubSecrets('Bearer xyz123abcdef0987654321qq')).toContain('[REDACTED]');
  });

  it('redacts GitHub PATs and Google API keys', () => {
    // Build fake fixtures from parts so source file scanners don't flag them as real secrets.
    const fakeGhPat = 'ghp' + '_' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const fakeGoogleKey = 'AI' + 'za' + 'SyD_abc123DEF456GHI789jkl012mno345p';
    expect(scrubSecrets(fakeGhPat)).toBe('[REDACTED]');
    expect(scrubSecrets(fakeGoogleKey)).toBe('[REDACTED]');
  });

  it('does not flag short hex or normal text', () => {
    expect(scrubSecrets('user 123abc visited page')).toBe('user 123abc visited page');
    expect(scrubSecrets('commit hash deadbeef')).toBe('commit hash deadbeef');
  });
});

// ─── Recursion ──────────────────────────────────────────────────────────

describe('scrubSecrets — recursion', () => {
  it('walks deeply nested objects and arrays', () => {
    const input = {
      list: [
        { id: 1, config: { token: 'abc' } },
        { id: 2, config: { other: 'fine' } },
      ],
    };
    const out = scrubSecrets(input) as typeof input;
    expect(out.list[0].config.token).toBe('[REDACTED]');
    expect(out.list[1].config.other).toBe('fine');
  });

  it('does not mutate the input object', () => {
    const input = { apiKey: 'secret', name: 'Alice' };
    scrubSecrets(input);
    expect(input.apiKey).toBe('secret');
  });

  it('handles circular references without infinite-looping', () => {
    interface Cycle { name: string; self?: Cycle }
    const cycle: Cycle = { name: 'a' };
    cycle.self = cycle;
    expect(() => scrubSecrets(cycle)).not.toThrow();
  });
});

// ─── Binary stripping ───────────────────────────────────────────────────

describe('stripBinaryContent', () => {
  it('replaces image blocks with size-tagged text placeholder', () => {
    // 1024-char base64 ≈ 768 bytes raw
    const fakeData = 'A'.repeat(1024);
    const content: MessageContent[] = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fakeData } },
    ];
    const out = stripBinaryContent(content);
    expect(out[0].type).toBe('text');
    expect(out[0].type === 'text' && out[0].text).toContain('image:');
    expect(out[0].type === 'text' && out[0].text).toContain('png');
  });

  it('replaces document blocks similarly', () => {
    const content: MessageContent[] = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'A'.repeat(4096) } },
    ];
    const out = stripBinaryContent(content);
    expect(out[0].type).toBe('text');
    expect(out[0].type === 'text' && out[0].text).toContain('document:');
  });

  it('preserves text blocks unchanged', () => {
    const content: MessageContent[] = [{ type: 'text', text: 'hello' }];
    expect(stripBinaryContent(content)).toEqual(content);
  });

  it('formats sizes with KB/MB suffixes', () => {
    const small: MessageContent[] = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(100) } }];
    const huge: MessageContent[] = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2_000_000) } }];
    expect(stripBinaryContent(small)[0]).toMatchObject({ type: 'text' });
    const hugeOut = stripBinaryContent(huge)[0];
    expect(hugeOut.type === 'text' && hugeOut.text).toMatch(/MB/);
  });
});

// ─── Message scrubbing ──────────────────────────────────────────────────

const baseMsg = (overrides: Partial<Message> = {}): Message => ({
  id: 'm1',
  role: 'user',
  content: 'hello world',
  timestamp: 1700000000000,
  ...overrides,
});

describe('scrubMessage', () => {
  it('replaces text content with size placeholder by default', () => {
    const out = scrubMessage(baseMsg(), { includeRawText: false }) as { content: string };
    expect(out.content).toBe('[text: 11 chars]');
  });

  it('preserves text content when includeRawText is true (still redacting secrets)', () => {
    const m = baseMsg({ content: 'my key is sk-abc123def456ghi789jkl012mno345pqr' });
    const out = scrubMessage(m, { includeRawText: true }) as { content: string };
    expect(out.content).toContain('my key is');
    expect(out.content).toContain('[REDACTED]');
    expect(out.content).not.toContain('sk-abc');
  });

  it('keeps tool call structure intact (name + input + result)', () => {
    const m = baseMsg({
      toolCalls: [{
        id: 'tc1',
        name: 'run_command',
        input: { command: 'echo hi >> ~/foo.md' },
        result: 'done',
      }],
    });
    const out = scrubMessage(m, { includeRawText: false }) as { toolCalls: Array<{ name: string; input: unknown; result: string }> };
    expect(out.toolCalls[0].name).toBe('run_command');
    expect(out.toolCalls[0].input).toEqual({ command: 'echo hi >> ~/foo.md' });
    expect(out.toolCalls[0].result).toBe('done');
  });

  it('redacts secrets inside tool call inputs', () => {
    const m = baseMsg({
      toolCalls: [{
        id: 'tc1',
        name: 'http_fetch',
        input: { url: 'https://api/x', headers: { authorization: 'Bearer  abcdef1234567890XYZ123' } },
      }],
    });
    const out = scrubMessage(m, { includeRawText: false }) as { toolCalls: Array<{ input: { headers: { authorization: string } } }> };
    expect(out.toolCalls[0].input.headers.authorization).toBe('[REDACTED]');
  });

  it('strips embedded image binaries from multimodal content', () => {
    const m = baseMsg({
      content: [
        { type: 'text', text: 'see this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1_000_000) } },
      ],
    });
    const out = scrubMessage(m, { includeRawText: true }) as { content: MessageContent[] };
    expect(out.content[1].type).toBe('text');
    expect((out.content[1] as { type: 'text'; text: string }).text).toContain('image:');
  });

  it('scrubs thinking content same as message text', () => {
    const m = baseMsg({ thinking: 'thinking about sk-abc123def456ghi789jkl012mno345pqr' });
    const out = scrubMessage(m, { includeRawText: true }) as { thinking: string };
    expect(out.thinking).toContain('[REDACTED]');
    const outDefault = scrubMessage(m, { includeRawText: false }) as { thinking: string };
    expect(outDefault.thinking).toMatch(/^\[text: \d+ chars\]$/);
  });

  it('preserves loopId, usage, role, timestamp', () => {
    const m = baseMsg({
      loopId: 'loop-1',
      role: 'assistant',
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    const out = scrubMessage(m, { includeRawText: false }) as Record<string, unknown>;
    expect(out.loopId).toBe('loop-1');
    expect(out.role).toBe('assistant');
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(out.timestamp).toBe(1700000000000);
  });
});
