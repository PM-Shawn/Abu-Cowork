import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFile } from '../src/core/skill/loader';
import { parseAppFile } from '../electron/shared/appSpec.mjs';
import { resolveLocalizedText } from '../electron/shared/specFields.mjs';
import type { LocalizedText } from '../src/types/app';

/**
 * What ships with Abu reads in both interface languages: every built-in
 * skill carries a short display description per locale, and every app of the
 * official market names and describes itself per locale.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CJK = /[㐀-鿿]/;
const ZH_MAX_CHARS = 40;
const EN_MAX_CHARS = 100;

const skillsDir = path.join(repoRoot, 'builtin-skills');
const skillNames = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

describe('built-in skills', () => {
  it('ship 32 skills', () => {
    expect(skillNames).toHaveLength(32);
  });

  it.each(skillNames)('%s has a one-line display description in zh-CN and en-US', (name) => {
    const file = path.join(skillsDir, name, 'SKILL.md');
    const skill = parseSkillFile(readFileSync(file, 'utf8'), file.replace(/\\/g, '/'));
    expect(skill?.name).toBe(name);
    expect(skill?.description).toBeTruthy();
    const chinese = skill?.displayDescription?.['zh-CN'] ?? '';
    const english = skill?.displayDescription?.['en-US'] ?? '';
    expect(chinese).toMatch(CJK);
    expect(chinese.length).toBeLessThanOrEqual(ZH_MAX_CHARS);
    expect(english).not.toBe('');
    expect(english).not.toMatch(CJK);
    expect(english.length).toBeLessThanOrEqual(EN_MAX_CHARS);
    for (const text of [chinese, english]) expect(text).not.toContain('\n');
  });

  // A Windows checkout hands these files over with CRLF line endings.
  it.each(skillNames)('%s reads the same with CRLF line endings', (name) => {
    const file = path.join(skillsDir, name, 'SKILL.md');
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const where = file.replace(/\\/g, '/');
    const fromLf = parseSkillFile(text, where);
    expect(fromLf?.name).toBe(name);
    expect(parseSkillFile(text.replace(/\n/g, '\r\n'), where)).toEqual(fromLf);
  });
});

const marketApps = ['ecommerce'];

describe('apps of the official market', () => {
  it.each(marketApps)('%s names and describes itself in zh-CN and en-US', (name) => {
    const file = parseAppFile(JSON.parse(readFileSync(path.join(repoRoot, 'builtin-plugin-market', 'apps', name, '.abu-app', 'app.json'), 'utf8')));
    const texts: Array<LocalizedText | undefined> = [file.interface.displayName, file.interface.shortDescription, file.interface.longDescription];
    for (const text of texts) {
      expect(Object.keys(text as object).sort()).toEqual(['en-US', 'zh-CN']);
      expect(resolveLocalizedText(text, 'zh-CN')).toMatch(CJK);
      expect(resolveLocalizedText(text, 'en-US')).not.toMatch(CJK);
    }
  });
});
