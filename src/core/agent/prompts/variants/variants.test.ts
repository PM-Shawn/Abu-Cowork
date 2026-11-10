import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_FAMILIES, type ModelFamily } from '@/core/llm/model-data/families';
import { resolveModelProfile } from '@/core/llm/modelProfile';
import { PROMPT_VARIANTS, familyNotesFor, resolvePromptVariant } from './index';
import {
  DEFAULT_PLANNING, PARALLEL_TOOL_CALLS_LINE, PLANNING_SITUATIONS, SYSTEM_SETTINGS_TOOL_LINE, defaultVariant,
} from './default';
import { gptVariant } from './gpt';
import { deepseekVariant } from './deepseek';
import { kimiVariant } from './kimi';
import { claudeVariant } from './claude';

function variantFor(modelId: string) {
  return resolvePromptVariant(resolveModelProfile({ modelId }));
}

describe('resolvePromptVariant', () => {
  it('without a profile returns the default fragments', () => {
    const resolved = resolvePromptVariant(undefined);
    expect(resolved.planning).toBe(DEFAULT_PLANNING);
    expect(resolved.persona).toBeUndefined();
    expect(resolved.familyNotes).toBeUndefined();
  });

  it('default planning keeps the line the Windows rewrite looks for', () => {
    expect(DEFAULT_PLANNING).toContain(SYSTEM_SETTINGS_TOOL_LINE);
    expect(defaultVariant.persona).toBeUndefined();
    expect(defaultVariant.familyNotes).toBeUndefined();
  });

  describe('claude', () => {
    it('keeps the default planning and adds the lean working notes', () => {
      const resolved = variantFor('claude-opus-5-5');
      expect(resolved.planning).toBe(DEFAULT_PLANNING);
      expect(resolved.persona).toBeUndefined();
      expect(resolved.familyNotes).toBe(claudeVariant.familyNotes);
      expect(resolved.familyNotes).toContain('Do not write a sentence ending in a colon before a tool call');
      expect(resolved.familyNotes).toContain('single JSON value');
    });
  });

  describe('gpt', () => {
    it('replaces the planning text and adds the patch-tool notes', () => {
      const resolved = variantFor('gpt-5.6-sol');
      expect(resolved.planning).toBe(gptVariant.planning);
      expect(resolved.planning).not.toBe(DEFAULT_PLANNING);
      expect(resolved.planning).toContain('report_plan is the plan');
      expect(resolved.planning).toContain(SYSTEM_SETTINGS_TOOL_LINE);
      expect(resolved.familyNotes).toBe(gptVariant.familyNotes);
      expect(resolved.familyNotes).toContain('apply_patch');
      expect(resolved.persona).toBeUndefined();
    });

    it('covers the o-series and codex ids', () => {
      expect(variantFor('o3-mini').planning).toBe(gptVariant.planning);
      expect(variantFor('codex-mini-latest').familyNotes).toBe(gptVariant.familyNotes);
    });
  });

  describe('deepseek', () => {
    it('keeps the default planning and adds the direct-tool notes', () => {
      const resolved = variantFor('deepseek-v4-pro');
      expect(resolved.planning).toBe(DEFAULT_PLANNING);
      expect(resolved.familyNotes).toBe(deepseekVariant.familyNotes);
      expect(resolved.familyNotes).toContain('Do not call get_system_info');
      // read-before-edit lives in the edit_file description only, not repeated per family
      expect(resolved.familyNotes).not.toContain('Read a file before editing it');
      expect(resolved.persona).toBeUndefined();
    });
  });

  describe('kimi', () => {
    it('keeps the default planning and adds the act-by-default notes', () => {
      const resolved = variantFor('moonshotai/kimi-k2.6');
      expect(resolved.planning).toBe(DEFAULT_PLANNING);
      expect(resolved.familyNotes).toBe(kimiVariant.familyNotes);
      expect(resolved.familyNotes).toContain('treat it as a task');
      expect(resolved.familyNotes).toContain('not saved anywhere');
      expect(resolved.persona).toBeUndefined();
    });
  });

  describe.each<[ModelFamily, string]>([
    ['qwen', 'qwen3-max'],
    ['glm', 'glm-5'],
    ['gemini', 'google/gemini-3-pro'],
    ['other', 'llama3.3:70b'],
  ])('%s', (family, modelId) => {
    it('falls back to the default on every field', () => {
      expect(PROMPT_VARIANTS[family]).toBeUndefined();
      const profile = resolveModelProfile({ modelId });
      expect(profile.family).toBe(family);
      expect(PROMPT_VARIANTS[profile.harness.promptVariant]).toBeUndefined();
      const resolved = resolvePromptVariant(profile);
      expect(resolved.planning).toBe(DEFAULT_PLANNING);
      expect(resolved.persona).toBeUndefined();
      expect(resolved.familyNotes).toBeUndefined();
      expect(familyNotesFor(profile)).toBe('');
    });
  });

  it('every family resolves to a planning text that carries the Windows rewrite line', () => {
    for (const family of MODEL_FAMILIES) {
      const resolved = resolvePromptVariant({ harness: { promptVariant: family } });
      expect(resolved.planning, family).toContain(SYSTEM_SETTINGS_TOOL_LINE);
      expect(resolved.planning, family).toContain('Situation A');
    }
  });

  it('a variant that sets only some fields takes the rest from the default', () => {
    for (const [family, variant] of Object.entries(PROMPT_VARIANTS) as Array<[ModelFamily, typeof defaultVariant]>) {
      const resolved = resolvePromptVariant({ harness: { promptVariant: family } });
      expect(resolved.planning).toBe(variant.planning ?? DEFAULT_PLANNING);
      expect(resolved.familyNotes).toBe(variant.familyNotes);
      expect(familyNotesFor({ harness: { promptVariant: family } })).toBe(variant.familyNotes ?? '');
    }
  });

  it('every fragment is English prose', () => {
    for (const variant of Object.values(PROMPT_VARIANTS)) {
      for (const text of [variant.persona, variant.planning, variant.familyNotes]) {
        if (text === undefined) continue;
        expect(text).not.toMatch(/[一-鿿]/);
      }
    }
  });

  describe('text shared between families is defined once', () => {
    it('gpt planning is the shared situations plus its own rules, and the default is the situations alone', () => {
      expect(DEFAULT_PLANNING.startsWith(PLANNING_SITUATIONS)).toBe(true);
      expect(gptVariant.planning?.startsWith(PLANNING_SITUATIONS)).toBe(true);
      expect(gptVariant.planning?.match(/### Situation A/g)).toHaveLength(1);
    });

    it('the parallel-call line reaches every family that carries it, from one definition', () => {
      for (const variant of [gptVariant, deepseekVariant, kimiVariant, claudeVariant]) {
        expect(variant.familyNotes).toContain(PARALLEL_TOOL_CALLS_LINE);
      }
      const dir = path.dirname(new URL(import.meta.url).pathname);
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'default.ts')) {
        expect(readFileSync(path.join(dir, file), 'utf8'), file).not.toContain('Independent tool calls go out together');
      }
    });

    it('no family restates the reply language or leading with the result: the always-on sections say it', () => {
      for (const variant of [gptVariant, deepseekVariant, kimiVariant, claudeVariant]) {
        expect(variant.familyNotes).not.toMatch(/user's language|Lead with the (outcome|result)/);
      }
    });
  });
});
