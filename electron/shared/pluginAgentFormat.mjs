export const BUILTIN_AGENT_NAMES = Object.freeze(['abu', '高级开发工程师', '产品经理', '数据分析师', '公众号编辑', 'HR 招聘官']);
// Shared pure format used by Electron approval/materialization and renderer.
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
const AGENT_SOURCE_PLUGIN_PREFIX = 'plugin:';
export function formatAgentSource(source) {
    if (!source || source.kind !== 'plugin')
        return undefined;
    const plugin = source.plugin.trim();
    return plugin === '' ? undefined : `${AGENT_SOURCE_PLUGIN_PREFIX}${plugin}`;
}
export function serializeAgentMd(metadata, systemPrompt) {
    const meta = {};
    const set = (key, value) => {
        if (value === undefined || value === null || value === '')
            return;
        if (Array.isArray(value) && value.length === 0)
            return;
        meta[key] = value;
    };
    set('name', metadata.name);
    set('role-id', metadata.roleId);
    set('created', metadata.createdAt);
    set('description', metadata.description);
    set('avatar', metadata.avatar);
    set('model', metadata.model);
    set('max-turns', metadata.maxTurns);
    set('tools', metadata.tools);
    set('disallowed-tools', metadata.disallowedTools);
    set('skills', metadata.skills);
    set('memory', metadata.memory);
    if (metadata.background)
        set('background', true);
    // Provenance, if any. Emitted as the same `plugin:<key>` scalar the parser
    // reads, so an agent written by the plugin installer and one re-saved by the
    // editor carry it identically.
    set('source', formatAgentSource(metadata.source));
    // Display-only fields for the toolbox detail panel and chat welcome banner.
    // Skipped when empty so the AGENT.md frontmatter stays minimal.
    set('intro', metadata.intro);
    set('expertise', metadata.expertise);
    set('sample-prompts', metadata.samplePrompts);
    set('category', metadata.category);
    set('tags', metadata.tags);
    const yaml = stringifyYaml(meta, { lineWidth: 0 }).trimEnd();
    return `---\n${yaml}\n---\n\n${systemPrompt}`;
}
export const AGENT_FRONTMATTER_ALLOWLIST = [
    'name',
    'description',
    'avatar',
    'model',
    'max-turns',
    'tools',
    'disallowed-tools',
    'skills',
    'memory',
    'background',
    'intro',
    'expertise',
    'sample-prompts',
    'category',
    'tags',
    'source',
];
/** Allowlisted keys whose value is a list, however the author spelled it. */
const LIST_KEYS = ['tools', 'disallowed-tools', 'skills', 'tags'];
/**
 * Allowlisted (i.e. `parseAgentFile` reads them) but never carried over from
 * the package's own frontmatter.
 *
 * `memory` stays in the allowlist because that constant documents the parser's
 * key set, but no converted agent carries it: writing a package's own
 * `memory: user` back out would hand a stranger's agent a claim over the user's
 * memory, and writing anything else would state a restriction nothing enforces.
 * Absent, the agent reads exactly like one whose author never declared it.
 *
 * `source` is dropped for a sharper reason: it is provenance, and provenance is
 * the host's statement, not the package's. A package declaring
 * `source: plugin:trusted-vendor@official` would otherwise get to label itself
 * as coming from somewhere it does not. The only `source` a converted agent
 * carries is the one `renderAgentMd` injects from the key the installer is
 * actually installing under (spec §1).
 */
const DROPPED_KEYS = ['memory', 'source'];
/**
 * Frontmatter fence, matched the way `parseAgentFile` matches it: the FIRST
 * `---` line after the opening one closes the block, so a `---` horizontal
 * rule inside the prose stays prose (the Vercel plugin's `deployment-expert.md`
 * uses several).
 *
 * Two deliberate differences from the parser's regex: the trailing body group
 * is optional, so a file that is nothing but frontmatter converts to an empty
 * body instead of being read as one big body; and the run of spaces after a
 * fence is `[^\S\n]*` rather than `\s*`, which cannot swallow the newline that
 * delimits the fence itself. Neither can make this accept something the parser
 * would reject downstream: `renderAgentMd` re-serializes from scratch.
 */
const FRONTMATTER_RE = /^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*(?:\n([\s\S]*))?$/;
/**
 * Convert one single-file agent into Abu's shape.
 *
 * `fallbackName` is what the caller would have called this agent without
 * frontmatter — the file's basename. A package that omits `name`, or gives one
 * that is blank or not a string, gets it; nothing is rejected for it.
 */
export function convertSingleFileAgent(raw, fallbackName) {
    const match = raw.match(FRONTMATTER_RE);
    // No frontmatter at all is a legitimate shape: the whole file is the prompt.
    // So is frontmatter that YAML cannot parse — the body is still the prompt,
    // there is simply no metadata to keep. Both land on the fallback name.
    let meta = {};
    let body;
    if (!match) {
        body = raw;
    }
    else {
        body = match[2] ?? '';
        try {
            const parsed = parseYaml(match[1]);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                meta = parsed;
            }
        }
        catch {
            // Leave `meta` empty — see above.
        }
    }
    const frontmatter = {};
    for (const key of AGENT_FRONTMATTER_ALLOWLIST) {
        if (!(key in meta))
            continue;
        if (DROPPED_KEYS.includes(key))
            continue;
        const value = meta[key];
        if (value === undefined || value === null)
            continue;
        if (LIST_KEYS.includes(key)) {
            const list = normalizeList(value);
            if (list.length > 0)
                frontmatter[key] = list;
            continue;
        }
        frontmatter[key] = value;
    }
    const name = typeof frontmatter.name === 'string' && frontmatter.name.trim().length > 0
        ? frontmatter.name.trim()
        : fallbackName;
    const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
    frontmatter.name = name;
    if (description === '') {
        delete frontmatter.description;
    }
    else {
        frontmatter.description = description;
    }
    return { name, description, frontmatter, body };
}
/**
 * Accept both list spellings and produce one clean list.
 *
 * `tools: Read, Grep` (a comma-separated scalar) is how the ecosystem's
 * single-file agents usually write it; `tools:\n  - Read` is how Abu writes it.
 * Both mean the same thing, so both come out trimmed, empty-filtered and
 * de-duplicated, order preserved. Anything that is neither a string nor an
 * array yields nothing, and the key is dropped.
 */
function normalizeList(value) {
    const parts = typeof value === 'string'
        ? value.split(',')
        : Array.isArray(value)
            ? value.filter((v) => typeof v === 'string')
            : [];
    const out = [];
    for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed === '' || out.includes(trimmed))
            continue;
        out.push(trimmed);
    }
    return out;
}
/**
 * Render a converted agent as AGENT.md text.
 *
 * Goes through `serializeAgentMd` — the same function `AgentEditor` writes
 * user-authored agents with — so a plugin's agent is byte-compatible with one
 * the user typed, and a change to Abu's format reaches both at once.
 *
 * The body is trimmed because that is what the round trip settles on anyway:
 * `parseAgentFile` trims the prompt on read, and the serializer supplies its
 * own blank line after the closing fence.
 *
 * `options.pluginKey` is the ONLY way a `source:` key reaches the output: pass
 * the key the install record will carry and the agent is stamped with it; omit
 * it and the file has no provenance. A package's own `source:` never survives
 * (see {@link DROPPED_KEYS}).
 */
export function renderAgentMd(agent, options) {
    const fm = agent.frontmatter;
    const pluginKey = options?.pluginKey?.trim();
    const metadata = {
        name: agent.name,
        description: agent.description,
        avatar: asString(fm.avatar),
        model: asString(fm.model),
        maxTurns: typeof fm['max-turns'] === 'number' ? fm['max-turns'] : undefined,
        tools: asStringArray(fm.tools),
        disallowedTools: asStringArray(fm['disallowed-tools']),
        skills: asStringArray(fm.skills),
        background: fm.background === true,
        intro: asString(fm.intro),
        expertise: asStringArray(fm.expertise),
        samplePrompts: asStringArray(fm['sample-prompts']),
        category: asString(fm.category),
        tags: asStringArray(fm.tags),
        // Provenance comes from the caller — never from `fm`, which had `source`
        // dropped on conversion. Rendering the same agent without a key (the
        // user-authored path) writes no `source` at all.
        source: pluginKey ? { kind: 'plugin', plugin: pluginKey } : undefined,
    };
    // No `memory`: `serializeAgentMd` omits an undefined one, so the AGENT.md
    // simply has no such key and `parseAgentFile` applies its own default on read
    // (spec §4).
    return serializeAgentMd(metadata, agent.body.trim());
}
function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const list = value.filter((v) => typeof v === 'string');
    return list.length > 0 ? list : undefined;
}
