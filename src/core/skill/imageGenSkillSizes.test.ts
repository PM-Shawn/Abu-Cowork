import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFile } from './loader';
import { substituteVariables } from './preprocessor';
import { normalizeSeedreamSize } from '@/core/llm/imageGen';
import { buildVolcengineRequest } from '@/core/llm/imageGen/vendors/volcengine';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SKILL_DIR = join(REPO, 'builtin-skills', 'image-gen');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const raw = readFileSync(SKILL_MD, 'utf8');
const skill = parseSkillFile(raw, SKILL_MD)!;

// The generate_image tool's own size handling lives in imageGen/sizePolicy.ts (called by the Volcengine
// request builder). Models: the two 5.0 ids with the tier contract, and the older ones with the pixel floor.
const FIVE = ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260628'];
const OLDER = ['doubao-seedream-5-0-lite-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'];

/** Rows of the "Sizes" table: [use, ratio, size]. */
function sizeRows(): Array<{ use: string; ratio: string; size: string }> {
  const section = raw.split('## Sizes')[1]!.split('\n## ')[0]!;
  return section
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l) && !/^\|\s*Use\s*\|/.test(l))
    .map((l) => l.split('|').map((c) => c.trim()))
    .map((c) => ({ use: c[1]!, ratio: c[2]!, size: c[3]! }));
}

describe('image-gen SKILL.md size table against the image tool', () => {
  const rows = sizeRows();

  it('parses the table (seven documented uses)', () => {
    expect(rows).toHaveLength(7);
    for (const r of rows) expect(r.size).toMatch(/^\d{3,4}x\d{3,4}$/);
  });

  it.each(rows.map((r) => [r.use, r.size] as const))('%s (%s) is sent to Seedream 5.0 pro/flash unchanged', (_use, size) => {
    for (const model of FIVE) {
      expect(normalizeSeedreamSize(size, model)).toBe(size);
      expect(buildVolcengineRequest({ model, prompt: 'x', size }).size).toBe(size);
    }
  });

  it.each(rows.map((r) => [r.use, r.size] as const))('%s (%s) is also legal for older Seedream models (>= 3,686,400 px)', (_use, size) => {
    for (const model of OLDER) {
      expect(normalizeSeedreamSize(size, model)).toBe(size);
    }
  });

  it('keeps the ratio it advertises, within 1 percent', () => {
    for (const r of rows) {
      const [w, h] = r.size.split('x').map(Number) as [number, number];
      const m = /^([\d.]+):([\d.]+)$/.exec(r.ratio)!;
      const want = Number(m[1]) / Number(m[2]);
      const got = w / h;
      expect(Math.abs(got - want) / want, `${r.use}: ${r.ratio} vs ${r.size}`).toBeLessThan(0.01);
    }
  });

  it.each(['1K', '1.5K', '2K'])('tier %s passes through the 5.0 normalizer untouched', (tier) => {
    for (const model of FIVE) expect(normalizeSeedreamSize(tier, model)).toBe(tier);
  });

  it('leads with WxH, offers only 2K as the tier, and does not claim the tool snaps sizes', () => {
    const body = skill.content;
    const sizes = body.split('## Sizes')[1]!.split('\n## ')[0]!;
    expect(sizes.indexOf('`WxH`')).toBeGreaterThanOrEqual(0);
    expect(sizes).toMatch(/`2K`/);
    expect(sizes).toMatch(/Do not pass `1K` or `1\.5K`/);
    expect(body).not.toMatch(/`1K`, `1\.5K` or `2K`/);
    expect(body).not.toMatch(/snaps/);
    expect(sizes).toMatch(/retry once without `size`/);
    expect(body).toMatch(/reference images are not supported/);
    expect(body).not.toMatch(/2\.35/);
    const named = [...body.matchAll(/\b(\d{3,4})x(\d{3,4})\b/g)].map((m) => m[0]);
    for (const s2 of named) expect(normalizeSeedreamSize(s2, FIVE[0]!)).toBe(s2);
  });

  it('never advises a small size that the tool would silently scale up', () => {
    expect(normalizeSeedreamSize('1024x1024', OLDER[1]!)).not.toBe('1024x1024'); // the trap the skill must avoid
    for (const r of rows) {
      const [w, h] = r.size.split('x').map(Number) as [number, number];
      expect(w * h).toBeGreaterThanOrEqual(3_686_400);
    }
  });

  it('leaves the watermark as the setting gives it: on by default, off when the setting says so', () => {
    const req = { model: FIVE[0]!, prompt: 'x', size: rows[0]!.size };
    expect(buildVolcengineRequest(req).watermark).toBe(true);
    expect(buildVolcengineRequest({ ...req, watermark: false }).watermark).toBe(false);
  });
});

describe('image-gen SKILL.md command line', () => {
  const cmd = /^python "\$\{ABU_SKILL_DIR\}\/(scripts\/[\w.]+)" (.*)$/m.exec(skill.content);

  it('uses the documented skill-dir variable', () => {
    expect(cmd).not.toBeNull();
    expect(existsSync(join(SKILL_DIR, cmd![1]!))).toBe(true);
  });

  it('is substituted into an absolute, quoted path (macOS, spaces, Windows, Chinese user names)', () => {
    for (const dir of [
      '/Applications/阿布.app/Contents/Resources/builtin-skills/image-gen',
      '/Users/张 三/Library/Application Support/xs/skills/image-gen',
      'C:\\Program Files\\阿布\\resources\\builtin-skills\\image-gen',
    ]) {
      const out = substituteVariables(skill.content, '', dir, 'sess');
      expect(out).toContain(`python "${dir}/scripts/remove_chroma_key.py" --input`);
      expect(out).not.toContain('${ABU_SKILL_DIR}');
      expect(out).not.toMatch(/ARGUMENTS:/);
    }
  });

  it('runs its script by absolute path, like the office skills', () => {
    // The shell tool starts in the user's workspace, not the skill folder, so a relative `python scripts/...` would not find the script.
    expect(skill.content).not.toMatch(/^python scripts\//m);
    expect(skill.content).toContain('${ABU_SKILL_DIR}/scripts/');
    // The absolute form keeps working when the shell tool starts in the user's workspace instead of the skill folder.
    expect(cmd![1]).toBe('scripts/remove_chroma_key.py');
    expect(existsSync(join(SKILL_DIR, cmd![1]!))).toBe(true);
  });

  it('names exit code 3 the way the script uses it', () => {
    expect(skill.content).toMatch(/Exit code 3/);
    const script = readFileSync(join(SKILL_DIR, 'scripts', 'remove_chroma_key.py'), 'utf8');
    expect(script).toMatch(/return 3/);
  });
});
