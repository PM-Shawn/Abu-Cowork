import { readTextFile } from '@tauri-apps/plugin-fs';
import { format, getI18n } from '@/i18n';
import { joinPath } from '@/utils/pathUtils';
import { parseSkillFile } from '@/core/skill/loader';
import type { PackageScan } from './fsOps';
import { PluginManifestError, parseMcpServerMap, type McpServerSpec, type PluginManifest } from './manifest';
import { normalizePluginComponentPath } from './paths';

function componentMissing(field: string): never {
  throw new PluginManifestError(format(getI18n().toolbox.pluginsComponentMissing, { field }), field);
}

/** One explicit merge rule: distinct names combine; duplicate names never overwrite. */
export async function resolvePluginMcpServers(
  packageDir: string,
  scan: PackageScan,
  declaration: PluginManifest['mcpServers'],
  readText: (path: string) => Promise<string> = readTextFile,
): Promise<Record<string, McpServerSpec> | undefined> {
  const result: Record<string, McpServerSpec> = {};
  let found = declaration !== undefined;
  function merge(servers: Record<string, McpServerSpec> | undefined) {
    for (const [name, spec] of Object.entries(servers ?? {})) {
      const field = `mcpServers.${name}`;
      if (Object.hasOwn(result, name)) {
        throw new PluginManifestError(format(getI18n().toolbox.pluginsComponentConflict, { field }), field);
      }
      // defineProperty keeps a JSON key named __proto__ an own key, not a setter.
      Object.defineProperty(result, name, { value: spec, enumerable: true, configurable: true, writable: true });
    }
  }
  if (typeof declaration !== 'string') merge(declaration);
  const explicit = typeof declaration === 'string' ? normalizePluginComponentPath(declaration) : undefined;
  const files = new Set(['.mcp.json', ...(explicit ? [explicit] : [])]);
  for (const path of files) {
    const entry = await scan.find(path);
    if (!entry) {
      if (path === explicit) componentMissing(path);
      continue;
    }
    if (entry.isDirectory) componentMissing(path);
    found = true;
    let raw: unknown;
    try { raw = JSON.parse(await readText(joinPath(packageDir, path))); } catch {
      throw new PluginManifestError(format(getI18n().toolbox.pluginsComponentInvalidJson, { field: path }), path);
    }
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      const wrappers = ['mcpServers', 'mcp_servers'].filter(key => Object.hasOwn(obj, key));
      if (wrappers.length > 0) {
        if (wrappers.length !== 1 || Object.keys(obj).length !== 1) {
          throw new PluginManifestError(format(getI18n().toolbox.pluginsManifestInvalidField, { field: path }), path);
        }
        raw = obj[wrappers[0]];
      }
    }
    merge(parseMcpServerMap(raw));
  }
  return found ? parseMcpServerMap(result) : undefined;
}

/** Freeze concrete skill directories so later scans cannot acquire extra siblings. */
export async function discoverPluginSkills(
  packageDir: string,
  scan: PackageScan,
  declaration: PluginManifest['skills'],
  readText: (path: string) => Promise<string> = readTextFile,
): Promise<{ name: string; path: string }[]> {
  const explicit = new Set((typeof declaration === 'string' ? [declaration] : declaration ?? [])
    .map(normalizePluginComponentPath));
  const roots = new Set(['skills', ...explicit]);
  const files = new Map<string, string>();
  async function skillFile(path: string): Promise<string | undefined> {
    for (const name of ['SKILL.md', 'skill.md']) {
      const relative = path === '.' ? name : `${path}/${name}`;
      const entry = await scan.find(relative);
      if (entry && !entry.isDirectory) return relative;
    }
  }
  for (const path of roots) {
    const entry = path === '.' ? { isDirectory: true } : await scan.find(path);
    if (!entry?.isDirectory) {
      if (explicit.has(path)) componentMissing(`skills:${path}`);
      continue;
    }
    const direct = await skillFile(path);
    let foundSkill = false;
    if (direct && (path !== 'skills' || explicit.has(path))) {
      files.set(path, direct);
      foundSkill = true;
      if (path !== 'skills') continue;
    }
    for (const child of (await scan.children(path === '.' ? '' : path)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!child.isDirectory) continue;
      const childPath = path === '.' ? child.name : `${path}/${child.name}`;
      const file = await skillFile(childPath);
      if (file) {
        files.set(childPath, file);
        foundSkill = true;
      }
    }
    if (explicit.has(path) && !foundSkill) {
      throw new PluginManifestError(format(getI18n().toolbox.pluginsComponentEmptySkills, { field: path }), path);
    }
  }
  const skills: { name: string; path: string }[] = [];
  for (const [path, file] of files) {
    const skill = parseSkillFile(await readText(joinPath(packageDir, file)), joinPath(packageDir, file));
    if (!skill) {
      throw new PluginManifestError(format(getI18n().toolbox.pluginsManifestInvalidField, { field: file }), file);
    }
    skills.push({ name: skill.name, path });
  }
  return skills;
}
