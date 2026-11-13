/**
 * Self-extension consequence classification.
 *
 * Abu lets the agent grow its own capabilities and automations — create
 * subagents, install MCP servers, rewrite its persona, and schedule future
 * unattended work. These operations write durable state that shapes later
 * turns or runs, and the model can be
 * steered by whatever it just read (a web page, a document, a tool result).
 * Without a gate, one injected instruction buys a persistent foothold: an MCP
 * server that spawns processes, a subagent with an attacker-authored system
 * prompt, or a rewritten persona that survives into every future conversation.
 *
 * Skills already got this treatment (draft queue + content guard + audited
 * history). Durable automation writes need the same consequence gate.
 *
 * Unlike browser automation there is no per-conversation grant: these are rare,
 * deliberate acts, so each one is worth its own confirmation.
 */

import { TOOL_NAMES } from '../tools/toolNames';
import { format, getI18n } from '../../i18n';

/** manage_mcp_server actions that add a server (and therefore spawn processes or reach a URL). */
const MCP_INSTALLING_ACTIONS = new Set(['install', 'add_custom', 'ensure']);
const AUTOMATION_MANAGER_TOOLS = new Set<string>([
  TOOL_NAMES.MANAGE_TRIGGER,
  TOOL_NAMES.MANAGE_SCHEDULED_TASK,
  TOOL_NAMES.MANAGE_FILE_WATCH,
]);

/** The model chooses these strings; the dialog shows a short, single-line version of them. */
const MAX_NAME_CHARS = 60;
const MAX_DETAIL_CHARS = 120;
const MAX_PROMPT_CHARS = 120;

export interface SelfExtensionAction {
  /** What is about to happen, in plain words ("新建定时任务「每周一检查库存」"). */
  summary: string;
  /** One plain sentence on why this needs the user's say-so. */
  reason: string;
}

/** What the caller read from disk about the call, for summaries that depend on it. */
export interface SelfExtensionFacts {
  /**
   * save_agent: an AGENT.md already exists where this call would write
   * (`saveAgentWouldReplace`). Anything but an explicit `false` reads as a
   * replace — never the model's `overwrite` flag.
   */
  saveAgentReplaces?: boolean;
  /**
   * save_team: a team of this name already exists (`saveTeamWouldReplace`).
   * Anything but an explicit `false` reads as a replace.
   */
  saveTeamReplaces?: boolean;
  /**
   * manage_mcp_server ensure: a server of this name is already in the user's
   * configuration, so `ensure` only connects it (or reports it disabled) and
   * adds nothing. Anything but an explicit `true` reads as an install.
   */
  mcpServerConfigured?: boolean;
  /**
   * manage_scheduled_task / manage_trigger update, delete, pause and resume
   * name their target by id only. This is the name that id has in the user's
   * own list, read by the caller, so the dialog can say which one it is.
   * Missing when the id matches nothing; the summary then names no target.
   */
  automationTargetName?: string;
}

/** One line of text: whitespace collapsed (a name cannot start a new paragraph), clipped. */
function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // Invisible format characters (bidi overrides, zero-width joiners) could
  // reorder or hide the dialog's own words; they are dropped.
  const flat = value.replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

/** `what` followed by the thing's name, or just `what` when the call named nothing. */
function named(what: string, name: string): string {
  return name ? format(getI18n().commandConfirm.selfExtensionNamed, { what, name }) : what;
}

/** `summary` followed by a side detail, or just `summary` when there is none. */
function withDetail(summary: string, detail: string): string {
  return detail ? format(getI18n().commandConfirm.selfExtensionDetail, { summary, detail }) : summary;
}

/**
 * Where an MCP service lives, as a reader should weigh it: the real host and
 * path. Credentials in the address and query strings (often tokens) are left
 * out, and a host hidden behind `trusted.example@evil.example` shows as the
 * host it is.
 */
function describeUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return oneLine(`${url.origin}${url.pathname === '/' ? '' : url.pathname}`, MAX_DETAIL_CHARS);
    }
  } catch {
    // Not an address: show what was given, so the user still sees where it points.
  }
  return oneLine(raw, MAX_DETAIL_CHARS);
}

/** When a new scheduled task runs, worded as the schedule list words it, with the tool's own defaults. */
function describeSchedule(input: Record<string, unknown>): string {
  const t = getI18n().schedule;
  const labels: Record<string, string> = {
    hourly: t.frequencyHourly,
    daily: t.frequencyDaily,
    weekly: t.frequencyWeekly,
    weekdays: t.frequencyWeekdays,
    manual: t.frequencyManual,
  };
  const frequency = typeof input.frequency === 'string' ? input.frequency : '';
  if (!Object.hasOwn(labels, frequency)) return '';
  const label = labels[frequency];
  if (frequency === 'hourly' || frequency === 'manual') return label;

  const inRange = (value: unknown, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : fallback;
  const clock = `${String(inRange(input.time_hour, 23, 9)).padStart(2, '0')}:${String(inRange(input.time_minute, 59, 0)).padStart(2, '0')}`;
  if (frequency !== 'weekly') return `${label} ${clock}`;

  const days = [t.sunday, t.monday, t.tuesday, t.wednesday, t.thursday, t.friday, t.saturday];
  return `${label} ${days[inRange(input.day_of_week, 6, 1)]} ${clock}`;
}

type AutomationVerb = 'Create' | 'Update' | 'Delete' | 'Pause' | 'Resume' | 'Toggle' | 'Other';

/** The known actions of each automation manager. `list` is observational and never gets here. */
const AUTOMATION_ACTION_VERBS: Record<string, Record<string, AutomationVerb>> = {
  [TOOL_NAMES.MANAGE_SCHEDULED_TASK]: { create: 'Create', update: 'Update', delete: 'Delete', pause: 'Pause', resume: 'Resume' },
  [TOOL_NAMES.MANAGE_TRIGGER]: { create: 'Create', update: 'Update', delete: 'Delete', pause: 'Pause', resume: 'Resume' },
  [TOOL_NAMES.MANAGE_FILE_WATCH]: { add: 'Create', remove: 'Delete', toggle: 'Toggle' },
};

function describeAutomation(
  name: string,
  input: Record<string, unknown>,
  facts: SelfExtensionFacts,
): SelfExtensionAction {
  const t = getI18n().commandConfirm;
  const action = typeof input.action === 'string' ? input.action : '';
  const verbs = AUTOMATION_ACTION_VERBS[name];
  const verb: AutomationVerb = Object.hasOwn(verbs, action) ? verbs[action] : 'Other';

  const kind = name === TOOL_NAMES.MANAGE_SCHEDULED_TASK
    ? { noun: t.selfExtensionNounTask, reason: t.selfExtensionReasonTask }
    : name === TOOL_NAMES.MANAGE_TRIGGER
      ? { noun: t.selfExtensionNounTrigger, reason: t.selfExtensionReasonTrigger }
      : { noun: t.selfExtensionNounFileWatch, reason: t.selfExtensionReasonFileWatch };
  const verbText = {
    Create: t.selfExtensionVerbCreate,
    Update: t.selfExtensionVerbUpdate,
    Delete: t.selfExtensionVerbDelete,
    Pause: t.selfExtensionVerbPause,
    Resume: t.selfExtensionVerbResume,
    Toggle: t.selfExtensionVerbToggle,
    Other: t.selfExtensionVerbOther,
  }[verb];
  const what = format(t.selfExtensionAction, { verb: verbText, thing: kind.noun });

  // Which one it is. A new one is named by the call; an existing one by the
  // user's own list (the call only carries an id). A watch rule's id says
  // nothing readable, so removing or toggling one names nothing.
  let target = '';
  let detail = '';
  if (verb === 'Create') {
    if (name === TOOL_NAMES.MANAGE_FILE_WATCH) {
      target = oneLine(input.path, MAX_NAME_CHARS);
      detail = oneLine(input.pattern, MAX_NAME_CHARS);
    } else {
      target = oneLine(input.name, MAX_NAME_CHARS);
      if (name === TOOL_NAMES.MANAGE_SCHEDULED_TASK) {
        detail = describeSchedule(input);
      } else if (input.source_type === 'file') {
        const path = oneLine(input.source_path, MAX_DETAIL_CHARS);
        if (path) detail = format(t.selfExtensionWatching, { path });
      }
    }
  } else if (verb !== 'Other' && name !== TOOL_NAMES.MANAGE_FILE_WATCH) {
    target = oneLine(facts.automationTargetName, MAX_NAME_CHARS);
    // The id matched nothing the caller could read; the new name is still better than none.
    if (!target && verb === 'Update') target = oneLine(input.name, MAX_NAME_CHARS);
  }

  // An action nobody described is still gated. It is worded generically and
  // says which action it was, so the user is not asked to approve a blank.
  if (verb === 'Other') detail = oneLine(action, MAX_NAME_CHARS);

  let summary = withDetail(named(what, target), detail);
  // What the new or changed task will actually do each time it runs, which is
  // what the user is really approving.
  const prompt = (verb === 'Create' || verb === 'Update') && name !== TOOL_NAMES.MANAGE_FILE_WATCH
    ? oneLine(input.prompt, MAX_PROMPT_CHARS)
    : '';
  if (prompt) summary = format(t.selfExtensionRuns, { summary, prompt });
  return { summary, reason: kind.reason };
}

/**
 * Classify a tool call that would extend the agent's own capabilities.
 * Returns null when the call does not write durable capability state.
 */
export function classifySelfExtension(
  name: string,
  input: Record<string, unknown>,
  facts: SelfExtensionFacts = {},
): SelfExtensionAction | null {
  const t = getI18n().commandConfirm;

  if (name === TOOL_NAMES.SAVE_AGENT) {
    // The user approving this is the one check on the model's claim that they
    // asked to change an existing expert, so the summary says which it is.
    const what = facts.saveAgentReplaces === false ? t.selfExtensionSaveAgentNew : t.selfExtensionSaveAgentReplace;
    return { summary: named(what, oneLine(input.name, MAX_NAME_CHARS)), reason: t.selfExtensionReasonAgent };
  }

  if (name === TOOL_NAMES.SAVE_TEAM) {
    // Same durable foothold as an expert: the team is overwritten by name, and
    // `leaderNote` is free text handed to the leader on every later run of it.
    const what = facts.saveTeamReplaces === false ? t.selfExtensionSaveTeamNew : t.selfExtensionSaveTeamReplace;
    return { summary: named(what, oneLine(input.name, MAX_NAME_CHARS)), reason: t.selfExtensionReasonTeam };
  }

  if (name === TOOL_NAMES.UPDATE_SOUL) {
    return { summary: t.selfExtensionUpdateSoul, reason: t.selfExtensionReasonSoul };
  }

  if (name === TOOL_NAMES.MANAGE_MCP_SERVER) {
    const action = typeof input.action === 'string' ? input.action : '';
    if (!MCP_INSTALLING_ACTIONS.has(action)) return null;
    // Reconnecting a server the user already set up writes nothing new; asking
    // about it on every restart would only teach the user to click through.
    if (action === 'ensure' && facts.mcpServerConfigured === true) return null;
    // A registry install may be asked by search words instead of a name.
    const server = oneLine(input.name, MAX_NAME_CHARS) || oneLine(input.query, MAX_NAME_CHARS);
    const summary = action === 'add_custom'
      ? withDetail(named(t.selfExtensionMcpAddCustom, server), describeUrl(input.url))
      : named(t.selfExtensionMcpInstall, server);
    return { summary, reason: t.selfExtensionReasonMcp };
  }

  if (name === TOOL_NAMES.SKILL_MANAGE) {
    // Installing brings in instructions from outside (a web address, an npm
    // package, a folder) that steer every later task. The skill's own writes
    // (create, patch, ...) are not asked about here: a create the user asked
    // for is written directly (`skillManageTool.ts`), one the agent proposes
    // on its own (`agent_proposed`) goes to the draft queue, and both pass the
    // content guard.
    if (input.action !== 'install') return null;
    const rules = getI18n().permission.rules;
    const source = typeof input.source === 'string' ? input.source.trim() : '';
    const where = /^https?:\/\//i.test(source) ? describeUrl(source) : oneLine(source, MAX_DETAIL_CHARS);
    return {
      summary: withDetail(named(rules.skillInstall, oneLine(input.name, MAX_NAME_CHARS)), where),
      reason: rules.skillInstallReason,
    };
  }

  if (AUTOMATION_MANAGER_TOOLS.has(name)) {
    const action = typeof input.action === 'string' ? input.action : '';
    // Listing is observational. Everything else fails closed so a newly added
    // mutation cannot silently escape the durable-state gate.
    if (action === 'list') return null;
    return describeAutomation(name, input, facts);
  }

  return null;
}
