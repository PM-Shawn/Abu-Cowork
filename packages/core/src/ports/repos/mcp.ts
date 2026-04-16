export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
  timeout?: number;
}

export interface McpRepo {
  list(): Promise<McpServerConfig[]>;
  get(id: string): Promise<McpServerConfig | null>;
  upsert(cfg: McpServerConfig): Promise<void>;
  delete(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}
