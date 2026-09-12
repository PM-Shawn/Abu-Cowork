import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import enUS from '@/i18n/locales/en-US';
import zhCN from '@/i18n/locales/zh-CN';
import type { TranslationDict } from '@/i18n/types';
import { AVATAR_ICONS, AVATAR_TINTS } from './avatarPresets';

/**
 * `avatarPresets.ts` is the source of truth for the icon and tint keys, but
 * four places restate them: each locale's picker labels, each locale's
 * `errInvalidAvatar` (what the model is told), and the create-agent skill (what
 * the model is taught). The types say `Record<string, string>`, so adding an
 * icon compiles happily and only shows up as an `undefined · 蓝色` aria-label
 * and a stale list in the model's hands. These tests are that guarantee.
 */
const LOCALES: Array<[string, TranslationDict]> = [['zh-CN', zhCN], ['en-US', enUS]];
const SKILL_MD = readFileSync('builtin-skills/create-agent/SKILL.md', 'utf-8');

describe('avatar preset copies stay in sync with avatarPresets.ts', () => {
  it.each(LOCALES)('%s labels every icon and every tint', (_locale, dict) => {
    for (const icon of AVATAR_ICONS) {
      expect(dict.avatarPicker.icons[icon]?.trim()).toBeTruthy();
    }
    for (const tint of AVATAR_TINTS) {
      expect(dict.avatarPicker.tints[tint]?.trim()).toBeTruthy();
    }
    expect(Object.keys(dict.avatarPicker.icons).sort()).toEqual([...AVATAR_ICONS].sort());
    expect(Object.keys(dict.avatarPicker.tints).sort()).toEqual([...AVATAR_TINTS].sort());
  });

  it.each(LOCALES)('%s tells save_agent callers every icon and tint that exists', (_locale, dict) => {
    for (const key of [...AVATAR_ICONS, ...AVATAR_TINTS]) {
      expect(dict.toolResult.agent.errInvalidAvatar).toContain(key);
    }
  });

  it('the create-agent skill teaches every icon and tint', () => {
    for (const key of [...AVATAR_ICONS, ...AVATAR_TINTS]) {
      expect(SKILL_MD).toContain(`\`${key}\``);
    }
  });
});
