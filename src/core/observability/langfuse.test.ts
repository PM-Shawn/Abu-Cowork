/**
 * Tests for Langfuse observability module — specifically the subagent span.
 *
 * The test environment may or may not have VITE_LANGFUSE_* keys (developer
 * machines with .env.local have them, CI does not). Tests must hold in BOTH
 * states: they verify the API contracts — non-throwing, correct return shape —
 * not the enabled/disabled state itself.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeLangfusePayload, startSubagentSpan } from './langfuse';

describe('startSubagentSpan', () => {
  it('always returns a handle (never null/undefined), regardless of observability state', () => {
    const handle = startSubagentSpan(null, { agentName: 'test-agent', task: 'do something' });
    expect(handle).toBeDefined();
    expect(typeof handle.end).toBe('function');
  });

  it('.end() does not throw when called with no arguments (null parentId)', () => {
    const handle = startSubagentSpan(null, { agentName: 'test-agent', task: 'do something' });
    expect(() => handle.end()).not.toThrow();
  });

  it('.end() does not throw with a full payload (null parentId)', () => {
    const handle = startSubagentSpan(null, { agentName: 'test-agent', task: 'do something' });
    expect(() =>
      handle.end({
        output: 'result text',
        tokenUsage: { input: 1000, output: 500 },
        toolCallCount: 3,
        turnCount: 2,
        duration: 4.5,
      })
    ).not.toThrow();
  });

  it('.end() does not throw when parentConversationId is a non-existent trace id', () => {
    // A conversationId that has no entry in _traces — must fall back gracefully
    const handle = startSubagentSpan('missing-conversation-id', {
      agentName: 'test-agent',
      task: 'another task',
    });
    expect(() =>
      handle.end({
        output: 'some output',
        tokenUsage: { input: 200, output: 100 },
        toolCallCount: 1,
        turnCount: 1,
        duration: 1.2,
        error: 'something went wrong',
      })
    ).not.toThrow();
  });

  it('.end() does not throw when called multiple times on the same handle', () => {
    const handle = startSubagentSpan(null, { agentName: 'multi-end', task: 'task' });
    expect(() => handle.end()).not.toThrow();
    expect(() => handle.end({ output: 'second call' })).not.toThrow();
  });

  it('.end() does not throw with error field set', () => {
    const handle = startSubagentSpan(null, { agentName: 'error-agent', task: 'fail task' });
    expect(() =>
      handle.end({
        output: 'Error: network timeout',
        error: 'network timeout',
        duration: 0.5,
      })
    ).not.toThrow();
  });

  it('redacts provider-derived subagent output and status messages before telemetry', () => {
    const raw = {
      output: 'provider echoed data:application/pdf;base64,JVBERi0x and /Users/alice/secret.pdf',
      error: 'failed fetching https://files.example.test/a.pdf?token=Bearer%20abc123def456ghi789 from C:\\Users\\Alice\\secret.pdf',
    };

    const sanitized = sanitizeLangfusePayload(raw);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain('JVBERi0x');
    expect(serialized).not.toContain('/Users/alice/secret.pdf');
    expect(serialized).not.toContain('abc123def456ghi789');
    expect(serialized).not.toContain('C:\\Users\\Alice\\secret.pdf');
    expect(sanitized.output).toContain('[REDACTED:base64]');
    expect(sanitized.error).toContain('[REDACTED:url-token]');
  });

  it('redacts generic local and network absolute paths before telemetry', () => {
    const raw = {
      privatePath: 'failed reading /private/var/folders/customer/plan.pdf',
      tmpPath: 'failed reading /tmp/customer-upload.pdf',
      volumePath: 'failed reading /Volumes/Customer Files/plan.pdf',
      uncPath: 'failed reading \\\\fileserver\\customer-share\\plan.pdf',
    };

    const sanitized = sanitizeLangfusePayload(raw);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain('/private/var/folders/customer/plan.pdf');
    expect(serialized).not.toContain('/tmp/customer-upload.pdf');
    expect(serialized).not.toContain('/Volumes/Customer Files/plan.pdf');
    expect(serialized).not.toContain('fileserver');
    expect(serialized).toContain('[REDACTED:path]');
  });

  it('redacts sidecar-style path prefixes and short data URLs without breaking https or plain data text', () => {
    const httpsUrl = 'https://example.test/assets/a.png';
    const ordinaryDataText = 'ordinary data: label';
    const dataUrls = [
      'data:image/png;base64,QQ==',
      'data:image/png;charset=utf-8;base64,QUJDRA==',
      'data:application/pdf;name=secret.pdf;base64,JVBERi0=',
      'data:;base64,QQ==',
    ];
    const raw = {
      output: `provider path:/Users/alice/secret.png file:///Users/alice/secret.png </Users/alice/secret.png> file=/tmp/a.png opening /var/private/report.txt ${dataUrls.join(' ')} ${httpsUrl} ${ordinaryDataText}`,
    };

    const sanitized = sanitizeLangfusePayload(raw);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain('path:/Users/alice/secret.png');
    expect(serialized).not.toContain('file:///Users/alice/secret.png');
    expect(serialized).not.toContain('/Users/alice/secret.png');
    expect(serialized).not.toContain('/tmp/a.png');
    expect(serialized).not.toContain('/var/private/report.txt');
    for (const dataUrl of dataUrls) {
      expect(serialized).not.toContain(dataUrl);
    }
    expect(serialized).toContain('path:[REDACTED:path]');
    expect(serialized).toContain('file://[REDACTED:path]');
    expect(serialized).toContain('<[REDACTED:path]>');
    expect(serialized).toContain('file=[REDACTED:path]');
    expect(serialized).toContain(httpsUrl);
    expect(serialized).toContain(ordinaryDataText);
  });

  it.each([
    ['PATH prefix', 'PATH:/Users/a/secret.png', 'PATH:[REDACTED:path]'],
    ['output prefix', 'output:/Users/a/secret.png', 'output:[REDACTED:path]'],
    ['uppercase file URI', 'FILE:///Users/a/secret.png', 'FILE://[REDACTED:path]'],
  ])('redacts %s in telemetry while preserving https URLs', (_label, rawPath, expected) => {
    const httpsUrl = 'https://example.test/assets/a.png';
    const sanitized = sanitizeLangfusePayload({ output: `${rawPath} ${httpsUrl}` });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(rawPath);
    expect(serialized).toContain(expected);
    expect(serialized).toContain(httpsUrl);
  });

  it('redacts raw base64 carried in semantically sensitive telemetry fields', () => {
    const sentinel = 'UERGX1NFTlRJTkVMX1BBWUxPQUQ=';
    const raw = {
      trace: {
        input: {
          source: { type: 'base64', media_type: 'application/pdf', data: sentinel },
          nested: [{ imageData: { mediaType: 'image/png', base64: sentinel } }],
        },
      },
      generation: { output: { base64: sentinel } },
      tool: { input: { imageData: sentinel }, output: { source: { data: sentinel } } },
    };

    const sanitized = sanitizeLangfusePayload(raw);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(sentinel);
    expect(serialized).toContain('[REDACTED:base64]');
  });

  it('redacts short base64 in a typed media source instead of relying on payload length', () => {
    const sentinel = 'aGk=';
    const sanitized = sanitizeLangfusePayload({
      source: { type: 'base64', media_type: 'image/png', data: sentinel },
    });

    expect(JSON.stringify(sanitized)).not.toContain(sentinel);
    expect(sanitized.source.data).toBe('[REDACTED:base64]');
  });
});
