import { exists, mkdir, readDir, readTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import type { SubagentDefinition } from '@/types';
import type { AppDefinition, AppRunRef, ParsedAppFile, ParsedPluginTeam } from '@/types/app';
import { APP_FILE_PATH, appRuns, parseAppFile, splitRunTarget } from '../../../electron/shared/appSpec.mjs';
import { parseTeamFile } from '../../../electron/shared/pluginSpec.mjs';
import { convertSingleFileAgent, renderAgentMd, BUILTIN_AGENT_NAMES } from '../../../electron/shared/pluginAgentFormat.mjs';
import { PluginManifestError } from '../../../electron/shared/pluginManifestError.mjs';
import { resolveLocalizedText } from '../../../electron/shared/specFields.mjs';
import { saveItemToAbuDir } from '@/utils/itemStorage';
import { AGENT_NAME_RE } from '@/utils/validation';
import { atomicWrite } from '@/utils/atomicFs';
import { joinPath } from '@/utils/pathUtils';
import { getI18n, getLocale } from '@/i18n';
import { agentRegistry } from '@/core/agent/registry';
import { ensureRoleId } from '@/core/team/roleIdentity';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useTeamStore } from '@/stores/teamStore';
import { useChatStore } from '@/stores/chatStore';
import { useAppStore } from '@/stores/appStore';
import { useAppDraftStore, type AppDraft } from '@/stores/appDraftStore';
import { addedAppId, appDir, saveAddedApp } from './appRecords';
import { isUsersOwnAgent, isUsersOwnTeam, liveRefCatalog, resolveTarget, type RefCatalog } from './appRefs';
import { refreshAddedApps } from './appSync';

/**
 * 「创建应用」 (docs/app-spec.md, product brief §6.7). The conversation writes
 * its app into a draft folder:
 *
 *   .abu-app/app.json   the app; `mine:` references name the user's own
 *                       experts and teams, or the new ones below
 *   agents/<名称>.md     experts to create (single-file agent format)
 *   teams/<id>.json     expert teams to create (same format as a plugin's)
 *
 * `app_prepare` validates the draft for the model; the preview card shows it
 * to the user; confirming creates the new experts and teams as the user's own,
 * points the app at them and adds the app.
 */

export interface DraftExpert { name: string; description: string; markdown: string }

export interface AppDraftPreview {
  file: ParsedAppFile;
  /** The app as it will appear once added. */
  app: AppDefinition;
  experts: DraftExpert[];
  teams: ParsedPluginTeam[];
}

const APPS_FOLDER = 'Abu Apps';

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Start a creation conversation with its own draft folder, and open it. */
export async function createAppDraft(): Promise<void> {
  const id = randomId();
  const dir = joinPath(await homeDir(), APPS_FOLDER, id);
  await mkdir(dir, { recursive: true });
  const chat = useChatStore.getState();
  const conversationId = chat.createConversation(dir);
  useAppDraftStore.getState().record(conversationId, { id, dir, createdAt: new Date().toISOString() });
  chat.renameConversation(conversationId, getI18n().appSwitcher.createConversation);
  chat.setPendingInput(getI18n().appSwitcher.createPrompt);
}

export function draftFor(conversationId: string): AppDraft {
  const draft = useAppDraftStore.getState().draftsByConversation[conversationId];
  if (!draft) throw new Error('This conversation is not an app creation conversation');
  return draft;
}

export async function draftHasApp(draft: AppDraft): Promise<boolean> {
  return exists(joinPath(draft.dir, APP_FILE_PATH));
}

/** What `mine:` can name: the user's own experts by name, and the user's own teams by id. */
export interface UsersOwnRefs {
  experts: string[];
  teams: { id: string; name: string }[];
}

export function usersOwnRefs(): UsersOwnRefs {
  const experts = useDiscoveryStore.getState().agents
    .map((agent) => agentRegistry.getAgent(agent.name))
    .filter((agent): agent is SubagentDefinition => agent !== undefined && isUsersOwnAgent(agent))
    .map((agent) => agent.name);
  const teams = useTeamStore.getState().teams.filter(isUsersOwnTeam).map((team) => ({ id: team.id, name: team.name }));
  return { experts, teams };
}

async function listFiles(dir: string, extension: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  return (await readDir(dir)).filter((entry) => entry.isFile && entry.name.toLowerCase().endsWith(extension)).map((entry) => entry.name).sort();
}

function draftFail(field: string, message: string, reason: 'unknown-reference' | 'duplicate' = 'unknown-reference'): never {
  throw new PluginManifestError(`${field}: ${message}`, field, reason);
}

/**
 * Every `mine:` reference names a new expert or team of the draft, or one the
 * user already has; every other reference resolves on this computer now.
 */
function checkReferences(app: AppDefinition, experts: DraftExpert[], teams: ParsedPluginTeam[], catalog: RefCatalog): void {
  const newExperts = new Set(experts.map((expert) => expert.name));
  const newTeams = new Set(teams.map((team) => team.id));
  for (const { field, run } of appRuns(app.config)) {
    for (const kind of ['team', 'expert', 'skill'] as const) {
      const value = (run as Record<string, string | undefined>)[kind];
      if (value === undefined) continue;
      const target = splitRunTarget(kind, value);
      if (target?.origin === 'mine' && ((kind === 'expert' && newExperts.has(target.id)) || (kind === 'team' && newTeams.has(target.id)))) continue;
      const resolved = resolveTarget(app, kind, value, catalog);
      if (resolved.status !== 'ok') draftFail(`${field}.${kind}`, `"${value}" does not exist on this computer; name one that does, or add it to agents/ or teams/`);
    }
  }
}

/** Read and check a draft folder. Errors carry the field to fix, for the model. */
export async function readAppDraft(draft: AppDraft, catalog: RefCatalog = liveRefCatalog()): Promise<AppDraftPreview> {
  if (draft.appId !== undefined) throw new Error('The app of this conversation has already been added; it is in the app switcher');
  const appPath = joinPath(draft.dir, APP_FILE_PATH);
  if (!(await exists(appPath))) draftFail(APP_FILE_PATH, 'write the app here first');
  const file = parseAppFile(JSON.parse(await readTextFile(appPath)), { source: 'created' });

  const experts: DraftExpert[] = [];
  for (const name of await listFiles(joinPath(draft.dir, 'agents'), '.md')) {
    const converted = convertSingleFileAgent(await readTextFile(joinPath(draft.dir, 'agents', name)), name.replace(/\.md$/i, ''));
    const field = `agents/${name}`;
    if (!AGENT_NAME_RE.test(converted.name)) draftFail(field, `"${converted.name}" cannot be an expert name`);
    if (BUILTIN_AGENT_NAMES.includes(converted.name) || catalog.getAgent(converted.name)) draftFail(field, `an expert named "${converted.name}" already exists; pick another name`, 'duplicate');
    if (converted.body.trim().length === 0) draftFail(field, 'the expert has no instructions');
    experts.push({ name: converted.name, description: converted.description, markdown: renderAgentMd(converted) });
  }

  const teams: ParsedPluginTeam[] = [];
  for (const name of await listFiles(joinPath(draft.dir, 'teams'), '.json')) {
    const id = name.replace(/\.json$/i, '');
    teams.push(parseTeamFile(JSON.parse(await readTextFile(joinPath(draft.dir, 'teams', name))), id, { agentNames: experts.map((expert) => expert.name) }));
  }

  const appId = addedAppId(file.name, { kind: 'created', authoringId: draft.id });
  if (useAppStore.getState().addedApps.some((added) => added.appId === appId)) draftFail('name', `an app named "${file.name}" is already added; pick another name`, 'duplicate');
  const app: AppDefinition = {
    appId, name: file.interface.displayName, description: file.interface.shortDescription,
    config: file.config, version: file.version, origin: { kind: 'created', authoringId: draft.id }, plugins: file.plugins,
  };
  checkReferences(app, experts, teams, catalog);
  return { file, app, experts, teams };
}

/** Point `mine:<draft team id>` references at the teams created for them. */
function rewriteTeamRefs(value: unknown, teamIds: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteTeamRefs(item, teamIds));
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'team' && typeof item === 'string' && item.startsWith('mine:') && teamIds.has(item.slice('mine:'.length))) {
      next[key] = `mine:${teamIds.get(item.slice('mine:'.length))}`;
    } else next[key] = rewriteTeamRefs(item, teamIds);
  }
  return next;
}

/**
 * Create the draft's new experts and teams as the user's own, add the app,
 * and enter it. The draft is read and checked again first, so what is created
 * is what is in the folder now.
 */
export async function commitAppDraft(conversationId: string): Promise<string> {
  const draft = draftFor(conversationId);
  const preview = await readAppDraft(draft);
  const home = await homeDir();

  for (const expert of preview.experts) {
    await saveItemToAbuDir('agents', 'AGENT.md', expert.name, expert.markdown, undefined, { mustBeNew: true });
  }
  if (preview.experts.length > 0) await useDiscoveryStore.getState().refresh();
  const roleIds = new Map<string, string>();
  for (const expert of preview.experts) {
    const agent = agentRegistry.getAgent(expert.name);
    if (!agent) throw new Error(`the expert "${expert.name}" was written but did not load`);
    roleIds.set(`plugin:${expert.name}`, (await ensureRoleId(agent)).roleId);
  }
  if (preview.experts.length > 0) await useDiscoveryStore.getState().refresh();

  const locale = getLocale();
  const text = (value: ParsedPluginTeam['name'] | undefined) => (value === undefined ? undefined : resolveLocalizedText(value, locale));
  const role = (roleId: string) => roleIds.get(roleId) ?? roleId;
  const teamIds = new Map<string, string>();
  for (const team of preview.teams) {
    const created = useTeamStore.getState().createTeam({
      name: text(team.name)!,
      leaderRoleId: role(team.leaderRoleId),
      memberRoleIds: team.memberRoleIds.map(role),
      leaderNote: team.leaderNote,
      requirePlanApproval: team.requirePlanApproval,
      avatar: team.avatar,
      description: text(team.description),
      intro: text(team.intro),
      expertise: team.expertise.map((item) => text(item)!),
      samplePrompts: team.samplePrompts.map((item) => text(item)!),
    });
    teamIds.set(team.id, created.id);
  }

  const record = { appId: preview.app.appId, name: preview.file.name, version: preview.file.version, origin: { kind: 'created' as const, authoringId: draft.id }, addedAt: new Date().toISOString() };
  await saveAddedApp(home, draft.dir, record);
  const raw = JSON.parse(await readTextFile(joinPath(draft.dir, APP_FILE_PATH)));
  await atomicWrite(joinPath(appDir(home, record.appId), APP_FILE_PATH), `${JSON.stringify(rewriteTeamRefs(raw, teamIds), null, 2)}\n`);
  await refreshAddedApps();
  useAppDraftStore.getState().markAdded(conversationId, record.appId);
  useAppStore.getState().enterAppWhenAvailable(record.appId);
  return record.appId;
}

/** Who a draft scene is handed to, for the preview: a new expert or team by its own name. */
export function draftRunLabel(run: AppRunRef | undefined, preview: AppDraftPreview): string | undefined {
  if (!run) return undefined;
  const value = 'team' in run ? run.team : 'expert' in run ? run.expert : undefined;
  if (!value?.startsWith('mine:')) return undefined;
  const id = value.slice('mine:'.length);
  const team = preview.teams.find((item) => item.id === id);
  if (team) return resolveLocalizedText(team.name, getLocale());
  return preview.experts.find((item) => item.name === id)?.name;
}
