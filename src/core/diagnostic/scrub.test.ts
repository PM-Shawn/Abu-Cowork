import { describe, it, expect } from 'vitest';
import { scrubSecrets, stripBinaryContent, scrubMessage } from './scrub';
import type { Message, MessageContent, ToolCall } from '@/types';

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

  it('redacts short secret fields embedded in serialized or plain log strings', () => {
    expect(scrubSecrets('request {"apiKey":"short-local-key","model":"m"}')).toBe(
      'request {"apiKey":"[REDACTED]","model":"m"}',
    );
    expect(scrubSecrets('access_token=short-token status=failed')).toBe(
      'access_token=[REDACTED] status=failed',
    );
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

// ─── Browser fill values (v0.42.0 diagnostic-bundle leak) ───────────────
//
// Incident: bundle abu-diagnostic-mtbq8b20 carried a user's login password in
// plaintext because the abu-browser fill tool echoed the filled value in its
// result (`Filled field with "<password>"`) and the tool INPUT carries the
// same value in `value`. A password is an arbitrary string — no generic
// secret-shape regex can flag it — so redaction here is STRUCTURAL: the tool
// name tells us `input.value` is a filled value, and that exact string is
// erased wherever the same call's result echoes it. Pattern backstops cover
// conversations recorded before the extension itself stopped echoing.

describe('scrubMessage — browser fill values never reach a bundle', () => {
  const PASSWORD = 'Szzj#0322?*pass';

  const fillMsg = (toolCall: Partial<ToolCall>): Message =>
    baseMsg({
      toolCalls: [{
        id: 'tc1',
        name: 'abu-browser__fill',
        input: { tabId: 3, locator: '{"css":"#pw"}', value: PASSWORD },
        ...toolCall,
      }],
    });

  it('redacts the `value` input of a fill tool call, keeping the locator', () => {
    const out = scrubMessage(fillMsg({}), { includeRawText: false }) as {
      toolCalls: Array<{ input: { value: string; locator: string; tabId: number } }>;
    };
    expect(out.toolCalls[0].input.value).not.toContain(PASSWORD);
    expect(out.toolCalls[0].input.locator).toBe('{"css":"#pw"}');
    expect(out.toolCalls[0].input.tabId).toBe(3);
  });

  it('matches the bare bridge-local `fill` name and `form_input` too', () => {
    for (const name of ['fill', 'mcp__browser__form_input']) {
      const m = baseMsg({
        toolCalls: [{ id: 't', name, input: { value: PASSWORD } }],
      });
      const out = scrubMessage(m, { includeRawText: false }) as {
        toolCalls: Array<{ input: { value: string } }>;
      };
      expect(out.toolCalls[0].input.value).not.toContain(PASSWORD);
    }
  });

  it('erases the filled value from the result, JSON-escaped echo included', () => {
    const result = JSON.stringify(
      { success: true, message: `Filled field with "${PASSWORD}"` },
      null,
      2,
    );
    const out = scrubMessage(fillMsg({ result }), { includeRawText: false }) as {
      toolCalls: Array<{ result: string }>;
    };
    expect(out.toolCalls[0].result).not.toContain(PASSWORD);
  });

  it('erases the filled value from structured resultContent blocks', () => {
    const out = scrubMessage(
      fillMsg({
        resultContent: [{ type: 'text', text: `ok: ${PASSWORD} written` }],
      }),
      { includeRawText: false },
    ) as { toolCalls: Array<{ resultContent: unknown }> };
    expect(JSON.stringify(out.toolCalls[0].resultContent)).not.toContain(PASSWORD);
  });

  it('redacts fill-step values inside a browser batch, keeping select steps readable', () => {
    const steps = JSON.stringify([
      { action: 'fill', locator: { ref: 'e1' }, value: PASSWORD },
      { action: 'select', locator: { ref: 'e2' }, value: '运维部' },
      { action: 'click', locator: { ref: 'e3' } },
    ]);
    const m = baseMsg({
      toolCalls: [{ id: 't', name: 'abu-browser__batch', input: { tabId: 1, steps } }],
    });
    const out = scrubMessage(m, { includeRawText: false }) as {
      toolCalls: Array<{ input: { steps: string } }>;
    };
    expect(out.toolCalls[0].input.steps).not.toContain(PASSWORD);
    expect(out.toolCalls[0].input.steps).toContain('运维部');
    expect(out.toolCalls[0].input.steps).toContain('click');
  });

  it('erases batch fill-step values echoed in the batch result', () => {
    const steps = JSON.stringify([{ action: 'fill', locator: { ref: 'e1' }, value: PASSWORD }]);
    const result = JSON.stringify({
      steps: [{ ok: true, message: `Filled field with "${PASSWORD}"` }],
    });
    const m = baseMsg({
      toolCalls: [{ id: 't', name: 'abu-browser__batch', input: { tabId: 1, steps }, result }],
    });
    const out = scrubMessage(m, { includeRawText: false }) as {
      toolCalls: Array<{ result: string }>;
    };
    expect(out.toolCalls[0].result).not.toContain(PASSWORD);
  });

  it('leaves `value` inputs of non-fill tools alone', () => {
    const m = baseMsg({
      toolCalls: [{ id: 't', name: 'set_config', input: { value: 'theme-dark' } }],
    });
    const out = scrubMessage(m, { includeRawText: false }) as {
      toolCalls: Array<{ input: { value: string } }>;
    };
    expect(out.toolCalls[0].input.value).toBe('theme-dark');
  });

  it('redacts a legacy fill echo in any string (recorded before the source fix)', () => {
    expect(scrubSecrets('Filled field with "hunter2#pass!"')).toBe(
      'Filled field with "[REDACTED]"',
    );
    // JSON-escaped form, as it appears inside a stringified tool result.
    const escaped = JSON.stringify({ message: 'Filled field with "hunter2#pass!"' });
    expect(scrubSecrets(escaped)).not.toContain('hunter2#pass!');
  });

  it('redacts previousValue echoes in result strings', () => {
    expect(scrubSecrets('{"previousValue":"oldpw123!"}')).not.toContain('oldpw123!');
    const escaped = JSON.stringify({ result: '{"previousValue":"oldpw123!"}' });
    expect(scrubSecrets(escaped)).not.toContain('oldpw123!');
  });

  it('does not double-redact the extension\'s own redaction marker', () => {
    expect(scrubSecrets('Filled field with "[value redacted]"')).toBe(
      'Filled field with "[value redacted]"',
    );
  });
});

// ─── Credential detector parity with memory hygiene (M1) ────────────────
//
// The memory write funnel (memdir/sanitize.ts, reusing shareRedactor's vendor
// rules) already knows credential shapes this file's own regexes miss. The
// diagnostic channel reuses that detector so the two never drift: a shape the
// memory gate redacts must not sail through a diagnostic bundle.

describe('scrubSecrets — reuses the memory-hygiene credential detector', () => {
  it('redacts vendor tokens the memory sanitizer knows (slack, github fine-grained)', () => {
    expect(scrubSecrets('slack xoxb-123456789012-abcdefghij done')).not.toContain('xoxb-1234');
    expect(scrubSecrets('pat ghs_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')).not.toContain('ghs_a1B2');
  });

  it('redacts contextual bare credentials behind a Chinese keyword', () => {
    const out = scrubSecrets('数据库密钥: tp1234567890abcd 已配置') as string;
    expect(out).not.toContain('tp1234567890abcd');
    expect(out).toContain('密钥');
  });
});
