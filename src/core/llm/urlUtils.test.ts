import { describe, it, expect } from 'vitest';
import { normalizeBaseUrl, resolveOpenAIBaseUrl, buildFullChatUrl, normalizeImageGenerationsUrl } from './urlUtils';

describe('urlUtils', () => {
  describe('normalizeBaseUrl', () => {
    it('returns empty string for empty/null/undefined input', () => {
      expect(normalizeBaseUrl('')).toBe('');
      expect(normalizeBaseUrl(null)).toBe('');
      expect(normalizeBaseUrl(undefined)).toBe('');
    });

    it('strips leading and trailing whitespace', () => {
      expect(normalizeBaseUrl('  http://x.com  ')).toBe('http://x.com');
      expect(normalizeBaseUrl('\thttp://x.com\n')).toBe('http://x.com');
    });

    it('strips trailing slashes', () => {
      expect(normalizeBaseUrl('http://x.com/')).toBe('http://x.com');
      expect(normalizeBaseUrl('http://x.com///')).toBe('http://x.com');
    });

    it('strips trailing whitespace after slash (regression: %20 path bug)', () => {
      // The original bug: trailing space after slash would survive both
      // the trim-less regex and the /v<digit>$ check, producing a URL
      // with an encoded space mid-path.
      expect(normalizeBaseUrl('http://x.com/ ')).toBe('http://x.com');
      expect(normalizeBaseUrl('  http://x.com/  ')).toBe('http://x.com');
    });

    it('preserves existing path segments', () => {
      expect(normalizeBaseUrl('http://x.com/api/v1')).toBe('http://x.com/api/v1');
      expect(normalizeBaseUrl('http://x.com/api/v1/')).toBe('http://x.com/api/v1');
    });
  });

  describe('resolveOpenAIBaseUrl', () => {
    it('falls back to OpenAI default when input is empty', () => {
      expect(resolveOpenAIBaseUrl('')).toBe('https://api.openai.com/v1');
      expect(resolveOpenAIBaseUrl(undefined)).toBe('https://api.openai.com/v1');
    });

    it('auto-appends /v1 when base URL lacks version suffix', () => {
      expect(resolveOpenAIBaseUrl('http://x.com')).toBe('http://x.com/v1');
      expect(resolveOpenAIBaseUrl('http://x.com/')).toBe('http://x.com/v1');
    });

    it('preserves existing /vN suffix', () => {
      expect(resolveOpenAIBaseUrl('http://x.com/v1')).toBe('http://x.com/v1');
      expect(resolveOpenAIBaseUrl('http://x.com/v2')).toBe('http://x.com/v2');
      expect(resolveOpenAIBaseUrl('http://x.com/v1/')).toBe('http://x.com/v1');
    });

    it('trims whitespace before applying suffix logic', () => {
      // Regression: trailing space used to bypass trailing-slash strip,
      // skip the /v<digit> check, and produce a URL like "http://x.com/ /v1".
      expect(resolveOpenAIBaseUrl('http://x.com/ ')).toBe('http://x.com/v1');
      expect(resolveOpenAIBaseUrl(' http://x.com/v1 ')).toBe('http://x.com/v1');
    });
  });

  describe('buildFullChatUrl', () => {
    it('builds OpenAI-compatible chat completions URL', () => {
      expect(buildFullChatUrl('http://x.com', 'openai-compatible'))
        .toBe('http://x.com/v1/chat/completions');
      expect(buildFullChatUrl('http://x.com/v1', 'openai-compatible'))
        .toBe('http://x.com/v1/chat/completions');
    });

    // Phase 3: idempotent normalization + useRawUrl
    describe('idempotent normalization', () => {
      const f = (u: string, opts?: { useRawUrl?: boolean }) =>
        buildFullChatUrl(u, 'openai-compatible', opts);

      it('bare host → append /v1/chat/completions', () => {
        expect(f('https://api.example.com')).toBe('https://api.example.com/v1/chat/completions');
      });
      it('base ending /v1 → append once', () => {
        expect(f('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions');
      });
      it('full endpoint → returned as-is (no double append)', () => {
        expect(f('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/chat/completions');
      });
      it('trailing slash + full endpoint → normalized once', () => {
        expect(f('https://api.example.com/v1/chat/completions/')).toBe('https://api.example.com/v1/chat/completions');
      });
      it('preserves query/fragment suffix', () => {
        expect(f('https://api.example.com/v1/chat/completions?x=1')).toBe('https://api.example.com/v1/chat/completions?x=1');
      });
      it('useRawUrl → use exactly, skip normalization', () => {
        expect(f('https://proxy.corp/llm/gateway', { useRawUrl: true })).toBe('https://proxy.corp/llm/gateway');
      });
      it('anthropic format unchanged by opts', () => {
        expect(buildFullChatUrl('https://api.anthropic.com', 'anthropic')).toBe('https://api.anthropic.com/v1/messages');
      });
    });

    it('builds Anthropic messages URL', () => {
      expect(buildFullChatUrl('http://x.com', 'anthropic'))
        .toBe('http://x.com/v1/messages');
      expect(buildFullChatUrl('', 'anthropic'))
        .toBe('https://api.anthropic.com/v1/messages');
    });

    it('handles the trailing-space regression for both formats', () => {
      expect(buildFullChatUrl('http://llm-proxy.intra.xiaojukeji.com/ ', 'openai-compatible'))
        .toBe('http://llm-proxy.intra.xiaojukeji.com/v1/chat/completions');
      expect(buildFullChatUrl('  http://x.com  ', 'anthropic'))
        .toBe('http://x.com/v1/messages');
    });

    it('does not produce %20 when passed through URL constructor', () => {
      // Guards the original bug: fetch would encode the mid-path space.
      const input = 'http://llm-proxy.intra.xiaojukeji.com/ ';
      const url = buildFullChatUrl(input, 'openai-compatible');
      expect(() => new URL(url)).not.toThrow();
      expect(new URL(url).pathname).toBe('/v1/chat/completions');
    });
  });

  describe('normalizeImageGenerationsUrl', () => {
    it('appends /v1/images/generations to a bare OpenAI host', () => {
      expect(normalizeImageGenerationsUrl('https://api.openai.com'))
        .toBe('https://api.openai.com/v1/images/generations');
    });
    it('keeps an existing version segment (ark /api/v3) and appends once', () => {
      expect(normalizeImageGenerationsUrl('https://ark.cn-beijing.volces.com/api/v3'))
        .toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
    });
    it('keeps Agent Plan /api/plan/v3 and appends once', () => {
      expect(normalizeImageGenerationsUrl('https://ark.cn-beijing.volces.com/api/plan/v3'))
        .toBe('https://ark.cn-beijing.volces.com/api/plan/v3/images/generations');
    });
    it('is idempotent when given the FULL endpoint (no path doubling)', () => {
      expect(normalizeImageGenerationsUrl('https://ark.cn-beijing.volces.com/api/v3/images/generations'))
        .toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
    });
    it('strips repeated /images/generations and trailing slashes', () => {
      expect(normalizeImageGenerationsUrl('https://x.com/api/v3/images/generations/images/generations/'))
        .toBe('https://x.com/api/v3/images/generations');
    });
    it('keeps a gateway /v1 and appends once', () => {
      expect(normalizeImageGenerationsUrl('https://oneapi.qunhequnhe.com/v1'))
        .toBe('https://oneapi.qunhequnhe.com/v1/images/generations');
    });
    it('preserves a query suffix', () => {
      expect(normalizeImageGenerationsUrl('https://x.com/api/v3/images/generations?k=1'))
        .toBe('https://x.com/api/v3/images/generations?k=1');
    });
  });
});
