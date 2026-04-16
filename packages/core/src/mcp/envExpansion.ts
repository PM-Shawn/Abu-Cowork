/**
 * 环境变量展开（纯函数子集）。从 Abu src/utils/envExpansion.ts 抽取。
 * 原版有从 Tauri 读 OS env vars 的能力，那部分交给 shell；core 只保留字符串替换。
 */

export function expandEnvString(input: string, envVars: Record<string, string>): string {
  return input.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    const colonIdx = expr.indexOf(':-');
    if (colonIdx !== -1) {
      const varName = expr.slice(0, colonIdx);
      const defaultVal = expr.slice(colonIdx + 2);
      return envVars[varName] || defaultVal;
    }
    return envVars[expr] ?? '';
  });
}

/** 对一个 config 的 command/url/args/env 值进行变量展开 */
export function expandConfigEnvVars<
  T extends {
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    command?: string;
  }
>(config: T, envVars: Record<string, string>): T {
  const expanded: T = { ...config };
  if (expanded.command) expanded.command = expandEnvString(expanded.command, envVars);
  if (expanded.url) expanded.url = expandEnvString(expanded.url, envVars);
  if (expanded.args) expanded.args = expanded.args.map((a) => expandEnvString(a, envVars));
  if (expanded.env) {
    const newEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(expanded.env)) {
      newEnv[k] = expandEnvString(v, envVars);
    }
    expanded.env = newEnv;
  }
  return expanded;
}
