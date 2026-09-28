// Validation for an app (docs/app-spec.md): the `.abu-app/app.json` file a
// developer writes, and the same configuration when it arrives from an
// organization console or from 「创建应用」. Shared by the renderer, the Electron
// hosts and `scripts/validate-plugin-market.mjs`, so an app that passes the
// marketplace check is exactly an app that can be added.
//
// This file checks the app on its own: fields, ids, limits and the shape of
// every reference. Whether a reference names something that exists on this
// machine is answered later, against the live catalog (`src/core/app/appRefs.ts`).
import semver from 'semver';
import { BUILTIN_AGENT_NAMES } from './pluginAgentFormat.mjs';
import { assertMinAbuVersionAtLeast, BUILTIN_TEAM_IDS, isPluginTeamFileId, validateMinAbuVersion } from './pluginSpec.mjs';
import {
    assertUnique,
    fail,
    optionalAssetPath,
    optionalString,
    parseLocalizedText,
    requireArray,
    requireId,
    requireObject,
    requireString,
    rejectUnknownKeys,
} from './specFields.mjs';

export const APP_FILE_PATH = '.abu-app/app.json';
export const APP_CONFIG_VERSION = 1;
/** The Abu version that introduced apps; an app's `minAbuVersion` is this or newer. */
export const APPS_MIN_ABU_VERSION = '0.51.0';
export const APP_PAGE_TARGET_PREFIX = 'url:';

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
    templatesMin: 3,
    templatesMax: 6,
    nameLength: 64,
});

/**
 * Reference prefixes, by where the app comes from. A packaged app (a market
 * or a folder) can only name what Abu ships or what its own plugins bring; an
 * app made in 「创建应用」 can also name the user's own experts and teams; an
 * organization app names only what the organization published.
 */
export const RUN_REF_PREFIXES = Object.freeze({
    team: Object.freeze({ builtin: 'builtin-team:', plugin: 'plugin:', mine: 'mine:', enterprise: 'enterprise-team:' }),
    expert: Object.freeze({ builtin: 'builtin:', plugin: 'plugin:', mine: 'mine:', enterprise: 'enterprise-agent:' }),
    skill: Object.freeze({ plugin: 'plugin:', enterprise: 'enterprise:' }),
});

const ORIGINS_BY_SOURCE = Object.freeze({
    package: Object.freeze(['builtin', 'plugin']),
    created: Object.freeze(['builtin', 'plugin', 'mine']),
    enterprise: Object.freeze(['enterprise']),
});

const APP_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
/** The schemes an app page may use; `appPageHost` hands the value to `loadURL`. */
const APP_PAGE_PROTOCOLS = new Set(['https:', 'http:']);

function assertSource(source) {
    if (!Object.hasOwn(ORIGINS_BY_SOURCE, source)) throw new Error(`unknown app source "${source}"`);
}

/**
 * Split a reference target into where it comes from and what it names:
 * `builtin-team:recruiting` → `{ origin: 'builtin', id: 'builtin-team:recruiting' }`,
 * `plugin:shop/ops` → `{ origin: 'plugin', plugin: 'shop', id: 'ops' }`,
 * `mine:周报` → `{ origin: 'mine', id: '周报' }`,
 * `enterprise-agent:<uuid>` → `{ origin: 'enterprise', id: '<uuid>' }`.
 * Built-in targets keep their full string, which is already the store id.
 */
export function splitRunTarget(kind, target) {
    const prefixes = RUN_REF_PREFIXES[kind];
    for (const [origin, prefix] of Object.entries(prefixes)) {
        if (!target.startsWith(prefix)) continue;
        const rest = target.slice(prefix.length);
        if (origin === 'builtin') return { origin, id: kind === 'team' ? target : rest };
        if (origin === 'plugin') {
            const slash = rest.indexOf('/');
            if (slash <= 0 || slash === rest.length - 1) return undefined;
            return { origin, plugin: rest.slice(0, slash), id: rest.slice(slash + 1) };
        }
        return rest.length > 0 ? { origin, id: rest } : undefined;
    }
    return undefined;
}

function parseRunTarget(kind, value, field, ctx) {
    if (typeof value !== 'string' || value.length === 0) fail('must be a non-empty string', field, 'type');
    const target = splitRunTarget(kind, value);
    const allowed = ORIGINS_BY_SOURCE[ctx.source].filter(origin => Object.hasOwn(RUN_REF_PREFIXES[kind], origin));
    if (!target || !allowed.includes(target.origin)) {
        const forms = allowed.map(origin => `${RUN_REF_PREFIXES[kind][origin]}…`).join(', ');
        fail(`must start with one of ${forms}`, field, 'type');
    }
    if (target.origin === 'builtin') {
        if (kind === 'team' && !BUILTIN_TEAM_IDS.includes(value)) fail(`built-in team "${value}" does not exist`, field, 'unknown-reference');
        if (kind === 'expert' && !BUILTIN_AGENT_NAMES.includes(target.id)) fail(`built-in expert "${target.id}" does not exist`, field, 'unknown-reference');
    }
    if (target.origin === 'plugin') {
        if (!ctx.plugins.has(target.plugin)) fail(`plugin "${target.plugin}" is not listed in plugins`, field, 'unknown-reference');
        if (kind === 'team' && !isPluginTeamFileId(target.id)) fail(`team id "${target.id}" is not a valid team id`, field, 'type');
    }
    return value;
}

/**
 * A scene's (or the app's default) run: exactly one of `team` / `expert` /
 * `skill`, or a `team` / `expert` with a `skill` the conversation starts with.
 */
function parseRunRef(value, field, ctx) {
    if (value === undefined) return undefined;
    const ref = requireObject(value, field);
    rejectUnknownKeys(ref, field, ['team', 'expert', 'skill']);
    const owners = ['team', 'expert'].filter(key => ref[key] !== undefined);
    if (owners.length > 1) fail('names both a team and an expert', field, 'type');
    if (owners.length === 0 && ref.skill === undefined) fail('must name a team, an expert or a skill', field, 'missing');
    const run = {};
    if (owners.length === 1) run[owners[0]] = parseRunTarget(owners[0], ref[owners[0]], `${field}.${owners[0]}`, ctx);
    if (ref.skill !== undefined) run.skill = parseRunTarget('skill', ref.skill, `${field}.skill`, ctx);
    return run;
}

/**
 * `https://host[:port]`, or `http://127.0.0.1[:port]` / `http://localhost[:port]`
 * for local preview. No path, query, hash, credentials or wildcard.
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
            if (!allowedOrigins.includes(parsed.origin)) fail(`origin ${parsed.origin} is not listed in allowedOrigins`, `${itemField}.target`, 'origin');
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

const CONFIG_KEYS = ['home', 'defaultRun', 'promptAppend', 'nav', 'allowedOrigins', 'requiredConnectors', 'composer'];

/**
 * The home, runs, navigation and pages of an app. `ctx.source` is where the
 * app comes from (`package`, `created` or `enterprise`), which decides the
 * references it may use; `ctx.plugins` names the plugins it lists; `field`
 * prefixes every error path (empty for `app.json`, where the fields sit at the
 * top level).
 */
export function parseAppConfig(raw, ctx) {
    assertSource(ctx.source);
    const prefix = ctx.field ? `${ctx.field}.` : '';
    const refCtx = { source: ctx.source, plugins: new Set(ctx.plugins ?? []) };
    const allowedOrigins = parseAllowedOrigins(raw.allowedOrigins, `${prefix}allowedOrigins`);
    const requiredConnectors = requireArray(raw.requiredConnectors, `${prefix}requiredConnectors`);
    requiredConnectors.forEach((value, index) => {
        const field = `${prefix}requiredConnectors[${index}]`;
        const slash = typeof value === 'string' ? value.indexOf('/') : -1;
        if (slash <= 0 || slash === value.length - 1) fail('must be <plugin>/<connector>', field, 'type');
        if (!refCtx.plugins.has(value.slice(0, slash))) fail(`plugin "${value.slice(0, slash)}" is not listed in plugins`, field, 'unknown-reference');
    });
    assertUnique(requiredConnectors, `${prefix}requiredConnectors`, 'connector');
    let composer;
    if (raw.composer !== undefined) {
        const rawComposer = requireObject(raw.composer, `${prefix}composer`);
        rejectUnknownKeys(rawComposer, `${prefix}composer`, ['placeholder']);
        composer = { placeholder: parseLocalizedText(rawComposer.placeholder, `${prefix}composer.placeholder`) };
    }
    const config = {
        version: APP_CONFIG_VERSION,
        home: parseHome(raw.home, `${prefix}home`, refCtx),
        defaultRun: parseRunRef(raw.defaultRun, `${prefix}defaultRun`, refCtx),
        promptAppend: optionalString(raw.promptAppend, `${prefix}promptAppend`, APP_LIMITS.promptAppend),
        nav: raw.nav === undefined ? undefined : parseNav(raw.nav, `${prefix}nav`, allowedOrigins),
        allowedOrigins: raw.allowedOrigins === undefined ? undefined : allowedOrigins,
        requiredConnectors: raw.requiredConnectors === undefined ? undefined : requiredConnectors,
        composer,
    };
    const pageItems = config.nav?.items.filter(item => appPageUrl(item.target) !== undefined) ?? [];
    if (pageItems.length > 0 && raw.allowedOrigins === undefined) fail('is required when nav has url: targets', `${prefix}allowedOrigins`, 'missing');
    return config;
}

function parseInterface(value, field) {
    const iface = requireObject(value, field);
    rejectUnknownKeys(iface, field, ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'brandColor', 'logo', 'logoDark']);
    const brandColor = optionalString(iface.brandColor, `${field}.brandColor`);
    if (brandColor !== undefined && !HEX_COLOR_RE.test(brandColor)) fail('must be a #RRGGBB colour', `${field}.brandColor`, 'type');
    return {
        displayName: requireString(iface.displayName, `${field}.displayName`, 64),
        shortDescription: requireString(iface.shortDescription, `${field}.shortDescription`, 200),
        longDescription: optionalString(iface.longDescription, `${field}.longDescription`, 4000),
        developerName: optionalString(iface.developerName, `${field}.developerName`, 100),
        category: optionalString(iface.category, `${field}.category`, 64),
        brandColor,
        logo: optionalAssetPath(iface.logo, `${field}.logo`),
        logoDark: optionalAssetPath(iface.logoDark, `${field}.logoDark`),
    };
}

/** An app's `name`: lower-case letters, digits and dashes, starting with a letter or digit. */
export function isAppName(value) {
    return typeof value === 'string' && value.length <= APP_LIMITS.nameLength && APP_NAME_RE.test(value);
}

/**
 * Validate `.abu-app/app.json`. `source` is `package` for an app from a
 * market or a folder, `created` for one made in 「创建应用」.
 */
export function parseAppFile(raw, { source = 'package' } = {}) {
    if (source === 'enterprise') throw new Error('organization apps are not app files');
    const file = requireObject(raw, APP_FILE_PATH);
    const allowed = ['name', 'version', 'minAbuVersion', 'interface', 'plugins', ...CONFIG_KEYS];
    for (const key of Object.keys(file)) {
        if (!allowed.includes(key)) fail(`unknown field "${key}"`, key, 'unknown-field');
    }
    if (!isAppName(file.name)) fail(`must match ${APP_NAME_RE} and be at most ${APP_LIMITS.nameLength} characters`, 'name', file.name === undefined ? 'missing' : 'type');
    if (typeof file.version !== 'string' || semver.valid(file.version) === null) fail('must be a semantic version such as 1.0.0', 'version', file.version === undefined ? 'missing' : 'version');
    if (file.minAbuVersion === undefined) fail('is required', 'minAbuVersion', 'missing');
    const minAbuVersion = validateMinAbuVersion(file.minAbuVersion);
    assertMinAbuVersionAtLeast(minAbuVersion, APPS_MIN_ABU_VERSION, 'apps');
    const plugins = requireArray(file.plugins, 'plugins');
    plugins.forEach((name, index) => {
        if (typeof name !== 'string' || name.trim() !== name || name.length === 0 || /[/\\@]/.test(name)) fail('must be a plugin name', `plugins[${index}]`, 'type');
    });
    assertUnique(plugins, 'plugins', 'plugin');
    const config = parseAppConfig(file, { source, plugins, field: '' });
    return {
        name: file.name,
        version: file.version,
        minAbuVersion,
        interface: parseInterface(file.interface, 'interface'),
        plugins: [...plugins],
        config,
    };
}

/** The page URL behind a validated `url:` nav item; throws for unknown or built-in items. */
export function resolveAppPageUrl(config, navItemId) {
    const item = config.nav?.items.find(entry => entry.id === navItemId);
    if (!item) fail(`nav item "${navItemId}" does not exist`, 'nav.items', 'unknown-reference');
    const url = appPageUrl(item.target);
    if (url === undefined) fail(`nav item "${navItemId}" is not a url: target`, 'nav.items', 'type');
    const parsed = new URL(url);
    // The host hands this straight to `loadURL`, so the scheme is settled here
    // too and not only where the config was first validated.
    if (!APP_PAGE_PROTOCOLS.has(parsed.protocol)) fail(`nav item "${navItemId}" is not an http(s) address`, 'nav.items', 'origin');
    if (!(config.allowedOrigins ?? []).includes(parsed.origin)) fail(`origin ${parsed.origin} is not listed in allowedOrigins`, 'allowedOrigins', 'origin');
    return url;
}

/** Every run in an app: the default first, then each scene's, in home order. */
export function appRuns(config) {
    const runs = [];
    if (config.defaultRun) runs.push({ field: 'defaultRun', run: config.defaultRun });
    config.home.modes.items.forEach((mode, modeIndex) => mode.scenes.forEach((scene, sceneIndex) => {
        if (scene.run) runs.push({ field: `home.modes.items[${modeIndex}].scenes[${sceneIndex}].run`, run: scene.run, modeId: mode.modeId, sceneId: scene.id });
    }));
    return runs;
}
