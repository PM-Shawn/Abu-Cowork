import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { BUILTIN_TEAMS, isBuiltinTeam } from '@/core/team/builtinTeams';

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

/** Runtime-extension metadata. The host owns only the read-only in-memory
 * contract; transport, authentication and policy stay in the extension. */
export interface ManagedTeamMetadata {
  source: string;
  id: string;
  version: string;
  readOnly: true;
  ready: boolean;
  unavailableReason?: string;
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
  /** Optional emoji or built-in icon reference; absent = the default group mark. */
  avatar?: string;
  /** Card subtitle; absent = leader and member count. */
  description?: string;
  /** Greeting shown only on first contact, before the user sends a task. */
  intro?: string;
  /** Display-only areas of expertise, matching agent metadata. */
  expertise?: string[];
  /** Suggested questions prefill a new conversation without sending. */
  samplePrompts?: string[];
  /** The split the leader used last time (reference input for the next run, never a skip). */
  lastPlan?: TeamLastPlan;
  createdAt: number;
  managed?: ManagedTeamMetadata;
}

interface TeamState {
  teams: Team[];
  managedTeamSources: Record<string, { isActive: () => boolean; teams: Team[] }>;
}

interface TeamActions {
  createTeam: (input: { name: string; leaderRoleId: string; memberRoleIds: string[]; leaderNote?: string; requirePlanApproval?: boolean; avatar?: string; description?: string; intro?: string; expertise?: string[]; samplePrompts?: string[] }) => Team;
  updateTeam: (id: string, patch: Partial<Pick<Team, 'name' | 'leaderRoleId' | 'memberRoleIds' | 'leaderNote' | 'requirePlanApproval' | 'avatar' | 'lastPlan' | 'description' | 'intro' | 'expertise' | 'samplePrompts'>>) => void;
  deleteTeam: (id: string) => void;
  registerManagedTeamSource: (source: string, isActive: () => boolean) => void;
  replaceManagedTeams: (source: string, teams: Team[]) => void;
  clearManagedTeams: (source: string) => void;
}

export type TeamStore = TeamState & TeamActions;

export function selectVisibleTeams(state: Pick<TeamStore, 'teams' | 'managedTeamSources'>): Team[] {
  const visible = state.teams.filter(team => !isBuiltinTeam(team));
  const ids = new Set(visible.map(team => team.id));
  for (const managedSource of Object.values(state.managedTeamSources)) {
    if (!managedSource.isActive()) continue;
    for (const team of managedSource.teams) {
      if (ids.has(team.id)) continue;
      visible.push(team);
      ids.add(team.id);
    }
  }
  // Managed versions of the shipped teams share their display names. Keep
  // both source shelves visible, and prefer the managed version for name lookup.
  for (const team of state.teams) {
    if (!isBuiltinTeam(team) || ids.has(team.id)) continue;
    visible.push(team);
    ids.add(team.id);
  }
  return visible;
}

export function getVisibleTeams(): Team[] {
  return selectVisibleTeams(useTeamStore.getState());
}

export function getVisibleTeamById(id: string): Team | undefined {
  return getVisibleTeams().find(team => team.id === id);
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persisted-state migration. Exported so it can be tested as the pure function
 * it is — reaching into the persist middleware's options from a test couples
 * the test to zustand's internals.
 *
 * v1 → v2: additive optional fields (memberRoleId, requirePlanApproval).
 * v2 → v3: pipelines array added; v3 → v4: pipelines removed again.
 * v4 → v5: TeamTask.permissionMode added.
 * v5 → v6: the task board is gone (in-conversation team, 2026-09-05) — the
 *   persisted `tasks` slice is dropped; teams are all that remains.
 * v6 → v7: archive is gone; a team is deleted outright, like an agent.
 *   Previously-archived teams come BACK to the list rather than being dropped:
 *   the user archived them, they never asked for them to be erased, and
 *   silently deleting their data on an upgrade is not ours to do. They can
 *   delete them explicitly now.
 * v7 → v8: additive optional display fields; existing data stays unchanged.
 */
export function migrateTeamState(persisted: unknown): { teams: Team[] } {
  const state = (persisted ?? {}) as { teams?: Array<Team & { archivedAt?: number }>; tasks?: unknown; pipelines?: unknown; focusTaskId?: unknown };
  const { pipelines: _pipelines, tasks: _tasks, focusTaskId: _focus, ...rest } = state;
  return {
    ...rest,
    teams: (state.teams ?? []).map(({ archivedAt: _archivedAt, ...team }) => team),
  };
}

/**
 * What persist writes. Built-ins never touch disk: an older blob and a newer
 * shipped roster would otherwise disagree with the app forever.
 *
 * Exported for the same reason {@link migrateTeamState} is — `useTeamStore.persist`
 * is not exposed under the test runtime, and reaching into zustand's middleware
 * options from a test couples the test to zustand's internals.
 */
export function partializeTeamState(state: { teams: Team[] }): { teams: Team[] } {
  return { teams: state.teams.filter((t) => !isBuiltinTeam(t)) };
}

/**
 * What persist hands back on hydration: the user's own teams from disk, plus
 * TODAY's shipped roster — never a built-in copy an older version wrote.
 */
export function mergeTeamState(persisted: unknown, current: TeamStore): TeamStore {
  const stored = (persisted ?? {}) as Partial<{ teams: Team[] }>;
  const userTeams = (stored.teams ?? []).filter((t) => !isBuiltinTeam(t));
  return { ...current, teams: [...dedupeNames(userTeams), ...BUILTIN_TEAMS] };
}

/**
 * The third door onto a duplicate name, and the only one the user does not
 * open themselves: the shipped roster grows between versions (v0.50 added
 * 财务对账专家团 and 招聘专家团), so a team the user named first can collide
 * with a built-in that did not exist when they created it. Left alone, the two
 * render identically, `save_team` can only ever reach one of them, and the
 * user's own team becomes permanently unsavable because every edit trips the
 * duplicate guard.
 *
 * The shipped name wins — it is the one the changelog, the docs and other
 * teams refer to — and the user's team keeps all of its content under a
 * numbered name, the way WorkBuddy suffixes a colliding team rather than
 * dropping it. Renaming settles on the next write: this pass is a fixed point,
 * so a re-hydration before that write reaches the same names again.
 *
 * `taken` is seeded with EVERY name in play, not just the built-ins, so a
 * rename can never land on a name somebody else already holds: a user who has
 * both 「X」 and 「X 2」 and then meets a shipped 「X」 gets 「X 3」 for the
 * collider and keeps 「X 2」 where it was. Renaming the innocent one would be
 * worse than the collision — `@X 2` and `save_team` resolve by name, so it
 * would silently start addressing a different team.
 */
function dedupeNames(teams: Team[]): Team[] {
  const builtinNames = BUILTIN_TEAMS.map((team) => team.name);
  const taken = new Set([...builtinNames, ...teams.map((team) => team.name)]);
  const claimed = new Set(builtinNames);
  return teams.map((team) => {
    if (!claimed.has(team.name)) { claimed.add(team.name); return team; }
    let suffix = 2;
    while (taken.has(`${team.name} ${suffix}`)) suffix += 1;
    const name = `${team.name} ${suffix}`;
    taken.add(name);
    claimed.add(name);
    return { ...team, name };
  });
}

export const useTeamStore = create<TeamStore>()(
  persist(
    (set, get) => ({
      teams: [...BUILTIN_TEAMS],
      managedTeamSources: {},

      createTeam: (input) => {
        const name = input.name.trim();
        if (!name) throw new Error('team name required');
        if (selectVisibleTeams(get()).some((t) => t.name === name)) {
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
          description: input.description || undefined,
          intro: input.intro || undefined,
          expertise: input.expertise?.length ? input.expertise : undefined,
          samplePrompts: input.samplePrompts?.length ? input.samplePrompts : undefined,
          createdAt: Date.now(),
        };
        // Newest first — freshly created things surface at the top (user feedback).
        set((s) => ({ teams: [team, ...s.teams] }));
        return team;
      },

      updateTeam: (id, patch) => {
        // Same rule `createTeam` enforces, applied to the rename it forgot.
        // Teams are addressed BY NAME by `save_team` (`teamTools.ts`), so two
        // teams sharing one name means the second is unreachable to the tool —
        // and because the store lists user teams before built-ins, a user team
        // renamed onto a built-in's name also slips past the built-in
        // read-only guard. Excludes the team being renamed, so re-saving a
        // dialog without touching the name stays a no-op.
        const wanted = patch.name?.trim();
        if (patch.name !== undefined && !wanted) throw new Error('team name required');
        if (wanted && selectVisibleTeams(get()).some((t) => t.id !== id && t.name === wanted)) {
          throw new Error('duplicate team name');
        }
        set((s) => ({
          teams: s.teams.map((t) => {
            if (t.id !== id) return t;
            if (isBuiltinTeam(t)) {
              // Read-only in the UI; the run may still record its last split.
              return patch.lastPlan ? { ...t, lastPlan: patch.lastPlan } : t;
            }
            // Store what the guard checked: an untrimmed write would slip a
            // trailing space past the next `createTeam` comparison.
            const next = { ...t, ...patch, ...(wanted ? { name: wanted } : {}) };
            // The leader is always a member.
            next.memberRoleIds = Array.from(new Set([next.leaderRoleId, ...next.memberRoleIds]));
            return next;
          }),
        }));
      },

      deleteTeam: (id) => set((s) => ({ teams: s.teams.filter((t) => t.id !== id || isBuiltinTeam(t)) })),
      registerManagedTeamSource: (source, isActive) => set((state) => ({
        managedTeamSources: {
          ...state.managedTeamSources,
          [source]: { isActive, teams: state.managedTeamSources[source]?.teams ?? [] },
        },
      })),
      replaceManagedTeams: (source, teams) => set((state) => {
        const registered = state.managedTeamSources[source];
        if (!registered) throw new Error(`managed team source not registered: ${source}`);
        const accepted = teams.filter(team => (
          team.managed?.source === source
          && team.managed.readOnly === true
          && team.id === team.managed.id
        ));
        return {
          managedTeamSources: {
            ...state.managedTeamSources,
            [source]: { ...registered, teams: accepted },
          },
        };
      }),
      clearManagedTeams: (source) => set((state) => {
        const registered = state.managedTeamSources[source];
        if (!registered) return state;
        return {
          managedTeamSources: {
            ...state.managedTeamSources,
            [source]: { ...registered, teams: [] },
          },
        };
      }),
    }),
    {
      name: 'abu-team',
      version: 8,
      migrate: migrateTeamState,
      // Built-ins never touch disk: strip on write, re-attach on read, so an
      // older persisted blob and a newer roster always agree with the app.
      partialize: partializeTeamState,
      merge: mergeTeamState,
    },
  ),
);
