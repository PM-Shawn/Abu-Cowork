import type { ThinkingProtocol, ToolResultImageSupport } from '../modelCapabilities';

export const PROVIDER_ALLOWLIST = [
  'anthropic', 'openai', 'deepseek', 'moonshotai', 'zhipuai', 'alibaba', 'google', 'xai',
] as const;

export interface RecordPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface ModelRecord {
  id: string;
  family?: string;
  providers?: string[];
  label?: string;
  vision: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  outputCeiling?: number;
  reasoning: boolean;
  pdfInput: boolean;
  pricing?: RecordPricing;
  thinking?: ThinkingProtocol;
  toolResultImages?: ToolResultImageSupport;
  documentBlock?: boolean;
}

export interface ModelsDevModel {
  id: string;
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number; input?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

export interface ModelsDevProvider {
  id: string;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevApi = Record<string, ModelsDevProvider>;
