import type {
  TriggerSource,
  TriggerFilter,
} from '../../../../../src/types/trigger';

/**
 * TriggerRepo 统一覆盖 Abu 的 trigger + schedule（未决点 #5：scheduler 合并进 trigger）。
 * Cron 类触发器用 `TriggerSource.type === 'cron'` 表达。
 */

export interface TriggerRule {
  id: string;
  name: string;
  enabled: boolean;
  source: TriggerSource;
  filter?: TriggerFilter;
  /** 命中后创建对话用的模板 prompt */
  prompt: string;
  /** 可选：绑定项目/技能/MCP */
  projectId?: string;
  activeSkills?: string[];
  enabledMCPServers?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TriggerRunRecord {
  id: string;
  triggerId: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'ok' | 'error';
  conversationId?: string;
  error?: string;
}

export interface TriggerRepo {
  listRules(): Promise<TriggerRule[]>;
  getRule(id: string): Promise<TriggerRule | null>;
  upsertRule(rule: TriggerRule): Promise<void>;
  deleteRule(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;

  recordRun(run: TriggerRunRecord): Promise<void>;
  listRuns(triggerId: string, limit?: number): Promise<TriggerRunRecord[]>;
}
