import type { LLMProvider, ApiFormat } from './index';

// ============================================================
// Marketplace Types for Skills, Agents, MCP
// ============================================================

/** Marketplace item for Skills and Agents */
export interface MarketplaceItem {
  id: string;
  name: string;
  description: string;
  author: string;
  category: string;
  isBuiltin?: boolean;
  content?: string; // SKILL.md or AGENT.md content
  trigger?: string;  // Display-only trigger summary for marketplace cards
  tags?: string[];   // Display-only tags for marketplace cards
}

/** MCP Server template */
export interface MCPTemplate {
  id: string;
  name: string;
  description: string;
  /** Transport type: 'stdio' (default) or 'http' */
  transport?: 'stdio' | 'http';
  /** Command for stdio transport */
  command?: string;
  /** Default args for stdio transport */
  defaultArgs?: string[];
  /** URL for HTTP transport */
  url?: string;
  /** Setup instructions shown to user (e.g. for HTTP servers that need manual startup) */
  setupHint?: string;
  /** Configurable args that user can customize during installation */
  configurableArgs?: {
    index: number;
    label: string;
    placeholder: string;
  }[];
  /** Required environment variables (e.g. API keys) prompted during installation */
  requiredEnvVars?: {
    name: string;
    label: string;
    placeholder: string;
    description?: string;
  }[];
  /** Default timeout for tool calls in ms (default: 30000) */
  defaultTimeout?: number;
}

/** Model preset for quick switching */
export interface ModelPreset {
  id: string;
  name: string;
  provider: LLMProvider;
  apiFormat: ApiFormat;
  model: string;
  baseUrl?: string;
  description: string;
}

/** Installation source for installed items */
export type InstallSource = 'builtin' | 'user' | 'project';
