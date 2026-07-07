import { describe, it, expect } from 'vitest';
import { applyModelRequestProcessors } from './modelRequestProcessors';

const run = (body: Record<string, unknown>, ctx: Parameters<typeof applyModelRequestProcessors>[1]) => {
  applyModelRequestProcessors(body, ctx);
  return body;
};

describe('modelRequestProcessors', () => {
  it('responses-native-fallback: gpt-5.5 + tools on openai host drops reasoning_effort', () => {
    const b = run({ model: 'gpt-5.5', reasoning_effort: 'medium', tools: [{}] },
      { modelId: 'gpt-5.5', requestHost: 'api.openai.com', hasTools: true, caps: undefined });
    expect(b.reasoning_effort).toBeUndefined();
    expect(Array.isArray(b.tools)).toBe(true);
  });
  it('responses-native-fallback: gpt-5.5 + tools on NON-openai host also drops reasoning_effort', () => {
    // Regression: the original guard required isDirectOpenAIHost, so proxies/gateways
    // would still send reasoning_effort and get a 400 from OpenAI's API.
    const b = run({ model: 'gpt-5.5', reasoning_effort: 'high', tools: [{}] },
      { modelId: 'gpt-5.5', requestHost: 'proxy.corp', hasTools: true, caps: undefined });
    expect(b.reasoning_effort).toBeUndefined();
    expect(Array.isArray(b.tools)).toBe(true);
  });
  it('reasoning-support: declared supportsReasoning=false strips reasoning_effort', () => {
    const b = run({ reasoning_effort: 'high' },
      { modelId: 'x', requestHost: 'h', hasTools: false, caps: { supportsReasoning: false } });
    expect(b.reasoning_effort).toBeUndefined();
  });
  it('tools-gate: declared supportsTools=false removes tools + tool_choice', () => {
    const b = run({ tools: [{}], tool_choice: 'auto' },
      { modelId: 'x', requestHost: 'h', hasTools: true, caps: { supportsTools: false } });
    expect(b.tools).toBeUndefined();
    expect(b.tool_choice).toBeUndefined();
  });
  it('effort-clamp: reasoning_effort outside supportedEfforts clamps to nearest', () => {
    const b = run({ reasoning_effort: 'high' },
      { modelId: 'x', requestHost: 'h', hasTools: false, caps: { supportedEfforts: ['low', 'medium'] } });
    expect(b.reasoning_effort).toBe('medium');
  });
  it('no caps + non-openai host: leaves body untouched', () => {
    const b = run({ reasoning_effort: 'medium', tools: [{}] },
      { modelId: 'llama3', requestHost: 'localhost', hasTools: true, caps: undefined });
    expect(b.reasoning_effort).toBe('medium');
    expect(Array.isArray(b.tools)).toBe(true);
  });
});
