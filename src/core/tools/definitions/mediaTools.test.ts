import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateImageTool } from './mediaTools';
import { useSettingsStore } from '../../../stores/settingsStore';
import type { ImageGenBackend } from '../../../types/provider';

// generate_image resolves its backend from the independent imageGeneration
// config (design doc §3.1, "C-a" — getDefaultImageBackend), fully decoupled
// from chat providers/models, and talks to a generic OpenAI-shape
// /images/generations endpoint via getTauriFetch(). In this test environment
// window.__TAURI_INTERNALS__ is undefined, so getTauriFetch() resolves to
// globalThis.fetch — stub that directly rather than mocking the tauri-fetch
// module.
const realFetch = globalThis.fetch;
const mockFetch = vi.fn();

const FAKE_B64 = 'aGVsbG8td29ybGQ='; // "hello-world"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function imageGenBackend(overrides: Partial<ImageGenBackend> = {}): ImageGenBackend {
  return {
    id: 'volc',
    name: 'Volcengine Seedream',
    vendor: 'volcengine',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'sk-volc-test',
    model: 'doubao-seedream-4-5',
    ...overrides,
  };
}

describe('generateImageTool', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('data:')) {
        // Base64 → bytes decode step in mediaTools.ts uses fetch(data:...) —
        // delegate to the real fetch, which supports data: URLs natively.
        return realFetch(url);
      }
      return jsonResponse({ data: [{ b64_json: FAKE_B64 }] });
    });

    useSettingsStore.setState({
      imageGeneration: { backends: [imageGenBackend()], defaultId: 'volc' },
    });
  });

  it('returns a text summary containing the saved path (no base64 image block)', async () => {
    // The saved file renders inline via ImagePreviewCard (workflowExtractor
    // matches this text), so the tool must NOT also return a base64 image block
    // — that would double the image AND push the full 2048x2048 base64 into the
    // LLM context.
    const result = await generateImageTool.execute(
      { prompt: 'a cat wearing sunglasses', save_path: '/tmp/abu-test/cat.png' },
    );

    expect(typeof result).toBe('string');
    expect(result as string).toContain('/tmp/abu-test/cat.png');
  });

  it('POSTs to {normalizedBase}/images/generations, not a hardcoded /v1/ prefix', async () => {
    await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    // ark base already ends in /api/v3 (matches /v\d+$/) — resolveOpenAIBaseUrl
    // must NOT append another /v1 segment on top of it.
    const genCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/images/generations'));
    expect(genCall).toBeDefined();
    expect(String(genCall![0])).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
  });

  it('POSTs to the Agent Plan base (/api/plan/v3) when the backend is configured with it', async () => {
    useSettingsStore.setState({
      imageGeneration: {
        backends: [imageGenBackend({ id: 'volc-agent', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3' })],
        defaultId: 'volc-agent',
      },
    });

    await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    const genCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/images/generations'));
    expect(genCall).toBeDefined();
    expect(String(genCall![0])).toBe('https://ark.cn-beijing.volces.com/api/plan/v3/images/generations');
  });

  it('does NOT double the path when the backend baseUrl is the full endpoint (as Volcengine docs present it)', async () => {
    // Regression: user pasted the full endpoint URL from the vendor docs.
    // Must not become .../images/generations/v1/images/generations (404).
    useSettingsStore.setState({
      imageGeneration: {
        backends: [imageGenBackend({ id: 'volc-full', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/images/generations' })],
        defaultId: 'volc-full',
      },
    });

    await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    const genCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/images/generations'));
    expect(genCall).toBeDefined();
    expect(String(genCall![0])).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
  });

  it('uses the default backend model id and apiKey in the request', async () => {
    await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    const genCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/images/generations'));
    expect(genCall).toBeDefined();
    const [, init] = genCall!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('doubao-seedream-4-5');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-volc-test');
  });

  it('omits size from the request body when the caller does not pass one (no hardcoded 1024x1024 default)', async () => {
    // Regression: Seedream requires >=3686400px and rejects the old
    // hardcoded 1024x1024 default outright — size must be optional so the
    // backend can apply its own default.
    await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    const genCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/images/generations'));
    expect(genCall).toBeDefined();
    const [, init] = genCall!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).not.toHaveProperty('size');
  });

  it('includes size in the request body when the caller explicitly passes one', async () => {
    await generateImageTool.execute({ prompt: 'test', size: '2048x2048', save_path: '/tmp/abu-test/out.png' });

    const genCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/images/generations'));
    expect(genCall).toBeDefined();
    const [, init] = genCall!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.size).toBe('2048x2048');
  });

  it('appends /v1 for a bare OpenAI-style base URL', async () => {
    useSettingsStore.setState({
      imageGeneration: {
        backends: [imageGenBackend({
          id: 'oai',
          vendor: 'openai',
          baseUrl: 'https://api.openai.com',
          model: 'dall-e-3',
        })],
        defaultId: 'oai',
      },
    });

    await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    const genCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/images/generations'));
    expect(String(genCall![0])).toBe('https://api.openai.com/v1/images/generations');
  });

  it('falls back to backends[0] when defaultId points at nothing (or is unset)', async () => {
    useSettingsStore.setState({
      imageGeneration: { backends: [imageGenBackend({ id: 'only-one' })], defaultId: undefined },
    });

    await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    const genCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/images/generations'));
    expect(genCall).toBeDefined();
  });

  it('returns a guidance error string (not empty/silent) when no image-gen backend is configured and no OpenAI-compatible provider is active', async () => {
    useSettingsStore.setState({
      imageGeneration: { backends: [], defaultId: undefined },
      providers: [],
      activeModel: { providerId: 'nonexistent', modelId: 'nonexistent' },
    });

    const result = await generateImageTool.execute({ prompt: 'test' });

    expect(typeof result).toBe('string');
    expect(result as string).not.toBe('');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to the active OpenAI-compatible provider (DALL-E 3, api.openai.com) when no image-gen backend is configured (F1 regression)', async () => {
    // Regression: the refactor to independent imageGeneration.backends
    // hard-required an explicit backend and dropped the pre-refactor
    // zero-config fallback (v0.29.0 behavior) — a user who never touched
    // Settings → Image Generation but has an OpenAI-compatible provider
    // active used to be able to generate images for free.
    useSettingsStore.setState({
      imageGeneration: { backends: [], defaultId: undefined },
      providers: [
        {
          id: 'openai', source: 'builtin', name: 'OpenAI', enabled: true,
          apiFormat: 'openai-compatible', baseUrl: 'https://api.openai.com',
          apiKey: 'sk-zero-config-key', models: [{ id: 'gpt-4o', label: 'GPT-4o' }],
          status: 'unchecked', sortOrder: 0,
        },
      ],
      activeModel: { providerId: 'openai', modelId: 'gpt-4o' },
    });

    const result = await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    expect(typeof result).toBe('string');
    expect(result as string).not.toContain('Error');

    const genCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/images/generations'));
    expect(genCall).toBeDefined();
    expect(String(genCall![0])).toBe('https://api.openai.com/v1/images/generations');
    const [, init] = genCall!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('dall-e-3');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-zero-config-key');
  });

  it('surfaces a non-ok API response as a text error, not a thrown exception', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('data:')) return realFetch(url);
      return new Response('rate limited', { status: 429 });
    });

    const result = await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    expect(typeof result).toBe('string');
    expect(result as string).toContain('429');
  });

  it('decodes a b64_json response WITHOUT fetching a data: URL (CSP-blocked in the packaged WKWebView build)', async () => {
    // Regression for the "Load failed" image-gen bug: the app CSP allows `data:`
    // under img-src/font-src but NOT connect-src, so `fetch("data:...")` is
    // blocked in the real build and rejects with `TypeError: Load failed`.
    // Decoding must therefore use atob(), never fetch(). We simulate the CSP
    // block by throwing on any data: fetch (as WebKit does) and assert the tool
    // still succeeds — and that it never attempts a data: fetch at all.
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('data:')) throw new TypeError('Load failed');
      return jsonResponse({ data: [{ b64_json: FAKE_B64 }] });
    });

    const result = await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    expect(typeof result).toBe('string');
    expect(result as string).not.toContain('Load failed');
    expect(result as string).not.toContain('Error generating image');
    expect(result as string).toContain('/tmp/abu-test/out.png');

    // Prove the decode path is network-free: no fetch was made to a data: URL.
    const dataUrlCalls = mockFetch.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : String(input);
      return url.startsWith('data:');
    });
    expect(dataUrlCalls).toHaveLength(0);
  });
});
