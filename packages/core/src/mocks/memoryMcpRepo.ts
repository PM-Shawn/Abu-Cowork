import type { McpRepo, McpServerConfig } from '../ports/repos/mcp';

export class MemoryMcpRepo implements McpRepo {
  private map = new Map<string, McpServerConfig>();

  async list() {
    return [...this.map.values()];
  }
  async get(id: string) {
    return this.map.get(id) ?? null;
  }
  async upsert(cfg: McpServerConfig) {
    this.map.set(cfg.id, { ...cfg });
  }
  async delete(id: string) {
    this.map.delete(id);
  }
  async setEnabled(id: string, enabled: boolean) {
    const cur = this.map.get(id);
    if (!cur) throw new Error(`MCP server not found: ${id}`);
    cur.enabled = enabled;
  }
}
