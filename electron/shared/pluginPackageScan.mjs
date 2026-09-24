// Node-side scan of a plugin package directory on disk: the names of what it
// ships, for `pluginAppSpec` reference checks. Used by
// `scripts/validate-plugin-market.mjs`; the renderer installer walks the
// same layout through its Tauri-backed `PackageScan`.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { convertSingleFileAgent } from './pluginAgentFormat.mjs';
import { PluginManifestError } from './pluginManifestError.mjs';
import { isSafeSkillDirName } from './skillDirName.mjs';

export const MANIFEST_CANDIDATES = Object.freeze([
    '.abu-plugin/plugin.json',
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
]);

const SKILL_FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

function ownedEntry(dir, name) {
    const stat = lstatSync(path.join(dir, name));
    // Links are refused by the installer's copy, so they are invisible here too.
    if (stat.isSymbolicLink()) return undefined;
    return { name, isDirectory: stat.isDirectory(), isFile: stat.isFile() };
}

function ownedChildren(dir) {
    let names;
    try {
        names = readdirSync(dir);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
        throw error;
    }
    return names.map(name => ownedEntry(dir, name)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

/** The owned entry at `relative`, walking only through owned directories. */
function ownedPath(root, relative) {
    const segments = relative.split('/').filter(segment => segment !== '' && segment !== '.');
    let dir = root;
    let entry;
    for (const segment of segments) {
        entry = ownedChildren(dir).find(child => child.name === segment);
        if (!entry) return undefined;
        if (segment !== segments[segments.length - 1] && !entry.isDirectory) return undefined;
        dir = path.join(dir, segment);
    }
    return entry ? { ...entry, absolute: dir } : undefined;
}

function ownedFile(root, relative) {
    const entry = ownedPath(root, relative);
    return entry?.isFile ? entry.absolute : undefined;
}

function ownedDir(root, relative) {
    if (relative === '.' || relative === '') return root;
    const entry = ownedPath(root, relative);
    return entry?.isDirectory ? entry.absolute : undefined;
}

function readJson(file, field) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        throw new PluginManifestError(`${field}: is not valid JSON`, field, 'type');
    }
}

/** The manifest object and the candidate path it was read from. */
export function readManifestRaw(packageDir) {
    for (const candidate of MANIFEST_CANDIDATES) {
        const file = ownedFile(packageDir, candidate);
        if (!file) continue;
        return { raw: readJson(file, candidate), relPath: candidate };
    }
    throw new PluginManifestError(`no plugin manifest found (looked for ${MANIFEST_CANDIDATES.join(', ')})`, 'manifest', 'missing');
}

/**
 * SKILL.md `name`, read the way the skill loader reads it — including the rule
 * that turns the name into a directory (`parseSkillFile` refuses the rest), so
 * a name this returns is a name the installer accepts.
 */
export function readSkillName(markdown) {
    // A checkout with core.autocrlf leaves CRLF in the working tree; the
    // frontmatter block is parsed with LF endings either way.
    const match = markdown.replace(/\r\n?/g, '\n').match(SKILL_FRONTMATTER_RE);
    if (!match) return undefined;
    const meta = parseYaml(match[1]);
    if (!meta || typeof meta !== 'object' || typeof meta.name !== 'string') return undefined;
    return isSafeSkillDirName(meta.name) ? meta.name : undefined;
}

function skillFile(packageDir, relDir) {
    for (const name of ['SKILL.md', 'skill.md']) {
        const file = ownedFile(packageDir, relDir === '.' ? name : `${relDir}/${name}`);
        if (file) return file;
    }
    return undefined;
}

/** Skill names under `skills/` and the manifest's explicit `skills` paths (see `discoverPluginSkills`). */
export function scanSkillNames(packageDir, declaration) {
    const explicit = (typeof declaration === 'string' ? [declaration] : declaration ?? []).map(entry => entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.');
    const files = new Map();
    for (const relDir of new Set(['skills', ...explicit])) {
        const absoluteDir = ownedDir(packageDir, relDir);
        if (!absoluteDir) continue;
        const direct = skillFile(packageDir, relDir);
        if (direct && (relDir !== 'skills' || explicit.includes(relDir))) {
            files.set(relDir, direct);
            if (relDir !== 'skills') continue;
        }
        for (const child of ownedChildren(absoluteDir)) {
            if (!child.isDirectory) continue;
            const childDir = relDir === '.' ? child.name : `${relDir}/${child.name}`;
            const file = skillFile(packageDir, childDir);
            if (file) files.set(childDir, file);
        }
    }
    const names = [];
    for (const [relDir, file] of files) {
        const name = readSkillName(readFileSync(file, 'utf8'));
        if (name === undefined) throw new PluginManifestError(`${relDir}: SKILL.md has no usable frontmatter name`, relDir, 'missing');
        names.push(name);
    }
    return names;
}

/** Agent names under `agents/`, both the folder shape and the single-file shape (see `readPayloadAgents`). */
export function scanAgentNames(packageDir) {
    const names = new Set();
    const agentsDir = ownedDir(packageDir, 'agents');
    if (!agentsDir) return [];
    for (const entry of ownedChildren(agentsDir)) {
        let file;
        let fallbackName;
        if (entry.isDirectory) {
            file = ownedFile(packageDir, `agents/${entry.name}/AGENT.md`);
            fallbackName = entry.name;
        } else if (/\.md$/i.test(entry.name)) {
            file = path.join(packageDir, 'agents', entry.name);
            fallbackName = entry.name.replace(/\.md$/i, '');
        }
        if (!file) continue;
        names.add(convertSingleFileAgent(readFileSync(file, 'utf8'), fallbackName).name);
    }
    return [...names];
}

/** `teams/<id>.json` files as `{ id, raw }`, sorted by id. */
export function scanTeamFiles(packageDir) {
    const teamsDir = ownedDir(packageDir, 'teams');
    if (!teamsDir) return [];
    return ownedChildren(teamsDir)
        .filter(entry => entry.isFile && /\.json$/i.test(entry.name))
        .map(entry => ({ id: entry.name.replace(/\.json$/i, ''), raw: readJson(path.join(packageDir, 'teams', entry.name), `teams/${entry.name}`) }));
}

/**
 * MCP server names from the manifest's inline map, its file reference and
 * `.mcp.json`, merged by `resolvePluginMcpServers`' rules: a map is an object
 * and never an array, a wrapper file holds nothing but its one `mcpServers` /
 * `mcp_servers` key, and two sources never declare the same name.
 */
export function scanMcpServerNames(packageDir, declaration) {
    const names = new Set();
    const addAll = (map, field) => {
        if (!map || typeof map !== 'object' || Array.isArray(map)) {
            throw new PluginManifestError(`${field}: must be an object mapping server names to their declarations`, field, 'type');
        }
        for (const name of Object.keys(map)) {
            if (names.has(name)) throw new PluginManifestError(`mcpServers.${name}: declared twice`, `mcpServers.${name}`, 'duplicate');
            names.add(name);
        }
    };
    if (declaration !== undefined && typeof declaration !== 'string') addAll(declaration, 'mcpServers');
    const files = new Set(['.mcp.json']);
    if (typeof declaration === 'string') files.add(declaration.replace(/\\/g, '/').replace(/^\.\//, ''));
    for (const relPath of files) {
        const file = ownedFile(packageDir, relPath);
        if (!file) {
            if (relPath !== '.mcp.json') throw new PluginManifestError(`${relPath}: is referenced by mcpServers but missing from the package`, relPath, 'missing');
            continue;
        }
        let raw = readJson(file, relPath);
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const wrappers = ['mcpServers', 'mcp_servers'].filter(key => Object.hasOwn(raw, key));
            if (wrappers.length > 0) {
                if (wrappers.length !== 1 || Object.keys(raw).length !== 1) {
                    throw new PluginManifestError(`${relPath}: must hold either the servers themselves or a single mcpServers key`, relPath, 'type');
                }
                raw = raw[wrappers[0]];
            }
        }
        addAll(raw, relPath);
    }
    return [...names];
}

/** True when `relPath` names a regular file the package owns (no link on the way). */
export function packageFileExists(packageDir, relPath) {
    return ownedFile(packageDir, relPath.replace(/\\/g, '/').replace(/^\.\//, '')) !== undefined;
}

/** Everything `parseAppConfig` / `parseTeamFile` need to know about a package on disk. */
export function scanPluginPackageDir(packageDir) {
    const manifest = readManifestRaw(packageDir);
    const raw = manifest.raw && typeof manifest.raw === 'object' ? manifest.raw : {};
    return {
        manifest,
        skillNames: scanSkillNames(packageDir, raw.skills),
        agentNames: scanAgentNames(packageDir),
        teamFiles: scanTeamFiles(packageDir),
        mcpServerNames: scanMcpServerNames(packageDir, raw.mcpServers),
    };
}
