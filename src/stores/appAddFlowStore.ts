import { create } from 'zustand';
import { homeDir } from '@tauri-apps/api/path';
import type { AppDefinition } from '@/types/app';
import {
  cancelPluginSteps,
  confirmAddApp,
  needsConfirmation,
  planAddApp,
  planPluginSteps,
  runPluginSteps,
  type AppAddPlan,
  type AppAddSource,
  type AppPluginStep,
} from '@/core/app/appInstaller';

/**
 * The one add / update / preview / repair flow the app market and the app
 * home share, so there is a single confirmation page on screen at a time.
 * Purely in memory: a flow never outlives the window it was started in.
 *
 *   - add / update: 「使用」 and 「更新」 in the app market. When nothing has to
 *     be installed and the app opens no websites, it goes straight through.
 *   - preview: 「从文件夹添加」, which always shows the app first.
 *   - repair: a scene whose plugin was removed; confirming reinstalls it and
 *     then starts what the user clicked.
 */
export type AppAddPurpose = 'add' | 'update' | 'preview';

export type AppAddFlow =
  | { kind: 'closed' }
  | { kind: 'planning'; name: string }
  | { kind: 'ready'; purpose: AppAddPurpose; plan: AppAddPlan }
  | { kind: 'repair'; app: AppDefinition; steps: AppPluginStep[]; resume: () => void }
  | { kind: 'error'; name: string; message: string };

interface AppAddFlowState {
  flow: AppAddFlow;
  running: boolean;
}

interface AppAddFlowActions {
  start: (source: AppAddSource, name: string, purpose: AppAddPurpose) => Promise<void>;
  repair: (app: AppDefinition, resume: () => void) => Promise<void>;
  confirm: (configuration: Record<string, Record<string, string>>) => Promise<void>;
  cancel: () => Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useAppAddFlowStore = create<AppAddFlowState & AppAddFlowActions>()((set, get) => ({
  flow: { kind: 'closed' },
  running: false,

  start: async (source, name, purpose) => {
    set({ flow: { kind: 'planning', name } });
    let plan: AppAddPlan;
    try {
      plan = await planAddApp(source, await homeDir());
    } catch (error) {
      set({ flow: { kind: 'error', name, message: message(error) } });
      return;
    }
    // Cancelled while planning: the snapshots it prepared are not needed.
    if (get().flow.kind !== 'planning') { await cancelPluginSteps(plan.steps); return; }
    set({ flow: { kind: 'ready', purpose, plan } });
    if (purpose !== 'preview' && !needsConfirmation(plan)) await get().confirm({});
  },

  repair: async (app, resume) => {
    set({ flow: { kind: 'planning', name: app.name } });
    let steps: AppPluginStep[];
    try {
      steps = await planPluginSteps(app, await homeDir());
    } catch (error) {
      set({ flow: { kind: 'error', name: app.name, message: message(error) } });
      return;
    }
    if (get().flow.kind !== 'planning') { await cancelPluginSteps(steps); return; }
    if (steps.length === 0) {
      set({ flow: { kind: 'closed' } });
      resume();
      return;
    }
    set({ flow: { kind: 'repair', app, steps, resume } });
  },

  confirm: async (configuration) => {
    const { flow, running } = get();
    if (running || (flow.kind !== 'ready' && flow.kind !== 'repair')) return;
    set({ running: true });
    try {
      if (flow.kind === 'ready') await confirmAddApp(flow.plan, await homeDir(), configuration);
      else await runPluginSteps(flow.steps, await homeDir(), configuration);
      set({ flow: { kind: 'closed' } });
      if (flow.kind === 'repair') flow.resume();
    } catch (error) {
      set({ flow: { kind: 'error', name: flow.kind === 'ready' ? flow.plan.app.name : flow.app.name, message: message(error) } });
    } finally {
      set({ running: false });
    }
  },

  cancel: async () => {
    const { flow, running } = get();
    if (running) return;
    set({ flow: { kind: 'closed' } });
    if (flow.kind === 'ready') await cancelPluginSteps(flow.plan.steps);
    if (flow.kind === 'repair') await cancelPluginSteps(flow.steps);
  },
}));
