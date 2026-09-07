/**
 * Source Text Hygiene Guard — no raw NUL bytes in source files.
 *
 * Background: three source files carried a literal NUL byte where an
 * escape sequence was meant — `pluginGitHost.cjs`'s unsafe-URL character
 * class (written as a raw `\x00`-`\x1f`-`\x7f` triple), its test's NUL
 * fixture, and `pluginToolPolicy.ts`'s grant-key separator
 * (`${conversationId}\x00${serverName}`). JavaScript treats a raw control
 * character and its escape as the same value, so nothing misbehaved and
 * every test stayed green.
 *
 * What it cost: git decides a blob is binary by looking for a NUL near
 * the start, so all three showed up in diffs as `Bin 12614 -> 30636
 * bytes` and NOTHING ELSE. Their changes could not be read in a diff, a
 * PR, or a review — and two of them are the privileged git fetch and the
 * MCP tool-approval gate, the files that most need reading. `grep` also
 * reports "binary file matches" instead of the line.
 *
 * The separators themselves are fine (NUL cannot occur in a conversation
 * id or a server name, which is exactly why it was chosen). Only the
 * SPELLING is wrong: write `\x00`, never the byte.
 *
 * Not banned here: other control characters. `electron/catalogDb.cjs`
 * deliberately embeds STX/ETX (0x02/0x03) as snippet sentinels that must
 * match the Rust side and `renderMarkedText`, and those do not make git
 * treat the file as binary — the NUL is what does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src', 'electron', 'sidecar', 'scripts', 'tests'];
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.json']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSourceFiles(full, out);
    } else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

describe('source text hygiene', () => {
  it('no source file contains a raw NUL byte (git would call it binary and hide its diff)', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of collectSourceFiles(path.join(REPO_ROOT, dir))) {
        if (fs.readFileSync(file).includes(0)) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(offenders, 'write the escape `\\x00`, never the byte itself').toEqual([]);
  });
});
