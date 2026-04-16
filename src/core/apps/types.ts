/**
 * WorkspaceApp SDK 类型定义 (V1)
 *
 * 本文件定义 Abu WorkspaceApp 扩展机制的核心接口。配套规范见
 * ~/Documents/PM/ClaudeCodeDev/Abu-docs/SDK_SPEC.md。
 *
 * 设计原则（V1 三条宪法）：
 *   1. 延迟抽象：不建 @/sdk 层；第 2 个 App 出现再抽
 *   2. 数据隔离先行：每 App 独立 .db + 独立 dataDir + 独立 KV 前缀
 *   3. 单向依赖：App → 宿主 ✅；宿主 → App ❌
 */

export const SDK_VERSION = '0.1.0';

// ============================================================================
// Manifest
// ============================================================================

export interface WorkspaceAppManifest {
  /** kebab-case，全局唯一。匹配 /^[a-z][a-z0-9-]*$/ */
  id: string;
  /** i18n key，如 "notebook.app.name" */
  name: string;
  /** semver */
  version: string;
  /** Lucide 图标名 */
  icon: string;

  description?: string;
  author?: string;
  homepage?: string;

  /**
   * V1 仅文档价值，不做运行时强制。V2 开放第三方时引入授权。
   * 示例：['fs.read', 'fs.write', 'browser.bridge', 'agent.run']
   */
  permissions?: readonly string[];

  contributes?: Contributes;
}

export interface Contributes {
  toolboxEntry?: {
    category?: 'productivity' | 'data' | 'collaboration' | 'utility';
  };
  sidebarNav?: {
    position: 'top' | 'middle' | 'bottom';
    order?: number;
  };
}

// ============================================================================
// Lifecycle
// ============================================================================

export interface WorkspaceApp {
  /**
   * 激活钩子（懒激活语义）：只注册入口，不加载重资产。
   * 宿主启动 / 用户激活 App 时调用一次。
   */
  activate(ctx: AppContext): Promise<void>;

  /**
   * 停用钩子：清理非 subscriptions 资源。
   * subscriptions 由宿主自动 dispose。
   */
  deactivate(): Promise<void>;
}

// ============================================================================
// AppContext（V1 极简版，只暴露 6 样）
// ============================================================================

export interface AppContext {
  readonly appId: string;
  readonly appVersion: string;

  /** 独立目录路径：<appData>/apps/<appId>/ */
  readonly dataDir: string;

  /** 独立 SQLite 文件的连接 */
  readonly db: Database;

  /** 独立 KV（localStorage 前缀 "app:<id>:"） */
  readonly kv: KVStore;

  /** 带 [appId] tag 的日志器 */
  readonly logger: Logger;

  /** 订阅自动回收池；deactivate 时 LIFO 顺序 dispose */
  readonly subscriptions: DisposableStore;
}

// ============================================================================
// Disposable
// ============================================================================

export interface Disposable {
  dispose(): void | Promise<void>;
}

export interface DisposableStore extends Disposable {
  /** 登记一个 disposable，deactivate 时自动清理 */
  add(d: Disposable): void;
  /** LIFO 顺序 dispose 全部已登记项 */
  dispose(): Promise<void>;
}

// ============================================================================
// Database（对 tauri-plugin-sql 的薄 facade；V1 接口最小化）
// ============================================================================

export interface Database {
  /** 执行 SQL（INSERT/UPDATE/DELETE/DDL），返回受影响行数 */
  execute(sql: string, params?: readonly unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;

  /** 查询多行 */
  select<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;

  /** 查询单行（找不到返回 null） */
  selectOne<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>;
}

// ============================================================================
// KVStore（小量配置值）
// ============================================================================

export interface KVStore {
  get<T = unknown>(key: string): T | null;
  set<T = unknown>(key: string, value: T): void;
  remove(key: string): void;
  keys(): string[];
  clear(): void;
}

// ============================================================================
// Logger
// ============================================================================

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// ============================================================================
// 类型守卫辅助
// ============================================================================

const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function isValidAppId(id: string): boolean {
  return APP_ID_PATTERN.test(id);
}

export function validateManifest(m: Partial<WorkspaceAppManifest>): string[] {
  const errors: string[] = [];
  if (!m.id || !isValidAppId(m.id)) {
    errors.push(`Invalid app id: ${String(m.id)} (expect kebab-case matching /^[a-z][a-z0-9-]*$/)`);
  }
  if (!m.name) errors.push('manifest.name is required');
  if (!m.version) errors.push('manifest.version is required');
  if (!m.icon) errors.push('manifest.icon is required');
  return errors;
}
