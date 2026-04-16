import type {
  LoggerAdapter,
  LogEntry,
  LogLevel,
} from '../ports/adapters/logger';

/**
 * Ambient Logger —— 为不方便构造器注入的纯函数 helpers 提供的"环境 logger"。
 *
 * 使用约束：
 * - 整个进程只允许一个 AbuCore 实例时使用（Tauri/Prism 单例场景）
 * - 多租户/多实例场景下请改走构造器注入，不要依赖 ambient
 * - Facade 启动时调用 `installAmbientLogger(adapter)` 替换默认实现
 *
 * 默认实现：SilentLogger（丢弃所有日志），不主动打 console 避免污染 CI/测试输出
 */

class SilentLogger implements LoggerAdapter {
  log(_level: LogLevel, _module: string, _message: string, _data?: unknown): void {
    /* drop */
  }
  getRecent(_limit?: number): LogEntry[] {
    return [];
  }
  async flush(): Promise<void> {
    /* no-op */
  }
}

let ambient: LoggerAdapter = new SilentLogger();

export function installAmbientLogger(adapter: LoggerAdapter): void {
  ambient = adapter;
}

export function getAmbientLogger(): LoggerAdapter {
  return ambient;
}

export function resetAmbientLogger(): void {
  ambient = new SilentLogger();
}
