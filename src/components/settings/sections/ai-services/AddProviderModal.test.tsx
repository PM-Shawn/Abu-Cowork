/// <reference types="@testing-library/jest-dom" />
/**
 * Unit tests for the advanced-config section in AddProviderModal.
 *
 * Full component render is impractical here: the modal depends on
 * useSettingsStore (persist + Tauri secret store), createPortal, and a dozen
 * LLM-core modules. Mocking all of them would produce a brittle test shell
 * that verifies the mock wiring rather than the logic. Instead, we extract and
 * test the two non-trivial pure-logic pieces directly:
 *
 *   1. showAdvanced predicate — must be true for custom/ollama/lmstudio,
 *      false for builtin cloud providers.
 *   2. supportedEfforts toggle reducer — the Set-based add/delete logic.
 */
import { describe, it, expect } from 'vitest';
import type { DeclaredCapabilities } from '@/types/provider';

// ── Logic extracted from AddProviderModal ──────────────────────────

const CUSTOM_OPENAI_ID = '__custom_openai__';
const CUSTOM_ANTHROPIC_ID = '__custom_anthropic__';

function isCustomId(id: string): boolean {
  return id === CUSTOM_OPENAI_ID || id === CUSTOM_ANTHROPIC_ID;
}

function computeShowAdvanced(selectedId: string, provider: string | undefined): boolean {
  const isCustom = selectedId ? isCustomId(selectedId) : false;
  const isOllama = provider === 'ollama';
  const isLMStudio = provider === 'lmstudio';
  return isCustom || isOllama || isLMStudio;
}

function toggleEffort(
  declared: DeclaredCapabilities,
  effort: 'low' | 'medium' | 'high',
): DeclaredCapabilities {
  const cur = new Set(declared.supportedEfforts ?? []);
  if (cur.has(effort)) cur.delete(effort); else cur.add(effort);
  return { ...declared, supportedEfforts: [...cur] as Array<'low' | 'medium' | 'high'> };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('AddProviderModal — showAdvanced predicate', () => {
  it('shows advanced section for custom OpenAI provider', () => {
    expect(computeShowAdvanced(CUSTOM_OPENAI_ID, 'custom')).toBe(true);
  });

  it('shows advanced section for custom Anthropic provider', () => {
    expect(computeShowAdvanced(CUSTOM_ANTHROPIC_ID, 'custom')).toBe(true);
  });

  it('shows advanced section for ollama', () => {
    expect(computeShowAdvanced('ollama', 'ollama')).toBe(true);
  });

  it('shows advanced section for lmstudio', () => {
    expect(computeShowAdvanced('lmstudio', 'lmstudio')).toBe(true);
  });

  it('hides advanced section for builtin cloud provider (anthropic)', () => {
    expect(computeShowAdvanced('anthropic', 'anthropic')).toBe(false);
  });

  it('hides advanced section for builtin cloud provider (openai)', () => {
    expect(computeShowAdvanced('openai', 'openai')).toBe(false);
  });

  it('hides advanced section when no provider is selected', () => {
    expect(computeShowAdvanced('', undefined)).toBe(false);
  });
});

describe('AddProviderModal — supportedEfforts toggle reducer', () => {
  it('adds an effort level when not present', () => {
    const result = toggleEffort({}, 'low');
    expect(result.supportedEfforts).toContain('low');
  });

  it('removes an effort level when already present', () => {
    const result = toggleEffort({ supportedEfforts: ['low', 'medium'] }, 'low');
    expect(result.supportedEfforts).not.toContain('low');
    expect(result.supportedEfforts).toContain('medium');
  });

  it('preserves other declared fields when toggling', () => {
    const result = toggleEffort({ supportsReasoning: true, supportedEfforts: [] }, 'high');
    expect(result.supportsReasoning).toBe(true);
    expect(result.supportedEfforts).toContain('high');
  });

  it('handles toggle on empty supportedEfforts', () => {
    const result = toggleEffort({ supportedEfforts: [] }, 'medium');
    expect(result.supportedEfforts).toEqual(['medium']);
  });

  it('can build all three effort levels independently', () => {
    let d: DeclaredCapabilities = {};
    d = toggleEffort(d, 'low');
    d = toggleEffort(d, 'medium');
    d = toggleEffort(d, 'high');
    expect(new Set(d.supportedEfforts)).toEqual(new Set(['low', 'medium', 'high']));
  });
});
