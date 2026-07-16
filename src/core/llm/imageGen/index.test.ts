import { describe, it, expect } from 'vitest';
import { buildImageRequest, parseImageResponse } from './index';

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

    it('does not add a dall-e-only style field', () => {
      const body = buildImageRequest('volcengine', { model: 'doubao-seedream-4-5', prompt: 'x', style: 'vivid' });
      expect(body).not.toHaveProperty('style');
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
