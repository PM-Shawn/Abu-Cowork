import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTextFile, readDir, exists, lstat } from '@tauri-apps/plugin-fs';
import { homeDir, resolve, resolveResource } from '@tauri-apps/api/path';
import { SkillLoader, parseSkillFile } from './loader';
import { substituteVariables } from './preprocessor';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BUILTIN = join(REPO, 'builtin-skills');
const SKILL_DIR = join(BUILTIN, 'image-gen');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');

describe('builtin image-gen skill files', () => {
  const skill = parseSkillFile(readFileSync(SKILL_MD, 'utf8'), SKILL_MD);

  it('has valid frontmatter that matches its folder', () => {
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('image-gen');
    expect(skill!.displayDescription?.['zh-CN']).toBeTruthy();
    expect(skill!.displayDescription?.['en-US']).toBeTruthy();
    expect(skill!.description.length).toBeGreaterThan(40);
    expect(skill!.trigger).toBeTruthy();
    expect(skill!.userInvocable).toBe(true);
    expect(skill!.disableAutoInvoke).toBe(false);
    expect(skill!.skillDir.replace(/\\/g, '/').endsWith('builtin-skills/image-gen')).toBe(true);
  });

  it('blocks no tools: it has to call generate_image, process_image and run the script', () => {
    expect(skill!.blockedTools ?? []).toEqual([]);
    expect(skill!.allowedTools ?? []).toEqual([]);
  });

  it('keeps its neighbours out by name, and those neighbours exist and are on by default', () => {
    expect(existsSync(join(BUILTIN, 'svg-diagram', 'SKILL.md'))).toBe(true);
    expect(skill!.doNotTrigger).toContain('svg-diagram');
    expect(skill!.doNotTrigger).toContain('show_widget');
    expect(skill!.doNotTrigger).toContain('process_image');
    expect(skill!.doNotTrigger).not.toContain('infographic'); // off by default, would point at nothing
  });

  it('fits the skill list: the DO NOT TRIGGER field is not cut, and its first clause is the Word/PPT/PDF one', () => {
    // orchestrator.ts lists DO NOT TRIGGER cut at 120 characters and TRIGGER at 150.
    expect(skill!.doNotTrigger!.length).toBeLessThanOrEqual(120);
    expect(skill!.trigger!.length).toBeLessThanOrEqual(150);
    expect(skill!.doNotTrigger!.startsWith('用户只要 Word/PPT/PDF 文件')).toBe(true);
  });

  it('does not take over changing the background of the user\'s own photo', () => {
    expect(skill!.trigger).not.toContain('抠图');
    expect(skill!.doNotTrigger).toMatch(/换自己照片的底色或抠图/);
    expect(skill!.content).toMatch(/Do not redraw a user's own photo onto green/);
  });

  // Fixed (found by re-tester): SKILL.md used to say "Add `--key-color magenta` for a magenta screen". Auto mode
  // already finds a magenta screen, and the named key pins the key to pure #FF00FF, so a slightly off screen such as
  // (225,35,210) exits 3 ("no pixel matched") where auto succeeds, and the skill then has the model pay for a new
  // picture. See test_auto_handles_an_off_key_magenta_screen_that_an_explicit_pure_key_misses in tests/imagegen.
  it('does not tell the model to pin the key color for a magenta screen (auto finds it), nor to use --border-only, and asks for a longer command timeout', () => {
    expect(skill!.content).not.toMatch(/Add `--key-color magenta`/);
    expect(skill!.content).not.toContain('--border-only');
    expect(skill!.content).toMatch(/longer `timeout` \(180\)/);
  });

  it('is short enough to read in one go', () => {
    expect(skill!.content.split('\n').length).toBeLessThan(110);
  });

  it('points at a script that exists and passes it through the skill-dir variable', () => {
    const match = /python "\$\{ABU_SKILL_DIR\}\/(scripts\/[\w.]+)"/.exec(skill!.content);
    expect(match).not.toBeNull();
    expect(existsSync(join(SKILL_DIR, match![1]!))).toBe(true);
  });

  it('ships the Apache-2.0 text and the attribution for the adapted script', () => {
    expect(readFileSync(join(SKILL_DIR, 'LICENSE.txt'), 'utf8')).toContain('Apache License');
    const notice = readFileSync(join(SKILL_DIR, 'NOTICE.md'), 'utf8');
    expect(notice).toContain('Apache License');
    expect(notice).toMatch(/Codex/);
    expect(readFileSync(join(SKILL_DIR, 'scripts', 'remove_chroma_key.py'), 'utf8')).toMatch(/Apache License 2\.0/);
  });

  it('documents every size it recommends within the Seedream 5.0 pixel range and 8px grid', () => {
    const sizes = [...skill!.content.matchAll(/\b(\d{3,4})x(\d{3,4})\b/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    expect(sizes.length).toBeGreaterThanOrEqual(6);
    for (const [w, h] of sizes) {
      expect(w % 8).toBe(0);
      expect(h % 8).toBe(0);
      expect(w * h).toBeGreaterThanOrEqual(3_686_400); // also legal for older Seedream models
      expect(w * h).toBeLessThanOrEqual(4_624_220);
    }
  });

  it('does not touch the watermark behaviour or promise native transparency', () => {
    expect(skill!.content).not.toMatch(/watermark/i);
    expect(skill!.content).toMatch(/Do not promise that the model draws transparency/);
  });
});

describe('SkillLoader discovers the bundled image-gen skill', () => {
  beforeEach(() => {
    vi.mocked(homeDir).mockResolvedValue('/nonexistent-home-for-image-gen-test');
    vi.mocked(resolveResource).mockResolvedValue(BUILTIN);
    vi.mocked(resolve).mockRejectedValue(new Error('unused'));
    vi.mocked(readDir).mockImplementation(async (p: string | URL) => {
      if (!existsSync(String(p))) throw new Error('ENOENT');
      return readdirSync(String(p), { withFileTypes: true }).map((d) => ({
        name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile(), isSymlink: d.isSymbolicLink(),
      })) as never;
    });
    vi.mocked(readTextFile).mockImplementation(async (p: string | URL) => readFileSync(String(p), 'utf8'));
    vi.mocked(exists).mockImplementation(async (p: string | URL) => existsSync(String(p)));
    vi.mocked(lstat).mockImplementation(async (p: string | URL) => {
      const info = lstatSync(String(p));
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), isSymlink: info.isSymbolicLink() } as never;
    });
  });

  it('lists it as a builtin skill and loads its body, and the skill-dir variable becomes the real script path', async () => {
    const loader = new SkillLoader();
    const skills = await loader.discoverSkills();
    const found = skills.find((s) => s.name === 'image-gen');
    expect(found).toBeDefined();
    expect(found!.source).toBe('builtin');
    const loaded = await loader.loadSkill('image-gen');
    expect(loaded?.content).toContain('remove_chroma_key.py');
    const dir = loaded!.skillDir;
    const filled = substituteVariables(loaded!.content, '', dir, 'sess');
    expect(filled).not.toContain('${ABU_SKILL_DIR}');
    expect(filled).toContain(`python "${dir}/scripts/remove_chroma_key.py"`);
    expect(existsSync(join(dir, 'scripts', 'remove_chroma_key.py'))).toBe(true);
  });

  it('does not shadow or get shadowed by another skill', async () => {
    const loader = new SkillLoader();
    await loader.discoverSkills();
    expect(loader.getNameClaims().filter((c) => c.name === 'image-gen')).toHaveLength(1);
  });
});
