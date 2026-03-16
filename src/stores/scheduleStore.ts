import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduleConfig,
  ScheduledTaskStatus,
} from '../types/schedule';

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
    outputChannelId?: string;
    outputChatIds?: string;
    outputUserIds?: string;
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
      outputChannelId: string | undefined;
      outputChatIds: string | undefined;
      outputUserIds: string | undefined;
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
          outputChannelId: data.outputChannelId,
          outputChatIds: data.outputChatIds,
          outputUserIds: data.outputUserIds,
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
          if (data.outputChannelId !== undefined) task.outputChannelId = data.outputChannelId;
          if (data.outputChatIds !== undefined) task.outputChatIds = data.outputChatIds;
          if (data.outputUserIds !== undefined) task.outputUserIds = data.outputUserIds;
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
      version: 2,
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
        // Recalculate nextRunAt for all tasks
        const now = Date.now();
        for (const task of Object.values(state.tasks)) {
          task.nextRunAt = computeNextRunAt(task.schedule, task.status, now);
          // Reset any stuck running runs
          for (const run of task.runs) {
            if (run.status === 'running') {
              run.status = 'error';
              run.completedAt = now;
              run.error = 'App restarted during execution';
            }
          }
        }
      },
    }
  )
);
