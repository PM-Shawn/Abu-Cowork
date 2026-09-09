import type { MCPServerConfig } from '@/core/mcp/client';
import { deleteSecret, listSecrets, getSecret, setSecret } from '@/utils/secretStore';

import { hasPluginOperationHost, pluginOperationStatus } from './operationBridge';

export const PLUGIN_CONFIG_VALUE_LIMIT = 16 * 1024;
const TOTAL_LIMIT = 64 * 1024;
const pendingReferences = new Set<string>();
let cleanupQueue: Promise<void> = Promise.resolve();
const SLOT = /\$\{config\.([A-Za-z][A-Za-z0-9_]{0,63})\}/g;
export function pluginConfigFields(servers: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }> = {}): string[] {
  const fields = [...new Set(Object.values(servers).flatMap(server => [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]
    .flatMap(value => [...value.matchAll(SLOT)].map(match => match[1]))))].sort();
  if (fields.length > 32) throw new Error('Plugin configuration supports at most 32 fields');
  return fields;
}
export async function savePluginConfiguration(key: string, fields: string[], values: Record<string, string>): Promise<string | undefined> {
  if (!fields.length) return undefined;
  if (fields.some(field => !Object.hasOwn(values, field) || typeof values[field] !== 'string' || !values[field].trim())) throw new Error('Plugin configuration is incomplete');
  if (fields.length > 32 || fields.some(field => values[field].length > PLUGIN_CONFIG_VALUE_LIMIT)) throw new Error('Plugin configuration exceeds size limit');
  const serialized = JSON.stringify(Object.fromEntries(fields.map(field => [field, values[field]])));
  if (new TextEncoder().encode(serialized).byteLength > TOTAL_LIMIT) throw new Error('Plugin configuration exceeds size limit');
  // A unique installation revision avoids overwriting credentials still used by
  // an older runtime if installation is cancelled or rolled back.
  const reference = `plugin-config:${key}:${crypto.randomUUID()}`;
  pendingReferences.add(reference);
  try { await setSecret(reference, serialized); }
  catch (error) { pendingReferences.delete(reference); await deleteSecret(reference).catch(() => {}); throw error; }
  return reference;
}
export async function resolvePluginConfiguration(config: MCPServerConfig): Promise<{ config: MCPServerConfig; redact: (value: string) => string }> {
  const fields = pluginConfigFields({ server: config });
  if (!fields.length) return { config, redact: value => value };
  if (!config.pluginConfiguration?.startsWith('plugin-config:')) throw new Error('Plugin configuration is incomplete');
  const raw = await getSecret(config.pluginConfiguration);
  let values: unknown;
  try { values = raw ? JSON.parse(raw) : null; } catch { throw new Error('Plugin configuration is incomplete'); }
  if (!values || typeof values !== 'object' || Array.isArray(values) || fields.some(field => !Object.hasOwn(values, field) || typeof (values as Record<string, unknown>)[field] !== 'string' || !(values as Record<string, string>)[field].trim())) throw new Error('Plugin configuration is incomplete');
  const secrets = values as Record<string, string>;
  const replace = (entries: Record<string, string> | undefined) => entries && Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, value.replace(SLOT, (_match, field: string) => secrets[field])]));
  return { config: { ...config, env: replace(config.env), headers: replace(config.headers) },
    redact: value => [...fields].sort((a, b) => secrets[b].length - secrets[a].length).reduce((text, field) => text.split(secrets[field]).join('[redacted]'), value) };
}

/** Transfer the newly saved reference to persisted runtime/journal ownership. */
export function finishPluginConfiguration(reference?: string): void {
  if (reference) pendingReferences.delete(reference);
}

/** Skip ALL collection while recovery is pending. Journal old/new refs can
 * both be needed then. Re-read live references after awaits; never guess from
 * an install's success/catch, since its commit response may have been lost. */
export function sweepPluginConfigurations(liveReferences: () => Iterable<string> | null): Promise<void> {
  const run = cleanupQueue.then(async () => {
    if (!hasPluginOperationHost() || await pluginOperationStatus() !== null || liveReferences() === null) return;
    const keys = await listSecrets();
    for (const key of keys ?? []) {
      if (!key.startsWith('plugin-config:')) continue;
      if (await pluginOperationStatus() !== null) return;
      const live = liveReferences();
      if (live === null) return;
      if (!pendingReferences.has(key) && !new Set(live).has(key)) await deleteSecret(key);
    }
  });
  cleanupQueue = run.catch(() => {});
  return run;
}
