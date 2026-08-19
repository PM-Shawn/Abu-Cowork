import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduleConfig,
  ScheduledTaskStatus,
} from '../types/schedule';
import type { PermissionMode } from '../core/permissions/permissionMode';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

const MAX_RUNS_PER_TASK = 20;

// --- nextRunAt computation ---

export function computeNextRunAt(
  schedule: ScheduleConfig,
  status: ScheduledTaskStatus,
  fromTime?: number
): number | undefined {
  if (status === 'paused' || schedule.frequency === 'manual') {
    return undefined;
  }

  const now = fromTime ?? Date.now();
  const base = new Date(now);
  const hour = schedule.time?.hour ?? 0;
  const minute = schedule.time?.minute ?? 0;

  switch (schedule.frequency) {
    case 'hourly': {
      // Next occurrence of :minute
      const next = new Date(base);
      next.setMinutes(minute, 0, 0);
      if (next.getTime() <= now) {
        next.setHours(next.getHours() + 1);
      }
      return next.getTime();
    }
    case 'daily': {
      const next = new Date(base);
      next.setHours(hour, minute, 0, 0);
      if (next.getTime() <= now) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime();
    }
    case 'weekly': {
      const targetDay = schedule.dayOfWeek ?? 1; // default Monday
      const next = new Date(base);
      next.setHours(hour, minute, 0, 0);
      // Find next occurrence of targetDay
      let daysUntil = targetDay - next.getDay();
      if (daysUntil < 0) daysUntil += 7;
      if (daysUntil === 0 && next.getTime() <= now) daysUntil = 7;
      next.setDate(next.getDate() + daysUntil);
      return next.getTime();
    }
    case 'weekdays': {
      const next = new Date(base);
      next.setHours(hour, minute, 0, 0);
      if (next.getTime() <= now) {
        next.setDate(next.getDate() + 1);
      }
      // Skip weekends
      while (next.getDay() === 0 || next.getDay() === 6) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime();
    }
    default:
      return undefined;
  }
}

/**
 * Cold-start catchup: rehydrate-time helper that decides, for each task,
 * whether a missed occurrence should collapse into a single immediate
 * run. Exported for unit testing — the real call site is inside
 * `onRehydrateStorage` below.
 *
 * Without catchup: an app that's been closed through the task's natural
 * trigger time (e.g. daily 9am task, app closed for 3 days) would reset
 * `nextRunAt` to tomorrow 9am and silently drop every missed occurrence.
 *
 * With catchup: when `lastRunAt` exists and the occurrence that *would
 * have* followed it is already in the past, we point `nextRunAt` at
 * `now`. The scheduler's boot tick() picks it up on the next loop and
 * runs exactly once — we deliberately don't replay every missed slot
 * because (a) burst-firing N agent loops on boot is expensive and
 * user-disruptive, (b) most scheduled tasks are idempotent-enough that
 * one catch-up run covers the gap, and (c) `completeRun` re-computes
 * `nextRunAt` from "now", so after this one catch-up run we're back on
 * the normal cadence.
 *
 * `computeNextRunAt` returns `undefined` for paused/manual tasks, so
 * those skip catchup automatically (no false triggers).
 *
 * Also resets any run that was left stuck in `running` state when the
 * app crashed mid-execution, so the UI doesn't show a permanent spinner.
 */
export function applyCatchupOnRehydrate(
  tasks: Record<string, ScheduledTask>,
  now: number,
): void {
  for (const task of Object.values(tasks)) {
    const naturalNext = computeNextRunAt(task.schedule, task.status, now);
    const expectedIfCaughtUp = task.lastRunAt
      ? computeNextRunAt(task.schedule, task.status, task.lastRunAt)
      : undefined;
    const missedRun =
      expectedIfCaughtUp !== undefined && expectedIfCaughtUp < now;
    task.nextRunAt = missedRun ? now : naturalNext;
    for (const run of task.runs) {
      if (run.status === 'running') {
        run.status = 'error';
        run.completedAt = now;
        run.error = 'App restarted during execution';
      }
    }
  }
}

// --- Store types ---

interface ScheduleState {
  tasks: Record<string, ScheduledTask>;
  // UI state (not persisted)
  activeTaskId: string | null;
  selectedTaskId: string | null;
  showEditor: boolean;
  editingTaskId: string | null;
}

interface ScheduleActions {
  // CRUD
  createTask: (data: {
    name: string;
    description?: string;
    prompt: string;
    schedule: ScheduleConfig;
    skillName?: string;
    workspacePath?: string;
    projectId?: string;
    outputChannelId?: string;
    outputChatIds?: string;
    outputUserIds?: string;
    /** undefined = follow the global settings permission mode (default). */
    permissionMode?: PermissionMode;
  }) => string;
  updateTask: (
    id: string,
    data: Partial<{
      name: string;
      description: string | undefined;
      prompt: string;
      schedule: ScheduleConfig;
      skillName: string | undefined;
      workspacePath: string | undefined;
      projectId: string | undefined;
      outputChannelId: string | undefined;
      outputChatIds: string | undefined;
      outputUserIds: string | undefined;
      /** undefined = follow the global settings permission mode. Distinct
       *  from the key being omitted — see the `'permissionMode' in data`
       *  check in the implementation below, which lets a caller explicitly
       *  reset a task back to "follow settings". */
      permissionMode: PermissionMode | undefined;
    }>
  ) => void;
  deleteTask: (id: string) => void;

  // Control
  pauseTask: (id: string) => void;
  resumeTask: (id: string) => void;

  // Run tracking
  startRun: (taskId: string, conversationId: string) => string;
  completeRun: (taskId: string, runId: string) => void;
  errorRun: (taskId: string, runId: string, error: string) => void;
  removeRun: (taskId: string, runId: string) => void;

  // Query
  getDueTasks: (now: number) => ScheduledTask[];
  getActiveTaskCount: () => number;

  // UI state
  setActiveTaskId: (id: string | null) => void;
  setSelectedTaskId: (id: string | null) => void;
  openEditor: (taskId?: string) => void;
  closeEditor: () => void;
}

export type ScheduleStore = ScheduleState & ScheduleActions;

export const useScheduleStore = create<ScheduleStore>()(
  persist(
    immer((set, get) => ({
      tasks: {},
      activeTaskId: null,
      selectedTaskId: null,
      showEditor: false,
      editingTaskId: null,

      // CRUD
      createTask: (data) => {
        const id = generateId();
        const now = Date.now();
        const task: ScheduledTask = {
          id,
          name: data.name,
          description: data.description,
          prompt: data.prompt,
          schedule: data.schedule,
          status: 'active',
          skillName: data.skillName,
          workspacePath: data.workspacePath,
          projectId: data.projectId,
          outputChannelId: data.outputChannelId,
          outputChatIds: data.outputChatIds,
          outputUserIds: data.outputUserIds,
          // undefined = follow the global settings permission mode (default) —
          // NOT the strictest tier. See PermissionMode's doc comment.
          permissionMode: data.permissionMode,
          createdAt: now,
          updatedAt: now,
          nextRunAt: computeNextRunAt(data.schedule, 'active', now),
          runs: [],
          totalRuns: 0,
        };
        set((state) => {
          state.tasks[id] = task;
        });
        return id;
      },

      updateTask: (id, data) => {
        set((state) => {
          const task = state.tasks[id];
          if (!task) return;
          if (data.name !== undefined) task.name = data.name;
          if (data.description !== undefined) task.description = data.description;
          if (data.prompt !== undefined) task.prompt = data.prompt;
          if (data.skillName !== undefined) task.skillName = data.skillName;
          if (data.workspacePath !== undefined) task.workspacePath = data.workspacePath;
          if (data.projectId !== undefined) task.projectId = data.projectId;
          if (data.outputChannelId !== undefined) task.outputChannelId = data.outputChannelId;
          if (data.outputChatIds !== undefined) task.outputChatIds = data.outputChatIds;
          if (data.outputUserIds !== undefined) task.outputUserIds = data.outputUserIds;
          // 'permissionMode' in data (not `!== undefined`): a caller must be
          // able to explicitly reset a task back to "follow settings"
          // (undefined) — the key being *provided* is what matters, not
          // whether its value happens to be undefined.
          if ('permissionMode' in data) task.permissionMode = data.permissionMode;
          if (data.schedule !== undefined) {
            task.schedule = data.schedule;
            task.nextRunAt = computeNextRunAt(data.schedule, task.status);
          }
          task.updatedAt = Date.now();
        });
      },

      deleteTask: (id) => {
        set((state) => {
          delete state.tasks[id];
          if (state.activeTaskId === id) {
            state.activeTaskId = null;
          }
          if (state.selectedTaskId === id) {
            state.selectedTaskId = null;
          }
        });
      },

      // Control
      pauseTask: (id) => {
        set((state) => {
          const task = state.tasks[id];
          if (task) {
            task.status = 'paused';
            task.nextRunAt = undefined;
            task.updatedAt = Date.now();
          }
        });
      },

      resumeTask: (id) => {
        set((state) => {
          const task = state.tasks[id];
          if (task) {
            task.status = 'active';
            task.nextRunAt = computeNextRunAt(task.schedule, 'active');
            task.updatedAt = Date.now();
          }
        });
      },

      // Run tracking
      startRun: (taskId, conversationId) => {
        const runId = generateId();
        set((state) => {
          const task = state.tasks[taskId];
          if (!task) return;
          const run: ScheduledTaskRun = {
            id: runId,
            scheduledTaskId: taskId,
            conversationId,
            startedAt: Date.now(),
            status: 'running',
          };
          task.runs.unshift(run);
          // Keep only last MAX_RUNS_PER_TASK
          if (task.runs.length > MAX_RUNS_PER_TASK) {
            task.runs = task.runs.slice(0, MAX_RUNS_PER_TASK);
          }
          task.totalRuns += 1;
          task.lastRunAt = run.startedAt;
        });
        return runId;
      },

      completeRun: (taskId, runId) => {
        set((state) => {
          const task = state.tasks[taskId];
          if (!task) return;
          const run = task.runs.find((r) => r.id === runId);
          if (run) {
            run.status = 'completed';
            run.completedAt = Date.now();
          }
          // Recalculate nextRunAt
          task.nextRunAt = computeNextRunAt(task.schedule, task.status);
          task.updatedAt = Date.now();
        });
      },

      errorRun: (taskId, runId, error) => {
        set((state) => {
          const task = state.tasks[taskId];
          if (!task) return;
          const run = task.runs.find((r) => r.id === runId);
          if (run) {
            run.status = 'error';
            run.completedAt = Date.now();
            run.error = error;
          }
          // Recalculate nextRunAt
          task.nextRunAt = computeNextRunAt(task.schedule, task.status);
          task.updatedAt = Date.now();
        });
      },

      removeRun: (taskId, runId) => {
        set((state) => {
          const task = state.tasks[taskId];
          if (!task) return;
          task.runs = task.runs.filter((r) => r.id !== runId);
          task.updatedAt = Date.now();
        });
      },

      // Query
      getDueTasks: (now) => {
        const { tasks } = get();
        return Object.values(tasks).filter(
          (t) => t.status === 'active' && t.nextRunAt != null && t.nextRunAt <= now
        );
      },

      getActiveTaskCount: () => {
        const { tasks } = get();
        return Object.values(tasks).filter((t) => t.status === 'active').length;
      },

      // UI state
      setActiveTaskId: (id) => {
        set((state) => {
          state.activeTaskId = id;
        });
      },

      setSelectedTaskId: (id) => {
        set((state) => {
          state.selectedTaskId = id;
        });
      },

      openEditor: (taskId) => {
        set((state) => {
          state.showEditor = true;
          state.editingTaskId = taskId ?? null;
        });
      },

      closeEditor: () => {
        set((state) => {
          state.showEditor = false;
          state.editingTaskId = null;
        });
      },
    })),
    {
      name: 'abu-schedule',
      version: 5,
      migrate(persisted: unknown, version: number) {
        if (version < 2) {
          // v1→v2 added optional IM output fields (outputChannelId, outputChatIds, outputUserIds).
          // These default to undefined, so no data transform needed — just pass through.
        }
        if (version < 3) {
          // v2→v3 added optional projectId field. No data transform needed.
        }
        if (version < 4) {
          // v3→v4 added permissionMode, at the time using TriggerCapability's
          // read_tools/safe_tools/full vocabulary. Superseded by v5 below —
          // no transform needed here, the v<5 step resets the field
          // regardless of whatever v4 wrote into it.
        }
        if (version < 5) {
          // v4→v5: permissionMode's vocabulary changed from TriggerCapability
          // (read_tools/safe_tools/full/custom) to chat's own PermissionMode
          // (standard/smart/autonomous) — the two are not the same axis, so
          // there is no sound value-preserving translation between them.
          // Reset every task back to undefined ("follow the global settings
          // permission mode"), the same value a brand-new task gets — not
          // the strictest tier, and not a guessed mapping.
          const state = persisted as { tasks?: Record<string, { permissionMode?: unknown }> };
          if (state?.tasks) {
            for (const task of Object.values(state.tasks)) {
              if (task) task.permissionMode = undefined;
            }
          }
        }
        return persisted as Record<string, unknown>;
      },
      partialize: (state) => ({
        tasks: state.tasks,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Reset UI state
        state.activeTaskId = null;
        state.selectedTaskId = null;
        state.showEditor = false;
        state.editingTaskId = null;
        // Recalculate nextRunAt for all tasks, with cold-start catchup.
        applyCatchupOnRehydrate(state.tasks, Date.now());
      },
    }
  )
);
