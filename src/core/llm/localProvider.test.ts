import { describe, it, expect } from 'vitest';
import { isLoopbackUrl, localServerKind } from './localProvider';

describe('isLoopbackUrl', () => {
  it('recognizes the loopback spellings a local server uses', () => {
    for (const url of [
      'http://127.0.0.1:1234/v1',
      'http://localhost:8080',
      'http://api.localhost:9000/v1',
      'http://[::1]:11434',
      'http://0.0.0.0:8000/v1',
      'http://2130706433:5000/v1',
      '127.0.0.1:1234',
    ]) {
      expect(isLoopbackUrl(url)).toBe(true);
    }
  });

  it('treats remote hosts and unparseable input as not local', () => {
    for (const url of ['https://api.deepseek.com', 'http://192.168.1.20:8080/v1', '', 'http://']) {
      expect(isLoopbackUrl(url)).toBe(false);
    }
  });
});

describe('localServerKind', () => {
  it('names Ollama and LM Studio by provider type', () => {
    expect(localServerKind({ id: 'ollama', source: 'builtin', baseUrl: 'http://10.0.0.5:11434' })).toBe('ollama');
    expect(localServerKind({ id: 'lmstudio', source: 'builtin', baseUrl: 'http://127.0.0.1:1234/v1' })).toBe('lmstudio');
  });

  it('treats a custom provider on this machine as a local server', () => {
    expect(localServerKind({ id: 'p1', source: 'custom', baseUrl: 'http://127.0.0.1:8080/v1' })).toBe('custom-local');
  });

  it('never treats a builtin cloud provider or a remote custom provider as local', () => {
    expect(localServerKind({ id: 'deepseek', source: 'builtin', baseUrl: 'http://localhost:9999' })).toBeNull();
    expect(localServerKind({ id: 'p2', source: 'custom', baseUrl: 'https://llm.example.com/v1' })).toBeNull();
    expect(localServerKind(undefined)).toBeNull();
  });
});
