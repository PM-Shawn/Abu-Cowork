import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type {
  Trigger,
  TriggerRun,
  TriggerOutputStatus,
  TriggerStatus,
  TriggerSource,
  TriggerSourceType,
  TriggerFilter,
  TriggerFilterType,
  TriggerAction,
  TriggerOutput,
  DebounceConfig,
  QuietHoursConfig,
} from '../types/trigger';
import { useIMChannelStore } from './imChannelStore';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

const MAX_RUNS_PER_TRIGGER = 20;

// --- Store types ---

/** Template defaults passed when opening editor from a template card */
export interface EditorTemplateDefaults {
  name?: string;
  sourceType?: TriggerSourceType;
  filterType?: TriggerFilterType;
  prompt?: string;
  keywords?: string;
}

interface TriggerState {
  triggers: Record<string, Trigger>;
  // UI state (not persisted)
  selectedTriggerId: string | null;
  showEditor: boolean;
  editingTriggerId: string | null;
  editorTemplateDefaults: EditorTemplateDefaults | null;
}

interface TriggerActions {
  // CRUD
  createTrigger: (data: {
    name: string;
    description?: string;
    source: TriggerSource;
    filter: TriggerFilter;
    action: TriggerAction;
    debounce: DebounceConfig;
    quietHours?: QuietHoursConfig;
    output?: TriggerOutput;
  }) => string;
  updateTrigger: (
    id: string,
    data: Partial<{
      name: string;
      description: string | undefined;
      source: TriggerSource;
      filter: TriggerFilter;
      action: TriggerAction;
      debounce: DebounceConfig;
      quietHours: QuietHoursConfig | undefined;
      output: TriggerOutput | undefined;
    }>
  ) => void;
  deleteTrigger: (id: string) => void;

  // Control
  setTriggerStatus: (id: string, status: TriggerStatus) => void;

  // Run tracking
  startRun: (triggerId: string, conversationId: string, eventSummary?: string) => string;
  completeRun: (triggerId: string, runId: string) => void;
  errorRun: (triggerId: string, runId: string, error: string) => void;
  addSkippedRun: (triggerId: string, status: 'filtered' | 'debounced', eventSummary?: string) => void;
  removeRun: (triggerId: string, runId: string) => void;
  updateRunOutput: (triggerId: string, runId: string, status: TriggerOutputStatus, error?: string) => void;

  // Query
  getActiveTriggers: () => Trigger[];
  getActiveTriggerCount: () => number;

  // UI state
  setSelectedTriggerId: (id: string | null) => void;
  openEditor: (triggerId?: string, templateDefaults?: EditorTemplateDefaults) => void;
  closeEditor: () => void;
}

export type TriggerStore = TriggerState & TriggerActions;

export const useTriggerStore = create<TriggerStore>()(
  persist(
    immer((set, get) => ({
      triggers: {},
      selectedTriggerId: null,
      showEditor: false,
      editingTriggerId: null,
      editorTemplateDefaults: null,

      // CRUD
      createTrigger: (data) => {
        const id = generateId();
        const now = Date.now();
        const trigger: Trigger = {
          id,
          name: data.name,
          description: data.description,
          status: 'active',
          source: data.source,
          filter: data.filter,
          action: data.action,
          debounce: data.debounce,
          quietHours: data.quietHours,
          output: data.output,
          createdAt: now,
          updatedAt: now,
          runs: [],
          totalRuns: 0,
        };
        set((state) => {
          state.triggers[id] = trigger;
        });
        return id;
      },

      updateTrigger: (id, data) => {
        set((state) => {
          const trigger = state.triggers[id];
          if (!trigger) return;
          if (data.name !== undefined) trigger.name = data.name;
          if (data.description !== undefined) trigger.description = data.description;
          if (data.source !== undefined) trigger.source = data.source;
          if (data.filter !== undefined) trigger.filter = data.filter;
          if (data.action !== undefined) trigger.action = data.action;
          if (data.debounce !== undefined) trigger.debounce = data.debounce;
          if (data.quietHours !== undefined) trigger.quietHours = data.quietHours;
          if (data.output !== undefined) trigger.output = data.output;
          trigger.updatedAt = Date.now();
        });
      },

      deleteTrigger: (id) => {
        set((state) => {
          delete state.triggers[id];
          if (state.selectedTriggerId === id) {
            state.selectedTriggerId = null;
          }
        });
      },

      // Control
      setTriggerStatus: (id, status) => {
        set((state) => {
          const trigger = state.triggers[id];
          if (trigger) {
            trigger.status = status;
            trigger.updatedAt = Date.now();
          }
        });
      },

      // Run tracking
      startRun: (triggerId, conversationId, eventSummary) => {
        const runId = generateId();
        set((state) => {
          const trigger = state.triggers[triggerId];
          if (!trigger) return;
          const run: TriggerRun = {
            id: runId,
            triggerId,
            conversationId,
            startedAt: Date.now(),
            status: 'running',
            eventSummary,
          };
          trigger.runs.unshift(run);
          if (trigger.runs.length > MAX_RUNS_PER_TRIGGER) {
            trigger.runs = trigger.runs.slice(0, MAX_RUNS_PER_TRIGGER);
          }
          trigger.totalRuns += 1;
          trigger.lastTriggeredAt = run.startedAt;
        });
        return runId;
      },

      completeRun: (triggerId, runId) => {
        set((state) => {
          const trigger = state.triggers[triggerId];
          if (!trigger) return;
          const run = trigger.runs.find((r) => r.id === runId);
          if (run) {
            run.status = 'completed';
            run.completedAt = Date.now();
          }
          trigger.updatedAt = Date.now();
        });
      },

      errorRun: (triggerId, runId, error) => {
        set((state) => {
          const trigger = state.triggers[triggerId];
          if (!trigger) return;
          const run = trigger.runs.find((r) => r.id === runId);
          if (run) {
            run.status = 'error';
            run.completedAt = Date.now();
            run.error = error;
          }
          trigger.updatedAt = Date.now();
        });
      },

      addSkippedRun: (triggerId, status, eventSummary) => {
        set((state) => {
          const trigger = state.triggers[triggerId];
          if (!trigger) return;
          const now = Date.now();
          const run: TriggerRun = {
            id: generateId(),
            triggerId,
            conversationId: '',
            startedAt: now,
            completedAt: now,
            status,
            eventSummary,
          };
          trigger.runs.unshift(run);
          if (trigger.runs.length > MAX_RUNS_PER_TRIGGER) {
            trigger.runs = trigger.runs.slice(0, MAX_RUNS_PER_TRIGGER);
          }
          trigger.totalRuns += 1;
          trigger.lastTriggeredAt = now;
        });
      },

      removeRun: (triggerId, runId) => {
        set((state) => {
          const trigger = state.triggers[triggerId];
          if (!trigger) return;
          trigger.runs = trigger.runs.filter((r) => r.id !== runId);
        });
      },

      updateRunOutput: (triggerId, runId, status, error) => {
        set((state) => {
          const trigger = state.triggers[triggerId];
          if (!trigger) return;
          const run = trigger.runs.find((r) => r.id === runId);
          if (run) {
            run.outputStatus = status;
            if (status === 'sent') run.outputSentAt = Date.now();
            if (error) run.outputError = error;
          }
        });
      },

      // Query
      getActiveTriggers: () => {
        const { triggers } = get();
        return Object.values(triggers).filter((t) => t.status === 'active');
      },

      getActiveTriggerCount: () => {
        const { triggers } = get();
        return Object.values(triggers).filter((t) => t.status === 'active').length;
      },

      // UI state
      setSelectedTriggerId: (id) => {
        set((state) => {
          state.selectedTriggerId = id;
        });
      },

      openEditor: (triggerId, templateDefaults) => {
        set((state) => {
          state.showEditor = true;
          state.editingTriggerId = triggerId ?? null;
          state.editorTemplateDefaults = templateDefaults ?? null;
        });
      },

      closeEditor: () => {
        set((state) => {
          state.showEditor = false;
          state.editingTriggerId = null;
          state.editorTemplateDefaults = null;
        });
      },
    })),
    {
      name: 'abu-triggers',
      version: 3,
      partialize: (state) => ({
        triggers: state.triggers,
      }),
      migrate: (persisted, version) => {
        // v1 → v2: TriggerRun gains outputStatus/outputError/outputSentAt; Trigger gains output
        // No data transformation needed — new fields are optional
        if (version < 2) {
          // no-op, new fields are optional
        }

        // v2 → v3: IMSource loses platform/appId/appSecret, gains channelId
        //           TriggerOutput target 'reply_source' → 'im_channel'
        if (version < 3) {
          const state = persisted as { triggers?: Record<string, Record<string, unknown>> };
          if (state.triggers) {
            for (const trigger of Object.values(state.triggers)) {
              const source = trigger.source as Record<string, unknown> | undefined;
              if (source?.type === 'im' && source.appId) {
                // Try to find an existing IM channel matching platform + appId
                let matchedChannelId: string | undefined;

                const channels = useIMChannelStore.getState().channels;
                for (const ch of Object.values(channels)) {
                  if (ch.platform === source.platform && ch.appId === source.appId) {
                    matchedChannelId = ch.id;
                    break;
                  }
                }

                // If no matching channel found, create one
                if (!matchedChannelId) {
                  matchedChannelId = useIMChannelStore.getState().addChannel({
                    platform: source.platform as 'dchat' | 'feishu' | 'dingtalk' | 'wecom' | 'slack',
                    name: `${source.platform} (migrated)`,
                    appId: String(source.appId),
                    appSecret: String(source.appSecret ?? ''),
                  });
                }

                // Update source: remove old fields, add channelId
                source.channelId = matchedChannelId ?? '';
                delete source.platform;
                delete source.appId;
                delete source.appSecret;
              }

              // Migrate output target
              const output = trigger.output as Record<string, unknown> | undefined;
              if (output?.target === 'reply_source') {
                output.target = 'im_channel';
                // Use the IM source's channel ID for output
                const src = trigger.source as Record<string, unknown> | undefined;
                if (src?.type === 'im' && src.channelId) {
                  output.outputChannelId = src.channelId;
                }
              }
            }
          }
        }

        return persisted;
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Reset UI state
        state.selectedTriggerId = null;
        state.showEditor = false;
        state.editingTriggerId = null;
        state.editorTemplateDefaults = null;
        // Reset any stuck running runs and pending output statuses
        const now = Date.now();
        for (const trigger of Object.values(state.triggers)) {
          for (const run of trigger.runs) {
            if (run.status === 'running') {
              run.status = 'error';
              run.completedAt = now;
              run.error = 'App restarted during execution';
            }
            if (run.outputStatus === 'pending') {
              run.outputStatus = 'failed';
              run.outputError = 'App restarted during push';
            }
          }
        }
      },
    }
  )
);
