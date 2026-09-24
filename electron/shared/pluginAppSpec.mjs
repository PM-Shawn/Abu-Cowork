// Validation for a package's `app` configuration and `teams/*.json` files
// (developer spec §6, §8, §11). Shared by the renderer installer, the Electron
// plugin hosts and `scripts/validate-plugin-market.mjs`, so a package that
// passes the marketplace check is exactly a package that installs.
import semver from 'semver';
import { PluginManifestError } from './pluginManifestError.mjs';
import { BUILTIN_AGENT_NAMES } from './pluginAgentFormat.mjs';

export const APP_CONFIG_VERSION = 1;
/**
 * The Abu version that introduced `app` and `teams/`. A package using either
 * one names this version or a later one in `minAbuVersion`: an older Abu reads
 * neither field, so a lower number would send the package to installs that
 * quietly drop the app and the teams.
 */
export const APP_SUPPORT_MIN_VERSION = '0.51.0';
export const BUILTIN_TEAM_ID_PREFIX = 'builtin-team:';
export const BUILTIN_AGENT_ROLE_PREFIX = 'builtin:';
export const PLUGIN_AGENT_ROLE_PREFIX = 'plugin:';
export const APP_PAGE_TARGET_PREFIX = 'url:';

/** Ids of the teams that ship with Abu; `src/core/team/builtinTeams.ts` is pinned to this list by test. */
export const BUILTIN_TEAM_IDS = Object.freeze([
    'builtin-team:software-rd',
    'builtin-team:data-analysis',
    'builtin-team:content-creation',
    'builtin-team:reporting',
    'builtin-team:finance-reconciliation',
    'builtin-team:recruiting',
]);

export const APP_BUILTIN_NAV_TARGETS = Object.freeze([
    'builtin:chat',
    'builtin:todos',
    'builtin:inbox',
    'builtin:team',
    'builtin:extensions',
    'builtin:automation',
]);

export const APP_LIMITS = Object.freeze({
    promptAppend: 16000,
    leaderNote: 4000,
    templatesMin: 3,
    templatesMax: 6,
    expertise: 5,
    samplePrompts: 4,
    teamMembersMin: 2,
    idLength: 64,
    // An emoji or an `icon:<name>/<tint>` preset, the same values a user team's avatar takes.
    teamAvatar: 32,
});

const LOCALES = ['zh-CN', 'en-US'];
const TEAM_FILE_ID_RE = /^[a-z0-9-]+$/;
const ID_RE = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
/** The schemes an app page may use; `appPageHost` hands the value to `loadURL`. */
const APP_PAGE_PROTOCOLS = new Set(['https:', 'http:']);

function fail(message, field, reason) {
    throw new PluginManifestError(`${field}: ${message}`, field, reason);
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value, field) {
    if (value === undefined) fail('is required', field, 'missing');
    if (!isPlainObject(value)) fail('must be an object', field, 'type');
    return value;
}

function rejectUnknownKeys(value, field, allowed) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) fail(`unknown field "${key}"`, `${field}.${key}`, 'unknown-field');
    }
}

function optionalString(value, field, max) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') fail('must be a string', field, 'type');
    if (max !== undefined && value.length > max) fail(`must be at most ${max} characters`, field, 'range');
    return value;
}

function requireId(value, field, re = ID_RE) {
    if (value === undefined) fail('is required', field, 'missing');
    if (typeof value !== 'string' || value.length === 0 || value.length > APP_LIMITS.idLength || !re.test(value)) {
        fail(`must match ${re} and be at most ${APP_LIMITS.idLength} characters`, field, 'type');
    }
    return value;
}

function requireArray(value, field, { min = 0, max } = {}) {
    if (value === undefined) {
        if (min > 0) fail('is required', field, 'missing');
        return [];
    }
    if (!Array.isArray(value)) fail('must be an array', field, 'type');
    if (value.length < min) fail(`needs at least ${min} entries`, field, 'range');
    if (max !== undefined && value.length > max) fail(`allows at most ${max} entries`, field, 'range');
    return value;
}

function assertUnique(values, field, label) {
    const seen = new Set();
    values.forEach((value, index) => {
        if (seen.has(value)) fail(`duplicate ${label} "${value}"`, `${field}[${index}]`, 'duplicate');
        seen.add(value);
    });
}

/** A drive letter's colon, a C0 control character, or DEL — none belong in a package path. */
function hasUnsafePathCharacter(value) {
    if (value.includes(':')) return true;
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code < 32 || code === 127) return true;
    }
    return false;
}

/**
 * Package-relative asset path: same rules as `normalizePluginComponentPath`
 * in the renderer (no absolute path, no `~`, no `..`, no drive or control
 * characters), applied to icons, avatars and logos referenced from `app`.
 */
export function isPackageRelativePath(value) {
    if (typeof value !== 'string') return false;
    const path = value.replace(/\\/g, '/');
    if (!path || path.trim() !== path || path.startsWith('/') || path.startsWith('~') || hasUnsafePathCharacter(path)) return false;
    const segments = path.split('/').filter(segment => segment !== '' && segment !== '.');
    return segments.length > 0 && !segments.includes('..');
}

function optionalAssetPath(value, field) {
    if (value === undefined) return undefined;
    if (!isPackageRelativePath(value)) fail('must be a relative path inside the package', field, 'type');
    return value.replace(/\\/g, '/');
}

/** Spec §8.6: a string, or `{ "zh-CN": …, "en-US": … }` with at least one locale. */
export function parseLocalizedText(value, field, { required = false } = {}) {
    if (value === undefined) {
        if (required) fail('is required', field, 'missing');
        return undefined;
    }
    if (typeof value === 'string') {
        if (value.trim().length === 0) fail('must not be empty', field, 'type');
        return value;
    }
    if (!isPlainObject(value)) fail('must be a string or an object keyed by locale', field, 'type');
    const keys = Object.keys(value);
    if (keys.length === 0) fail('needs at least one locale', field, 'missing');
    for (const key of keys) {
        if (!LOCALES.includes(key)) fail(`unknown locale "${key}"`, `${field}.${key}`, 'unknown-field');
        if (typeof value[key] !== 'string' || value[key].trim().length === 0) fail('must be a non-empty string', `${field}.${key}`, 'type');
    }
    return { ...value };
}

/**
 * Is `value` a team id a package may ship (spec §6)? The id becomes a file
 * name under the package's `teams/`, so every surface that turns a recorded id
 * back into a path asks this first.
 */
export function isPluginTeamFileId(value) {
    return typeof value === 'string' && TEAM_FILE_ID_RE.test(value);
}

/** Pick the text for `locale`, then zh-CN, then en-US. */
export function resolveLocalizedText(text, locale) {
    if (text === undefined) return '';
    if (typeof text === 'string') return text;
    return text[locale] ?? text['zh-CN'] ?? text['en-US'] ?? '';
}

function localizedList(value, field, max) {
    return requireArray(value, field, { max }).map((entry, index) => parseLocalizedText(entry, `${field}[${index}]`, { required: true }));
}

/** Resolve one expert reference (spec §6) to a role id. */
function resolveExpertReference(value, field, ctx) {
    if (typeof value !== 'string' || value.length === 0) fail('must be an expert name', field, 'type');
    if (value.startsWith(BUILTIN_AGENT_ROLE_PREFIX)) {
        const name = value.slice(BUILTIN_AGENT_ROLE_PREFIX.length);
        if (!BUILTIN_AGENT_NAMES.includes(name)) fail(`built-in expert "${name}" does not exist`, field, 'unknown-reference');
        return value;
    }
    if (!ctx.agentNames.has(value)) fail(`expert "${value}" is not in this package's agents/`, field, 'unknown-reference');
    return `${PLUGIN_AGENT_ROLE_PREFIX}${value}`;
}

/**
 * Validate one `teams/<id>.json` (spec §6). `ctx.agentNames` holds the names
 * of the package's own experts.
 */
export function parseTeamFile(raw, id, ctx) {
    const field = `teams.${id}`;
    if (typeof id !== 'string' || !TEAM_FILE_ID_RE.test(id)) fail(`team id must match ${TEAM_FILE_ID_RE}`, field, 'type');
    const team = requireObject(raw, field);
    rejectUnknownKeys(team, field, ['name', 'leader', 'members', 'leaderNote', 'requirePlanApproval', 'avatar', 'description', 'intro', 'expertise', 'samplePrompts']);
    const agentNames = new Set(ctx?.agentNames ?? []);
    const refCtx = { agentNames };
    const members = requireArray(team.members, `${field}.members`, { min: APP_LIMITS.teamMembersMin });
    assertUnique(members, `${field}.members`, 'member');
    const memberRoleIds = members.map((member, index) => resolveExpertReference(member, `${field}.members[${index}]`, refCtx));
    if (team.leader === undefined) fail('is required', `${field}.leader`, 'missing');
    const leaderRoleId = resolveExpertReference(team.leader, `${field}.leader`, refCtx);
    if (!memberRoleIds.includes(leaderRoleId)) fail('leader must also be listed in members', `${field}.leader`, 'unknown-reference');
    if (team.requirePlanApproval !== undefined && typeof team.requirePlanApproval !== 'boolean') fail('must be a boolean', `${field}.requirePlanApproval`, 'type');
    return {
        id,
        name: parseLocalizedText(team.name, `${field}.name`, { required: true }),
        leaderRoleId,
        memberRoleIds,
        leaderNote: optionalString(team.leaderNote, `${field}.leaderNote`, APP_LIMITS.leaderNote),
        requirePlanApproval: team.requirePlanApproval === true,
        avatar: optionalString(team.avatar, `${field}.avatar`, APP_LIMITS.teamAvatar),
        description: parseLocalizedText(team.description, `${field}.description`, { required: true }),
        intro: parseLocalizedText(team.intro, `${field}.intro`),
        expertise: localizedList(team.expertise, `${field}.expertise`, APP_LIMITS.expertise),
        samplePrompts: localizedList(team.samplePrompts, `${field}.samplePrompts`, APP_LIMITS.samplePrompts),
    };
}

/** Spec §8.3: exactly one of `team`, `expert`, `skill`, each resolving to something that exists. */
function parseRunRef(value, field, ctx) {
    if (value === undefined) return undefined;
    const ref = requireObject(value, field);
    const keys = Object.keys(ref);
    if (keys.length !== 1 || !['team', 'expert', 'skill'].includes(keys[0])) fail('must be exactly one of { team } / { expert } / { skill }', field, 'type');
    const kind = keys[0];
    const target = ref[kind];
    if (typeof target !== 'string' || target.length === 0) fail('must be a non-empty string', `${field}.${kind}`, 'type');
    if (kind === 'team') {
        if (target.startsWith(BUILTIN_TEAM_ID_PREFIX)) {
            if (!BUILTIN_TEAM_IDS.includes(target)) fail(`built-in team "${target}" does not exist`, `${field}.team`, 'unknown-reference');
        } else if (!ctx.teamIds.has(target)) {
            fail(`team "${target}" is not in this package's teams/`, `${field}.team`, 'unknown-reference');
        }
        return { team: target };
    }
    if (kind === 'expert') {
        if (target.startsWith(BUILTIN_AGENT_ROLE_PREFIX)) {
            const name = target.slice(BUILTIN_AGENT_ROLE_PREFIX.length);
            if (!BUILTIN_AGENT_NAMES.includes(name)) fail(`built-in expert "${name}" does not exist`, `${field}.expert`, 'unknown-reference');
        } else if (!ctx.agentNames.has(target)) {
            fail(`expert "${target}" is not in this package's agents/`, `${field}.expert`, 'unknown-reference');
        }
        return { expert: target };
    }
    if (!ctx.skillNames.has(target)) fail(`skill "${target}" is not in this package's skills/`, `${field}.skill`, 'unknown-reference');
    return { skill: target };
}

/**
 * Spec §8.5: `https://host[:port]`, or `http://127.0.0.1[:port]` /
 * `http://localhost[:port]` for local preview. No path, query, hash,
 * credentials or wildcard.
 */
export function isAllowedAppPageOrigin(value) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('*')) return false;
    let url;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.pathname !== '/' || value.endsWith('/')) return false;
    if (url.origin !== value) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

function parseAllowedOrigins(value, field) {
    const origins = requireArray(value, field);
    origins.forEach((origin, index) => {
        if (!isAllowedAppPageOrigin(origin)) fail('must be https://host[:port] (or http://127.0.0.1 / http://localhost for local preview) without path, query or wildcard', `${field}[${index}]`, 'origin');
    });
    assertUnique(origins, field, 'origin');
    return origins;
}

function parseTemplates(value, field) {
    const templates = requireArray(value, field, { min: APP_LIMITS.templatesMin, max: APP_LIMITS.templatesMax }).map((entry, index) => {
        const itemField = `${field}[${index}]`;
        const template = requireObject(entry, itemField);
        rejectUnknownKeys(template, itemField, ['id', 'title', 'prompt']);
        return {
            id: requireId(template.id, `${itemField}.id`),
            title: parseLocalizedText(template.title, `${itemField}.title`, { required: true }),
            prompt: parseLocalizedText(template.prompt, `${itemField}.prompt`, { required: true }),
        };
    });
    assertUnique(templates.map(template => template.id), field, 'template id');
    return templates;
}

function parseScenes(value, field, ctx) {
    const scenes = requireArray(value, field, { min: 1 }).map((entry, index) => {
        const itemField = `${field}[${index}]`;
        const scene = requireObject(entry, itemField);
        rejectUnknownKeys(scene, itemField, ['id', 'title', 'icon', 'run', 'promptAppend', 'placeholder', 'templates']);
        return {
            id: requireId(scene.id, `${itemField}.id`),
            title: parseLocalizedText(scene.title, `${itemField}.title`, { required: true }),
            icon: optionalAssetPath(scene.icon, `${itemField}.icon`),
            run: parseRunRef(scene.run, `${itemField}.run`, ctx),
            promptAppend: optionalString(scene.promptAppend, `${itemField}.promptAppend`, APP_LIMITS.promptAppend),
            placeholder: parseLocalizedText(scene.placeholder, `${itemField}.placeholder`),
            templates: parseTemplates(scene.templates, `${itemField}.templates`),
        };
    });
    assertUnique(scenes.map(scene => scene.id), field, 'scene id');
    return scenes;
}

function parseHome(value, field, ctx) {
    const home = requireObject(value, field);
    rejectUnknownKeys(home, field, ['header', 'modes']);
    let header;
    if (home.header !== undefined) {
        const rawHeader = requireObject(home.header, `${field}.header`);
        rejectUnknownKeys(rawHeader, `${field}.header`, ['title', 'slogan']);
        header = {
            title: parseLocalizedText(rawHeader.title, `${field}.header.title`),
            slogan: parseLocalizedText(rawHeader.slogan, `${field}.header.slogan`),
        };
    }
    const modes = requireObject(home.modes, `${field}.modes`);
    rejectUnknownKeys(modes, `${field}.modes`, ['defaultSelected', 'items']);
    const items = requireArray(modes.items, `${field}.modes.items`, { min: 1 }).map((entry, index) => {
        const itemField = `${field}.modes.items[${index}]`;
        const mode = requireObject(entry, itemField);
        rejectUnknownKeys(mode, itemField, ['modeId', 'title', 'icon', 'promptAppend', 'scenes']);
        return {
            modeId: requireId(mode.modeId, `${itemField}.modeId`),
            title: parseLocalizedText(mode.title, `${itemField}.title`, { required: true }),
            icon: optionalAssetPath(mode.icon, `${itemField}.icon`),
            promptAppend: optionalString(mode.promptAppend, `${itemField}.promptAppend`, APP_LIMITS.promptAppend),
            scenes: parseScenes(mode.scenes, `${itemField}.scenes`, ctx),
        };
    });
    assertUnique(items.map(mode => mode.modeId), `${field}.modes.items`, 'modeId');
    const defaultSelected = optionalString(modes.defaultSelected, `${field}.modes.defaultSelected`);
    if (defaultSelected !== undefined && !items.some(mode => mode.modeId === defaultSelected)) {
        fail(`"${defaultSelected}" is not a modeId of this app`, `${field}.modes.defaultSelected`, 'unknown-reference');
    }
    return { header, modes: { defaultSelected, items } };
}

/** The URL a `url:` nav target points at, or undefined for built-in targets. */
export function appPageUrl(target) {
    return typeof target === 'string' && target.startsWith(APP_PAGE_TARGET_PREFIX) ? target.slice(APP_PAGE_TARGET_PREFIX.length) : undefined;
}

function parseNav(value, field, allowedOrigins) {
    const nav = requireObject(value, field);
    rejectUnknownKeys(nav, field, ['items']);
    const items = requireArray(nav.items, `${field}.items`, { min: 1 }).map((entry, index) => {
        const itemField = `${field}.items[${index}]`;
        const item = requireObject(entry, itemField);
        rejectUnknownKeys(item, itemField, ['id', 'title', 'icon', 'order', 'target']);
        if (item.order !== undefined && (typeof item.order !== 'number' || !Number.isFinite(item.order))) fail('must be a number', `${itemField}.order`, 'type');
        const target = item.target;
        if (typeof target !== 'string') fail('is required', `${itemField}.target`, 'missing');
        const url = appPageUrl(target);
        if (url === undefined) {
            if (!APP_BUILTIN_NAV_TARGETS.includes(target)) fail(`unknown target "${target}"`, `${itemField}.target`, 'type');
        } else {
            let parsed;
            try {
                parsed = new URL(url);
            } catch {
                fail('url: target must be an absolute URL', `${itemField}.target`, 'type');
            }
            // A scheme that borrows its origin from an inner URL (`blob:`,
            // `filesystem:`) passes an origin comparison while naming something
            // else entirely, so the scheme is settled before the origin is.
            if (!APP_PAGE_PROTOCOLS.has(parsed.protocol)) fail('url: target must be an http(s) address', `${itemField}.target`, 'origin');
            if (parsed.username || parsed.password) fail('url: target must not carry credentials', `${itemField}.target`, 'origin');
            if (!allowedOrigins.includes(parsed.origin)) fail(`origin ${parsed.origin} is not listed in app.allowedOrigins`, `${itemField}.target`, 'origin');
            if (item.title === undefined) fail('is required for url: targets', `${itemField}.title`, 'missing');
        }
        return {
            id: requireId(item.id, `${itemField}.id`),
            title: parseLocalizedText(item.title, `${itemField}.title`),
            icon: optionalAssetPath(item.icon, `${itemField}.icon`),
            order: item.order,
            target,
        };
    });
    assertUnique(items.map(item => item.id), `${field}.items`, 'nav id');
    const chatEntries = items.filter(item => item.target === 'builtin:chat').length;
    if (chatEntries !== 1) fail('must contain builtin:chat exactly once', `${field}.items`, chatEntries === 0 ? 'missing' : 'duplicate');
    return { items };
}

/**
 * Validate a manifest's `app` field (spec §8). `ctx` names what the package
 * itself ships: `teamIds` (from `teams/`), `agentNames` (from `agents/`),
 * `skillNames` (SKILL.md `name`s) and `mcpServerNames`.
 */
export function parseAppConfig(raw, ctx) {
    const field = 'app';
    const app = requireObject(raw, field);
    rejectUnknownKeys(app, field, ['version', 'home', 'defaultRun', 'promptAppend', 'nav', 'allowedOrigins', 'requiredConnectors', 'composer']);
    if (app.version !== APP_CONFIG_VERSION) fail(`must be ${APP_CONFIG_VERSION}`, `${field}.version`, 'version');
    const refCtx = {
        teamIds: new Set(ctx?.teamIds ?? []),
        agentNames: new Set(ctx?.agentNames ?? []),
        skillNames: new Set(ctx?.skillNames ?? []),
    };
    const mcpServerNames = new Set(ctx?.mcpServerNames ?? []);
    const allowedOrigins = parseAllowedOrigins(app.allowedOrigins, `${field}.allowedOrigins`);
    const requiredConnectors = requireArray(app.requiredConnectors, `${field}.requiredConnectors`);
    requiredConnectors.forEach((name, index) => {
        if (typeof name !== 'string' || !mcpServerNames.has(name)) fail(`connector "${name}" is not declared in mcpServers`, `${field}.requiredConnectors[${index}]`, 'unknown-reference');
    });
    assertUnique(requiredConnectors, `${field}.requiredConnectors`, 'connector');
    let composer;
    if (app.composer !== undefined) {
        const rawComposer = requireObject(app.composer, `${field}.composer`);
        rejectUnknownKeys(rawComposer, `${field}.composer`, ['placeholder']);
        composer = { placeholder: parseLocalizedText(rawComposer.placeholder, `${field}.composer.placeholder`) };
    }
    const config = {
        version: APP_CONFIG_VERSION,
        home: parseHome(app.home, `${field}.home`, refCtx),
        defaultRun: parseRunRef(app.defaultRun, `${field}.defaultRun`, refCtx),
        promptAppend: optionalString(app.promptAppend, `${field}.promptAppend`, APP_LIMITS.promptAppend),
        nav: app.nav === undefined ? undefined : parseNav(app.nav, `${field}.nav`, allowedOrigins),
        allowedOrigins: app.allowedOrigins === undefined ? undefined : allowedOrigins,
        requiredConnectors: app.requiredConnectors === undefined ? undefined : requiredConnectors,
        composer,
    };
    const pageItems = config.nav?.items.filter(item => appPageUrl(item.target) !== undefined) ?? [];
    if (pageItems.length > 0 && app.allowedOrigins === undefined) fail('is required when nav has url: targets', `${field}.allowedOrigins`, 'missing');
    return config;
}

/** The page URL behind a validated `url:` nav item; throws for unknown or built-in items. */
export function resolveAppPageUrl(config, navItemId) {
    const item = config.nav?.items.find(entry => entry.id === navItemId);
    if (!item) fail(`nav item "${navItemId}" does not exist`, 'app.nav.items', 'unknown-reference');
    const url = appPageUrl(item.target);
    if (url === undefined) fail(`nav item "${navItemId}" is not a url: target`, 'app.nav.items', 'type');
    const parsed = new URL(url);
    // The host hands this straight to `loadURL`, so the scheme is settled here
    // too and not only where the config was first validated.
    if (!APP_PAGE_PROTOCOLS.has(parsed.protocol)) fail(`nav item "${navItemId}" is not an http(s) address`, 'app.nav.items', 'origin');
    if (!(config.allowedOrigins ?? []).includes(parsed.origin)) fail(`origin ${parsed.origin} is not listed in app.allowedOrigins`, 'app.allowedOrigins', 'origin');
    return url;
}

/** Spec §11: `minAbuVersion`, when present, is a semantic version. */
export function validateMinAbuVersion(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || semver.valid(value) === null) fail('must be a semantic version such as 0.51.0', 'minAbuVersion', 'version');
    return value;
}

/** Spec §11: a package using `app` or `teams/` declares `minAbuVersion`, `APP_SUPPORT_MIN_VERSION` or newer. */
export function assertMinAbuVersionDeclared(manifest, { hasTeams = false } = {}) {
    const usesNewFields = manifest.app !== undefined || hasTeams;
    if (!usesNewFields) return;
    if (manifest.minAbuVersion === undefined) fail('is required when the package uses app or teams/', 'minAbuVersion', 'missing');
    const declared = validateMinAbuVersion(manifest.minAbuVersion);
    // Judged by the release the value belongs to, so a package written against
    // a pre-release of that version (0.51.0-rc.1) is accepted.
    if (semver.lt(semver.coerce(declared) ?? declared, APP_SUPPORT_MIN_VERSION)) {
        fail(`must be ${APP_SUPPORT_MIN_VERSION} or newer: app and teams/ arrived in Abu ${APP_SUPPORT_MIN_VERSION}`, 'minAbuVersion', 'version');
    }
}

/** Does this Abu (`appVersion`) satisfy the package's `minAbuVersion`? */
export function checkMinAbuVersion(manifest, appVersion) {
    const required = validateMinAbuVersion(manifest.minAbuVersion);
    if (required === undefined) return { ok: true };
    if (semver.valid(appVersion) === null) fail(`host version "${appVersion}" is not a semantic version`, 'minAbuVersion', 'version');
    return { ok: semver.gte(appVersion, required), required };
}
