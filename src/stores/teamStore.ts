import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Team domain store (R1: management surface only — PRD docs/abu-team-prd-v2.md).
 *
 * Vocabulary is pinned by PRD §2: 队员 (member) / 团队 (team) / 任务 (team task).
 * Members are NOT stored here — a 队员 IS a custom agent in the existing
 * AgentRegistry (single identity source, AGENT.md on disk). Teams reference
 * members by their stable roleId (written into AGENT.md frontmatter on first
 * team membership, salvaged from the v1 spike).
 *
 * Persistence: zustand/persist, same pattern as scheduleStore/triggerStore.
 * Execution state (plans, sub-tasks, runs) intentionally does NOT live here —
 * R2 builds it on conversations + the message ledger, not a parallel DB.
 */

export interface Team {
  id: string;
  name: string;
  /** Stable roleId of the leader (must also appear in memberRoleIds). */
  leaderRoleId: string;
  /** Stable roleIds of all members, leader included. */
  memberRoleIds: string[];
  /** Optional leader briefing — injected into the leader's instructions when
   *  it picks up a task for this team (copy explains this in the UI). */
  leaderNote?: string;
  /** Opt-in strict mode: the leader's split waits for the user before running.
   *  Default (false) = plan is visible-not-blocking and execution auto-starts —
   *  the human gates are risky-op approvals, stuck states, and review. */
  requirePlanApproval?: boolean;
  createdAt: number;
  archivedAt?: number;
}

export type TeamTaskStatus =
  | 'awaiting_plan'   // 待确认分工 — created, leader has not produced / user has not confirmed a plan
  | 'running'         // 执行中
  | 'pending_review'  // 待你确认
  | 'blocked'         // 卡住了
  | 'done';           // 完成 — only the user can move a task here

// 'stopped' is user agency, 'failed' is the member's — never conflated (PRD §10).
export type TeamPlanItemState = 'pending' | 'running' | 'done' | 'failed' | 'stopped';

/** One member's share of a confirmed plan. */
export interface TeamPlanItem {
  id: string;
  memberRoleId: string;
  /** What this member should do, in the leader's words. */
  what: string;
  /** Expected output (e.g. a filename in the task folder). Advisory. */
  produces?: string;
  /** Item ids that must be done before this one starts. */
  dependsOn: string[];
  state: TeamPlanItemState;
  /** Sub-conversation carrying this item's full run (execution ledger). */
  conversationId?: string;
  /** Bounded failure summary for the task detail row. */
  error?: string;
}

export interface TeamPlan {
  items: TeamPlanItem[];
  /** Leader-drafted "怎么算做完" — shown with the plan, user may edit or ignore. */
  doneWhen: string[];
  proposedAt: number;
  confirmedAt?: number;
}

export interface TeamTask {
  id: string;
  /** Exactly one of teamId / memberRoleId is set: a task is handed to a team
   *  (leader plans the split) or directly to one member (no planning step). */
  teamId?: string;
  memberRoleId?: string;
  /** The user's ask, verbatim (never paraphrased — PRD §4.3). */
  goal: string;
  /** Absolute paths of attached reference files (optional). */
  attachments: string[];
  status: TeamTaskStatus;
  /** Leader's proposed (then confirmed) split. Absent until the leader plans. */
  plan?: TeamPlan;
  /** Conversation where the leader planned (and later summarizes). */
  planningConversationId?: string;
  /** Task folder where member outputs land. */
  folder?: string;
  /** One-line blocked/failure reason surfaced in lists (plain language). */
  statusNote?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A pipeline is a confirmed split, frozen for reuse: running it seeds the plan
 * from the template and skips leader planning entirely (that is the value —
 * no planning cost, no drift). Saved from an accepted task (PRD 流水线).
 */
export interface TeamPipeline {
  id: string;
  teamId: string;
  name: string;
  /** Default goal text for runs (editable per run later; v1 uses it verbatim). */
  goal: string;
  /** Frozen plan template — items without runtime state. */
  template: Array<Pick<TeamPlanItem, 'id' | 'memberRoleId' | 'what' | 'produces' | 'dependsOn'>>;
  doneWhen: string[];
  createdFromTaskId: string;
  createdAt: number;
  /** Set when 2 consecutive runs failed — unattended loops must fail loud,
   *  not quietly burn money (PRD §7). Cleared by 恢复. */
  pausedAt?: number;
  consecutiveFailures: number;
  lastRunTaskId?: string;
  lastRunAt?: number;
}

interface TeamState {
  teams: Team[];
  tasks: TeamTask[];
  pipelines: TeamPipeline[];

  createTeam: (input: { name: string; leaderRoleId: string; memberRoleIds: string[]; leaderNote?: string; requirePlanApproval?: boolean }) => Team;
  updateTeam: (id: string, patch: Partial<Pick<Team, 'name' | 'leaderRoleId' | 'memberRoleIds' | 'leaderNote' | 'requirePlanApproval'>>) => void;
  archiveTeam: (id: string) => void;
  restoreTeam: (id: string) => void;

  createTask: (input: { teamId?: string; memberRoleId?: string; goal: string; attachments?: string[] }) => TeamTask;
  updateTaskStatus: (id: string, status: TeamTaskStatus, statusNote?: string) => void;

  // --- pipelines ---
  savePipeline: (input: { taskId: string; name: string }) => TeamPipeline;
  deletePipeline: (id: string) => void;
  pausePipeline: (id: string) => void;
  resumePipeline: (id: string) => void;
  recordPipelineRun: (id: string, taskId: string) => void;
  /** Returns the new consecutiveFailures count (auto-pauses at 2). */
  recordPipelineOutcome: (id: string, ok: boolean) => number;

  // --- planning / execution (R2) — called by the team orchestrator only ---
  setPlanningConversation: (taskId: string, conversationId: string) => void;
  /** Leader's proposal via the team_propose_plan tool. Proposing never starts
   *  anything by itself: the orchestrator auto-starts right after (default) or
   *  waits for the user (strict requirePlanApproval teams). */
  proposePlan: (taskId: string, plan: Omit<TeamPlan, 'proposedAt' | 'confirmedAt'>) => void;
  confirmPlan: (taskId: string, folder: string) => void;
  setItemState: (taskId: string, itemId: string, state: TeamPlanItemState, patch?: { conversationId?: string; error?: string }) => void;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useTeamStore = create<TeamState>()(
  persist(
    (set, get) => ({
      teams: [],
      tasks: [],
      pipelines: [],

      createTeam: (input) => {
        const name = input.name.trim();
        if (!name) throw new Error('team name required');
        if (get().teams.some((t) => !t.archivedAt && t.name === name)) {
          throw new Error('duplicate team name');
        }
        if (!input.leaderRoleId) throw new Error('leader required');
        const memberRoleIds = Array.from(new Set([input.leaderRoleId, ...input.memberRoleIds]));
        const team: Team = {
          id: genId('team'),
          name,
          leaderRoleId: input.leaderRoleId,
          memberRoleIds,
          leaderNote: input.leaderNote?.trim() || undefined,
          requirePlanApproval: input.requirePlanApproval || undefined,
          createdAt: Date.now(),
        };
        // Newest first — freshly created things surface at the top (user feedback).
        set((s) => ({ teams: [team, ...s.teams] }));
        return team;
      },

      updateTeam: (id, patch) =>
        set((s) => ({
          teams: s.teams.map((t) => {
            if (t.id !== id) return t;
            const next = { ...t, ...patch };
            // The leader is always a member.
            next.memberRoleIds = Array.from(new Set([next.leaderRoleId, ...next.memberRoleIds]));
            return next;
          }),
        })),

      archiveTeam: (id) =>
        set((s) => ({
          teams: s.teams.map((t) => (t.id === id ? { ...t, archivedAt: Date.now() } : t)),
        })),

      restoreTeam: (id) =>
        set((s) => ({
          teams: s.teams.map((t) => (t.id === id ? { ...t, archivedAt: undefined } : t)),
        })),

      createTask: (input) => {
        const goal = input.goal.trim();
        if (!goal) throw new Error('task goal required');
        if (!!input.teamId === !!input.memberRoleId) throw new Error('assign to exactly one team or member');
        if (input.teamId) {
          const team = get().teams.find((t) => t.id === input.teamId && !t.archivedAt);
          if (!team) throw new Error('team not found');
        }
        const now = Date.now();
        const task: TeamTask = {
          id: genId('ttask'),
          teamId: input.teamId,
          memberRoleId: input.memberRoleId,
          goal,
          attachments: input.attachments ?? [],
          status: 'awaiting_plan',
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({ tasks: [task, ...s.tasks] }));
        return task;
      },

      updateTaskStatus: (id, status, statusNote) =>
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, status, statusNote, updatedAt: Date.now() } : t)),
        })),

      savePipeline: (input) => {
        const task = get().tasks.find((t) => t.id === input.taskId);
        if (!task?.plan || !task.teamId) throw new Error('only accepted team tasks can become pipelines');
        if (task.status !== 'done') throw new Error('accept the task before saving it as a pipeline');
        const name = input.name.trim();
        if (!name) throw new Error('pipeline name required');
        if (get().pipelines.some((p) => p.name === name)) throw new Error('duplicate pipeline name');
        const pipeline: TeamPipeline = {
          id: genId('pipe'),
          teamId: task.teamId,
          name,
          goal: task.goal,
          template: task.plan.items.map((item) => ({
            id: item.id, memberRoleId: item.memberRoleId, what: item.what,
            produces: item.produces, dependsOn: item.dependsOn,
          })),
          doneWhen: task.plan.doneWhen,
          createdFromTaskId: task.id,
          createdAt: Date.now(),
          consecutiveFailures: 0,
        };
        set((s) => ({ pipelines: [pipeline, ...s.pipelines] }));
        return pipeline;
      },

      deletePipeline: (id) => set((s) => ({ pipelines: s.pipelines.filter((p) => p.id !== id) })),
      pausePipeline: (id) => set((s) => ({
        pipelines: s.pipelines.map((p) => (p.id === id ? { ...p, pausedAt: Date.now() } : p)),
      })),
      resumePipeline: (id) => set((s) => ({
        pipelines: s.pipelines.map((p) => (p.id === id ? { ...p, pausedAt: undefined, consecutiveFailures: 0 } : p)),
      })),
      recordPipelineRun: (id, taskId) => set((s) => ({
        pipelines: s.pipelines.map((p) => (p.id === id ? { ...p, lastRunTaskId: taskId, lastRunAt: Date.now() } : p)),
      })),
      recordPipelineOutcome: (id, ok) => {
        let count = 0;
        set((s) => ({
          pipelines: s.pipelines.map((p) => {
            if (p.id !== id) return p;
            count = ok ? 0 : p.consecutiveFailures + 1;
            return { ...p, consecutiveFailures: count, pausedAt: !ok && count >= 2 ? Date.now() : p.pausedAt };
          }),
        }));
        return count;
      },

      setPlanningConversation: (taskId, conversationId) =>
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, planningConversationId: conversationId, updatedAt: Date.now() } : t)),
        })),

      proposePlan: (taskId, plan) => {
        const task = get().tasks.find((t) => t.id === taskId);
        if (!task) throw new Error('task not found');
        if (task.status !== 'awaiting_plan') throw new Error('task is not awaiting a plan');
        if (plan.items.length === 0) throw new Error('plan needs at least one item');
        const ids = new Set(plan.items.map((i) => i.id));
        for (const item of plan.items) {
          for (const dep of item.dependsOn) {
            if (!ids.has(dep)) throw new Error(`unknown dependency: ${dep}`);
            if (dep === item.id) throw new Error('an item cannot depend on itself');
          }
        }
        // Cycle check: repeatedly peel items whose deps are all peeled.
        const peeled = new Set<string>();
        let progressed = true;
        while (progressed) {
          progressed = false;
          for (const item of plan.items) {
            if (peeled.has(item.id)) continue;
            if (item.dependsOn.every((d) => peeled.has(d))) { peeled.add(item.id); progressed = true; }
          }
        }
        if (peeled.size !== plan.items.length) throw new Error('plan has a dependency cycle');
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === taskId
            ? { ...t, plan: { ...plan, proposedAt: Date.now() }, updatedAt: Date.now() }
            : t)),
        }));
      },

      confirmPlan: (taskId, folder) =>
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === taskId && t.plan
            ? { ...t, status: 'running', folder, statusNote: undefined, plan: { ...t.plan, confirmedAt: Date.now() }, updatedAt: Date.now() }
            : t)),
        })),

      setItemState: (taskId, itemId, state, patch) =>
        set((s) => ({
          tasks: s.tasks.map((t) => {
            if (t.id !== taskId || !t.plan) return t;
            return {
              ...t,
              updatedAt: Date.now(),
              plan: {
                ...t.plan,
                items: t.plan.items.map((item) => (item.id === itemId ? { ...item, state, ...patch } : item)),
              },
            };
          }),
        })),
    }),
    {
      name: 'abu-team',
      version: 3,
      // v1 → v2: additive optional fields (memberRoleId, requirePlanApproval).
      // v2 → v3: pipelines array added — older payloads just get [].
      migrate: (persisted: unknown) => {
        const state = persisted as { teams: Team[]; tasks: TeamTask[]; pipelines?: TeamPipeline[] };
        return { ...state, pipelines: state.pipelines ?? [] };
      },
      partialize: (s) => ({ teams: s.teams, tasks: s.tasks, pipelines: s.pipelines }),
    },
  ),
);

/**
 * Items that need the user's attention — drives the 收件箱 tab.
 * awaiting_plan only counts when the team runs in strict mode AND a proposal
 * is actually waiting; by default planning is visible-not-blocking.
 */
export function selectPendingTasks(tasks: TeamTask[], teams: Team[]): TeamTask[] {
  return tasks.filter((t) => {
    if (t.status === 'pending_review' || t.status === 'blocked') return true;
    if (t.status === 'awaiting_plan' && t.plan) {
      const team = teams.find((tm) => tm.id === t.teamId);
      return team?.requirePlanApproval === true;
    }
    return false;
  });
}
