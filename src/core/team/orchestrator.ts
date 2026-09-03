import { useTeamStore, type Team, type TeamTask, type TeamPlanItem } from '@/stores/teamStore';
import { useChatStore } from '@/stores/chatStore';
import { resolveRoleId } from '@/core/team/roleIdentity';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import type { AgentLoopOptions } from '@/core/agent/agentLoop';
import type { SubagentDefinition } from '@/types';
import type { PermissionMode } from '@/core/permissions/permissionMode';
import { mkdir } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath } from '@/utils/pathUtils';
import { getI18n, format } from '@/i18n';
import { notifyTeamTaskPendingReview, notifyTeamTaskBlocked } from '@/utils/notifications';

/**
 * Team orchestrator (R2 — PRD docs/abu-team-prd-v2.md §4.4–4.6).
 *
 * Deliberately thin: every run is an ordinary conversation driven through the
 * EXISTING main loop + @member delegation route, so execution records land in
 * the normal conversation ledger — no parallel transcript store (rework brief
 * §1 持久化决策). This module only sequences runs and moves task state.
 *
 * State discipline:
 * - Proposing a plan never starts work (指派 ≠ 启动).
 * - Only user confirmation starts execution; only the user reaches 完成.
 * - Item completion is silent; the task surfaces once as pending_review.
 */

/**
 * Everything an UNATTENDED run (自动化 dispatch) needs so it can never stall on
 * an approval dialog nobody is there to see. The interactive fallbacks used by
 * a normal chat — requestCommandConfirmation / requestFilePermission — have no
 * timeout and only render for the ACTIVE conversation, while every team run
 * lives in a background conversation; without this envelope an unattended team
 * task hangs forever and the schedule's fail-loud auto-pause never trips.
 * Mirrors what the scheduler already installs for an ordinary scheduled run.
 *
 * Ephemeral and keyed by team task id — it carries live callbacks and an
 * authorization scope, so it must never be persisted.
 */
export interface UnattendedRun {
  permissionMode?: PermissionMode;
  /** Spread into every runAgentLoopDispatched this task performs. */
  dispatch: AgentLoopOptions;
  /** Grant the task folder write rights once it exists (members write there). */
  authorizeFolder: (folder: string) => void;
  /** Actions the envelope auto-denied, for an honest failure reason. */
  getDenials: () => string[];
}

const unattendedRuns = new Map<string, UnattendedRun>();

/** Every team run goes through here so the unattended envelope, when present,
 *  is applied uniformly — planning, member, adjustment and rework alike. */
function dispatchRun(taskId: string, conversationId: string, prompt: string, extra?: AgentLoopOptions) {
  const envelope = unattendedRuns.get(taskId);
  return runAgentLoopDispatched(conversationId, prompt, { ...(envelope?.dispatch ?? {}), ...extra });
}

/** In-flight guard so double-clicks can't double-run a task. */
const inFlight = new Set<string>();

/** Live abort controllers per task — planning, member and rework runs all
 *  register here so 停止 reaches every conversation the task owns. */
const liveRuns = new Map<string, Set<AbortController>>();
const stopRequested = new Set<string>();

function trackRun(taskId: string): { controller: { signal?: AbortSignal }; register: (c: AbortController) => void; done: () => void } {
  const registered = new Set<AbortController>();
  const register = (c: AbortController) => {
    registered.add(c);
    let set = liveRuns.get(taskId);
    if (!set) { set = new Set(); liveRuns.set(taskId, set); }
    set.add(c);
    if (stopRequested.has(taskId)) c.abort(new Error('stopped by user'));
  };
  const done = () => {
    const set = liveRuns.get(taskId);
    for (const c of registered) set?.delete(c);
    if (set && set.size === 0) liveRuns.delete(taskId);
  };
  return { controller: {}, register, done };
}

/**
 * 停止 — the user's brake. Aborts every live run the task owns; each run's
 * settle path then records 'stopped' (user agency), never 'failed'.
 */
export function stopTask(taskId: string): void {
  stopRequested.add(taskId);
  const set = liveRuns.get(taskId);
  if (set) for (const c of set) c.abort(new Error('stopped by user'));
  const t = getI18n();
  const task = useTeamStore.getState().tasks.find((item) => item.id === taskId);
  if (!task) return;
  if (task.status === 'awaiting_plan' || task.status === 'running') {
    useTeamStore.getState().updateTaskStatus(taskId, 'blocked', t.team.stoppedByUser);
    if (task.plan) {
      for (const item of task.plan.items) {
        // Everything unfinished in a task that had actually started counts as
        // stopped, so each one keeps a 重试 affordance. Items of a plan still
        // waiting on the confirm screen never ran — they stay pending.
        const unstartedButLive = task.status === 'running' && item.state === 'pending';
        if (item.state === 'running' || unstartedButLive) {
          useTeamStore.getState().setItemState(taskId, item.id, 'stopped');
        }
      }
    }
  }
}

/**
 * A fresh, user-initiated run cycle. The stop latch is per-cycle: without this
 * a stop whose settle path never ran (e.g. 停止 during planning, where
 * stopTask already moved the task to 'blocked' so the consume branch is
 * skipped) would survive and make `trackRun` abort the NEXT cycle's runs on
 * sight — 重新拆解 would fail without ever running anything. Every entry point
 * clears it after its own status guards have passed.
 */
function clearStop(taskId: string): void {
  stopRequested.delete(taskId);
}

function consumeStop(taskId: string): boolean {
  const hit = stopRequested.has(taskId);
  stopRequested.delete(taskId);
  return hit;
}

function resolveMember(roleId: string): SubagentDefinition | null {
  return resolveRoleId(roleId);
}

function memberLine(agent: SubagentDefinition): string {
  return `- ${agent.name}：${agent.description || '—'}`;
}

/** Leader planning brief. LLM-facing scaffold is English (AGENTS.md §1);
 *  the user's goal and leader note travel verbatim. */
function buildPlanningPrompt(team: Team, task: TeamTask, leader: SubagentDefinition, members: SubagentDefinition[]): string {
  const roster = members.map(memberLine).join('\n');
  const attachments = task.attachments.length > 0
    ? `\nReference files:\n${task.attachments.map((p) => `- ${p}`).join('\n')}`
    : '';
  const note = team.leaderNote ? `\nTeam briefing from the user:\n${team.leaderNote}` : '';
  return `@${leader.name} You are the leader of team "${team.name}". Plan the split for the team task below — do NOT do the work yourself yet.

The user's ask (verbatim — this is the contract, never reinterpret it):
"""
${task.goal}
"""
${attachments}
Your team roster (assign work only to these members, by exact name):
${roster}
${note}

Break the ask into 1-8 clear per-member assignments. Prefer parallel items; use depends_on only for real ordering needs. Draft done_when as how the USER will check the task is done. Then call the team_propose_plan tool exactly once and stop. The system dispatches the members from your split (immediately by default; strict teams wait for the user's confirmation first) — never start the work yourself, and never ask the user to confirm in chat.`;
}

/** Sub-task prompt for one member. English scaffold; user goal verbatim. */
function buildItemPrompt(task: TeamTask, item: TeamPlanItem, member: SubagentDefinition, folder: string, upstream: TeamPlanItem[]): string {
  const attachments = task.attachments.length > 0
    ? `\nReference files from the user:\n${task.attachments.map((p) => `- ${p}`).join('\n')}`
    : '';
  const upstreamNote = upstream.length > 0
    ? `\nAlready completed by teammates (their outputs are in the task folder):\n${upstream.map((u) => `- ${u.what}${u.produces ? ` → ${u.produces}` : ''}`).join('\n')}`
    : '';
  const produces = item.produces ? `\nExpected output: ${item.produces}` : '';
  return `@${member.name} ${item.what}

The user's original ask (verbatim, for context — your job is only the assignment above):
"""
${task.goal}
"""
${attachments}${upstreamNote}
Write any output files into the task folder: ${folder}${produces}`;
}

/**
 * Kick off leader planning for a task sitting in awaiting_plan without a plan.
 * Creates a background conversation and drives the leader via @delegation; the
 * leader reports its split through the team_propose_plan tool (teamTools.ts).
 */
export async function startPlanning(taskId: string): Promise<void> {
  const store = useTeamStore.getState();
  const task = store.tasks.find((item) => item.id === taskId);
  if (!task || task.status !== 'awaiting_plan') return;
  if (inFlight.has(taskId)) return;

  const team = store.teams.find((item) => item.id === task.teamId);
  if (!team) {
    useTeamStore.getState().updateTaskStatus(taskId, 'blocked', getI18n().team.blockedTeamMissing);
    return;
  }
  const leader = resolveMember(team.leaderRoleId);
  if (!leader) {
    useTeamStore.getState().updateTaskStatus(taskId, 'blocked', getI18n().team.blockedLeaderMissing);
    return;
  }
  const members = team.memberRoleIds
    .map((roleId) => resolveMember(roleId))
    .filter((agent): agent is SubagentDefinition => agent !== null);

  clearStop(taskId);
  inFlight.add(taskId);
  try {
    const chatStore = useChatStore.getState();
    const conversationId = chatStore.createConversation(null, { skipActivate: true, teamTaskId: taskId });
    // Unattended dispatch pins its own autonomy tier — see TeamTask.permissionMode.
    if (task.permissionMode) chatStore.setConversationPermissionMode(conversationId, task.permissionMode);
    chatStore.renameConversation(conversationId, format(getI18n().team.planningConversationTitle, { goal: task.goal.split('\n')[0].slice(0, 24) }));
    useTeamStore.getState().setPlanningConversation(taskId, conversationId);

    const tracker = trackRun(taskId);
    let result;
    try {
      result = await dispatchRun(taskId, conversationId, buildPlanningPrompt(team, task, leader, members), {
        onAbortControllerReady: tracker.register,
      });
    } finally {
      tracker.done();
    }
    const after = useTeamStore.getState().tasks.find((item) => item.id === taskId);
    if (after?.status === 'awaiting_plan' && !after.plan) {
      // Leader finished without calling the plan tool — visible, not silent.
      // A user stop is agency, not failure — worded as such.
      useTeamStore.getState().updateTaskStatus(
        taskId,
        'blocked',
        consumeStop(taskId) || result.reason === 'aborted'
          ? getI18n().team.stoppedByUser
          : result.reason === 'completed' ? getI18n().team.blockedNoPlan : format(getI18n().team.blockedPlanFailed, { reason: result.reason }),
      );
    }
  } finally {
    inFlight.delete(taskId);
  }
  // Default mode: the plan is visible-not-blocking — execution starts as soon
  // as the leader has a split. The human gates are risky-op approvals, stuck
  // states, and final review (user decision 2026-08-31; strict per-team
  // requirePlanApproval keeps the old confirm screen).
  const settled = useTeamStore.getState().tasks.find((item) => item.id === taskId);
  if (settled?.status === 'awaiting_plan' && settled.plan && !team.requirePlanApproval) {
    await confirmAndExecute(taskId);
  }
}

/**
 * Single-member task: no leader, no planning step — the user's goal IS the
 * assignment. Materializes a one-item plan (so detail/review UIs are shared)
 * and executes immediately.
 */
export async function startMemberTask(taskId: string): Promise<void> {
  const store = useTeamStore.getState();
  const task = store.tasks.find((item) => item.id === taskId);
  if (!task?.memberRoleId || task.status !== 'awaiting_plan' || task.plan) return;
  const member = resolveMember(task.memberRoleId);
  if (!member) {
    useTeamStore.getState().updateTaskStatus(taskId, 'blocked', getI18n().team.itemMemberMissing);
    return;
  }
  clearStop(taskId);
  useTeamStore.getState().proposePlan(taskId, {
    items: [{ id: '1', memberRoleId: task.memberRoleId, what: task.goal, dependsOn: [], state: 'pending' }],
    doneWhen: [],
  });
  await confirmAndExecute(taskId);
}

/**
 * Scheduled dispatch: hand `goal` to a team unattended (自动化 executor —
 * user decision 2026-09-01: no user-facing "pipeline" concept).
 *
 * If this team has already run the SAME goal to acceptance, the accepted
 * split is reused verbatim and leader planning is skipped (faster, cheaper,
 * no drift). Any other goal goes through normal leader planning; non-strict
 * teams then execute immediately, strict teams wait on the confirm screen.
 */
export async function runScheduledTeamTask(teamId: string, goal: string, unattended?: UnattendedRun): Promise<{ ok: boolean; taskId?: string; reason?: string }> {
  const store = useTeamStore.getState();
  const t = getI18n();
  const team = store.teams.find((item) => item.id === teamId && !item.archivedAt);
  if (!team) return { ok: false, reason: t.team.blockedTeamMissing };
  const cleanGoal = goal.trim();
  if (!cleanGoal) return { ok: false, reason: 'empty goal' };

  // Latest accepted run of the same goal → frozen-split reuse.
  const donePrior = store.tasks.find((item) =>
    item.teamId === teamId && item.status === 'done' && item.plan && item.goal.trim() === cleanGoal);

  const task = useTeamStore.getState().createTask({ teamId, goal: cleanGoal, permissionMode: unattended?.permissionMode });
  if (unattended) unattendedRuns.set(task.id, unattended);
  if (donePrior?.plan) {
    useTeamStore.getState().proposePlan(task.id, {
      items: donePrior.plan.items.map((item) => ({
        id: item.id, memberRoleId: item.memberRoleId, what: item.what,
        produces: item.produces, dependsOn: [...item.dependsOn], state: 'pending',
      })),
      doneWhen: [...donePrior.plan.doneWhen],
    });
    await confirmAndExecute(task.id);
  } else {
    await startPlanning(task.id);
  }

  unattendedRuns.delete(task.id);
  const after = useTeamStore.getState().tasks.find((item) => item.id === task.id);
  // Blocked (or planning that produced nothing) is the failure shape; a
  // strict team parked on its confirm screen still counts as a successful
  // dispatch — the task is waiting on the user, not broken.
  const ok = after !== undefined && after.status !== 'blocked';
  // Auto-denied escalations are the usual reason an unattended run fails —
  // name them so the schedule's 2-strike pause carries a real explanation.
  const denials = unattended?.getDenials() ?? [];
  const reason = ok ? undefined : [after?.statusNote, ...denials].filter(Boolean).join(' · ');
  return { ok, taskId: task.id, reason };
}

/** Route a freshly created task to its execution path. */
export function kickoffTask(taskId: string): void {
  const task = useTeamStore.getState().tasks.find((item) => item.id === taskId);
  if (!task) return;
  if (task.memberRoleId) void startMemberTask(taskId);
  else void startPlanning(taskId);
}

/** Leader planning retry with the user's adjustment note appended. */
export async function requestPlanAdjustment(taskId: string, feedback: string): Promise<void> {
  const store = useTeamStore.getState();
  const task = store.tasks.find((item) => item.id === taskId);
  if (!task?.planningConversationId || task.status !== 'awaiting_plan') return;
  if (inFlight.has(taskId)) return;
  // Clear the previous proposal so the tool can accept a fresh one.
  useTeamStore.setState((s) => ({
    tasks: s.tasks.map((item) => (item.id === taskId ? { ...item, plan: undefined } : item)),
  }));
  clearStop(taskId);
  inFlight.add(taskId);
  const tracker = trackRun(taskId);
  try {
    const result = await dispatchRun(
      taskId,
      task.planningConversationId,
      `The user wants the split adjusted. Their feedback (verbatim):\n"""\n${feedback}\n"""\nRevise the plan accordingly and call team_propose_plan again, then stop.`,
      { onAbortControllerReady: tracker.register },
    );
    const stopHit = consumeStop(taskId);
    const after = useTeamStore.getState().tasks.find((item) => item.id === taskId);
    if (after?.status === 'awaiting_plan' && !after.plan) {
      useTeamStore.getState().updateTaskStatus(
        taskId,
        'blocked',
        stopHit || result.reason === 'aborted' ? getI18n().team.stoppedByUser : getI18n().team.blockedNoPlan,
      );
    }
  } finally {
    tracker.done();
    inFlight.delete(taskId);
  }
}

function slugify(goal: string): string {
  return goal.split('\n')[0].replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 24) || 'task';
}

/**
 * User confirmed the split — create the task folder and execute the plan in
 * dependency waves. Items in the same wave run in parallel; each item is its
 * own background conversation delegated to the member agent.
 */
export async function confirmAndExecute(taskId: string): Promise<void> {
  const store = useTeamStore.getState();
  const task = store.tasks.find((item) => item.id === taskId);
  if (!task?.plan || task.status !== 'awaiting_plan') return;
  if (inFlight.has(taskId)) return;
  if (task.teamId && !store.teams.some((item) => item.id === task.teamId)) return;

  clearStop(taskId);
  inFlight.add(taskId);
  try {
    const home = await homeDir();
    const folder = joinPath(home, 'Documents', 'abu-team', `${slugify(task.goal)}-${task.id.slice(-6)}`);
    await mkdir(folder, { recursive: true });
    // Unattended runs auto-deny file escalations, so the task folder members
    // write into has to be authorized explicitly or every output is refused.
    unattendedRuns.get(taskId)?.authorizeFolder(folder);
    useTeamStore.getState().confirmPlan(taskId, folder);

    const readItems = () => useTeamStore.getState().tasks.find((item) => item.id === taskId)?.plan?.items ?? [];

    // Wave scheduling: run everything whose deps are done; repeat until settled.
    for (;;) {
      if (stopRequested.has(taskId)) break;
      const items = readItems();
      if (items.every((item) => item.state === 'done' || item.state === 'failed' || item.state === 'stopped')) break;
      const ready = items.filter((item) =>
        item.state === 'pending' && item.dependsOn.every((dep) => items.find((x) => x.id === dep)?.state === 'done'));
      if (ready.length === 0) {
        // Remaining items are blocked behind failures — stop, surface it.
        break;
      }
      await Promise.all(ready.map((item) => runItem(taskId, item, folder)));
    }

    const finalItems = readItems();
    const failed = finalItems.filter((item) => item.state === 'failed');
    const stopped = consumeStop(taskId) || finalItems.some((item) => item.state === 'stopped');
    if (stopped) {
      useTeamStore.getState().updateTaskStatus(taskId, 'blocked', getI18n().team.stoppedByUser);
    } else if (failed.length > 0) {
      useTeamStore.getState().updateTaskStatus(
        taskId, 'blocked',
        format(getI18n().team.blockedItemsFailed, { count: String(failed.length) }));
    } else {
      // Whole-task barrier: members finishing was silent; this is the single
      // moment the user hears about it. 完成 stays user-only.
      useTeamStore.getState().updateTaskStatus(taskId, 'pending_review');
    }
    if (!stopped) notifyTaskSettled(taskId);
  } finally {
    inFlight.delete(taskId);
  }
}

async function runItem(taskId: string, item: TeamPlanItem, folder: string): Promise<void> {
  const t = getI18n();
  const member = resolveMember(item.memberRoleId);
  if (!member) {
    useTeamStore.getState().setItemState(taskId, item.id, 'failed', { error: t.team.itemMemberMissing });
    return;
  }
  const chatStore = useChatStore.getState();
  const conversationId = chatStore.createConversation(folder, { skipActivate: true, teamTaskId: taskId });
  chatStore.renameConversation(conversationId, format(t.team.itemConversationTitle, { member: member.name, what: item.what.slice(0, 20) }));
  useTeamStore.getState().setItemState(taskId, item.id, 'running', { conversationId });

  const task = useTeamStore.getState().tasks.find((x) => x.id === taskId);
  if (!task) return;
  // Unattended dispatch pins its own autonomy tier — see TeamTask.permissionMode.
  if (task.permissionMode) chatStore.setConversationPermissionMode(conversationId, task.permissionMode);
  const upstream = (task.plan?.items ?? []).filter((candidate) => item.dependsOn.includes(candidate.id));

  const tracker = trackRun(taskId);
  try {
    const result = await dispatchRun(taskId, conversationId, buildItemPrompt(task, item, member, folder, upstream), {
      onAbortControllerReady: tracker.register,
    });
    if (result.reason === 'completed' || result.reason === 'max_turns') {
      useTeamStore.getState().setItemState(taskId, item.id, 'done');
    } else if (result.reason === 'aborted' || stopRequested.has(taskId)) {
      useTeamStore.getState().setItemState(taskId, item.id, 'stopped');
    } else {
      useTeamStore.getState().setItemState(taskId, item.id, 'failed', { error: result.error ?? result.reason });
    }
  } catch (err) {
    useTeamStore.getState().setItemState(taskId, item.id, 'failed', { error: String(err) });
  } finally {
    tracker.done();
  }
}

/** An item may only run once every item it depends on has finished. */
export function dependenciesSatisfied(item: TeamPlanItem, items: TeamPlanItem[]): boolean {
  return item.dependsOn.every((dep) => items.find((candidate) => candidate.id === dep)?.state === 'done');
}

/**
 * Re-settle a task from its items after a PARTIAL run (retry / rework).
 *
 * A task with nothing running must never keep the 'running' status: the detail
 * view would spin forever, and — worse — the per-item 重试 buttons are gated on
 * 'blocked', so the remaining items would lose their only affordance and the
 * user would have to press 停止 on an idle task to get them back.
 */
function settleFromItems(taskId: string): void {
  const t = getI18n();
  const stopHit = consumeStop(taskId);
  const items = useTeamStore.getState().tasks.find((x) => x.id === taskId)?.plan?.items ?? [];
  const failed = items.filter((item) => item.state === 'failed');
  const unfinished = items.filter((item) => item.state === 'pending' || item.state === 'stopped');
  if (stopHit) {
    useTeamStore.getState().updateTaskStatus(taskId, 'blocked', t.team.stoppedByUser);
  } else if (failed.length > 0) {
    useTeamStore.getState().updateTaskStatus(taskId, 'blocked', format(t.team.blockedItemsFailed, { count: String(failed.length) }));
  } else if (unfinished.length > 0) {
    useTeamStore.getState().updateTaskStatus(taskId, 'blocked', format(t.team.blockedItemsRemaining, { count: String(unfinished.length) }));
  } else {
    useTeamStore.getState().updateTaskStatus(taskId, 'pending_review');
  }
}

/** Retry one failed item, then re-settle the whole task. */
export async function retryItem(taskId: string, itemId: string): Promise<void> {
  const store = useTeamStore.getState();
  const task = store.tasks.find((item) => item.id === taskId);
  if (!task?.plan || !task.folder || task.status !== 'blocked') return;
  if (task.teamId && !store.teams.some((item) => item.id === task.teamId)) return;
  const target = task.plan.items.find((item) => item.id === itemId);
  if (!target || (target.state !== 'failed' && target.state !== 'stopped')) return;
  // The wave scheduler only ever starts an item whose dependencies are done,
  // and a manual retry must honour the same invariant: since a stopped task
  // now marks never-started items 'stopped' too, a downstream item can be
  // retryable while its upstream produced nothing — running it would hand the
  // member an "already completed by teammates" note for work that never ran.
  if (!dependenciesSatisfied(target, task.plan.items)) return;
  if (inFlight.has(taskId)) return;
  clearStop(taskId);
  inFlight.add(taskId);
  try {
    useTeamStore.getState().updateTaskStatus(taskId, 'running');
    useTeamStore.getState().setItemState(taskId, itemId, 'pending', { error: undefined });
    await runItem(taskId, { ...target, state: 'pending' }, task.folder);
    settleFromItems(taskId);
    notifyTaskSettled(taskId);
  } finally {
    inFlight.delete(taskId);
  }
}

/** Review actions — 完成 is user-only; rejection re-opens execution. */
export function acceptTask(taskId: string): void {
  const task = useTeamStore.getState().tasks.find((item) => item.id === taskId);
  if (task?.status !== 'pending_review') return;
  useTeamStore.getState().updateTaskStatus(taskId, 'done');
}

export async function rejectTask(taskId: string, feedback: string, targetItemId?: string): Promise<void> {
  const store = useTeamStore.getState();
  const task = store.tasks.find((item) => item.id === taskId);
  if (!task?.plan || task.status !== 'pending_review' || !task.folder) return;
  if (task.teamId && !store.teams.some((item) => item.id === task.teamId)) return;
  // Re-open the targeted item (or the last one) with the user's note verbatim.
  const target = targetItemId
    ? task.plan.items.find((item) => item.id === targetItemId)
    : task.plan.items[task.plan.items.length - 1];
  if (!target) return;
  // rejectTask used to be the one run entry point without this latch, so a
  // 重试 clicked during a rework's unwind could run concurrently and clear the
  // stop flag out from under the rework's own settle path.
  if (inFlight.has(taskId)) return;
  clearStop(taskId);
  inFlight.add(taskId);
  useTeamStore.getState().updateTaskStatus(taskId, 'running');
  useTeamStore.getState().setItemState(taskId, target.id, 'running');
  const member = resolveMember(target.memberRoleId);
  const t = getI18n();
  if (!member || !target.conversationId) {
    useTeamStore.getState().setItemState(taskId, target.id, 'failed', { error: t.team.itemMemberMissing });
    useTeamStore.getState().updateTaskStatus(taskId, 'blocked', t.team.itemMemberMissing);
    inFlight.delete(taskId);
    return;
  }
  const tracker = trackRun(taskId);
  try {
    const result = await dispatchRun(
      taskId,
      target.conversationId,
      `The user reviewed the team task and sent this back for rework. Their feedback (verbatim):\n"""\n${feedback}\n"""\nRevise your output in the task folder accordingly.`,
      { onAbortControllerReady: tracker.register },
    );
    // 停止 must reach a rework run too, and a stopped rework must not settle
    // the task back into 待你确认 as if it had finished.
    if (result.reason === 'aborted' || stopRequested.has(taskId)) {
      useTeamStore.getState().setItemState(taskId, target.id, 'stopped');
    } else {
      const ok = result.reason === 'completed' || result.reason === 'max_turns';
      useTeamStore.getState().setItemState(
        taskId, target.id,
        ok ? 'done' : 'failed',
        ok ? undefined : { error: result.error ?? result.reason },
      );
    }
    settleFromItems(taskId);
    notifyTaskSettled(taskId);
  } catch (err) {
    useTeamStore.getState().setItemState(taskId, target.id, 'failed', { error: String(err) });
    useTeamStore.getState().updateTaskStatus(taskId, 'blocked', String(err));
  } finally {
    tracker.done();
    inFlight.delete(taskId);
  }
}

/** Notice when a task reaches a state that needs the user (never silent). */
function notifyTaskSettled(taskId: string): void {
  const t = getI18n();
  const task = useTeamStore.getState().tasks.find((item) => item.id === taskId);
  if (!task) return;
  const team = useTeamStore.getState().teams.find((item) => item.id === task.teamId);
  if (task.status === 'pending_review') {
    void notifyTeamTaskPendingReview(format(t.team.noticePendingReview, { team: team?.name ?? '', goal: task.goal.split('\n')[0].slice(0, 30) }), taskId);
  } else if (task.status === 'blocked') {
    void notifyTeamTaskBlocked(format(t.team.noticeBlocked, { team: team?.name ?? '', reason: task.statusNote ?? '' }), taskId);
  }
}
