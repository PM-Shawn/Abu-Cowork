/**
 * An archive route checks the name declared by ONE entry — the SKILL.md it
 * picked — and then writes EVERY entry in archive order. When two entries land
 * on the skill's root SKILL.md, the last one written is the manifest that goes
 * live, and it can declare a name nothing checked: the organization's skill
 * blacklist, and the single-segment name rule, both asked about the other one.
 *
 * Two entries collide whenever the disk resolves them to one file: a tarball
 * repeating a path (tar allows it); `SKILL.md` vs `skill.md` on the
 * case-insensitive disks Abu ships on (APFS, NTFS); `./SKILL.md`; and, on
 * Windows, `SKILL.md.`, `SKILL.md ` or `SKILL.md::$DATA`. A package whose root
 * holds more than one manifest is refused outright.
 *
 * This is the early, write-nothing refusal. The staged npm / URL routes also
 * re-read the manifest that actually landed before going live, which holds
 * whatever resolution rule a disk applies that this function does not model.
 */

/** Whether `relativePath` (relative to the skill directory) resolves to its root SKILL.md. */
function isRootManifest(relativePath: string): boolean {
  // Resolve the path the way the disk will: `\` separates on Windows, empty
  // and `.` segments vanish, `..` climbs.
  const segments: string[] = [];
  for (const segment of relativePath.split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  if (segments.length !== 1) return false;
  // NTFS: `name:stream` writes a stream of `name`, and trailing dots and
  // spaces are dropped from a file name.
  const name = segments[0].replace(/:.*$/, '').replace(/[. ]+$/, '');
  // Upper-then-lower folds the letters `toLowerCase` alone misses (`ſ` → `s`)
  // as well as the ones `toUpperCase` alone misses (the Kelvin sign → `k`).
  return name.normalize('NFC').toUpperCase().toLowerCase() === 'skill.md';
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
