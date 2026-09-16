/**
 * The marketplace's view of Abu's connector catalog.
 *
 * There is one catalog — {@link BUILTIN_REGISTRY}, what the agent searches and
 * installs. `MCPTemplate` is no longer data: it is that registry rendered for
 * the install UI, which needs a few things the registry deliberately does not
 * store — prose, in both languages, for a card and a form field.
 *
 * The prose comes from the two locale dictionaries directly rather than through
 * the current-locale accessors, because a template carries *both* languages at
 * once (`description` + `descriptionEn`); resolving one locale would leave the
 * other field guessing. The view is therefore locale-independent — what a card
 * shows is picked from the pair at render time, as it always was.
 */

import type { MCPTemplate, ModelPreset } from '@/types/marketplace';
import { hasElectronCommandHost } from '@/utils/electronHost';
import { BUILTIN_REGISTRY, getRegistryEntry, type MCPRegistryEntry } from '@/core/agent/mcpDiscovery';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';

const zh = zhCN.toolResult.system;
const en = enUS.toolResult.system;

/** One registry entry, already host-resolved, as the install UI needs it. */
function toTemplate(entry: MCPRegistryEntry): MCPTemplate {
  const envKeys = Object.keys(entry.env);
  const configurableArgs = entry.configurableArgs ?? [];
  return {
    id: entry.name,
    name: entry.name,
    // Falling back to the name matches getEntryDescription(); the registry's
    // own tests keep every entry described in both dictionaries.
    description: zh.mcpCatalog[entry.name] ?? entry.name,
    descriptionEn: en.mcpCatalog[entry.name] ?? entry.name,
    command: entry.command,
    defaultArgs: [...entry.args],
    ...(configurableArgs.length > 0 && {
      configurableArgs: configurableArgs.map((arg) => ({
        index: arg.index,
        // A slot with no label would be an unlabeled required field; the
        // placeholder at least says what belongs in it. The registry's own
        // tests keep every slot labeled in both dictionaries.
        label: zh.mcpArgLabels[`${entry.name}.${arg.index}`] ?? arg.placeholder,
        labelEn: en.mcpArgLabels[`${entry.name}.${arg.index}`] ?? arg.placeholder,
        placeholder: arg.placeholder,
      })),
    }),
    ...(envKeys.length > 0 && {
      // The key *is* the label: it is what the server reads, so naming it
      // anything else would leave the user matching prose to documentation.
      requiredEnvVars: envKeys.map((key) => ({
        name: key,
        label: key,
        placeholder: entry.envPlaceholders?.[key] ?? '',
        description: zh.mcpEnvHints[key],
        descriptionEn: en.mcpEnvHints[key],
      })),
    }),
    ...(zh.mcpSetupHints[entry.name] && { setupHint: zh.mcpSetupHints[entry.name] }),
    ...(en.mcpSetupHints[entry.name] && { setupHintEn: en.mcpSetupHints[entry.name] }),
    ...(entry.defaultTimeout !== undefined && { defaultTimeout: entry.defaultTimeout }),
  };
}

/**
 * Every connector in the catalog, resolved the way this host would run it —
 * the Electron build swaps the Chrome bridge's command, so a template built
 * here describes an install that would actually start.
 */
export function getMCPTemplates(): MCPTemplate[] {
  return BUILTIN_REGISTRY.map((entry) => toTemplate(getRegistryEntry(entry.name) ?? entry));
}

/**
 * The templates this host offers to install. Electron provisions the Chrome
 * bridge itself (see provisionFirstPartyMCPServers), so offering it again as
 * an install card would duplicate a server the user already has.
 */
export function getMCPTemplatesForHost(): MCPTemplate[] {
  const templates = getMCPTemplates();
  if (!hasElectronCommandHost()) return templates;
  return templates.filter((template) => template.id !== 'abu-browser-bridge');
}

/** Model presets for quick switching */
export const modelPresets: ModelPreset[] = [
  {
    id: 'claude-sonnet',
    name: 'Claude Sonnet 5',
    provider: 'anthropic',
    apiFormat: 'anthropic',
    model: 'claude-sonnet-5',
    description: '速度与智能的最佳平衡，适合大多数任务',
    descriptionEn: 'The best balance of speed and intelligence, suited for most tasks',
  },
  {
    id: 'claude-opus',
    name: 'Claude Opus 5',
    provider: 'anthropic',
    apiFormat: 'anthropic',
    model: 'claude-opus-5',
    description: '最强模型，适合复杂推理和编程',
    descriptionEn: 'The most capable model, suited for complex reasoning and coding',
  },
  {
    id: 'claude-haiku',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    apiFormat: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    description: '快速响应，适合简单任务和高频调用',
    descriptionEn: 'Fast responses, suited for simple tasks and high-frequency calls',
  },
  {
    id: 'gpt-sol',
    name: 'GPT-5.6 Sol',
    provider: 'openai',
    apiFormat: 'openai-compatible',
    model: 'gpt-5.6-sol',
    description: 'OpenAI 旗舰模型，适合复杂推理和编程',
    descriptionEn: "OpenAI's flagship model, suited for complex reasoning and coding",
  },
  {
    id: 'gpt-luna',
    name: 'GPT-5.6 Luna',
    provider: 'openai',
    apiFormat: 'openai-compatible',
    model: 'gpt-5.6-luna',
    description: 'OpenAI 轻量快速模型',
    descriptionEn: "OpenAI's lightweight, fast model",
  },
  {
    id: 'deepseek-v4',
    name: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    apiFormat: 'openai-compatible',
    model: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com',
    description: 'DeepSeek 旗舰模型，高性价比',
    descriptionEn: "DeepSeek's flagship model with great value for money",
  },
  {
    id: 'volcengine-doubao-seed',
    name: 'Doubao Seed 2.1 Turbo',
    provider: 'volcengine',
    // Agent Plan is the default multi-endpoint config for volcengine, OpenAI-compatible (see PROVIDER_CONFIGS).
    apiFormat: 'openai-compatible',
    // Seed 2.0 Pro is retired and no longer served on this tier; this is the
    // current Doubao entry on the plan's published model list.
    model: 'doubao-seed-2.1-turbo',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    description: '豆包旗舰模型，字节跳动出品',
    descriptionEn: 'Doubao flagship model by ByteDance',
  },
  {
    id: 'bailian-qwen-max',
    name: 'Qwen3.7 Max',
    provider: 'bailian',
    // Token Plan 团队版 is the default multi-endpoint config for bailian (see PROVIDER_CONFIGS).
    apiFormat: 'openai-compatible',
    model: 'qwen3.7-max',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    description: '通义千问旗舰模型，阿里百炼平台',
    descriptionEn: 'Qwen flagship model on Alibaba Bailian platform',
  },
  {
    id: 'qiniu-deepseek-v3.2',
    name: '七牛云 DeepSeek V3.2',
    nameEn: 'Qiniu Cloud DeepSeek V3.2',
    provider: 'qiniu',
    apiFormat: 'openai-compatible',
    model: 'deepseek/deepseek-v3.2-251201',
    baseUrl: 'https://api.qnaigc.com/v1',
    description: '七牛云代理，50+ 模型统一接入',
    descriptionEn: 'Qiniu Cloud proxy with unified access to 50+ models',
  },
  {
    id: 'ollama-llama',
    name: 'Ollama Llama 3.2',
    provider: 'local',
    apiFormat: 'openai-compatible',
    model: 'llama3.2',
    baseUrl: 'http://localhost:11434/v1',
    description: '本地运行 Llama 3.2 模型',
    descriptionEn: 'Run the Llama 3.2 model locally',
  },
  {
    id: 'ollama-qwen',
    name: 'Ollama Qwen 2.5',
    provider: 'local',
    apiFormat: 'openai-compatible',
    model: 'qwen2.5',
    baseUrl: 'http://localhost:11434/v1',
    description: '本地运行 Qwen 2.5 模型',
    descriptionEn: 'Run the Qwen 2.5 model locally',
  },
];

/** Get MCP template by ID */
export function getMCPTemplate(id: string): MCPTemplate | undefined {
  return getMCPTemplates().find((t) => t.id === id);
}

/** Get model preset by ID */
export function getModelPreset(id: string): ModelPreset | undefined {
  return modelPresets.find((p) => p.id === id);
}
