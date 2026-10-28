import type { SettingsState } from '@/stores/settingsStore';
import type { ActiveModel } from '@/types/provider';
import type { AgentModelCapabilities } from '@/core/llm/modelCapabilities';

export type ModelRecoveryReason = 'quota' | 'context-window';

export interface RunModelBinding {
  revision: number;
  model: ActiveModel;
  settingsSnapshot: SettingsState;
  resolvedCreds: { apiKey: string; baseUrl: string | undefined; forceOpenAiCompatible: boolean };
  capabilities: AgentModelCapabilities & { modelId: string };
}

export interface ModelRecoveryPort {
  waitForSelection(reason: ModelRecoveryReason): Promise<RunModelBinding | null>;
}
