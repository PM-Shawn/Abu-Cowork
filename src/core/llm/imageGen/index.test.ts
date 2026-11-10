import { describe, it, expect } from 'vitest';
import { buildImageRequest, parseImageResponse, volcengineMaxReferenceImages } from './index';

describe('buildImageRequest', () => {
  describe('openai', () => {
    it('includes response_format:b64_json and style for dall-e-3', () => {
      const body = buildImageRequest('openai', { model: 'dall-e-3', prompt: 'a cat', style: 'natural' });
      expect(body).toMatchObject({ model: 'dall-e-3', prompt: 'a cat', n: 1, response_format: 'b64_json', style: 'natural' });
    });

    it('omits response_format for gpt-image-1 (it rejects the field outright)', () => {
      const body = buildImageRequest('openai', { model: 'gpt-image-1', prompt: 'a cat' });
      expect(body).not.toHaveProperty('response_format');
      expect(body).not.toHaveProperty('style');
      expect(body).toMatchObject({ model: 'gpt-image-1', prompt: 'a cat', n: 1 });
    });

    it('snaps an unsupported size for dall-e-3 instead of forwarding it as-is', () => {
      const body = buildImageRequest('openai', { model: 'dall-e-3', prompt: 'x', size: '512x512' });
      expect(body.size).toBe('1024x1024');
    });

    it('defaults size to 1024x1024 when the caller does not pass one (F4 regression: custom/OpenAI-shape endpoints 400 without a size)', () => {
      const body = buildImageRequest('openai', { model: 'dall-e-3', prompt: 'x' });
      expect(body.size).toBe('1024x1024');
    });
  });

  describe('volcengine', () => {
    it('scales a below-floor size up to meet the Seedream pixel floor', () => {
      const body = buildImageRequest('volcengine', { model: 'doubao-seedream-4-5', prompt: 'x', size: '1024x1024' });
      expect(body.size).toBe('1920x1920'); // 1024x1024 → scaled up to the floor, square preserved
      expect(body.response_format).toBe('b64_json');
    });

    it('omits size when the caller does not pass one (no forced default)', () => {
      const body = buildImageRequest('volcengine', { model: 'doubao-seedream-4-5', prompt: 'x' });
      expect(body).not.toHaveProperty('size');
    });

    describe('Seedream 5.0 pro/flash size contract', () => {
      it('passes the 1K / 1.5K / 2K tiers through', () => {
        for (const tier of ['1K', '1.5K', '2K']) {
          expect(buildImageRequest('volcengine', { model: 'doubao-seedream-5-0-pro-260628', prompt: 'x', size: tier }).size).toBe(tier);
        }
      });

      it('keeps an in-range WxH instead of scaling it up to the older floor', () => {
        const pro = buildImageRequest('volcengine', { model: 'doubao-seedream-5-0-pro-260628', prompt: 'x', size: '1024x1024' });
        const flash = buildImageRequest('volcengine', { model: 'doubao-seedream-5-0-flash-260628', prompt: 'x', size: '1024x1024' });
        const older = buildImageRequest('volcengine', { model: 'doubao-seedream-4-5', prompt: 'x', size: '1024x1024' });
        expect(pro.size).toBe('1024x1024');
        expect(flash.size).toBe('1024x1024');
        expect(older.size).toBe('1920x1920');
      });

      it('clamps a too-large WxH under the 4,624,220px ceiling', () => {
        const body = buildImageRequest('volcengine', { model: 'doubao-seedream-5-0-pro-260628', prompt: 'x', size: '4096x4096' });
        expect(body.size).toBe('2144x2144');
      });
    });

    it('lets the model id, not the endpoint, set the max reference count', () => {
      expect(volcengineMaxReferenceImages('doubao-seedream-5-0-pro-260628')).toBe(10);
      expect(volcengineMaxReferenceImages('doubao-seedream-5-0-flash-260628')).toBe(10);
      expect(volcengineMaxReferenceImages('doubao-seedream-5-0-lite-260128')).toBe(14);
      expect(volcengineMaxReferenceImages('doubao-seedream-4-5-251128')).toBe(14);
      expect(volcengineMaxReferenceImages('doubao-seedream-4-0-250828')).toBe(14);
    });

    it('does not add a dall-e-only style field', () => {
      const body = buildImageRequest('volcengine', { model: 'doubao-seedream-4-5', prompt: 'x', style: 'vivid' });
      expect(body).not.toHaveProperty('style');
    });

    // The API stamps a watermark unless told otherwise (default true).
    it('always asks for no watermark, with or without reference images', () => {
      for (const model of ['doubao-seedream-4-5', 'doubao-seedream-5-0-pro-260628']) {
        expect(buildImageRequest('volcengine', { model, prompt: 'x' }).watermark).toBe(false);
        expect(buildImageRequest('volcengine', { model, prompt: 'x', referenceImages: ['https://example.com/a.png'] }).watermark).toBe(false);
      }
    });

    it('sends watermark only to Volcengine, not to other vendors', () => {
      for (const vendor of ['openai', 'custom', 'siliconflow', 'zhipu'] as const) {
        expect(buildImageRequest(vendor, { model: 'm', prompt: 'x' })).not.toHaveProperty('watermark');
      }
    });

    describe('reference images', () => {
      const A = 'data:image/png;base64,AAAA';
      const B = 'https://example.com/b.jpg';

      it('omits image when there are no reference images (undefined or empty)', () => {
        expect(buildImageRequest('volcengine', { model: 'm', prompt: 'x' })).not.toHaveProperty('image');
        expect(buildImageRequest('volcengine', { model: 'm', prompt: 'x', referenceImages: [] })).not.toHaveProperty('image');
      });

      it('sends a single reference image as a plain string', () => {
        const body = buildImageRequest('volcengine', { model: 'm', prompt: 'x', referenceImages: [A] });
        expect(body.image).toBe(A);
      });

      it('sends several reference images as an array in the given order', () => {
        const body = buildImageRequest('volcengine', { model: 'm', prompt: 'x', referenceImages: [A, B] });
        expect(body.image).toEqual([A, B]);
      });

      it('never sends sequential_image_generation (Seedream 5.0 rejects it even when "disabled")', () => {
        const body = buildImageRequest('volcengine', { model: 'm', prompt: 'x', referenceImages: [A, B] });
        expect(body).not.toHaveProperty('sequential_image_generation');
      });
    });
  });

  describe('siliconflow', () => {
    it('renames size to image_size and n to batch_size', () => {
      const body = buildImageRequest('siliconflow', { model: 'some-sf-model', prompt: 'x', size: '1024x1024' });
      expect(body).toMatchObject({ model: 'some-sf-model', prompt: 'x', batch_size: 1, image_size: '1024x1024' });
      expect(body).not.toHaveProperty('size');
      expect(body).not.toHaveProperty('n');
    });

    it('does not send response_format (unsupported/unconfirmed)', () => {
      const body = buildImageRequest('siliconflow', { model: 'some-sf-model', prompt: 'x' });
      expect(body).not.toHaveProperty('response_format');
    });
  });

  describe('zhipu', () => {
    it('builds an OpenAI-shape request as a documented fallback', () => {
      const body = buildImageRequest('zhipu', { model: 'cogview-4', prompt: 'x', size: '1024x1024' });
      expect(body).toMatchObject({ model: 'cogview-4', prompt: 'x', n: 1, size: '1024x1024' });
    });
  });

  describe('custom', () => {
    it('falls back to the default OpenAI-shape builder', () => {
      const body = buildImageRequest('custom', { model: 'some-gateway-model', prompt: 'x' });
      expect(body).toMatchObject({ model: 'some-gateway-model', prompt: 'x', n: 1, response_format: 'b64_json' });
    });

    it('defaults size to 1024x1024 when the caller does not pass one (F4 regression)', () => {
      const body = buildImageRequest('custom', { model: 'some-gateway-model', prompt: 'x' });
      expect(body.size).toBe('1024x1024');
    });
  });
});

describe('parseImageResponse', () => {
  it('parses the OpenAI/Volcengine/Zhipu/custom data[] envelope', () => {
    const json = { data: [{ b64_json: 'AAAA', revised_prompt: 'a nicer cat' }] };
    expect(parseImageResponse('openai', json)).toEqual({ b64: 'AAAA', url: undefined, revisedPrompt: 'a nicer cat' });
    expect(parseImageResponse('volcengine', json)).toEqual({ b64: 'AAAA', url: undefined, revisedPrompt: 'a nicer cat' });
    expect(parseImageResponse('custom', json)).toEqual({ b64: 'AAAA', url: undefined, revisedPrompt: 'a nicer cat' });
  });

  it('parses the zhipu data[] envelope (url field)', () => {
    const json = { data: [{ url: 'https://example.com/cat.png' }] };
    expect(parseImageResponse('zhipu', json)).toEqual({ b64: undefined, url: 'https://example.com/cat.png' });
  });

  it('normalizes the SiliconFlow images[] envelope into the shared shape', () => {
    const json = { images: [{ url: 'https://example.com/cat.png' }] };
    expect(parseImageResponse('siliconflow', json)).toEqual({ url: 'https://example.com/cat.png' });
  });

  it('returns an empty result when the envelope is missing/malformed', () => {
    expect(parseImageResponse('openai', {})).toEqual({ b64: undefined, url: undefined, revisedPrompt: undefined });
    expect(parseImageResponse('siliconflow', {})).toEqual({ url: undefined });
  });
});
