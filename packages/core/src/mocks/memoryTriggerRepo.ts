import type {
  TriggerRepo,
  TriggerRule,
  TriggerRunRecord,
} from '../ports/repos/trigger';

export class MemoryTriggerRepo implements TriggerRepo {
  private rules = new Map<string, TriggerRule>();
  private runs: TriggerRunRecord[] = [];

  async listRules() {
    return [...this.rules.values()];
  }
  async getRule(id: string) {
    return this.rules.get(id) ?? null;
  }
  async upsertRule(rule: TriggerRule) {
    this.rules.set(rule.id, { ...rule, updatedAt: Date.now() });
  }
  async deleteRule(id: string) {
    this.rules.delete(id);
  }
  async setEnabled(id: string, enabled: boolean) {
    const cur = this.rules.get(id);
    if (!cur) throw new Error(`Trigger rule not found: ${id}`);
    cur.enabled = enabled;
    cur.updatedAt = Date.now();
  }

  async recordRun(run: TriggerRunRecord) {
    this.runs.push({ ...run });
  }
  async listRuns(triggerId: string, limit?: number) {
    const filtered = this.runs
      .filter((r) => r.triggerId === triggerId)
      .sort((a, b) => b.startedAt - a.startedAt);
    return limit ? filtered.slice(0, limit) : filtered;
  }
}
