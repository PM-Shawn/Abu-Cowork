import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trace: vi.fn(),
  generation: vi.fn(),
  span: vi.fn(),
  generationEnd: vi.fn(),
  spanEnd: vi.fn(),
  traceUpdate: vi.fn(),
  flushAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('langfuse', () => ({
  Langfuse: class MockLangfuse {
    trace(input: unknown) {
      return mocks.trace(input);
    }

    flushAsync() {
      return mocks.flushAsync();
    }
  },
}));

describe('Langfuse telemetry privacy boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_LANGFUSE_PUBLIC_KEY', 'public-test-key');
    vi.stubEnv('VITE_LANGFUSE_SECRET_KEY', 'secret-test-key');
    vi.stubEnv('VITE_LANGFUSE_BASE_URL', 'https://langfuse.example.test');
    mocks.trace.mockReset();
    mocks.generation.mockReset();
    mocks.span.mockReset();
    mocks.generationEnd.mockReset();
    mocks.spanEnd.mockReset();
    mocks.traceUpdate.mockReset();
    mocks.flushAsync.mockClear();
    mocks.generation.mockReturnValue({ end: mocks.generationEnd });
    mocks.span.mockReturnValue({ end: mocks.spanEnd });
    mocks.trace.mockReturnValue({
      generation: mocks.generation,
      span: mocks.span,
      update: mocks.traceUpdate,
    });
  });

  it('sanitizes trace, generation, and tool inputs before the SDK sees them', async () => {
    const {
      startConversationTrace,
      startGeneration,
      startToolSpan,
    } = await import('./langfuse');
    const inlineImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

    startConversationTrace('conv-telemetry', {
      input: { content: inlineImage, filePath: '/private/customer/source.png' },
      metadata: { workspacePath: '/Volumes/Customer Files/workspace' },
    });
    startGeneration('conv-telemetry', {
      model: 'test-model',
      input: [{ role: 'user', content: inlineImage }],
    });
    startToolSpan('conv-telemetry', {
      name: 'read_file',
      input: { path: '\\\\fileserver\\customer-share\\plan.pdf' },
    });

    const sdkPayloads = JSON.stringify([
      mocks.trace.mock.calls,
      mocks.generation.mock.calls,
      mocks.span.mock.calls,
    ]);
    expect(sdkPayloads).not.toContain('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
    expect(sdkPayloads).not.toContain('/private/customer/source.png');
    expect(sdkPayloads).not.toContain('/Volumes/Customer Files/workspace');
    expect(sdkPayloads).not.toContain('fileserver');
    expect(sdkPayloads).toContain('[REDACTED:base64]');
    expect(sdkPayloads).toContain('[REDACTED:path]');
  });
});
