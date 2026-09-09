import { getI18n } from '@/i18n';
const active = new Map<string, number>();
const changing = new Set<string>();

/** File-changing operations never race an admitted MCP or agent invocation. */
export function acquirePluginUse(key: string | null | undefined): () => void {
  if (!key) return () => {};
  if (changing.has(key)) throw new Error(getI18n().toolbox.pluginsChanging);
  active.set(key, (active.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (active.get(key) ?? 1) - 1;
    if (count) active.set(key, count); else active.delete(key);
  };
}

export function acquirePluginChange(key: string): () => void {
  if (changing.has(key) || active.has(key)) throw new Error(getI18n().toolbox.pluginsBusy);
  changing.add(key);
  return () => { changing.delete(key); };
}
