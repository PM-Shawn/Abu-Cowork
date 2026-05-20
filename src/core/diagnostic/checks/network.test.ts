import { describe, it, expect } from 'vitest';
import { buildProbeUrl } from './network';

describe('buildProbeUrl', () => {
  // Regression: DeepSeek's baseUrl is the bare domain. A HEAD against `/`
  // got dropped at the connection level (reqwest: "error sending request
  // for url"), even though the API itself was reachable. Probing /v1/models
  // surfaces a real HTTP status (401), which the runner treats as reachable.
  it('appends /v1/models when baseUrl has no path', () => {
    expect(buildProbeUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/models');
    expect(buildProbeUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com/v1/models');
  });

  it('preserves existing path on baseUrl', () => {
    expect(buildProbeUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(buildProbeUrl('https://example.com/api/v2')).toBe('https://example.com/api/v2');
  });

  it('returns input unchanged when URL is unparseable', () => {
    expect(buildProbeUrl('not a url')).toBe('not a url');
  });
});
