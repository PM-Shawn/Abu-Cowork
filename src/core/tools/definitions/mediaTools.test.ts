import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateImageTool } from './mediaTools';
import { useSettingsStore } from '../../../stores/settingsStore';
import type { ImageGenBackend } from '../../../types/provider';
import type { ToolExecutionContext } from '../../../types';


// Reference images are read through fsBridge when the tool has no host file
// access; the bytes come from here instead of the disk.
const { mockReadFile } = vi.hoisted(() => ({ mockReadFile: vi.fn() }));
vi.mock('../fsBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fsBridge')>()),
  readFile: mockReadFile,
}));

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

  it('sends watermark:true to a Volcengine backend by default and false when the setting is off', async () => {
    const sent = () => {
      const genCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/images/generations'));
      return JSON.parse((genCall![1] as RequestInit).body as string);
    };
    await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });
    expect(sent().watermark).toBe(true);

    mockFetch.mockClear();
    useSettingsStore.getState().setImageGenWatermark(false);
    await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });
    expect(sent().watermark).toBe(false);
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
    // A 429 is neither a 404/401 nor a chat-endpoint symptom — no
    // misconfiguration hint should be appended.
    expect(result as string).not.toContain('doubao-seedream');
  });

  it('appends the chat-endpoint hint (with the correct /api/v3 URL) when a Volcengine /api/coding/ baseUrl 404s — the V41-migrated misconfig', async () => {
    // Regression: 0.38 users whose legacy auxiliaryServices.imageGen held the
    // ark *chat* endpoint got it migrated verbatim by V41, so generate_image
    // stably returned a bare "Error generating image: 404 " (empty body) —
    // undiagnosable for both the model and the user.
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('data:')) return realFetch(url);
      return new Response('', { status: 404 });
    });
    useSettingsStore.setState({
      imageGeneration: {
        // vendor 'custom' — exactly the migrated shape before F5 inference,
        // resolved to volcengine via the ark host.
        backends: [imageGenBackend({ id: 'volc-chat', vendor: 'custom', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', model: 'Doubao-Seed-2.0-lite' })],
        defaultId: 'volc-chat',
      },
    });

    const result = await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    expect(result as string).toContain('404');
    expect(result as string).toContain('/api/coding/');
    expect(result as string).toContain('https://ark.cn-beijing.volces.com/api/v3');
  });

  it('appends the generic check-backend hint on a 404 from a correct-shaped endpoint (e.g. chat model on the image endpoint)', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('data:')) return realFetch(url);
      return new Response('', { status: 404 });
    });

    const result = await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    expect(result as string).toContain('404');
    expect(result as string).toContain('doubao-seedream');
  });

  it('appends the generic check-backend hint on a 401', async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('data:')) return realFetch(url);
      return new Response('unauthorized', { status: 401 });
    });

    const result = await generateImageTool.execute({ prompt: 'test', save_path: '/tmp/abu-test/out.png' });

    expect(result as string).toContain('401');
    expect(result as string).toContain('doubao-seedream');
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

  describe('reference images', () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    const MB = 1024 * 1024;

    function sentBody(): Record<string, unknown> {
      const genCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/images/generations'));
      expect(genCall).toBeDefined();
      return JSON.parse((genCall![1] as RequestInit).body as string);
    }

    function filesStub(readFile: (path: string) => Promise<Uint8Array>): ToolExecutionContext {
      return {
        files: {
          assertCurrent: async () => {},
          assertActive: () => {},
          readFile,
          ensureParentDir: async () => {},
          writeFile: async () => {},
        },
      } as unknown as ToolExecutionContext;
    }

    beforeEach(() => {
      mockReadFile.mockReset();
    });

    it('sends one local reference image as a data URI string and keeps the success text intact', async () => {
      mockReadFile.mockResolvedValue(PNG);

      const result = await generateImageTool.execute({
        prompt: 'make it a watercolor', reference_images: ['/tmp/abu-test/in.png'], save_path: '/tmp/abu-test/out.png',
      });

      expect(mockReadFile).toHaveBeenCalledWith('/tmp/abu-test/in.png');
      const body = sentBody();
      expect(body.image).toBe(`data:image/png;base64,${b64(PNG)}`);
      expect(body).not.toHaveProperty('sequential_image_generation');
      // The preview card reads the path up to the first newline; the count rides on a later line.
      expect(result as string).toMatch(/^Image saved to: \/tmp\/abu-test\/out\.png\n/);
      expect(result as string).toContain('1 reference image');
    });

    it('sends several reference images as an array in the given order', async () => {
      mockReadFile.mockImplementation(async (path: string) => (path.endsWith('b.jpg') ? JPEG : PNG));

      await generateImageTool.execute({
        prompt: 'put the product from image 1 into the scene of image 2',
        reference_images: ['/w/a.png', '/w/b.jpg'],
        save_path: '/tmp/abu-test/out.png',
      });

      expect(sentBody().image).toEqual([`data:image/png;base64,${b64(PNG)}`, `data:image/jpeg;base64,${b64(JPEG)}`]);
    });

    it('treats a single string as a one-item list', async () => {
      mockReadFile.mockResolvedValue(PNG);

      await generateImageTool.execute({ prompt: 'x', reference_images: '/w/a.png', save_path: '/tmp/abu-test/out.png' });

      expect(sentBody().image).toBe(`data:image/png;base64,${b64(PNG)}`);
    });

    it('drops blank entries, and sends no image field when nothing is left', async () => {
      await generateImageTool.execute({ prompt: 'x', reference_images: ['', '   '], save_path: '/tmp/abu-test/out.png' });

      expect(mockReadFile).not.toHaveBeenCalled();
      expect(sentBody()).not.toHaveProperty('image');
    });

    it('passes http(s) URLs and data URIs through without reading anything', async () => {
      mockReadFile.mockResolvedValue(JPEG);

      await generateImageTool.execute({
        prompt: 'x',
        reference_images: ['https://example.com/a.png', 'data:image/webp;base64,AAAA', '/w/b.jpg'],
        save_path: '/tmp/abu-test/out.png',
      });

      expect(mockReadFile).toHaveBeenCalledTimes(1);
      expect(sentBody().image).toEqual([
        'https://example.com/a.png', 'data:image/webp;base64,AAAA', `data:image/jpeg;base64,${b64(JPEG)}`,
      ]);
    });

    it.each([
      ['png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'image/png'],
      ['jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0]), 'image/jpeg'],
      ['webp', new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50, 0]), 'image/webp'],
      ['gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0]), 'image/gif'],
      ['bmp', new Uint8Array([0x42, 0x4d, 0, 0, 0]), 'image/bmp'],
      ['tiff (little endian)', new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0]), 'image/tiff'],
      ['tiff (big endian)', new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0]), 'image/tiff'],
      ['heic (brand heic)', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0]), 'image/heic'],
      ['heic (brand heix)', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x78, 0]), 'image/heic'],
      ['heif (brand mif1)', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0]), 'image/heif'],
      ['heif (brand heif)', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x66, 0]), 'image/heif'],
    ])('detects %s from its magic bytes, whatever the file is called', async (_name, bytes, mime) => {
      mockReadFile.mockResolvedValue(bytes);

      await generateImageTool.execute({ prompt: 'x', reference_images: ['/w/misnamed.dat'], save_path: '/tmp/abu-test/out.png' });

      expect(sentBody().image).toBe(`data:${mime};base64,${b64(bytes)}`);
    });

    it.each([
      '/w/photo.JPG', '/w/shot.heic', '/w/scan.tif', '/w/PHOTO.PNG',
    ])('refuses %s when its bytes are not a recognised image, whatever the name says', async (path) => {
      mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));

      const result = await generateImageTool.execute({ prompt: 'x', reference_images: [path], save_path: '/tmp/abu-test/out.png' });

      expect(result as string).toContain(path);
      expect(result as string).toContain('not a supported format');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('refuses text content named like an image and uploads nothing', async () => {
      mockReadFile.mockResolvedValue(new TextEncoder().encode('api_key=not-a-picture'));

      const result = await generateImageTool.execute({ prompt: 'x', reference_images: ['/w/looks-like.png'], save_path: '/tmp/abu-test/out.png' });

      expect(result as string).toContain('not a supported format');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('writes the format in the data URI in lowercase, as Ark requires', async () => {
      mockReadFile.mockResolvedValue(PNG);

      await generateImageTool.execute({ prompt: 'x', reference_images: ['/w/PHOTO.PNG'], save_path: '/tmp/abu-test/out.png' });

      expect(String(sentBody().image)).toMatch(/^data:image\/png;base64,/);
    });

    function useBackendModel(model: string) {
      useSettingsStore.setState({
        imageGeneration: { backends: [imageGenBackend({ model })], defaultId: 'volc' },
      });
    }

    const urls = (count: number) => Array.from({ length: count }, (_, i) => `https://example.com/${i}.png`);

    it('rejects more than 14 reference images on Seedream 4.5 without reading or calling anything', async () => {
      const result = await generateImageTool.execute({ prompt: 'x', reference_images: urls(15), save_path: '/tmp/abu-test/out.png' });

      expect(result as string).toContain('at most 14');
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('accepts 14 reference images on Seedream 4.5 and on 5.0 lite', async () => {
      await generateImageTool.execute({ prompt: 'x', reference_images: urls(14), save_path: '/tmp/abu-test/out.png' });
      expect(sentBody().image).toEqual(urls(14));

      mockFetch.mockClear();
      useBackendModel('doubao-seedream-5-0-lite-260128');
      await generateImageTool.execute({ prompt: 'x', reference_images: urls(14), save_path: '/tmp/abu-test/out.png' });
      expect(sentBody().image).toEqual(urls(14));
    });

    it.each(['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260628'])(
      'caps %s at 10 reference images, before calling the API',
      async (model) => {
        useBackendModel(model);

        const result = await generateImageTool.execute({ prompt: 'x', reference_images: urls(11), save_path: '/tmp/abu-test/out.png' });

        expect(result as string).toContain('at most 10');
        expect(result as string).toContain('11 were given');
        expect(mockFetch).not.toHaveBeenCalled();

        await generateImageTool.execute({ prompt: 'x', reference_images: urls(10), save_path: '/tmp/abu-test/out.png' });
        expect(sentBody().image).toEqual(urls(10));
      },
    );

    it('rejects a file over 20 MB and points at process_image', async () => {
      mockReadFile.mockResolvedValue(new Uint8Array(20 * MB + 1));

      const result = await generateImageTool.execute({ prompt: 'x', reference_images: ['/w/huge.png'], save_path: '/tmp/abu-test/out.png' });

      expect(result as string).toContain('/w/huge.png');
      expect(result as string).toContain('20.0 MB');
      expect(result as string).toContain('process_image');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('accepts a file of exactly 20 MB', async () => {
      const exactly = new Uint8Array(20 * MB);
      exactly.set(PNG);
      mockReadFile.mockResolvedValue(exactly);

      await generateImageTool.execute({ prompt: 'x', reference_images: ['/w/edge.png'], save_path: '/tmp/abu-test/out.png' });

      expect(String(sentBody().image)).toMatch(/^data:image\/png;base64,/);
    });

    it('maps size through the Seedream 5.0 contract: tiers pass through, nothing is pushed up to 3,686,400px', async () => {
      useBackendModel('doubao-seedream-5-0-pro-260628');

      await generateImageTool.execute({ prompt: 'x', size: '2K', save_path: '/tmp/abu-test/out.png' });
      expect(sentBody().size).toBe('2K');

      mockFetch.mockClear();
      await generateImageTool.execute({ prompt: 'x', size: '1024x1024', save_path: '/tmp/abu-test/out.png' });
      expect(sentBody().size).toBe('1024x1024');
    });

    it('reports a file that cannot be read, naming the path, and calls nothing', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

      const result = await generateImageTool.execute({ prompt: 'x', reference_images: ['/w/gone.png'], save_path: '/tmp/abu-test/out.png' });

      expect(result as string).toContain('/w/gone.png');
      expect(result as string).toContain('ENOENT');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('refuses reference images on a non-Volcengine backend, without reading files or calling the API', async () => {
      useSettingsStore.setState({
        imageGeneration: {
          backends: [imageGenBackend({ id: 'oai', vendor: 'openai', baseUrl: 'https://api.openai.com', model: 'dall-e-3' })],
          defaultId: 'oai',
        },
      });

      const result = await generateImageTool.execute({ prompt: 'x', reference_images: ['/w/a.png'], save_path: '/tmp/abu-test/out.png' });

      expect(result as string).toMatch(/^Error: /);
      expect(result as string).toContain('openai');
      expect(result as string).toContain('Volcengine Seedream');
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('still generates on a non-Volcengine backend when no reference image is given', async () => {
      useSettingsStore.setState({
        imageGeneration: {
          backends: [imageGenBackend({ id: 'oai', vendor: 'openai', baseUrl: 'https://api.openai.com', model: 'dall-e-3' })],
          defaultId: 'oai',
        },
      });

      const result = await generateImageTool.execute({ prompt: 'x', reference_images: [], save_path: '/tmp/abu-test/out.png' });

      expect(result as string).toContain('/tmp/abu-test/out.png');
      expect(sentBody()).not.toHaveProperty('image');
    });

    it('reads through the operation\'s file access when the host provides it', async () => {
      const readFile = vi.fn().mockResolvedValue(PNG);

      await generateImageTool.execute(
        { prompt: 'x', reference_images: ['/w/a.png'], save_path: '/tmp/abu-test/out.png' },
        filesStub(readFile),
      );

      expect(readFile).toHaveBeenCalledWith('/w/a.png');
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(sentBody().image).toBe(`data:image/png;base64,${b64(PNG)}`);
    });
  });
});
