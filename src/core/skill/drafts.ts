/**
 * Draft filesystem operations for the self-evolving skills system.
 *
 * A draft is a skill that has been written to `drafts/{name}/` and is
 * awaiting user review. Accepted drafts move to `workspace-auto/{name}/`
 * and become indistinguishable from agent-authored workspace skills.
 * Rejected drafts move to `drafts/.trash/{name}-{ts}/` so the user can
 * recover a week of history if they change their mind.
 *
 * Each draft directory holds:
 *   - SKILL.md                (the skill content itself)
 *   - .abu-draft-meta.json    (sidecar with action/triggerReason/ttl; stripped on accept)
 *   - scripts/ / references/  (optional supporting files written by the agent)
 *
 * The sidecar is intentionally a separate file rather than frontmatter keys
 * so accepted skills don't carry draft-era metadata into their final form.
 *
 * Wired in by module G (Task #19). `skill_manage(action='create')` delegates
 * the actual write here; the store layer (Task #20) subscribes to listDrafts
 * and schedules cleanExpiredDrafts; the UI (Task #21) calls acceptDraft /
 * rejectDraft.
 */

import {
  readTextFile,
  readDir,
  exists,
  mkdir,
  remove,
  rename,
} from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath, normalizeSeparators } from '../../utils/pathUtils';
import { sanitizePath } from '../memdir/paths';
import { atomicWrite } from '../../utils/atomicFs';
import { assertSkillNameAllowed } from './skillPolicy';
import type { ProactivityLevel } from '../agent/prompts/skillsGuidance';

// ── Constants ───────────────────────────────────────────────────────────

const SIDECAR_FILENAME = '.abu-draft-meta.json';
const TRASH_DIRNAME = '.trash';
const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Draft TTL (ms) per proactivity preset. Matches the UX table in PRD §G:
 * shy keeps drafts longer because the agent proposes less, butler expires
 * fast because it proposes constantly.
 */
const DRAFT_TTL_MS_BY_LEVEL: Record<ProactivityLevel, number> = {
  shy: 7 * 24 * 60 * 60 * 1000,       // 7 days
  companion: 72 * 60 * 60 * 1000,     // 72 hours
  butler: 24 * 60 * 60 * 1000,        // 24 hours
};

// ── Types ───────────────────────────────────────────────────────────────

/** User-facing record returned by listDrafts / readDraft. */
export interface DraftRecord {
  /** Stable identifier — currently just the skill name (unique within drafts/). */
  id: string;
  /** The skill name (directory basename). */
  skillName: string;
  /** Absolute path to the draft directory. */
  skillDir: string;
  /** Absolute path to SKILL.md inside skillDir. */
  skillMdPath: string;
  /** 'create' for new-skill proposals; 'patch' for upstream-modification proposals (reserved for v2+). */
  action: 'create' | 'patch';
  /** Free-form reason captured at write time, e.g. "6-step task succeeded". */
  triggerReason: string;
  /** For patch proposals, the upstream skill being modified. */
  parentSkill?: string;
  createdAt: number;
  expiresAt: number;
}

/** Input metadata for writeDraft. */
export interface DraftMetadata {
  action: 'create' | 'patch';
  /** Proactivity level at write time — drives TTL selection. Defaults to 'companion'. */
  proactivity?: ProactivityLevel;
  triggerReason?: string;
  parentSkill?: string;
  /** Override TTL explicitly in ms. Wins over proactivity-derived default. */
  ttlMs?: number;
}

interface DraftSidecar {
  action: 'create' | 'patch';
  triggerReason: string;
  parentSkill?: string;
  createdAt: number;
  expiresAt: number;
}

// ── Path helpers ────────────────────────────────────────────────────────

async function getProjectSkillsDir(workspacePath: string): Promise<string> {
  const home = await homeDir();
  const key = sanitizePath(normalizeSeparators(workspacePath));
  return joinPath(home, '.abu/projects', key, 'skills');
}

async function getDraftsRoot(workspacePath: string): Promise<string> {
  return joinPath(await getProjectSkillsDir(workspacePath), 'drafts');
}

async function getTrashRoot(workspacePath: string): Promise<string> {
  return joinPath(await getDraftsRoot(workspacePath), TRASH_DIRNAME);
}

function getSidecarPath(draftDir: string): string {
  return joinPath(draftDir, SIDECAR_FILENAME);
}

// ── Internal helpers ────────────────────────────────────────────────────

async function readSidecar(draftDir: string): Promise<DraftSidecar | null> {
  const path = getSidecarPath(draftDir);
  if (!(await exists(path).catch(() => false))) return null;
  try {
    const raw = await readTextFile(path);
    const parsed = JSON.parse(raw) as Partial<DraftSidecar>;
    if (
      (parsed.action === 'create' || parsed.action === 'patch') &&
      typeof parsed.createdAt === 'number' &&
      typeof parsed.expiresAt === 'number'
    ) {
      return {
        action: parsed.action,
        triggerReason: parsed.triggerReason ?? '',
        parentSkill: parsed.parentSkill,
        createdAt: parsed.createdAt,
        expiresAt: parsed.expiresAt,
      };
    }
  } catch {
    /* corrupt sidecar — treat as missing */
  }
  return null;
}

async function writeSidecar(draftDir: string, sidecar: DraftSidecar): Promise<void> {
  await atomicWrite(getSidecarPath(draftDir), JSON.stringify(sidecar, null, 2));
}

/** Fallback sidecar for legacy drafts (created before Module G landed). */
function legacySidecar(now: number, ttl: number): DraftSidecar {
  return {
    action: 'create',
    triggerReason: '(legacy draft — predates Module G)',
    createdAt: now,
    expiresAt: now + ttl,
  };
}

function toRecord(skillName: string, draftDir: string, sidecar: DraftSidecar): DraftRecord {
  return {
    id: skillName,
    skillName,
    skillDir: draftDir,
    skillMdPath: joinPath(draftDir, 'SKILL.md'),
    action: sidecar.action,
    triggerReason: sidecar.triggerReason,
    parentSkill: sidecar.parentSkill,
    createdAt: sidecar.createdAt,
    expiresAt: sidecar.expiresAt,
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Write `skillMdContent` as a new draft at `drafts/{name}/SKILL.md` plus its
 * sidecar meta. Parent dirs are created as needed. Overwrites any draft that
 * happens to share the same name (agent retry case).
 *
 * The caller (skill_manage.createAction) is still responsible for running
 * contentGuard and rolling back on block — this function just persists bytes.
 */
export async function writeDraft(
  skillName: string,
  skillMdContent: string,
  metadata: DraftMetadata,
  workspacePath: string,
): Promise<DraftRecord> {
  const draftsRoot = await getDraftsRoot(workspacePath);
  const draftDir = joinPath(draftsRoot, skillName);
  const skillMdPath = joinPath(draftDir, 'SKILL.md');

  await mkdir(draftDir, { recursive: true });
  await atomicWrite(skillMdPath, skillMdContent);

  const level = metadata.proactivity ?? 'companion';
  const ttl = metadata.ttlMs ?? DRAFT_TTL_MS_BY_LEVEL[level];
  const now = Date.now();
  const sidecar: DraftSidecar = {
    action: metadata.action,
    triggerReason: metadata.triggerReason ?? '',
    parentSkill: metadata.parentSkill,
    createdAt: now,
    expiresAt: now + ttl,
  };
  await writeSidecar(draftDir, sidecar);

  return toRecord(skillName, draftDir, sidecar);
}

/**
 * Write a SKILL.md directly to the workspace-auto skills dir, bypassing the
 * drafts/review flow. Used by `skill_manage(create)` when the user explicitly
 * asked for the skill (i.e. `agent_proposed` is false / omitted). No sidecar,
 * no TTL, no trash — this is the "立即生效" path.
 *
 * Caller is still responsible for:
 *   - name / frontmatter validation
 *   - contentGuard pre-scan (refuse on block)
 *   - collision check against non-draft skills
 *   - best-effort reject of any same-name draft (so the loader's first-win
 *     rule doesn't leave a phantom in the drafts panel)
 *
 * Creates only: returns null, writing nothing, when the skill folder is
 * already there — made since the caller's check (another loop creating the
 * same name), or holding a SKILL.md the check could not see.
 */
export async function writeSkillDirect(
  skillName: string,
  skillMdContent: string,
  workspacePath: string,
): Promise<{ skillDir: string; skillMdPath: string } | null> {
  const skillsRoot = await getProjectSkillsDir(workspacePath);
  const skillDir = joinPath(skillsRoot, skillName);
  const skillMdPath = joinPath(skillDir, 'SKILL.md');
  await mkdir(skillsRoot, { recursive: true });
  // Not `recursive`: that succeeds on an existing folder, this fails on one.
  try {
    await mkdir(skillDir);
  } catch (err) {
    if (await exists(skillDir).catch(() => false)) return null;
    throw err;
  }
  await atomicWrite(skillMdPath, skillMdContent);
  return { skillDir, skillMdPath };
}

/** Load one draft by name. Returns null if not found. */
export async function readDraft(
  skillName: string,
  workspacePath: string,
): Promise<DraftRecord | null> {
  const draftsRoot = await getDraftsRoot(workspacePath);
  const draftDir = joinPath(draftsRoot, skillName);
  if (!(await exists(draftDir).catch(() => false))) return null;
  if (!(await exists(joinPath(draftDir, 'SKILL.md')).catch(() => false))) return null;

  const sidecar =
    (await readSidecar(draftDir)) ??
    legacySidecar(Date.now(), DRAFT_TTL_MS_BY_LEVEL.companion);
  return toRecord(skillName, draftDir, sidecar);
}

/**
 * Enumerate all drafts for `workspacePath`. Skips the `.trash/` subdir.
 * Entries without a sidecar are surfaced with legacy defaults so the UI
 * can still offer accept / reject on them.
 *
 * Every draft on disk, including ones under a name the organization's skill
 * blacklist blocks. Anything that shows drafts to someone must drop those;
 * skillDraftsStore does.
 */
export async function listDrafts(workspacePath: string): Promise<DraftRecord[]> {
  const draftsRoot = await getDraftsRoot(workspacePath);
  if (!(await exists(draftsRoot).catch(() => false))) return [];

  const entries = await readDir(draftsRoot).catch(() => []);
  const now = Date.now();
  const records: DraftRecord[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    if (entry.name === TRASH_DIRNAME) continue;
    if (entry.name.startsWith('.')) continue;

    const draftDir = joinPath(draftsRoot, entry.name);
    const skillMdPath = joinPath(draftDir, 'SKILL.md');
    if (!(await exists(skillMdPath).catch(() => false))) continue;

    const sidecar =
      (await readSidecar(draftDir)) ??
      legacySidecar(now, DRAFT_TTL_MS_BY_LEVEL.companion);
    records.push(toRecord(entry.name, draftDir, sidecar));
  }

  records.sort((a, b) => b.createdAt - a.createdAt);
  return records;
}

/**
 * Promote a draft to workspace-auto: move `drafts/{name}/` → `skills/{name}/`
 * and drop the sidecar so the final skill dir carries no draft artefacts.
 *
 * Fails if a skill with the same name already exists at workspace-auto —
 * callers should surface the conflict and let the user decide (rename /
 * overwrite is a v2+ flow, see Module H).
 */
export async function acceptDraft(
  skillName: string,
  workspacePath: string,
): Promise<{ targetDir: string }> {
  // A draft may predate the organization's policy, or have been proposed on a
  // machine that had none — accepting it is what makes the skill live.
  assertSkillNameAllowed(skillName);

  const draftsRoot = await getDraftsRoot(workspacePath);
  const sourceDir = joinPath(draftsRoot, skillName);
  const skillsRoot = await getProjectSkillsDir(workspacePath);
  const targetDir = joinPath(skillsRoot, skillName);

  if (!(await exists(sourceDir).catch(() => false))) {
    throw new Error(`Draft "${skillName}" not found at ${sourceDir}`);
  }
  if (await exists(targetDir).catch(() => false)) {
    throw new Error(
      `Cannot accept "${skillName}": a workspace skill with the same name already exists at ${targetDir}. Resolve the conflict first.`,
    );
  }

  // Strip the sidecar before moving so the accepted skill dir is clean.
  // Best-effort — even if this fails (e.g. file missing), the rename below
  // is the step that actually commits the accept.
  const sidecarPath = getSidecarPath(sourceDir);
  if (await exists(sidecarPath).catch(() => false)) {
    await remove(sidecarPath).catch(() => {
      /* best-effort */
    });
  }

  await mkdir(skillsRoot, { recursive: true });
  await rename(sourceDir, targetDir);
  return { targetDir };
}

/**
 * Reject a draft: move it into `drafts/.trash/{name}-{ts}/` so the user
 * can still recover it for TRASH_TTL_MS. `reason` is reserved for a
 * future feedback-memory write (Module G's "永远不提议这类" path); for
 * now it's accepted but unused.
 */
export async function rejectDraft(
  skillName: string,
  workspacePath: string,
  _reason?: string,
): Promise<{ trashDir: string }> {
  void _reason;
  const draftsRoot = await getDraftsRoot(workspacePath);
  const sourceDir = joinPath(draftsRoot, skillName);
  if (!(await exists(sourceDir).catch(() => false))) {
    throw new Error(`Draft "${skillName}" not found at ${sourceDir}`);
  }

  const trashRoot = await getTrashRoot(workspacePath);
  await mkdir(trashRoot, { recursive: true });
  const trashDir = joinPath(trashRoot, `${skillName}-${Date.now()}`);
  await rename(sourceDir, trashDir);
  return { trashDir };
}

/**
 * Sweep expired drafts into the trash. Returns the number swept. Intended
 * to run on app start and once an hour thereafter (scheduled in Task #20).
 */
export async function cleanExpiredDrafts(workspacePath: string): Promise<number> {
  const drafts = await listDrafts(workspacePath);
  const now = Date.now();
  let swept = 0;
  for (const draft of drafts) {
    if (draft.expiresAt <= now) {
      await rejectDraft(draft.skillName, workspacePath).catch(() => {
        /* swallow — a single bad draft shouldn't halt the sweep */
      });
      swept++;
    }
  }
  return swept;
}

/**
 * Permanently delete trash entries older than TRASH_TTL_MS. Independent of
 * the draft TTL sweep — trashed items get their own week-long grace period
 * regardless of why they were trashed (reject vs. expiry).
 */
export async function emptyExpiredTrash(workspacePath: string): Promise<number> {
  const trashRoot = await getTrashRoot(workspacePath);
  if (!(await exists(trashRoot).catch(() => false))) return 0;

  const entries = await readDir(trashRoot).catch(() => []);
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    // Entries are named `${name}-${timestamp}` — parse the trailing ts.
    const idx = entry.name.lastIndexOf('-');
    if (idx < 0) continue;
    const ts = Number(entry.name.slice(idx + 1));
    if (!Number.isFinite(ts)) continue;
    if (now - ts < TRASH_TTL_MS) continue;

    const dir = joinPath(trashRoot, entry.name);
    await remove(dir, { recursive: true }).catch(() => {
      /* best-effort */
    });
    removed++;
  }
  return removed;
}
