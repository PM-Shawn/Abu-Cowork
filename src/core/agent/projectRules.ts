/**
 * Project Rules — user-maintained project rules (ABU.md)
 *
 * Rules are manually maintained by users (committed to git, high priority).
 * This is separate from AI-written memories (.abu/MEMORY.md).
 *
 * File structure:
 *   ~/.abu/ABU.md                    — User-level rules (cross-project)
 *   {workspace}/.abu/ABU.md          — Project main rules
 *   {workspace}/.abu/rules/*.md      — Modular rules (alphabetical)
 */

import { readTextFile, readDir, exists, lstat, mkdir } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath } from '../../utils/pathUtils';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { getI18n, format } from '../../i18n';

const MAX_USER_RULES_CHARS = 4000;
const MAX_PROJECT_RULES_CHARS = 8000;
const MAX_RULE_FILES = 20;

/**
 * Truncate content at a paragraph boundary to avoid breaking markdown structure.
 */
function truncateAtParagraph(content: string, maxChars: number, suffix: string): string {
  if (content.length <= maxChars) return content;
  const cutPoint = content.lastIndexOf('\n\n', maxChars);
  const effectiveCut = cutPoint > maxChars * 0.5 ? cutPoint : maxChars;
  return content.slice(0, effectiveCut) + '\n' + suffix;
}

// Cache homeDir to avoid repeated IPC calls
let cachedHomeDir: string | null = null;

async function getCachedHomeDir(): Promise<string> {
  if (!cachedHomeDir) {
    cachedHomeDir = await homeDir();
  }
  return cachedHomeDir;
}

/**
 * Read a text file safely, returning empty string on error.
 */
async function safeReadTextFile(path: string): Promise<string> {
  try {
    return await readTextFile(path);
  } catch {
    return '';
  }
}

/**
 * Is `p` itself a symlink?
 *
 * `lstat` is the one fs call routed with `followFinalSymlink: false`
 * (`electron/fsHost.cjs`, `plugin:fs|lstat`); `exists`, `readDir` and
 * `readTextFile` all resolve the final component, so none of them can answer
 * this about the thing they are being pointed at.
 *
 * A path that cannot be lstat'd is not a link we can prove, and answering
 * `false` is safe: the read that follows either succeeds on a real file or
 * fails into `safeReadTextFile`'s empty string.
 */
async function isSymlinkPath(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymlink;
  } catch {
    return false;
  }
}

/**
 * Why anything under `{workspace}/` gets a link gate before it is read.
 *
 * These bytes do not go on screen; `loadAllRules` splices them into the SYSTEM
 * PROMPT, which is sent to the model provider. The workspace is whatever
 * repository the user opened, and git stores a symlink as a mode-120000 entry
 * that `git clone` materialises verbatim — so `.abu/rules/notes.md ->
 * ~/.ssh/id_rsa` in a cloned repo turns a repo-content channel into an
 * arbitrary local-file read that leaves the machine. Rule TEXT from a repo is
 * trusted by design; a repo naming a file OUTSIDE itself is not the same
 * thing, and the product already refuses exactly this target on the tool path
 * (`pathSafety.checkReadPath` runs its blocked-path test a second time on the
 * canonicalized path precisely so a link inside an authorized workspace cannot
 * reach `.ssh`).
 *
 * A link is therefore ABSENT here — the same answer `installSkillFromFolder`
 * gives a linked SKILL.md and `scanPluginPackage` a linked `plugin.json`.
 *
 * `~/.abu/ABU.md` deliberately gets NO such gate: $HOME is the user's own
 * configuration, `~/.abu/ABU.md -> ~/dotfiles/abu.md` is an ordinary
 * dotfile-farm arrangement, and no repository can plant it. The line is "what
 * the opened workspace controls", not "links are bad".
 *
 * The refusal is announced on the console rather than in the returned string:
 * there is no user-facing surface on this path at all (the caller's only
 * output is prompt text), and writing the note into the prompt would put an
 * attacker-chosen filename in front of the model while spending the rules
 * budget. `console.warn` is where this module already reports a rules file it
 * could not load, and it is what a diagnostic bundle carries.
 */
function warnRefusedLink(what: string, names: string[]): void {
  console.warn(
    `Ignoring ${what} that is a symlink, not a file the workspace owns ` +
      `(it would be read through and its target spliced into the system prompt): ${names.join(', ')}`,
  );
}

/**
 * Load user-level rules from ~/.abu/ABU.md
 */
export async function loadUserRules(): Promise<string> {
  const home = await getCachedHomeDir();
  const rulesPath = joinPath(home, '.abu', 'ABU.md');
  const content = await safeReadTextFile(rulesPath);
  if (!content) return '';
  return truncateAtParagraph(content, MAX_USER_RULES_CHARS, getI18n().toolResult.projectRules.userRulesTruncated);
}

/**
 * Load project main rules from {workspace}/.abu/ABU.md
 */
export async function loadProjectRules(workspacePath: string): Promise<string> {
  const rulesPath = joinPath(workspacePath, '.abu', 'ABU.md');
  // See warnRefusedLink: workspace-controlled, and read straight through.
  if (await isSymlinkPath(rulesPath)) {
    warnRefusedLink('{workspace}/.abu/ABU.md', [rulesPath]);
    return '';
  }
  return await safeReadTextFile(rulesPath);
}

/**
 * Load modular rules from {workspace}/.abu/rules/*.md
 * Files are sorted alphabetically, max MAX_RULE_FILES files.
 * Each file is prefixed with "### {filename}" header.
 */
export async function loadModularRules(workspacePath: string): Promise<string> {
  const rulesDir = joinPath(workspacePath, '.abu', 'rules');
  try {
    if (!(await exists(rulesDir))) return '';
    // The directory itself, before its entries: a per-entry check is defeated
    // by one extra indirection, because everything inside a linked directory is
    // a real file and nothing below it looks like a link at all.
    if (await isSymlinkPath(rulesDir)) {
      warnRefusedLink('{workspace}/.abu/rules', [rulesDir]);
      return '';
    }
    const entries = await readDir(rulesDir);
    const named = entries.filter(e => e.name.endsWith('.md'));

    // `isFile`, not `!isDirectory`. A dirent for a symlink reports
    // `isDirectory: false` whichever kind of thing it points at, so the old
    // predicate admitted every link — and `readTextFile` then followed it. A
    // FIFO reports `isDirectory:false / isFile:false / isSymlink:false`, the
    // one shape an isSymlink test would still miss, and reading a writer-less
    // pipe blocks the privileged host's `readFileSync` on the MAIN process
    // event loop. One predicate covers all three.
    const mdFiles = named
      .filter(e => e.isFile)
      .map(e => e.name)
      .sort()
      .slice(0, MAX_RULE_FILES);

    const refusedLinks = named.filter(e => e.isSymlink).map(e => e.name).sort();
    if (refusedLinks.length > 0) warnRefusedLink('rule file(s) in {workspace}/.abu/rules', refusedLinks);

    if (mdFiles.length === 0) return '';

    const parts: string[] = [];
    for (const fileName of mdFiles) {
      const filePath = joinPath(rulesDir, fileName);
      const content = await safeReadTextFile(filePath);
      if (content.trim()) {
        parts.push(`### ${fileName}\n${content.trim()}`);
      }
    }
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

/**
 * Load all rules by priority (low → high):
 * 1. User-level rules (~/.abu/ABU.md)
 * 2. Project main rules ({workspace}/.abu/ABU.md)
 * 3. Modular rules ({workspace}/.abu/rules/*.md)
 *
 * Total budget: MAX_USER_RULES_CHARS + MAX_PROJECT_RULES_CHARS
 */
export async function loadAllRules(workspacePath: string | null): Promise<string> {
  const t = getI18n().toolResult.projectRules;
  const parts: string[] = [];

  // 1. User-level rules
  try {
    const userRules = await loadUserRules();
    if (userRules.trim()) {
      parts.push(`${t.userRulesHeader}\n${userRules.trim()}`);
    }
  } catch (err) {
    console.warn('Failed to load user rules:', err);
  }

  // 2 & 3. Project rules (main + modular)
  if (workspacePath) {
    try {
      const projectRules = await loadProjectRules(workspacePath);
      if (projectRules.trim()) {
        parts.push(`${t.projectRulesHeader}\n${projectRules.trim()}`);
      }
    } catch (err) {
      console.warn('Failed to load project rules:', err);
    }

    try {
      const modularRules = await loadModularRules(workspacePath);
      if (modularRules.trim()) {
        parts.push(`${t.modularRulesHeader}\n${modularRules.trim()}`);
      }
    } catch (err) {
      console.warn('Failed to load modular rules:', err);
    }
  }

  if (parts.length === 0) return '';

  let result = parts.join('\n\n');

  // Enforce total budget
  const totalBudget = MAX_USER_RULES_CHARS + MAX_PROJECT_RULES_CHARS;
  result = truncateAtParagraph(result, totalBudget, t.rulesTruncated);

  return result;
}

/**
 * Initialize workspace rules: create template .abu/ABU.md and .abu/rules/ directory.
 * Returns a description of what was created.
 */
export async function initWorkspaceRules(workspacePath: string): Promise<string> {
  const t = getI18n().toolResult.projectRules;
  const abuDir = joinPath(workspacePath, '.abu');
  const rulesFile = joinPath(abuDir, 'ABU.md');
  const rulesDir = joinPath(abuDir, 'rules');
  const results: string[] = [];

  // Check if ABU.md already exists
  if (await exists(rulesFile)) {
    return t.abuAlreadyExists;
  }

  // Ensure .abu directory exists
  try {
    if (!(await exists(abuDir))) {
      await mkdir(abuDir, { recursive: true });
    }
  } catch (err) {
    console.warn('Failed to create .abu directory:', err);
  }

  // Create template ABU.md (localized starter file the user then edits by hand)
  try {
    await writeTextFile(rulesFile, t.abuTemplate);
    results.push(t.abuTemplateCreated);
  } catch (err) {
    results.push(format(t.abuCreateFailed, { error: String(err) }));
  }

  // Create rules directory
  try {
    if (!(await exists(rulesDir))) {
      await mkdir(rulesDir, { recursive: true });
      results.push(t.rulesDirCreated);
    }
  } catch (err) {
    results.push(format(t.rulesDirCreateFailed, { error: String(err) }));
  }

  return results.join('\n');
}
