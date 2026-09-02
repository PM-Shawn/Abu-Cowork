/**
 * 插件清单（plugin.json）解析器。
 *
 * 参考 Claude Code 插件生态（.claude-plugin/plugin.json）与 Abu 自有插件目录
 * （.abu-plugin/plugin.json）的字段形状；两种目录同构，Abu 优先使用自有目录，
 * 未找到时回退到 Claude 目录以兼容生态内已有插件。
 */

/** 单个 MCP server 声明：stdio（command/args/env）或 http/sse（url）二选一。 */
export interface McpServerSpec {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

/** 插件在 UI 层展示所需的可选元信息（应用市场卡片、聊天输入区图标等）。 */
export interface PluginInterface {
  displayName?: string;
  shortDescription?: string;
  longDescription?: string;
  developerName?: string;
  category?: string;
  capabilities?: string[];
  brandColor?: string;
  composerIcon?: string;
  logo?: string;
  logoDark?: string;
  screenshots?: string[];
  defaultPrompt?: string[];
  websiteURL?: string;
  privacyPolicyURL?: string;
  termsOfServiceURL?: string;
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string | { name: string; email?: string };
  license?: string;
  keywords?: string[];
  skills?: string[];
  mcpServers?: Record<string, McpServerSpec>;
  interface?: PluginInterface;
  // 未知字段前向兼容保留，见 parsePluginManifest 尾部的字段回填。
  [key: string]: unknown;
}

/** 清单校验失败时抛出；field 指向具体不合法的字段路径，便于上层定位报错。 */
export class PluginManifestError extends Error {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'PluginManifestError';
    this.field = field;
  }
}

/**
 * 三候选清单相对路径，按序尝试：Abu 自有目录优先，找不到依次回退到 Claude
 * 生态目录、再到 Codex 生态目录（`.codex-plugin/`），兼容已发布的第三方插件。
 */
export const MANIFEST_CANDIDATES = [
  '.abu-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
] as const;

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const MAX_SCREENSHOTS_DEFAULT_PROMPT = 3;
const MAX_DEFAULT_PROMPT_LENGTH = 128;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 把 author 字段（字符串或对象两种历史写法）归一化为 { name, email? }。 */
export function normalizeAuthor(
  a: PluginManifest['author']
): { name: string; email?: string } | undefined {
  if (a === undefined) return undefined;
  if (typeof a === 'string') return { name: a };
  return a;
}

function validateInterface(iface: unknown): PluginInterface | undefined {
  if (iface === undefined) return undefined;
  if (!isPlainObject(iface)) {
    throw new PluginManifestError('interface 字段必须是对象', 'interface');
  }

  const brandColor = iface.brandColor;
  if (brandColor !== undefined) {
    if (typeof brandColor !== 'string' || !HEX_COLOR_RE.test(brandColor)) {
      throw new PluginManifestError(
        'interface.brandColor 必须是 #RRGGBB 形式的十六进制颜色（不接受 #RGB 简写）',
        'interface.brandColor'
      );
    }
  }

  const screenshots = iface.screenshots;
  if (screenshots !== undefined) {
    if (
      !Array.isArray(screenshots) ||
      !screenshots.every((s) => typeof s === 'string' && s.toLowerCase().endsWith('.png'))
    ) {
      throw new PluginManifestError(
        'interface.screenshots 每一项都必须是 .png 文件路径',
        'interface.screenshots'
      );
    }
  }

  const defaultPrompt = iface.defaultPrompt;
  if (defaultPrompt !== undefined) {
    if (!Array.isArray(defaultPrompt) || !defaultPrompt.every((s) => typeof s === 'string')) {
      throw new PluginManifestError(
        'interface.defaultPrompt 必须是字符串数组',
        'interface.defaultPrompt'
      );
    }
    if (defaultPrompt.length > MAX_SCREENSHOTS_DEFAULT_PROMPT) {
      throw new PluginManifestError(
        `interface.defaultPrompt 最多 ${MAX_SCREENSHOTS_DEFAULT_PROMPT} 条`,
        'interface.defaultPrompt'
      );
    }
    if (defaultPrompt.some((s) => s.length > MAX_DEFAULT_PROMPT_LENGTH)) {
      throw new PluginManifestError(
        `interface.defaultPrompt 单条不能超过 ${MAX_DEFAULT_PROMPT_LENGTH} 字符`,
        'interface.defaultPrompt'
      );
    }
  }

  return iface as PluginInterface;
}

function validateMcpServers(mcpServers: unknown): Record<string, McpServerSpec> | undefined {
  if (mcpServers === undefined) return undefined;
  if (!isPlainObject(mcpServers)) {
    throw new PluginManifestError('mcpServers 字段必须是对象', 'mcpServers');
  }
  for (const [key, value] of Object.entries(mcpServers)) {
    if (!isPlainObject(value)) {
      throw new PluginManifestError(`mcpServers.${key} 必须是对象`, `mcpServers.${key}`);
    }
  }
  return mcpServers as Record<string, McpServerSpec>;
}

/**
 * 解析并校验插件清单原始 JSON。未知顶层字段会被原样保留（前向兼容——
 * 插件生态会持续新增字段，解析器不应因为多了一个陌生字段就整体拒绝清单）。
 */
export function parsePluginManifest(raw: unknown): PluginManifest {
  if (!isPlainObject(raw)) {
    throw new PluginManifestError('插件清单必须是 JSON 对象');
  }

  const name = raw.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new PluginManifestError('缺少必填字段 name（或 name 不是非空字符串）', 'name');
  }

  const mcpServers = validateMcpServers(raw.mcpServers);
  const iface = validateInterface(raw.interface);

  return {
    // 先展开未知字段做前向兼容兜底，再用校验过的字段覆盖，确保类型正确的值优先。
    ...raw,
    name,
    mcpServers,
    interface: iface,
  };
}
