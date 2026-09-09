import { format, getI18n } from '@/i18n';
import { joinPath, normalizeSeparators } from '@/utils/pathUtils';
import type { InstalledPlugin } from './installedStore';
import { pluginInstallDir } from './paths';

/** A persisted deny gate and the minimum ownership needed before disk is ready. */
export interface PluginActivation {
  enabled: boolean;
  conflicted?: boolean;
  root: string;
  skillDirs: string[];
  legacySkills: boolean;
  agentFiles: string[];
  mcpServers: string[];
}
export type PluginActivations = Record<string, PluginActivation>;
interface ChildPreferences {
  skills?: Array<{ name: string; skillDir: string }>;
  agents?: Array<{ name: string; filePath: string }>;
  disabledSkills: string[];
  disabledAgents: string[];
  servers: Record<string, { config: { enabled?: boolean } }>;
}
const normalized = (path: string) => normalizeSeparators(path).replace(/\/$/, '');

export function reconcilePluginActivation(
  previous: PluginActivations, installed: InstalledPlugin[], home: string, prefs: ChildPreferences,
): PluginActivations {
  const result: PluginActivations = {};
  for (const plugin of installed) {
    const root = pluginInstallDir(home, plugin.marketplace, plugin.name, plugin.version);
    const old = Object.hasOwn(previous, plugin.key) ? previous[plugin.key] : undefined;
    const skillDirs = (plugin.skillPaths ?? []).map(path => path === '.' ? root : joinPath(root, path));
    const agentFiles = plugin.contributed.agents.flatMap(name => ['AGENT.md', 'agent.md'].map(file => joinPath(home, '.abu/agents', name, file)));
    const enabled = old?.enabled ?? (
      (prefs.skills ?? []).some(skill => ownsSkill({ root, skillDirs, legacySkills: plugin.skillPaths === undefined }, normalized(skill.skillDir)) && !prefs.disabledSkills.includes(skill.name)) ||
      (prefs.agents ?? []).some(agent => agentFiles.includes(normalized(agent.filePath)) && !prefs.disabledAgents.includes(agent.name)) ||
      plugin.contributed.mcpServers.some(name => prefs.servers[name]?.config.enabled === true)
    );
    const activation = { enabled, root, skillDirs, legacySkills: plugin.skillPaths === undefined, agentFiles, mcpServers: [...plugin.contributed.mcpServers] };
    if (Object.hasOwn(result, plugin.key)) {
      // Duplicate identities are corrupt. Retain all deny ownership, grant none.
      const prior = result[plugin.key];
      result[plugin.key] = { ...prior, enabled: false, conflicted: true, agentFiles: [...new Set([...prior.agentFiles, ...agentFiles])], mcpServers: [...new Set([...prior.mcpServers, ...activation.mcpServers])] };
    } else Object.defineProperty(result, plugin.key, { value: activation, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function ownsSkill(a: Pick<PluginActivation, 'root' | 'skillDirs' | 'legacySkills'>, dir: string): boolean {
  const legacyChild = a.legacySkills && dir.startsWith(`${a.root}/skills/`) && !dir.slice(`${a.root}/skills/`.length).includes('/');
  return a.skillDirs.includes(dir) || legacyChild;
}
export function pluginOwnerForSkill(skillDir: string): string | null | undefined {
  const dir = normalized(skillDir);
  return uniqueOwner(Object.entries(activations).filter(([, a]) => dir === a.root || dir.startsWith(`${a.root}/`)).map(([key]) => key));
}

/** Same-version persisted data is untrusted too; only retain a coherent shape. */
export function sanitizePluginActivations(raw: unknown): PluginActivations {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string');
  return Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => {
    if (!value || typeof value !== 'object') return [];
    const v = value as Partial<PluginActivation>;
    if (typeof v.enabled !== 'boolean' || typeof v.root !== 'string' || typeof v.legacySkills !== 'boolean' ||
      !strings(v.skillDirs) || !strings(v.agentFiles) || !strings(v.mcpServers)) return [];
    return [[key, { enabled: v.enabled, conflicted: v.conflicted === true, root: normalized(v.root), legacySkills: v.legacySkills,
      skillDirs: v.skillDirs.map(normalized), agentFiles: v.agentFiles.map(normalized), mcpServers: [...v.mcpServers] }]];
  }));
}

// No store imports: renderer execution gates can use this without a registry ↔
// installer ↔ store cycle. pluginStore publishes synchronously on every change.
let activations: PluginActivations = {};
let knownMcp = new Set<string>();
let ready = true;
const mcpEpochs = new Map<string, number>();
const mcpGrants = new Map<string, string>();
export function publishPluginActivation(next: PluginActivations, knownServers: string[], recordsReady: boolean): void {
  const names = new Set([...knownMcp, ...knownServers, ...Object.values(activations).flatMap(a => a.mcpServers), ...Object.values(next).flatMap(a => a.mcpServers)]);
  for (const name of names) {
    const claims = Object.entries(next).filter(([, a]) => a.mcpServers.includes(name));
    const grant = JSON.stringify([knownServers.includes(name), claims.map(([key, a]) => [key, a.root, a.enabled, a.conflicted])]);
    if (mcpGrants.get(name) !== grant) mcpEpochs.set(name, (mcpEpochs.get(name) ?? 0) + 1);
    mcpGrants.set(name, grant);
  }
  activations = next;
  knownMcp = new Set(knownServers);
  ready = recordsReady;
}

const retainedAgentOwners = new WeakMap<object, { owner: string | null; root?: string }>();

/** undefined = independent; null = conflicting claims, which must fail closed. */
function uniqueOwner(matches: string[]): string | null | undefined {
  return matches.length > 1 ? null : matches[0];
}
export function pluginOwnerForAgent(agent: { filePath: string }): string | null | undefined {
  const retained = retainedAgentOwners.get(agent);
  if (retained) return retained.owner;
  const owner = uniqueOwner(Object.entries(activations).filter(([, a]) => a.agentFiles.includes(normalized(agent.filePath))).map(([key]) => key));
  if (owner !== undefined) retainedAgentOwners.set(agent, { owner, root: owner === null ? undefined : activations[owner].root });
  return owner;
}
export function pluginOwnerForMcp(name: string): string | null | undefined {
  return uniqueOwner(Object.entries(activations).filter(([, a]) => a.mcpServers.includes(name)).map(([key]) => key));
}
export function isPluginEnabled(key: string): boolean {
  return ready && Object.hasOwn(activations, key) && activations[key].enabled === true && !activations[key].conflicted;
}
export function assertPluginEnabled(key: string): void {
  if (!isPluginEnabled(key)) throw new Error(format(getI18n().toolbox.pluginsDisabledCapability, { name: key }));
}
export function isPluginSkillAllowed(skill: { skillDir: string }): boolean {
  const dir = normalized(skill.skillDir);
  const matches = Object.entries(activations).filter(([, a]) => dir === a.root || dir.startsWith(`${a.root}/`));
  if (!matches.length) return !dir.includes('/.abu/plugin-packages/');
  if (matches.length !== 1) return false;
  const [, a] = matches[0];
  return ready && a.enabled && !a.conflicted && ownsSkill(a, dir);
}
export function isPluginAgentAllowed<T extends { filePath: string }>(agent: T): boolean {
  const owner = pluginOwnerForAgent(agent);
  if (owner === null) return false;
  if (owner !== undefined) {
    const current = Object.entries(activations).filter(([, a]) => a.agentFiles.includes(normalized(agent.filePath))).map(([key]) => key);
    return current.length === 1 && current[0] === owner && isPluginEnabled(owner) && retainedAgentOwners.get(agent)?.root === activations[owner].root;
  }
  // Until the first successful read, a file-backed agent could belong to an
  // older installation with no persisted ownership. Host presets remain usable.
  return ready || agent.filePath.startsWith('__');
}
export function assertPluginAgentEnabled(agent: { filePath: string }): void {
  if (!isPluginAgentAllowed(agent)) throw new Error(format(getI18n().toolbox.pluginsDisabledCapability, { name: 'agent' }));
}
export function isPluginMcpAllowed(name: string): boolean {
  const owner = pluginOwnerForMcp(name);
  if (owner === null) return false;
  if (owner !== undefined) return isPluginEnabled(owner);
  return !knownMcp.has(name);
}
export function assertPluginMcpEnabled(name: string): void {
  if (!isPluginMcpAllowed(name)) throw new Error(format(getI18n().toolbox.pluginsDisabledCapability, { name }));
}

/** Invalidates a connection admitted before an off/on cycle or package update. */
export function pluginMcpEpoch(name: string): number { return mcpEpochs.get(name) ?? 0; }
export function assertPluginMcpEpoch(name: string, epoch: number): void {
  assertPluginMcpEnabled(name);
  if (pluginMcpEpoch(name) !== epoch) throw new Error(format(getI18n().toolbox.pluginsDisabledCapability, { name }));
}
