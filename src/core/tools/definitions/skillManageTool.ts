/**
 * skill_manage — agent-managed skill creation + patching (MVP).
 *
 * Three actions the MVP covers:
 *   - create:     propose a new skill (always lands in drafts/ for user review)
 *   - patch:      modify an existing skill in place; Copy-on-Modify when the
 *                 original lives outside agent's write scope
 *   - write_file: add or update a supporting file in a skill directory
 *                 (references/ | templates/ | scripts/ | assets/)
 *
 * v2+ (tracked as Task #17): edit (full-file rewrite), delete, remove_file.
 * These involve destructive or structurally broad changes and benefit from
 * the confirmation UX in Module I, which isn't landed yet.
 *
 * ## Scope rules
 *
 *   writable:  workspace-auto  (~/.abu/projects/<key>/skills/)
 *   writable:  draft           (~/.abu/projects/<key>/skills/drafts/) — via create
 *   read-only: user, project, project-standard, standard, builtin
 *
 * Agent attempts to patch a read-only source transparently Copy-on-Modify
 * into workspace-auto: the original is preserved, a copy lives under
 * workspace-auto, and loader's first-win resolution makes the copy win on
 * the next scan. See PRD 2.4.
 *
 * MVP rejects explicit scope='user' writes — that path requires the
 * confirmation UX from Module I, and issuing unauthorized global writes
 * before that UX exists would be a silent surprise.
 *
 * ## Write flow (shared by all actions)
 *
 *   1. Validate name / frontmatter / size
 *   2. Resolve target path (apply scope + CoM rules)
 *   3. atomicWriteWithBackup → capture backupPath for rollback
 *   4. scanContent against written content + evaluate against scope
 *   5. On block → restoreFromBackup + structured error (pattern_id, line, excerpt)
 *   6. On pass → skillLoader.refresh + success payload
 *
 * Patch failures come back with a rich diagnostic so the agent can
 * self-correct: {closest_match, file_structure} instead of a blind
 * 500-char preview (Hermes's approach).
 */

import { readTextFile, exists, mkdir, readDir } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';

import type { ToolDefinition, SkillMetadata, Skill, ToolExecutionContext, InteractiveNoticeCard } from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import {
  atomicWrite,
  atomicWriteWithBackup,
  restoreFromBackup,
} from '../../../utils/atomicFs';
import {
  scanContent,
  evaluate,
  type ScanContext,
  type Finding,
} from '../../safety/contentGuard';
import { skillLoader, serializeSkillMd } from '../../skill/loader';
import { fuzzyFindAndReplace } from '../../skill/fuzzyPatch';
import { writeDraft, writeSkillDirect, rejectDraft } from '../../skill/drafts';
import { appendHistoryEntry, writeTombstone, newTurnId } from '../../skill/history';
import { joinPath, normalizeSeparators } from '../../../utils/pathUtils';
import { sanitizePath } from '../../memdir/paths';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useSettingsStore } from '../../../stores/settingsStore';

// ── Constants ───────────────────────────────────────────────────────────

const MAX_CONTENT_CHARS = 100_000;
const MAX_DESCRIPTION_CHARS = 1024;
const NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ALLOWED_SUBDIRS: ReadonlySet<string> = new Set([
  'references',
  'templates',
  'scripts',
  'assets',
]);

type SkillAction = 'install' | 'create' | 'patch' | 'write_file' | 'edit' | 'delete' | 'remove_file';
type SkillScope = 'workspace-auto' | 'user';

// ── Path helpers ────────────────────────────────────────────────────────

async function getWorkspaceAutoSkillsDir(workspacePath: string): Promise<string> {
  const home = await homeDir();
  const key = sanitizePath(normalizeSeparators(workspacePath));
  return joinPath(home, '.abu/projects', key, 'skills');
}

/**
 * Require an active workspace for any write — no writes to global dirs without one.
 *
 * Prefers the loop-time snapshot in `context.workspacePath` (agentLoop builds
 * this once per loop from imContext or the store), falling back to the live
 * global store only when context is absent. This avoids the "workspace lost
 * mid-turn" failure where the user switches conversations or the store is
 * cleared between tool calls even though the conversation is still bound.
 */
function requireWorkspace(context?: ToolExecutionContext): string {
  const wp = context?.workspacePath ?? useWorkspaceStore.getState().currentPath;
  if (!wp) {
    throw new Error(
      'skill_manage needs an active workspace. Call `request_workspace` first ' +
        "to let the user pick a project directory (e.g. folder_hint=\"下载\" / " +
        '"桌面" if the user mentioned one), then retry this skill_manage call. ' +
        'Do NOT ask the user in plain text — the request_workspace tool shows ' +
        'a native folder picker.',
    );
  }
  return wp;
}

// ── Validation helpers ──────────────────────────────────────────────────

function validateName(name: string): string | null {
  if (!name) return 'name is required';
  if (name.length > 64) return 'name exceeds 64 characters';
  if (!NAME_REGEX.test(name)) {
    return `invalid name "${name}". Use lowercase a-z, digits, dots, hyphens, underscores. Must start with a letter or digit.`;
  }
  return null;
}

function validateFrontmatter(fm: Partial<SkillMetadata>): string | null {
  if (!fm) return 'frontmatter is required';
  if (!fm.name) return 'frontmatter.name is required';
  if (!fm.description) return 'frontmatter.description is required';
  if ((fm.description ?? '').length > MAX_DESCRIPTION_CHARS) {
    return `frontmatter.description exceeds ${MAX_DESCRIPTION_CHARS} characters`;
  }
  return null;
}

function validateFilePath(filePath: string): string | null {
  if (!filePath) return 'file_path is required';
  if (filePath.includes('..')) return 'file_path must not contain ".." (path traversal rejected)';
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length < 2) {
    return `file_path must be under a subdir (references/ | templates/ | scripts/ | assets/). Got: "${filePath}"`;
  }
  if (!ALLOWED_SUBDIRS.has(parts[0])) {
    return `file_path must be under one of: ${[...ALLOWED_SUBDIRS].join(', ')}. Got: "${parts[0]}"`;
  }
  return null;
}

// ── Copy-on-Modify: fork a read-only skill into workspace-auto ──────────

/**
 * Ensure `skillName` has a writable copy under workspace-auto. If the
 * skill is already there, returns its existing directory. Otherwise
 * copies its entire directory (SKILL.md + supporting files) into
 * workspace-auto and returns the new directory path.
 *
 * Records provenance in the copied SKILL.md frontmatter so future
 * upstream-conflict detection can tell this copy was derived from
 * which source (see PRD 2.5).
 */
async function ensureWorkspaceAutoCopy(
  existingSkill: Skill,
  workspacePath: string,
): Promise<string> {
  const wsDir = await getWorkspaceAutoSkillsDir(workspacePath);
  const targetDir = joinPath(wsDir, existingSkill.name);

  // Case 1: skill is already in workspace-auto (or we previously CoM'd it).
  if (existingSkill.skillDir === targetDir) return targetDir;
  if (await exists(targetDir)) return targetDir;

  // Case 2: fork — copy whole skill dir to workspace-auto, tagging provenance.
  await mkdir(targetDir, { recursive: true });
  await copyDirectoryContents(existingSkill.skillDir, targetDir);

  // Overwrite the SKILL.md in the copy to inject provenance metadata.
  const skillMdSrc = joinPath(existingSkill.skillDir, 'SKILL.md');
  const originalContent = await readTextFile(skillMdSrc).catch(() => '');
  if (originalContent) {
    const enriched = withProvenance(
      existingSkill,
      originalContent,
    );
    await atomicWrite(joinPath(targetDir, 'SKILL.md'), enriched);
  }

  return targetDir;
}

/**
 * Walk `src` directory and write each file to the corresponding path under
 * `dst`. Uses atomicWrite (read+rename under the hood) so every individual
 * file copy is crash-safe. Subdirs are created on demand.
 *
 * Binary files currently decoded as UTF-8; for MVP all skill assets are
 * text (.md / .txt / scripts). If a skill ever ships binaries the agent
 * won't see them via patch — reserved for v2+.
 */
async function copyDirectoryContents(src: string, dst: string): Promise<void> {
  async function walk(rel: string): Promise<void> {
    const subSrc = rel ? joinPath(src, rel) : src;
    const entries = await readDir(subSrc);
    for (const entry of entries) {
      const relPath = rel ? joinPath(rel, entry.name) : entry.name;
      if (entry.isDirectory) {
        await walk(relPath);
      } else if (entry.isFile) {
        const content = await readTextFile(joinPath(src, relPath));
        await atomicWrite(joinPath(dst, relPath), content);
      }
    }
  }
  await walk('');
}

/**
 * Inject Copy-on-Modify provenance keys into the SKILL.md frontmatter.
 * Flat keys (abu-origin-*) to stay compatible with SkillMetadata.metadata
 * being typed as Record<string, string>.
 */
function withProvenance(skill: Skill, originalContent: string): string {
  const match = originalContent.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return originalContent; // not a valid frontmatter file — skip

  const [, yamlBlock, body] = match;
  const lines = yamlBlock.split('\n');
  // Find existing `metadata:` block or append at end
  const provenance = {
    'abu-origin-source': skill.source ?? 'unknown',
    'abu-origin-name': skill.name,
    'abu-forked-at': String(Date.now()),
  };

  // Check if metadata block already exists to append beneath it.
  const metadataIdx = lines.findIndex((l) => /^metadata\s*:/.test(l));
  if (metadataIdx === -1) {
    // Append a new metadata block to the YAML.
    lines.push('metadata:');
    for (const [k, v] of Object.entries(provenance)) {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    }
  } else {
    // Insert new keys right after `metadata:` (before any existing nested keys).
    const indent = '  ';
    const inserts: string[] = [];
    for (const [k, v] of Object.entries(provenance)) {
      inserts.push(`${indent}${k}: ${JSON.stringify(v)}`);
    }
    lines.splice(metadataIdx + 1, 0, ...inserts);
  }

  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

// ── Structured result types ─────────────────────────────────────────────

interface SuccessResult {
  success: true;
  status: 'pending-user-approval' | 'applied';
  message: string;
  path?: string;
  strategy?: string; // fuzzy patch strategy used
  match_count?: number;
  /**
   * Interactive notice card attached to this result. Chat renderer parses
   * the tool's JSON output, pulls this field off, and renders a card below
   * the tool call. Currently only populated by the agent-proposed create
   * branch (Module I), but the field is generic to accept future card types.
   */
  notice_card?: InteractiveNoticeCard;
}

interface ErrorResult {
  success: false;
  error: string;
  /** Scan findings when a write was blocked by contentGuard. */
  scan?: {
    verdict: string;
    findings: Array<{
      pattern_id: string;
      severity: string;
      category: string;
      line: number;
      match: string;
      description: string;
    }>;
  };
  /** Patch diagnostics when fuzzy match failed, to help agent self-correct. */
  closest_match?: {
    line_text: string;
    line_number: number;
    surrounding_context: string;
  };
  file_structure?: {
    total_lines: number;
    headings: string[];
  };
}

type ActionResult = SuccessResult | ErrorResult;

// ── Post-write scan + rollback ──────────────────────────────────────────

/**
 * Run contentGuard on the freshly-written content. If verdict is "block",
 * roll back the write and return a structured error. Otherwise return null
 * (caller proceeds).
 *
 * Honors `settings.safety.bypass` and the kill switch. Matches memdir's
 * policy — same scanner, same bypass list.
 */
async function scanOrRollback(
  content: string,
  context: ScanContext,
  targetPath: string,
  backupPath: string | null,
): Promise<ErrorResult | null> {
  const safety = useSettingsStore.getState().safety;
  if (!safety.enableContentGuard) return null;

  const scan = scanContent(content, { bypass: new Set(safety.bypass) });
  if (evaluate(scan, context) !== 'block') return null;

  // Roll back the write. If backup existed, restore it; otherwise the write
  // was a brand-new file, so just delete the file.
  try {
    if (backupPath) {
      await restoreFromBackup(targetPath, backupPath);
    } else {
      // No prior file → remove the newly-created one.
      const { remove } = await import('@tauri-apps/plugin-fs');
      await remove(targetPath).catch(() => {
        /* best-effort */
      });
    }
  } catch (e) {
    // Even if rollback fails, we should still surface the scan block.
    console.warn('[skill_manage] rollback failed after scan block:', e);
  }

  return {
    success: false,
    error: 'Content blocked by safety scanner. Rewrite without the matched patterns and retry.',
    scan: {
      verdict: scan.verdict,
      findings: scan.findings.map((f: Finding) => ({
        pattern_id: f.patternId,
        severity: f.severity,
        category: f.category,
        line: f.line,
        match: f.match,
        description: f.description,
      })),
    },
  };
}

// ── Action: install ─────────────────────────────────────────────────────

async function installAction(input: Record<string, unknown>): Promise<ActionResult> {
  const source = (input.source as string | undefined)?.trim();
  if (!source) return { success: false, error: 'action=install 时必须提供 source 参数（npm 包名 / 本地路径 / URL / GitHub 链接）' };

  const { detectSourceType, installSkillFromUrl } = await import('@/core/skill/urlInstaller');
  const { installSkillFromFolder } = await import('@/core/skill/installer');
  const { installSkillFromNpm } = await import('@/core/skill/npmInstaller');

  // Confirm-first: never silently clobber a same-named skill the user may have
  // hand-edited. Only overwrite when the caller explicitly opts in (after asking
  // the user). On conflict we return an actionable message telling the AI to retry
  // with overwrite:true rather than deleting the existing skill.
  const overwrite = input.overwrite === true;
  const sourceType = detectSourceType(source);
  let skillName: string;
  let fileCount: number;
  let skipped: string[] = [];

  try {
    if (sourceType === 'folder') {
      const r = await installSkillFromFolder(source, { overwrite });
      if (!r.ok) {
        if (r.code === 'ALREADY_EXISTS') {
          return { success: false, error: `${r.message}。如需覆盖，请先与用户确认，再重新调用本工具并传 overwrite: true。` };
        }
        return { success: false, error: r.message };
      }
      skillName = r.name;
      fileCount = r.fileCount;
      skipped = r.skipped ?? [];
    } else if (sourceType === 'npm') {
      const r = await installSkillFromNpm(source);
      skillName = r.skillName;
      fileCount = r.files.length;
    } else {
      const r = await installSkillFromUrl(source);
      skillName = r.skillName;
      fileCount = r.files.length;
    }
  } catch (e) {
    return { success: false, error: `安装失败: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Refresh discovery so the skill appears immediately in "我的技能"
  const { useDiscoveryStore } = await import('../../../stores/discoveryStore');
  await useDiscoveryStore.getState().refresh().catch(() => { /* best-effort */ });

  const skippedNote = skipped.length > 0
    ? `（跳过 ${skipped.length} 个隐藏文件：${skipped.join('、')}，其中 .mcp.json 等可能含密钥，如技能需要请手动配置）`
    : '';

  return {
    success: true,
    status: 'applied',
    message: `技能 "${skillName}" 安装成功（${fileCount} 个文件）${skippedNote}，已出现在"我的技能"中。`,
  };
}

// ── Action: create ──────────────────────────────────────────────────────

async function createAction(input: Record<string, unknown>, context?: ToolExecutionContext): Promise<ActionResult> {
  const name = input.name as string;
  const content = input.content as string;

  // Validate
  const nameErr = validateName(name);
  if (nameErr) return { success: false, error: nameErr };

  if (!content) {
    return { success: false, error: 'create requires content (the SKILL.md body)' };
  }

  // Accept multiple input shapes seen in the wild across providers:
  //   1. strict nested object: frontmatter: { description: "..." }
  //   2. stringified JSON: frontmatter: '{"description": "..."}'
  //      (GLM-5 / some Volcengine models serialize objects as JSON strings)
  //   3. flattened top-level: description: "...", trigger: "..."
  //      (model dropped the nesting entirely)
  // Copy into a fresh object since tool input is frozen and mutation throws.
  let rawFrontmatter = input.frontmatter as Partial<SkillMetadata> | string | undefined;
  if (typeof rawFrontmatter === 'string') {
    try {
      rawFrontmatter = JSON.parse(rawFrontmatter) as Partial<SkillMetadata>;
    } catch {
      rawFrontmatter = undefined; // malformed JSON — fall back to top-level fields
    }
  }
  const frontmatter: Partial<SkillMetadata> = rawFrontmatter
    ? { ...rawFrontmatter }
    : {};
  // name must always agree with `input.name`
  frontmatter.name = name;
  // Pull top-level fallbacks if the nested form didn't supply them
  if (!frontmatter.description && typeof input.description === 'string') {
    frontmatter.description = input.description;
  }
  if (!frontmatter.trigger && typeof input.trigger === 'string') {
    frontmatter.trigger = input.trigger;
  }

  const fmErr = validateFrontmatter(frontmatter);
  if (fmErr) return { success: false, error: fmErr };
  if (content.length > MAX_CONTENT_CHARS) {
    return { success: false, error: `content exceeds ${MAX_CONTENT_CHARS} chars` };
  }

  const workspacePath = requireWorkspace(context);

  // Name collision: abort if a non-draft skill with this name already exists.
  // Drafts with the same name are allowed to be overwritten (superseded).
  const existing = skillLoader.getSkill(name);
  if (existing && existing.source !== 'draft') {
    return {
      success: false,
      error: `skill "${name}" already exists (source=${existing.source}). Use patch or edit to modify, or pick a different name.`,
    };
  }

  const serialized = serializeSkillMd(frontmatter, content);

  // Pre-write scan: for create there is no pre-existing file to roll back
  // to, so we just refuse to write if the content trips the guard. Matches
  // scanOrRollback's verdict semantics (kill switch + bypass honored).
  const safety = useSettingsStore.getState().safety;
  if (safety.enableContentGuard) {
    const scan = scanContent(serialized, { bypass: new Set(safety.bypass) });
    if (evaluate(scan, 'skill-create') === 'block') {
      return {
        success: false,
        error: 'Content blocked by safety scanner. Rewrite without the matched patterns and retry.',
        scan: {
          verdict: scan.verdict,
          findings: scan.findings.map((f: Finding) => ({
            pattern_id: f.patternId,
            severity: f.severity,
            category: f.category,
            line: f.line,
            match: f.match,
            description: f.description,
          })),
        },
      };
    }
  }

  // Split point: who asked for this skill?
  //   - agent_proposed=true  → agent自发, needs review → drafts/ path
  //   - omitted / false      → user explicitly asked    → direct workspace-auto
  //
  // Default is direct write because the common case is the user saying
  // "帮我建 X"; making them review their own explicit ask is friction.
  // Agent must actively claim `agent_proposed=true` when it's自发 — the
  // asymmetric default keeps drafts as a review queue for agent autonomy,
  // not a mandatory gate for every create.
  // Providers are inconsistent about boolean serialization — some send
  // the raw boolean, others stringify to "true" / "True", or use 1 / "1".
  // Treat anything truthy-ish as explicit opt-in; anything missing or
  // "false" / 0 falls through to the safer direct-write default.
  const agentProposed = (() => {
    const v = input.agent_proposed;
    if (v === true || v === 1) return true;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      return s === 'true' || s === '1' || s === 'yes';
    }
    return false;
  })();
  const proactivity =
    useSettingsStore.getState().soul?.proactivity ?? 'companion';

  if (agentProposed) {
    // ── Agent-proposed: write to drafts, notify per preset ──────────────
    const triggerReason =
      typeof input.trigger_reason === 'string' ? input.trigger_reason : '';
    let record: Awaited<ReturnType<typeof writeDraft>>;
    try {
      record = await writeDraft(
        name,
        serialized,
        { action: 'create', proactivity, triggerReason },
        workspacePath,
      );
    } catch (e) {
      return {
        success: false,
        error: `write failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    await skillLoader.discoverSkills(workspacePath).catch(() => {
      /* best-effort refresh */
    });

    const { useSkillDraftsStore } = await import('../../../stores/skillDraftsStore');
    await useSkillDraftsStore.getState().refresh().catch(() => {
      /* best-effort refresh */
    });

    const { notifyDraftProposal } = await import('../../../utils/notifications');
    await notifyDraftProposal(name, proactivity).catch(() => {
      /* notification is best-effort */
    });

    // Build the inline notice card so the chat renderer can surface the
    // proposal right in the conversation (Module I). Agent's full SKILL.md
    // serialized content is embedded so the expand-to-preview UI doesn't
    // need an extra disk read; the card data is self-contained.
    const noticeCard: InteractiveNoticeCard = {
      type: 'skill-proposal',
      id: name,
      skillProposal: {
        skillName: name,
        description: frontmatter.description ?? '',
        triggerReason,
        draftPath: record.skillMdPath,
        fullContent: serialized,
        workspacePath,
      },
    };

    return {
      success: true,
      status: 'pending-user-approval',
      message:
        `草稿 "${name}" 已提议。用户可在聊天里直接采纳或拒绝；也可到「工具箱 → 技能」的草稿面板处理。路径：${record.skillMdPath}。`,
      path: record.skillMdPath,
      notice_card: noticeCard,
    };
  }

  // ── Explicit (default): write directly to workspace-auto ──────────────
  //
  // Sweep any same-name draft first so the loader's first-win rule doesn't
  // leave a phantom visible in the drafts panel that can never be accepted
  // (workspace-auto already owns the name). rejectDraft moves it to trash
  // for a 7-day recovery window.
  if (existing && existing.source === 'draft') {
    await rejectDraft(name, workspacePath).catch(() => {
      /* best-effort sweep — if trash rename fails we still proceed with direct write */
    });
  }

  let directResult: Awaited<ReturnType<typeof writeSkillDirect>>;
  try {
    directResult = await writeSkillDirect(name, serialized, workspacePath);
  } catch (e) {
    return {
      success: false,
      error: `write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Refresh both skill discovery (for main skills list UI) and drafts
  // store (in case we swept a same-name draft above). discoveryStore's
  // refresh internally calls skillLoader.discoverSkills, so we don't
  // duplicate that call.
  const { useDiscoveryStore } = await import('../../../stores/discoveryStore');
  await useDiscoveryStore.getState().refresh().catch(() => {
    /* best-effort */
  });
  const { useSkillDraftsStore } = await import('../../../stores/skillDraftsStore');
  await useSkillDraftsStore.getState().refresh().catch(() => {
    /* best-effort */
  });

  return {
    success: true,
    status: 'applied',
    message: `技能 "${name}" 已创建，立即生效。路径：${directResult.skillMdPath}`,
    path: directResult.skillMdPath,
  };
}

// ── Action: patch ───────────────────────────────────────────────────────

async function patchAction(input: Record<string, unknown>, context?: ToolExecutionContext): Promise<ActionResult> {
  const name = input.name as string;
  const oldString = input.old_string as string;
  const newString = input.new_string as string;
  // Coerce provider quirks (string "true", 1) — same treatment as agent_proposed.
  const replaceAll = (() => {
    const v = input.replace_all;
    if (v === true || v === 1) return true;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      return s === 'true' || s === '1' || s === 'yes';
    }
    return false;
  })();
  const filePath = input.file_path as string | undefined;

  const nameErr = validateName(name);
  if (nameErr) return { success: false, error: nameErr };
  if (oldString === undefined) return { success: false, error: 'old_string is required' };
  if (newString === undefined) return { success: false, error: 'new_string is required' };

  // Require explicit scope guard on user-scope mutations.
  const requestedScope = (input.scope as SkillScope | undefined) ?? 'workspace-auto';
  if (requestedScope === 'user') {
    return {
      success: false,
      error:
        "scope='user' writes are not yet supported in this MVP — they require the user-confirmation UX (Module I). Use scope='workspace-auto' (default) so the change is local to this project.",
    };
  }

  const workspacePath = requireWorkspace(context);

  const existing = skillLoader.getSkill(name);
  if (!existing) {
    return { success: false, error: `skill "${name}" not found` };
  }

  // Determine the writable target: either the existing location (if already
  // in workspace-auto) or a Copy-on-Modify fork.
  let targetDir: string;
  if (existing.source === 'workspace-auto' || existing.source === 'draft') {
    targetDir = existing.skillDir;
  } else {
    // CoM fork from read-only source (user / project / project-standard / builtin / standard)
    targetDir = await ensureWorkspaceAutoCopy(existing, workspacePath);
  }

  // Pick the file to patch: SKILL.md by default, or a supporting file.
  let targetPath: string;
  if (filePath) {
    const err = validateFilePath(filePath);
    if (err) return { success: false, error: err };
    targetPath = joinPath(targetDir, filePath);
  } else {
    targetPath = joinPath(targetDir, 'SKILL.md');
  }

  if (!(await exists(targetPath))) {
    return {
      success: false,
      error: `target file not found: ${filePath ?? 'SKILL.md'}`,
    };
  }

  const originalContent = await readTextFile(targetPath);
  const fuzzy = fuzzyFindAndReplace(originalContent, oldString, newString, replaceAll);

  if (fuzzy.error) {
    // Patch failed — return structured diagnostic so the agent can correct.
    return {
      success: false,
      error: fuzzy.error,
      ...buildPatchDiagnostic(originalContent, oldString),
    };
  }

  // Validate post-patch: if patching SKILL.md, frontmatter must still parse.
  if (!filePath) {
    const frontmatterOk = /^---\s*\n[\s\S]*?\n---\s*\n/.test(fuzzy.newContent);
    if (!frontmatterOk) {
      return {
        success: false,
        error: 'Patch would break the SKILL.md frontmatter. Preserve the `---` delimiters and required fields.',
      };
    }
  }
  if (fuzzy.newContent.length > MAX_CONTENT_CHARS) {
    return {
      success: false,
      error: `post-patch content exceeds ${MAX_CONTENT_CHARS} chars — consider splitting into supporting files.`,
    };
  }

  // Atomic write + scan + rollback
  let backupPath: string | null;
  try {
    const result = await atomicWriteWithBackup(targetPath, fuzzy.newContent);
    backupPath = result.backupPath;
  } catch (e) {
    return { success: false, error: `write failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const blocked = await scanOrRollback(fuzzy.newContent, 'skill-patch', targetPath, backupPath);
  if (blocked) return blocked;

  await skillLoader.discoverSkills(workspacePath).catch(() => {});

  // Record history — best-effort, must not abort the successful write.
  // The backupPath on disk is what restoreFromBackup will consume
  // during a future revert.
  await appendHistoryEntry(targetDir, {
    turnId: newTurnId(),
    op: 'patch',
    files: [
      {
        relPath: filePath ?? 'SKILL.md',
        snapshotPath: backupPath,
        action: 'modified',
      },
    ],
    summary: `${fuzzy.matchCount} replacement${fuzzy.matchCount > 1 ? 's' : ''} via ${fuzzy.strategy}`,
  }).catch(() => {});

  return {
    success: true,
    status: 'applied',
    message: `Patched ${filePath ?? 'SKILL.md'} in "${name}" (${fuzzy.matchCount} replacement${fuzzy.matchCount > 1 ? 's' : ''} via ${fuzzy.strategy} strategy).`,
    path: targetPath,
    strategy: fuzzy.strategy ?? undefined,
    match_count: fuzzy.matchCount,
  };
}

function buildPatchDiagnostic(content: string, oldString: string): Partial<ErrorResult> {
  // Headings helper — extract markdown # headings (max 5) for structural hint.
  const headings = content
    .split('\n')
    .filter((l) => /^#{1,6}\s+\S/.test(l))
    .slice(0, 5);
  const totalLines = content.split('\n').length;

  // Closest-match: very simple — find the single line with most chars in
  // common with old_string's first line (cheap, no edit-distance). Good
  // enough to point the agent at the right region.
  const oldFirst = oldString.split('\n')[0].trim();
  const lines = content.split('\n');
  let bestLine = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    // overlap score — how many chars from oldFirst appear at start of l
    let score = 0;
    const limit = Math.min(l.length, oldFirst.length);
    for (let j = 0; j < limit && l[j] === oldFirst[j]; j++) score++;
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  const diagnostic: Partial<ErrorResult> = {
    file_structure: { total_lines: totalLines, headings },
  };
  if (bestLine >= 0 && bestScore >= 3 /* avoid noise */) {
    const contextStart = Math.max(0, bestLine - 2);
    const contextEnd = Math.min(lines.length, bestLine + 3);
    diagnostic.closest_match = {
      line_text: lines[bestLine],
      line_number: bestLine + 1,
      surrounding_context: lines.slice(contextStart, contextEnd).join('\n'),
    };
  }
  return diagnostic;
}

// ── Action: write_file ──────────────────────────────────────────────────

async function writeFileAction(input: Record<string, unknown>, context?: ToolExecutionContext): Promise<ActionResult> {
  const name = input.name as string;
  const filePath = input.file_path as string;
  const fileContent = input.file_content as string;
  const requestedScope = (input.scope as SkillScope | undefined) ?? 'workspace-auto';

  const nameErr = validateName(name);
  if (nameErr) return { success: false, error: nameErr };

  const pathErr = validateFilePath(filePath);
  if (pathErr) return { success: false, error: pathErr };

  if (fileContent === undefined) return { success: false, error: 'file_content is required' };
  if (fileContent.length > MAX_CONTENT_CHARS) {
    return { success: false, error: `file_content exceeds ${MAX_CONTENT_CHARS} chars` };
  }
  if (requestedScope === 'user') {
    return {
      success: false,
      error: "scope='user' writes are not yet supported in this MVP (Module I pending).",
    };
  }

  const workspacePath = requireWorkspace(context);

  const existing = skillLoader.getSkill(name);
  if (!existing) {
    return {
      success: false,
      error: `skill "${name}" not found — write_file requires the skill to exist first. Use create to start a new skill.`,
    };
  }

  const targetDir =
    existing.source === 'workspace-auto' || existing.source === 'draft'
      ? existing.skillDir
      : await ensureWorkspaceAutoCopy(existing, workspacePath);
  const targetPath = joinPath(targetDir, filePath);

  let backupPath: string | null;
  try {
    const result = await atomicWriteWithBackup(targetPath, fileContent);
    backupPath = result.backupPath;
  } catch (e) {
    return { success: false, error: `write failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const blocked = await scanOrRollback(fileContent, 'skill-patch', targetPath, backupPath);
  if (blocked) return blocked;

  await skillLoader.discoverSkills(workspacePath).catch(() => {});

  await appendHistoryEntry(targetDir, {
    turnId: newTurnId(),
    op: 'write_file',
    files: [
      {
        relPath: filePath,
        snapshotPath: backupPath,
        // backupPath is null when the file didn't exist before — so
        // the action was a creation, not a modification.
        action: backupPath ? 'modified' : 'created',
      },
    ],
  }).catch(() => {});

  return {
    success: true,
    status: 'applied',
    message: `Wrote ${filePath} to "${name}".`,
    path: targetPath,
  };
}

// ── Action: edit ─ full-file replace (Task #17 v2) ──────────────────────
//
// Contrast with patch: patch uses fuzzy find/replace, which is brittle
// for big structural edits. edit takes the entire new content, so the
// agent can rewrite a whole file in one shot. Targets SKILL.md by
// default, can target supporting files via `file_path`.
//
// Scope rules identical to patch — CoM fork if existing source isn't
// workspace-auto or draft; user scope rejected pending Module I UX.
async function editAction(input: Record<string, unknown>, context?: ToolExecutionContext): Promise<ActionResult> {
  const name = input.name as string;
  const content = input.content as string;
  const filePath = input.file_path as string | undefined;

  const nameErr = validateName(name);
  if (nameErr) return { success: false, error: nameErr };
  if (content === undefined) return { success: false, error: 'content is required' };
  if (content.length > MAX_CONTENT_CHARS) {
    return { success: false, error: `content exceeds ${MAX_CONTENT_CHARS} chars` };
  }

  const requestedScope = (input.scope as SkillScope | undefined) ?? 'workspace-auto';
  if (requestedScope === 'user') {
    return {
      success: false,
      error:
        "scope='user' writes are not yet supported in this MVP — they require the user-confirmation UX (Module I). Use scope='workspace-auto' (default).",
    };
  }

  const workspacePath = requireWorkspace(context);

  const existing = skillLoader.getSkill(name);
  if (!existing) {
    return {
      success: false,
      error: `skill "${name}" not found — edit requires the skill to exist first. Use create for a new skill.`,
    };
  }

  // Pick target directory: existing location if writable, else CoM fork.
  const targetDir =
    existing.source === 'workspace-auto' || existing.source === 'draft'
      ? existing.skillDir
      : await ensureWorkspaceAutoCopy(existing, workspacePath);

  // Pick target file: SKILL.md by default, or a supporting file.
  let targetPath: string;
  if (filePath) {
    const pathErr = validateFilePath(filePath);
    if (pathErr) return { success: false, error: pathErr };
    targetPath = joinPath(targetDir, filePath);
  } else {
    targetPath = joinPath(targetDir, 'SKILL.md');
  }

  // When editing SKILL.md, verify the new content still has parseable
  // frontmatter. Without this guard, an agent can accidentally wipe
  // the `---\n...\n---` delimiters and brick the skill until someone
  // edits the file by hand.
  if (!filePath) {
    const frontmatterOk = /^---\s*\n[\s\S]*?\n---\s*\n/.test(content);
    if (!frontmatterOk) {
      return {
        success: false,
        error: 'Edit would break SKILL.md frontmatter. Preserve the `---` delimiters and required fields (name, description).',
      };
    }
  }

  // Atomic write + scan + rollback. backupPath is null if the target
  // didn't exist yet (e.g. editing a supporting file not present in
  // the original skill) — rollback for that case just deletes the
  // newly-created file.
  let backupPath: string | null;
  try {
    const result = await atomicWriteWithBackup(targetPath, content);
    backupPath = result.backupPath;
  } catch (e) {
    return { success: false, error: `write failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const blocked = await scanOrRollback(content, 'skill-patch', targetPath, backupPath);
  if (blocked) return blocked;

  await skillLoader.discoverSkills(workspacePath).catch(() => {});

  await appendHistoryEntry(targetDir, {
    turnId: newTurnId(),
    op: 'edit',
    files: [
      {
        relPath: filePath ?? 'SKILL.md',
        snapshotPath: backupPath,
        action: backupPath ? 'modified' : 'created',
      },
    ],
  }).catch(() => {});

  return {
    success: true,
    status: 'applied',
    message: `Edited ${filePath ?? 'SKILL.md'} in "${name}".`,
    path: targetPath,
  };
}

// ── Action: delete ─ remove a skill (Task #17 v2) ───────────────────────
//
// MVP restriction: only workspace-auto and draft sources are deletable.
// User/project/builtin/standard etc. are user-managed outside the
// agent — if we let delete hit them, a misbehaving agent could nuke
// hand-curated skills. Deletion of a draft reroutes to the existing
// rejectDraft flow (→ trash, 7-day recovery). Deletion of a
// workspace-auto skill is permanent (no git, no trash).
async function deleteAction(input: Record<string, unknown>, context?: ToolExecutionContext): Promise<ActionResult> {
  const name = input.name as string;

  const nameErr = validateName(name);
  if (nameErr) return { success: false, error: nameErr };

  const workspacePath = requireWorkspace(context);

  const existing = skillLoader.getSkill(name);
  if (!existing) {
    return { success: false, error: `skill "${name}" not found` };
  }

  if (existing.source !== 'workspace-auto' && existing.source !== 'draft') {
    return {
      success: false,
      error: `delete only supports workspace-auto and draft sources; "${name}" is source=${existing.source}. Users manage those scopes directly (via filesystem or git).`,
    };
  }

  let rescuable: boolean;
  let finalPath: string;
  try {
    if (existing.source === 'draft') {
      // Reuse the drafts trash flow — 7-day recovery window.
      const { trashDir } = await rejectDraft(name, workspacePath);
      finalPath = trashDir;
      rescuable = true;
    } else {
      // Permanent delete for workspace-auto. We intentionally skip any
      // trash/backup because workspace-auto is agent-created scratch —
      // a restore path would just let mistakes accumulate as clutter.
      const { remove } = await import('@tauri-apps/plugin-fs');
      await remove(existing.skillDir, { recursive: true });
      finalPath = existing.skillDir;
      rescuable = false;
    }
  } catch (e) {
    return { success: false, error: `delete failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  await skillLoader.discoverSkills(workspacePath).catch(() => {});

  const noticeCard: InteractiveNoticeCard = {
    type: 'skill-deleted',
    id: `${name}@${Date.now()}`,
    skillDeleted: {
      skillName: name,
      skillDir: finalPath,
      source: existing.source,
      rescuable,
      workspacePath,
    },
  };

  return {
    success: true,
    status: 'applied',
    message: rescuable
      ? `Moved skill "${name}" to trash (7-day recovery).`
      : `Deleted skill "${name}" permanently.`,
    path: finalPath,
    notice_card: noticeCard,
  };
}

// ── Action: remove_file (Task #17 v2) ───────────────────────────────────
//
// Remove a single supporting file (references/templates/scripts/assets)
// from a skill. Cannot target SKILL.md — validateFilePath requires a
// subdir prefix, so SKILL.md at the root is naturally rejected. No
// notice card — it's a minor maintenance op, not worth chat-level UI.
async function removeFileAction(input: Record<string, unknown>, context?: ToolExecutionContext): Promise<ActionResult> {
  const name = input.name as string;
  const filePath = input.file_path as string;

  const nameErr = validateName(name);
  if (nameErr) return { success: false, error: nameErr };
  const pathErr = validateFilePath(filePath);
  if (pathErr) return { success: false, error: pathErr };

  const requestedScope = (input.scope as SkillScope | undefined) ?? 'workspace-auto';
  if (requestedScope === 'user') {
    return {
      success: false,
      error: "scope='user' writes are not yet supported in this MVP (Module I pending).",
    };
  }

  const workspacePath = requireWorkspace(context);

  const existing = skillLoader.getSkill(name);
  if (!existing) {
    return { success: false, error: `skill "${name}" not found` };
  }

  // CoM rule mirrors patch/write_file — force the file to live under a
  // writable source before we touch it. If the supporting file is
  // missing from the read-only original, CoM copies it too (or not,
  // if it never existed) and the existence check below catches it.
  const targetDir =
    existing.source === 'workspace-auto' || existing.source === 'draft'
      ? existing.skillDir
      : await ensureWorkspaceAutoCopy(existing, workspacePath);
  const targetPath = joinPath(targetDir, filePath);

  if (!(await exists(targetPath))) {
    return { success: false, error: `file not found: ${filePath}` };
  }

  // Tombstone the current content BEFORE deleting so a future revert
  // can put the file back. atomicWriteWithBackup can't help here —
  // there's no "write with backup" when the intent is removal.
  const ts = Date.now();
  const tombstonePath = await writeTombstone(targetDir, filePath, ts).catch(() => null);

  try {
    const { remove } = await import('@tauri-apps/plugin-fs');
    await remove(targetPath);
  } catch (e) {
    return { success: false, error: `remove failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  await skillLoader.discoverSkills(workspacePath).catch(() => {});

  await appendHistoryEntry(targetDir, {
    turnId: newTurnId(),
    ts,
    op: 'remove_file',
    files: [
      {
        relPath: filePath,
        snapshotPath: tombstonePath,
        action: 'removed',
      },
    ],
  }).catch(() => {});

  return {
    success: true,
    status: 'applied',
    message: `Removed ${filePath} from "${name}".`,
    path: targetPath,
  };
}

// ── Tool definition ─────────────────────────────────────────────────────

export const skillManageTool: ToolDefinition = {
  name: TOOL_NAMES.SKILL_MANAGE,
  description:
    '管理 skills（agent 的程序性记忆）。7 个 action：' +
    '\n- **install**：从外部来源安装 skill（npm 包名 / 本地路径 / URL / GitHub 链接），装入用户"我的技能"' +
    '\n- **create**：新建 skill（必填 name + content + frontmatter.description）' +
    '\n- **patch**：原地改已有 skill，基于 fuzzy 查找替换（old_string → new_string）' +
    '\n- **edit**：整文件替换（比 patch 更可靠——大段改动时用 edit，不要硬塞给 patch）' +
    '\n- **write_file**：给 skill 加/覆盖 支撑文件（references / templates / scripts / assets）' +
    '\n- **remove_file**：删除 skill 的一个支撑文件（SKILL.md 不可删，需整体 delete）' +
    '\n- **delete**：删除整个 skill（仅限 workspace-auto 和 draft；draft 走 trash 7 天可恢复，workspace-auto 永久删）' +
    '\n\n⚠️ create 必填参数：action="create" + name + content + frontmatter.description。' +
    '漏任何一个会立即失败。最小示例：' +
    '\n`skill_manage({ action:"create", name:"my-skill", frontmatter:{ description:"一句话说明这个 skill 干啥" }, content:"# My Skill\\n正文…" })`' +
    '\n\n**create 的两种模式**（由 agent_proposed 区分）：' +
    '\n- **省略 agent_proposed（默认）** = 用户明确要求建 → **直接生效**，立刻出现在主技能列表' +
    '\n- **agent_proposed=true** = 你自发提议（用户没明说要建） → 进草稿区等用户审核采纳' +
    '\n\n使用时机：完成 5+ 次工具调用的复杂任务、从错误恢复、用户纠正了做法、发现非直觉工作流，' +
    '考虑 create 沉淀。使用 skill 时发现过时或错误，立即 patch 修正。' +
    '\n\n**改动自动 Copy-on-Modify**：对非 workspace-auto / draft 的 skill（user / project / builtin 等），' +
    'patch / edit / write_file / remove_file 会先把整个 skill 拷贝到 workspace-auto 再改，不动原 skill。' +
    '\n\nscope 默认 workspace-auto（本项目 agent 自治区），建议 99% 情况都保持默认。' +
    'scope=user（全局写入）在 MVP 暂不支持，需要等 Module I 的确认 UX。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['install', 'create', 'patch', 'write_file', 'edit', 'delete', 'remove_file'],
        description: 'install / create / patch / write_file / edit / delete / remove_file',
      },
      source: {
        type: 'string',
        description: '[install] 安装来源：npm 包名（如 "cooper"）、本地路径（如 "/Downloads/my-skill"）、直链 URL（.tgz/.zip）、或 GitHub 链接（https://github.com/user/repo）',
      },
      overwrite: {
        type: 'boolean',
        description: '[install] 是否覆盖同名已存在的 skill。默认 false —— 同名冲突会返回错误而非静默覆盖。仅在与用户确认后才传 true。',
      },
      name: {
        type: 'string',
        description: 'skill 名（a-z / 0-9 / 点 / 连字符 / 下划线，首字母/数字开头，最长 64 字符）',
      },
      scope: {
        type: 'string',
        enum: ['workspace-auto', 'user'],
        description: '写入作用域，默认 workspace-auto。user scope 在 MVP 暂不支持。',
      },
      frontmatter: {
        type: 'object',
        description: '[create] SKILL.md 前置 YAML。description 必填；trigger / user-invocable / argument-hint 可选。',
        properties: {
          description: {
            type: 'string',
            description: '一句话说明这个 skill 的用途（必填，最长 1024 字符）。例如："生成小红书风格的图文内容"。',
          },
          trigger: {
            type: 'string',
            description: '可选。自动触发条件，例如"用户要求做日报"。不填则 skill 只能被 /name 主动调用。',
          },
          'user-invocable': {
            type: 'boolean',
            description: '可选，默认 true。是否允许用户通过 /name 主动调用。',
          },
          'argument-hint': {
            type: 'string',
            description: '可选。/name 调用时的参数提示，例如"主题或关键词"。',
          },
        },
        required: ['description'],
      },
      content: {
        type: 'string',
        description: '[create|edit] SKILL.md 正文（create 必填；edit 整文件替换，最多 100,000 字符）',
      },
      old_string: {
        type: 'string',
        description: '[patch] 要查找替换的原字符串。支持 fuzzy 匹配（exact / line-trimmed / whitespace-normalized 三层）',
      },
      new_string: {
        type: 'string',
        description: '[patch] 替换后的新字符串',
      },
      replace_all: {
        type: 'boolean',
        description: '[patch] 是否替换所有匹配（默认 false，多匹配时拒绝）',
      },
      file_path: {
        type: 'string',
        description: '[patch|write_file|edit|remove_file] 支撑文件相对路径，必须在 references/ | templates/ | scripts/ | assets/ 下。edit 省略则指向 SKILL.md；remove_file 必填（SKILL.md 根文件不可删，需改用 delete 整个 skill）。',
      },
      file_content: {
        type: 'string',
        description: '[write_file] 文件内容',
      },
      trigger_reason: {
        type: 'string',
        description:
          '[create] 可选。用一句话说明为什么在此刻提议这个 skill，例如"6 步数据导出任务成功"。仅在 agent_proposed=true 时会被用户在草稿面板看到；直写模式下忽略。',
      },
      agent_proposed: {
        type: 'boolean',
        description:
          '[create] 默认省略（=false）= 直接生效到主技能列表。' +
          '仅当你自发觉得值得沉淀、用户没明说要建时设 true，进草稿区等用户审核。' +
          '不确定时省略（走直写）——用户可随时删；草稿误伤反而打扰用户。',
      },
    },
    required: ['action', 'name'],
  },
  execute: async (input, context) => {
    const action = input.action as SkillAction;
    let result: ActionResult;
    try {
      switch (action) {
        case 'install':
          result = await installAction(input);
          break;
        case 'create':
          result = await createAction(input, context);
          break;
        case 'patch':
          result = await patchAction(input, context);
          break;
        case 'write_file':
          result = await writeFileAction(input, context);
          break;
        case 'edit':
          result = await editAction(input, context);
          break;
        case 'delete':
          result = await deleteAction(input, context);
          break;
        case 'remove_file':
          result = await removeFileAction(input, context);
          break;
        default:
          result = {
            success: false,
            error: `unknown action "${action}". Supported: install, create, patch, write_file, edit, delete, remove_file.`,
          };
      }
    } catch (e) {
      result = {
        success: false,
        error: `skill_manage failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return JSON.stringify(result, null, 2);
  },
  isConcurrencySafe: false, // writes files; serialize with self
};
