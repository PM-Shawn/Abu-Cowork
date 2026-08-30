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
  createdAt: number;
  archivedAt?: number;
}

export type TeamTaskStatus =
  | 'awaiting_plan'   // 待确认分工 — created, leader has not produced / user has not confirmed a plan
  | 'running'         // 执行中
  | 'pending_review'  // 待你确认
  | 'blocked'         // 卡住了
  | 'done';           // 完成 — only the user can move a task here

export interface TeamTask {
  id: string;
  teamId: string;
  /** The user's ask, verbatim (never paraphrased — PRD §4.3). */
  goal: string;
  /** Absolute paths of attached reference files (optional). */
  attachments: string[];
  status: TeamTaskStatus;
  createdAt: number;
  updatedAt: number;
}

interface TeamState {
  teams: Team[];
  tasks: TeamTask[];

  createTeam: (input: { name: string; leaderRoleId: string; memberRoleIds: string[]; leaderNote?: string }) => Team;
  updateTeam: (id: string, patch: Partial<Pick<Team, 'name' | 'leaderRoleId' | 'memberRoleIds' | 'leaderNote'>>) => void;
  archiveTeam: (id: string) => void;
  restoreTeam: (id: string) => void;

  createTask: (input: { teamId: string; goal: string; attachments?: string[] }) => TeamTask;
  updateTaskStatus: (id: string, status: TeamTaskStatus) => void;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useTeamStore = create<TeamState>()(
  persist(
    (set, get) => ({
      teams: [],
      tasks: [],

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
          createdAt: Date.now(),
        };
        set((s) => ({ teams: [...s.teams, team] }));
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
        const team = get().teams.find((t) => t.id === input.teamId && !t.archivedAt);
        if (!team) throw new Error('team not found');
        const now = Date.now();
        const task: TeamTask = {
          id: genId('ttask'),
          teamId: input.teamId,
          goal,
          attachments: input.attachments ?? [],
          status: 'awaiting_plan',
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({ tasks: [task, ...s.tasks] }));
        return task;
      },

      updateTaskStatus: (id, status) =>
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, status, updatedAt: Date.now() } : t)),
        })),
    }),
    {
      name: 'abu-team',
      version: 1,
      partialize: (s) => ({ teams: s.teams, tasks: s.tasks }),
    },
  ),
);

/** Items that need the user's attention — drives the 收件箱 tab + sidebar badge. */
export function selectPendingTasks(tasks: TeamTask[]): TeamTask[] {
  return tasks.filter((t) => t.status === 'awaiting_plan' || t.status === 'pending_review' || t.status === 'blocked');
}
