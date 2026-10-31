import type { ImageGenBackend } from '@/types/provider';

export interface ImageEditCapabilities {
  whole: boolean;
  comments: boolean;
  markup: boolean;
  region: boolean;
  markupTransport: 'overlay' | 'reference';
  formats: readonly string[];
  maxBytes: number;
  maxPixels: number;
  canQuery: boolean;
  canCancel: boolean;
  profileVersion: string;
}

const unsupported: ImageEditCapabilities = {
  whole: false, comments: false, markup: false, region: false, markupTransport: 'overlay', formats: [],
  maxBytes: 0, maxPixels: 0, canQuery: false, canCancel: false, profileVersion: 'unavailable',
};

export function imageEditCapabilities(backend: Pick<ImageGenBackend, 'vendor' | 'baseUrl' | 'model'> | null): ImageEditCapabilities {
  if (!backend) return unsupported;
  if (!URL.canParse(backend.baseUrl)) return unsupported;
  const url = new URL(backend.baseUrl);
  if (url.search || url.hash || url.username || url.password) return unsupported;
  if (backend.vendor === 'volcengine' && url.origin === 'https://ark.cn-beijing.volces.com'
    && /^\/api\/(plan\/)?v3\/images\/generations\/?$/.test(url.pathname)
    && /^doubao-seedream-5[.-]0-(lite|flash)(-\d{6})?$/.test(backend.model)) {
    return {
      whole: true, comments: true, markup: true, region: false, markupTransport: 'reference',
      formats: ['image/png'], maxBytes: 30 * 1024 * 1024, maxPixels: 36_000_000,
      canQuery: false, canCancel: false,
      profileVersion: backend.model.includes('-flash') ? 'seedream-5-flash-reference-2026-10-30' : 'seedream-5-lite-reference-2026-10-30',
    };
  }
  if (backend.vendor !== 'openai' || url.origin !== 'https://api.openai.com' || !['', '/', '/v1', '/v1/'].includes(url.pathname)) return unsupported;
  if (!/^gpt-image-2\.5-(sunburst|flare)(-2026-09-08)?$/.test(backend.model)) return unsupported;
  return {
    whole: true, comments: true, markup: true, region: true, markupTransport: 'overlay',
    formats: ['image/png'], maxBytes: 15 * 1024 * 1024 - 64, maxPixels: 40_000_000,
    canQuery: false, canCancel: false, profileVersion: 'openai-images-edit-json-2026-10-30',
  };
}
