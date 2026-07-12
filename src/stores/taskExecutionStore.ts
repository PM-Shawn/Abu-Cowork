import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useShallow } from 'zustand/react/shallow';
import type {
  TaskExecution,
  ExecutionStep,
  StepStatus,
  DetailBlock,
  PlannedStep,
} from '../types/execution';
import type { TokenUsage } from '../types';

// --- Helper Functions ---

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// --- Store State & Actions ---

interface TaskExecutionState {
  /** All execution contexts, keyed by execution ID */
  executions: Record<string, TaskExecution>;
  /** Currently active execution ID */
  activeExecutionId: string | null;
  /** Index for quick lookup by loopId */
  loopIdIndex: Record<string, string>;  // loopId -> executionId
}

interface TaskExecutionActions {
  // --- Lifecycle ---

  /** Create a new execution context */
  createExecution: (conversationId: string, loopId: string) => TaskExecution;
  /** Complete an execution */
  completeExecution: (execId: string) => void;
  /** Mark execution as error */
  errorExecution: (execId: string, error: string) => void;
  /** Cancel an execution */
  cancelExecution: (execId: string) => void;

  // --- Step Management ---

  /** Add a step to an execution */
  addStep: (execId: string, step: ExecutionStep) => void;
  /** Update step status */
  updateStepStatus: (execId: string, stepId: string, status: StepStatus) => void;
  /** Set step result (and mark as completed) */
  setStepResult: (execId: string, stepId: string, result: string) => void;
  /** Set step error */
  setStepError: (execId: string, stepId: string, error: string) => void;
  /** Update step progress */
  updateStepProgress: (execId: string, stepId: string, current: number, total: number) => void;

  /** Add a child step to a delegate parent step */
  addChildStep: (execId: string, parentStepId: string, childStep: ExecutionStep) => void;
  /** Update a child step with result or error */
  updateChildStep: (execId: string, parentStepId: string, childStepId: string, result: string, error?: boolean) => void;

  // --- Detail Block Management ---

  /** Add a detail block to a step */
  addDetailBlock: (execId: string, stepId: string, block: DetailBlock) => void;
  /** Toggle detail block expanded state */
  toggleDetailExpanded: (execId: string, stepId: string, blockId: string) => void;
  /** Update detail block content (for streaming results) */
  updateDetailBlockContent: (execId: string, stepId: string, blockId: string, content: string) => void;

  // --- Thinking ---

  /** Set thinking content */
  setThinking: (execId: string, thinking: string) => void;
  /** Append to thinking content */
  appendThinking: (execId: string, content: string) => void;
  /** Set thinking duration */
  setThinkingDuration: (execId: string, duration: number) => void;

  // --- Planned Steps ---

  /** Set planned steps from parsed AI plan */
  setPlannedSteps: (execId: string, steps: PlannedStep[]) => void;
  /** Mark plan as parsed */
  markPlanParsed: (execId: string) => void;

  // --- Usage ---

  /** Set token usage */
  setUsage: (execId: string, usage: TokenUsage) => void;

  // --- Queries ---

  /** Get execution by ID */
  getExecution: (execId: string) => TaskExecution | undefined;
  /** Get execution by loopId */
  getExecutionByLoopId: (loopId: string) => TaskExecution | undefined;
  /** Get active execution */
  getActiveExecution: () => TaskExecution | null;
  /** Get executions by conversation ID */
  getExecutionsByConversation: (conversationId: string) => TaskExecution[];
  /** Get the latest execution for a conversation ID */
  getExecutionByConversationId: (conversationId: string) => TaskExecution | undefined;
  /** Find step by ID across all executions */
  findStep: (execId: string, stepId: string) => ExecutionStep | undefined;

  // --- Cleanup ---

  /** Clear all executions for a conversation */
  clearConversation: (conversationId: string) => void;
  /** Evict a completed/errored execution to free memory (after snapshot is persisted) */
  evictExecution: (execId: string) => void;
  /** Clear all executions */
  clearAll: () => void;
}

export type TaskExecutionStore = TaskExecutionState & TaskExecutionActions;

export const useTaskExecutionStore = create<TaskExecutionStore>()(
  immer((set, get) => ({
    executions: {},
    activeExecutionId: null,
    loopIdIndex: {},

    // --- Lifecycle ---

    createExecution: (conversationId, loopId) => {
      const id = generateId();
      const execution: TaskExecution = {
        id,
        conversationId,
        loopId,
        status: 'running',
        startTime: Date.now(),
        plannedSteps: [],
        planParsed: false,
        steps: [],
      };

      set((state) => {
        state.executions[id] = execution;
        state.activeExecutionId = id;
        state.loopIdIndex[loopId] = id;
      });

      return execution;
    },

    completeExecution: (execId) => {
      set((state) => {
        const exec = state.executions[execId];
        if (exec) {
          exec.status = 'completed';
          exec.endTime = Date.now();
          // Only mark 'in_progress' steps as completed (they were actively executing).
          // Mark 'pending' steps as completed only if the plan was partially executed
          // (i.e., some steps were already completed — the AI finished the task).
          const hasCompletedSteps = exec.plannedSteps.some(s => s.status === 'completed');
          for (const step of exec.plannedSteps) {
            if (step.status === 'in_progress') {
              step.status = 'completed';
            } else if (step.status === 'pending' && hasCompletedSteps) {
              // The plan was in progress and the AI finished — treat remaining as done
              step.status = 'completed';
            }
          }
        }
        // Keep activeExecutionId so UI still shows completed steps
      });
    },

    errorExecution: (execId, _error) => {
      set((state) => {
        const exec = state.executions[execId];
        if (exec) {
          exec.status = 'error';
          exec.endTime = Date.now();
        }
        // Keep activeExecutionId so UI still shows error steps
      });
    },

    cancelExecution: (execId) => {
      set((state) => {
        const exec = state.executions[execId];
        if (exec) {
          exec.status = 'cancelled';
          exec.endTime = Date.now();
        }
        // Keep activeExecutionId so UI still shows cancelled steps
      });
    },

    // --- Step Management ---

    addStep: (execId, step) => {
      set((state) => {
        const exec = state.executions[execId];
        if (exec) {
          exec.steps.push(step);
        }
      });
    },

    updateStepStatus: (execId, stepId, status) => {
      set((state) => {
        const exec = state.executions[execId];
        const step = exec?.steps.find((s) => s.id === stepId);
        if (step) {
          step.status = status;
          if (status === 'running' && !step.startTime) {
            step.startTime = Date.now();
          }
          if (status === 'completed' || status === 'error') {
            step.endTime = Date.now();
            if (step.startTime) {
              step.duration = (step.endTime - step.startTime) / 1000;
            }
          }
        }
      });
    },

    setStepResult: (execId, stepId, result) => {
      set((state) => {
        const exec = state.executions[execId];
        const step = exec?.steps.find((s) => s.id === stepId);
        if (step) {
          step.toolResult = result;
          step.status = 'completed';
          step.endTime = Date.now();
          if (step.startTime) {
            step.duration = (step.endTime - step.startTime) / 1000;
          }
        }
      });
    },

    setStepError: (execId, stepId, error) => {
      set((state) => {
        const exec = state.executions[execId];
        const step = exec?.steps.find((s) => s.id === stepId);
        if (step) {
          step.errorMessage = error;
          step.status = 'error';
          step.endTime = Date.now();
          if (step.startTime) {
            step.duration = (step.endTime - step.startTime) / 1000;
          }
        }
      });
    },

    updateStepProgress: (_execId, _stepId, _current, _total) => {
      // Progress tracking - can be extended for batch operations
      // For now, this is a placeholder for future use
    },

    addChildStep: (execId, parentStepId, childStep) => {
      set((state) => {
        const exec = state.executions[execId];
        const parentStep = exec?.steps.find((s) => s.id === parentStepId);
        if (parentStep) {
          if (!parentStep.childSteps) {
            parentStep.childSteps = [];
          }
          parentStep.childSteps.push(childStep);
        }
      });
    },

    updateChildStep: (execId, parentStepId, childStepId, result, error) => {
      set((state) => {
        const exec = state.executions[execId];
        const parentStep = exec?.steps.find((s) => s.id === parentStepId);
        const childStep = parentStep?.childSteps?.find((s) => s.id === childStepId);
        if (childStep) {
          childStep.toolResult = result;
          childStep.status = error ? 'error' : 'completed';
          if (error) {
            childStep.errorMessage = result;
          }
          childStep.endTime = Date.now();
          if (childStep.startTime) {
            childStep.duration = (childStep.endTime - childStep.startTime) / 1000;
          }
        }
      });
    },

    // --- Detail Block Management ---

    addDetailBlock: (execId, stepId, block) => {
      set((state) => {
        const exec = state.executions[execId];
        const step = exec?.steps.find((s) => s.id === stepId);
        if (step) {
          step.detailBlocks.push(block);
        }
      });
    },

    toggleDetailExpanded: (execId, stepId, blockId) => {
      set((state) => {
        const exec = state.executions[execId];
        const step = exec?.steps.find((s) => s.id === stepId);
        const block = step?.detailBlocks.find((b) => b.id === blockId);
        if (block) {
          block.isExpanded = !block.isExpanded;
        }
      });
    },

    updateDetailBlockContent: (execId, stepId, blockId, content) => {
      set((state) => {
        const exec = state.executions[execId];
        const step = exec?.steps.find((s) => s.id === stepId);
        const block = step?.detailBlocks.find((b) => b.id === blockId);
        if (block) {
          block.content = content;
        }
      });
    },

    // --- Thinking ---

    setThinking: (execId, thinking) => {
      set((state) => {
        const exec = state.executions[execId];
        if (exec) {
          exec.thinking = thinking;
        }
      });
    },

    appendThinking: (execId, content) => {
      set((state) => {
        const exec = state.executions[execId];
        if (exec) {
          exec.thinking = (exec.thinking || '') + content;
        }
      });
    },

    setThinkingDuration: (execId, duration) => {
      set((state) => {
        const exec = state.executions[execId];
        if (exec) {
          exec.thinkingDuration = duration;
        }
      });
    },

    // --- Planned Steps ---

    setPlannedSteps: (execId, steps) => {
      set((state) => {
        const exec = state.executions[execId];
        if (exec) {
          // Model owns the plan now (declarative full-replace via report_plan).
          exec.plannedSteps = steps;
        }
      });
    },

    markPlanParsed: (execId) => {
      set((state) => {
        const exec = state.executions[execId];
        if (exec) {
          exec.planParsed = true;
        }
      });
    },

    // --- Usage ---

    setUsage: (execId, usage) => {
      set((state) => {
        const exec = state.executions[execId];
        if (exec) {
          exec.usage = usage;
        }
      });
    },

    // --- Queries ---

    getExecution: (execId) => {
      return get().executions[execId];
    },

    getExecutionByLoopId: (loopId) => {
      const state = get();
      const execId = state.loopIdIndex[loopId];
      return execId ? state.executions[execId] : undefined;
    },

    getActiveExecution: () => {
      const state = get();
      return state.activeExecutionId ? state.executions[state.activeExecutionId] : null;
    },

    getExecutionsByConversation: (conversationId) => {
      const state = get();
      return Object.values(state.executions).filter(
        (exec) => exec.conversationId === conversationId
      );
    },

    getExecutionByConversationId: (conversationId) => {
      const execs = Object.values(get().executions).filter((e) => e.conversationId === conversationId);
      if (execs.length === 0) return undefined;
      return execs.reduce((a, b) => (b.startTime >= a.startTime ? b : a));
    },

    findStep: (execId, stepId) => {
      const exec = get().executions[execId];
      return exec?.steps.find((s) => s.id === stepId);
    },

    // --- Cleanup ---

    clearConversation: (conversationId) => {
      set((state) => {
        const execIds = Object.keys(state.executions).filter(
          (id) => state.executions[id].conversationId === conversationId
        );
        for (const id of execIds) {
          const loopId = state.executions[id].loopId;
          delete state.executions[id];
          delete state.loopIdIndex[loopId];
        }
        if (state.activeExecutionId && execIds.includes(state.activeExecutionId)) {
          state.activeExecutionId = null;
        }
      });
    },

    evictExecution: (execId) => {
      set((state) => {
        const exec = state.executions[execId];
        if (!exec) return;
        // Only evict non-running executions
        if (exec.status === 'running') return;
        delete state.loopIdIndex[exec.loopId];
        delete state.executions[execId];
        if (state.activeExecutionId === execId) {
          state.activeExecutionId = null;
        }
      });
    },

    clearAll: () => {
      set((state) => {
        state.executions = {};
        state.activeExecutionId = null;
        state.loopIdIndex = {};
      });
    },
  }))
);

// --- Helper Hooks ---

/**
 * Get execution for a specific loopId
 */
export function useExecutionByLoopId(loopId: string | undefined) {
  return useTaskExecutionStore(
    useShallow((s) => (loopId ? s.getExecutionByLoopId(loopId) : undefined))
  );
}

/**
 * Get active execution
 * Returns the full execution object with reactive updates
 */
export function useActiveExecution() {
  const activeExecutionId = useTaskExecutionStore((s) => s.activeExecutionId);
  const execution = useTaskExecutionStore((s) =>
    activeExecutionId ? s.executions[activeExecutionId] : null
  );
  // Subscribe to plannedSteps changes specifically for re-rendering
  const plannedSteps = useTaskExecutionStore((s) =>
    activeExecutionId ? s.executions[activeExecutionId]?.plannedSteps : undefined
  );
  const status = useTaskExecutionStore((s) =>
    activeExecutionId ? s.executions[activeExecutionId]?.status : undefined
  );

  // Return execution with current data
  if (!execution) return null;
  return { ...execution, plannedSteps: plannedSteps ?? [], status: status ?? execution.status };
}

/**
 * Get execution progress summary
 */
export function useExecutionProgress(execId: string | undefined) {
  return useTaskExecutionStore(
    useShallow((s) => {
      if (!execId) return null;
      const exec = s.executions[execId];
      if (!exec) return null;

      const total = exec.steps.length;
      const completed = exec.steps.filter((step) => step.status === 'completed').length;
      const running = exec.steps.filter((step) => step.status === 'running').length;
      const errors = exec.steps.filter((step) => step.status === 'error').length;

      return {
        total,
        completed,
        running,
        errors,
        isComplete: exec.status === 'completed',
        hasError: exec.status === 'error' || errors > 0,
        progress: total > 0 ? completed / total : 0,
      };
    })
  );
}
