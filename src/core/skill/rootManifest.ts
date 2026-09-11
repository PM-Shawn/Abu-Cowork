/**
 * An archive route checks the name declared by ONE entry — the SKILL.md it
 * picked — and then writes EVERY entry in archive order. When two entries land
 * on the skill's root SKILL.md, the last one written is the manifest that goes
 * live, and it can declare a name nothing checked: the organization's skill
 * blacklist, and the single-segment name rule, both asked about the other one.
 *
 * Two entries collide when a tarball repeats a path (tar allows it), or when
 * they differ only in letter case — `SKILL.md` and `skill.md` are one file on
 * the case-insensitive disks Abu ships on (APFS, NTFS). So a package whose
 * root holds more than one manifest is refused outright; on a case-sensitive
 * disk the extra `skill.md` would be dead weight anyway.
 */

/** Whether `relativePath` (relative to the skill directory) is its root SKILL.md, ignoring letter case. */
function isRootManifest(relativePath: string): boolean {
  // Upper-then-lower folds the letters `toLowerCase` alone misses (`ſ` → `s`)
  // as well as the ones `toUpperCase` alone misses (the Kelvin sign → `k`).
  return relativePath.normalize('NFC').toUpperCase().toLowerCase() === 'skill.md';
}

/**
 * How many of the file paths about to be written land on the skill's root
 * SKILL.md. The manifest the name was read from is one of them, so anything
 * above 1 means a later entry would replace it.
 */
export function rootManifestCount(relativePaths: Iterable<string>): number {
  let count = 0;
  for (const p of relativePaths) {
    if (isRootManifest(p)) count++;
  }
  return count;
}
