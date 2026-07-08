/// <reference types="@testing-library/jest-dom" />
/**
 * Unit tests for the advanced-config section in AddProviderModal.
 *
 * Full component render is impractical here: the modal depends on
 * useSettingsStore (persist + Tauri secret store), createPortal, and a dozen
 * LLM-core modules. Mocking all of them would produce a brittle test shell
 * that verifies the mock wiring rather than the logic. Instead, we test the
 * two non-trivial pure-logic pieces via their shared helper module, which the
 * component itself imports — so these tests guard the real shipped code.
 *
 *   1. showAdvanced predicate — must be true for custom/ollama/lmstudio,
 *      false for builtin cloud providers.
 *   2. supportedEfforts toggle reducer — the Set-based add/delete logic.
 */
import { describe, it, expect } from 'vitest';
import { computeShowAdvanced, toggleEffort } from './providerCapabilities';

// ── Tests ──────────────────────────────────────────────────────────

describe('AddProviderModal — showAdvanced predicate', () => {
  it('shows advanced section for custom OpenAI-compatible provider', () => {
    expect(computeShowAdvanced(true, 'custom', 'openai-compatible')).toBe(true);
  });

  it('hides advanced section for custom Anthropic-format provider', () => {
    expect(computeShowAdvanced(true, 'custom', 'anthropic')).toBe(false);
  });

  it('shows advanced section for ollama', () => {
    expect(computeShowAdvanced(false, 'ollama', undefined)).toBe(true);
  });

  it('shows advanced section for lmstudio', () => {
    expect(computeShowAdvanced(false, 'lmstudio', undefined)).toBe(true);
  });

  it('hides advanced section for builtin cloud provider (anthropic)', () => {
    expect(computeShowAdvanced(false, 'anthropic', 'anthropic')).toBe(false);
  });

  it('hides advanced section for builtin cloud provider (openai)', () => {
    expect(computeShowAdvanced(false, 'openai', 'openai-compatible')).toBe(false);
  });

  it('hides advanced section when no provider is selected', () => {
    expect(computeShowAdvanced(false, undefined, undefined)).toBe(false);
  });
});

describe('AddProviderModal — supportedEfforts toggle reducer', () => {
  it('adds an effort level when not present', () => {
    const result = toggleEffort(undefined, 'low');
    expect(result).toContain('low');
  });

  it('removes an effort level when already present', () => {
    const result = toggleEffort(['low', 'medium'], 'low');
    expect(result).not.toContain('low');
    expect(result).toContain('medium');
  });

  it('preserves other effort levels when toggling a new one', () => {
    const result = toggleEffort(['medium'], 'high');
    expect(result).toContain('medium');
    expect(result).toContain('high');
  });

  it('handles toggle on empty supportedEfforts', () => {
    const result = toggleEffort([], 'medium');
    expect(result).toEqual(['medium']);
  });

  it('can build all three effort levels independently', () => {
    let d: Array<'low' | 'medium' | 'high'> | undefined = undefined;
    d = toggleEffort(d, 'low');
    d = toggleEffort(d, 'medium');
    d = toggleEffort(d, 'high');
    expect(new Set(d)).toEqual(new Set(['low', 'medium', 'high']));
  });
});
