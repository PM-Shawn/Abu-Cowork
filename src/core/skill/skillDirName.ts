/**
 * The one rule every skill installer applies to the name it read out of a
 * SKILL.md before turning that name into a directory.
 *
 * Shared by `installer.ts` (local folder), `npmInstaller.ts` (registry) and
 * `urlInstaller.ts` (URL / GitHub archive) so the three routes cannot drift:
 * all three concatenate the name straight onto `~/.abu/skills/`.
 */

/**
 * Is `name` usable as the single directory name a skill installs into?
 *
 * The name comes out of frontmatter in a package somebody else wrote — on the
 * `skill_manage` route the model even picks the source — and `joinPath` does
 * not collapse `..`. The privileged host's guard only asks whether the
 * RESOLVED path lands under an allowed root (`assertAllowed`,
 * electron/fsHost.cjs), and `$HOME` is one, so `name: ../../.ssh` resolves to
 * `~/.ssh` and passes every check the fs surface has.
 *
 * What that buys an attacker differs by route but is never nothing:
 *   - the folder installer hands the escaped path to `atomicInstallDir`, which
 *     on `overwrite` renames the directory aside, swaps the staged content in
 *     and drops the backup — the directory is destroyed and replaced;
 *   - the npm and URL installers `mkdir` it and write the package's files into
 *     it, so an arbitrary directory under $HOME gains attacker-chosen files.
 *
 * The name is also what the enterprise policy matcher is handed, so a spelling
 * that resolves somewhere else is a denylist bypass on top.
 *
 * One path segment, therefore, and nothing that can address a parent. The
 * archive routes already refuse `..` inside an entry PATH; this is the same
 * rule for the segment those paths are written under.
 */
export function isSafeSkillDirName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    name !== '.' &&
    name !== '..'
  );
}
