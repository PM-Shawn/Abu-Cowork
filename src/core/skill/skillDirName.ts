/**
 * The one rule every skill installer applies to the name it read out of a
 * SKILL.md before turning that name into a directory.
 *
 * Shared by `installer.ts` (local folder), `npmInstaller.ts` (registry),
 * `urlInstaller.ts` (URL / GitHub archive) and, since they turn a stranger's
 * frontmatter into a directory under `~/.abu/` too, the `.askill` unpacker and
 * the agent installer — so the routes cannot drift.
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
 *   - the npm and URL installers stage the package and then rename the staging
 *     directory onto that path, replacing it wholesale.
 *
 * The name is also what the enterprise policy matcher is handed, so a spelling
 * that resolves somewhere else is a denylist bypass on top.
 *
 * One path segment, therefore, and nothing that can address a parent. The
 * archive routes already refuse `..` inside an entry PATH; this is the same
 * rule for the segment those paths are written under.
 *
 * ## Why these rules and not others
 *
 * They are `assertSafeSegment`'s (`src/core/plugin/paths.ts`), which guards the
 * same kind of string — a stranger's name turned into a path segment under
 * $HOME — against the same host weakness. That function is not imported here
 * because it throws a `PluginPathError` naming a plugin field while an
 * installer needs a boolean; but a plugin name and a skill name must not get
 * different answers, so the rules are deliberately identical, plus the display
 * rule below. Both are denylists rather than a charset allowlist: names
 * legitimately carry `@`, `.`, spaces and unicode (`中文技能`), and an
 * allowlist narrow enough to be safe would refuse real packages.
 *
 *   - **separators and NUL** — the escape itself, plus the byte that truncates
 *     a path at the OS boundary. Backslash counts on every platform: on Windows
 *     `assertAllowed` returns before any scope check at all.
 *   - **control characters** — never part of a real name, and one embedded in a
 *     name hides what the path is from whoever reads the install toast, the
 *     confirm dialog or the tool result.
 *   - **only dots** — `.`, `..` and `...` are directory references, not names.
 *   - **leading or trailing whitespace** — `" "` alone is a directory nobody can
 *     type, name in the UI, or pass back to `skill_manage` (whose NAME_REGEX
 *     rejects it), and `" evil "` displays as an existing skill's name.
 *   - **bidi and zero-width characters** — the raw name is printed by the
 *     install toast, the ConfirmDialog, the toolbox list and the `skill_manage`
 *     result, so `pd<ZWSP>f` is a second skill wearing `pdf`'s face and
 *     `safe<RLO>gnp.md` displays as something it is not. ZWNJ (U+200C) and ZWJ
 *     (U+200D) are deliberately NOT in the set: they are ordinary characters in
 *     Persian, Arabic and Indic orthographies and inside emoji sequences.
 *
 * Deliberately NOT encoded: Windows filename legality (`CON`, `NUL`, `COM1`,
 * `C:foo`, a trailing dot). Win32 normalization is documented to trim trailing
 * dots and spaces from the final component and to refuse the reserved device
 * names, which would make `foo.` alias onto `foo` and `NUL` fail the mkdir —
 * but that is a prediction, not a measurement: this was written and tested on
 * macOS, and `path.win32.resolve` does not model the trim, so it cannot settle
 * it either. The trailing-space half is closed anyway by the whitespace rule.
 * Encoding an unverified rule would refuse real names on a platform nobody
 * checked, so it stays a hypothesis for whoever has Windows in front of them.
 */
export function isSafeSkillDirName(name: string): boolean {
  return (
    name.length > 0 &&
    // Rejects a whitespace-only name too: `' '.trim()` is `''`.
    name.trim() === name &&
    !/[/\\]/.test(name) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(name) &&
    !/^\.+$/.test(name) &&
    // ZWSP, LRM/RLM, the bidi embeddings and overrides, the isolates, and BOM.
    !/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(name)
  );
}
