import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkOllamaHealth } from './ollama';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('./tauriFetch', () => ({ getTauriFetch: async () => mocks.fetch }));

const FAKE_URL_PASSWORD = 'test-password-not-a-secret';
const FAKE_TOKEN = 'sk-test-not-a-secret';
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

describe('checkOllamaHealth', () => {
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    mocks.fetch.mockReset();
    consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function loggedText(): string {
    return consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((arg: unknown) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : JSON.stringify(arg))).join(' '))
      .join('\n');
  }

  describe('failure text', () => {
    it('removes the account and password of a base URL echoed by the exception', async () => {
      const baseUrl = `http://user:${FAKE_URL_PASSWORD}@ollama.example.test:11434`;
      mocks.fetch.mockRejectedValue(
        new TypeError(`Request cannot be constructed from a URL that includes credentials: ${baseUrl}/`),
      );

      const result = await checkOllamaHealth(baseUrl);

      expect(result).toEqual({
        ok: false,
        error: 'Request cannot be constructed from a URL that includes credentials: [REDACTED]/',
      });
      expect(loggedText()).not.toContain(FAKE_URL_PASSWORD);
    });

    it('removes a URL password that contains URL delimiters', async () => {
      const baseUrl = 'http://user:test-pass/word@not#a-secret@ollama.example.test:11434';
      mocks.fetch.mockRejectedValue(new TypeError(`Failed to parse URL from ${baseUrl}`));

      const result = await checkOllamaHealth(baseUrl);

      expect(result.error).toBe('Failed to parse URL from [REDACTED]');
      expect(loggedText()).not.toContain('word@not#a-secret');
    });

    it('removes a token carried in the query string of an unparseable base URL', async () => {
      const baseUrl = `http://ollama.example.test:99999?token=${FAKE_TOKEN}`;
      mocks.fetch.mockRejectedValue(new TypeError(`Failed to parse URL from ${baseUrl}`));

      const result = await checkOllamaHealth(baseUrl);

      expect(result.error).toBe('Failed to parse URL from http://ollama.example.test:99999?token=[REDACTED]');
      expect(loggedText()).not.toContain(FAKE_TOKEN);
    });

    it('keeps an ordinary failure readable', async () => {
      mocks.fetch.mockRejectedValue(new TypeError('fetch failed'));

      const result = await checkOllamaHealth('http://127.0.0.1:11434');

      expect(result).toEqual({ ok: false, error: 'fetch failed' });
      expect(loggedText()).toContain('fetch failed');
    });
  });

  describe('response status', () => {
    it('reports the status of a non-OK response', async () => {
      mocks.fetch.mockResolvedValue({ ok: false, status: 502 });

      expect(await checkOllamaHealth('http://127.0.0.1:11434')).toEqual({ ok: false, error: 'HTTP 502' });
    });

    it('reports success for an OK response', async () => {
      mocks.fetch.mockResolvedValue({ ok: true, status: 200 });

      expect(await checkOllamaHealth('http://127.0.0.1:11434')).toEqual({ ok: true });
    });
  });
});
