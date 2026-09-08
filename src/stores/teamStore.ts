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

export interface TeamLastPlan {
  /** The user's request that split answered (trimmed). */
  request: string;
  /** Step text, "@owner" appended when the step had one. */
  steps: string[];
  savedAt: number;
}

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
  /** Optional emoji avatar set by the user; absent = the default group mark. */
  avatar?: string;
  /** The split the leader used last time (reference input for the next run, never a skip). */
  lastPlan?: TeamLastPlan;
  createdAt: number;
  archivedAt?: number;
}

interface TeamState {
  teams: Team[];
}

interface TeamActions {
  createTeam: (input: { name: string; leaderRoleId: string; memberRoleIds: string[]; leaderNote?: string; requirePlanApproval?: boolean; avatar?: string }) => Team;
  updateTeam: (id: string, patch: Partial<Pick<Team, 'name' | 'leaderRoleId' | 'memberRoleIds' | 'leaderNote' | 'requirePlanApproval' | 'avatar' | 'lastPlan'>>) => void;
  archiveTeam: (id: string) => void;
  restoreTeam: (id: string) => void;

}

type TeamStore = TeamState & TeamActions;

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useTeamStore = create<TeamStore>()(
  persist(
    (set, get) => ({
      teams: [],

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
          avatar: input.avatar?.trim() || undefined,
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
    }),
    {
      name: 'abu-team',
      version: 6,
      // v1 → v2: additive optional fields (memberRoleId, requirePlanApproval).
      // v2 → v3: pipelines array added; v3 → v4: pipelines removed again.
      // v4 → v5: TeamTask.permissionMode added.
      // v5 → v6: the task board is gone (in-conversation team, 2026-09-05) —
      // the persisted `tasks` slice is dropped; teams are all that remains.
      migrate: (persisted: unknown) => {
        const state = persisted as { teams: Team[]; tasks?: unknown; pipelines?: unknown; focusTaskId?: unknown };
        const { pipelines: _pipelines, tasks: _tasks, focusTaskId: _focus, ...rest } = state;
        return rest;
      },
      partialize: (s) => ({ teams: s.teams }),
    },
  ),
);
