// Field-level checks shared by the plugin spec (`pluginSpec.mjs`) and the app
// spec (`appSpec.mjs`). Every failure is a `PluginManifestError` whose message
// starts with the full field path, so an author sees exactly which entry to fix.
import { PluginManifestError } from './pluginManifestError.mjs';

export const ID_MAX_LENGTH = 64;
const ID_RE = /^[A-Za-z0-9_-]+$/;
const LOCALES = ['zh-CN', 'en-US'];

export function fail(message, field, reason) {
    throw new PluginManifestError(`${field}: ${message}`, field, reason);
}

export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireObject(value, field) {
    if (value === undefined) fail('is required', field, 'missing');
    if (!isPlainObject(value)) fail('must be an object', field, 'type');
    return value;
}

export function rejectUnknownKeys(value, field, allowed) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) fail(`unknown field "${key}"`, `${field}.${key}`, 'unknown-field');
    }
}

export function optionalString(value, field, max) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') fail('must be a string', field, 'type');
    if (max !== undefined && value.length > max) fail(`must be at most ${max} characters`, field, 'range');
    return value;
}

export function requireString(value, field, max) {
    if (value === undefined) fail('is required', field, 'missing');
    const text = optionalString(value, field, max);
    if (text.trim().length === 0) fail('must not be empty', field, 'type');
    return text;
}

export function requireId(value, field, re = ID_RE) {
    if (value === undefined) fail('is required', field, 'missing');
    if (typeof value !== 'string' || value.length === 0 || value.length > ID_MAX_LENGTH || !re.test(value)) {
        fail(`must match ${re} and be at most ${ID_MAX_LENGTH} characters`, field, 'type');
    }
    return value;
}

export function requireArray(value, field, { min = 0, max } = {}) {
    if (value === undefined) {
        if (min > 0) fail('is required', field, 'missing');
        return [];
    }
    if (!Array.isArray(value)) fail('must be an array', field, 'type');
    if (value.length < min) fail(`needs at least ${min} entries`, field, 'range');
    if (max !== undefined && value.length > max) fail(`allows at most ${max} entries`, field, 'range');
    return value;
}

export function assertUnique(values, field, label) {
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
 * characters), applied to icons, avatars and logos.
 */
export function isPackageRelativePath(value) {
    if (typeof value !== 'string') return false;
    const path = value.replace(/\\/g, '/');
    if (!path || path.trim() !== path || path.startsWith('/') || path.startsWith('~') || hasUnsafePathCharacter(path)) return false;
    const segments = path.split('/').filter(segment => segment !== '' && segment !== '.');
    return segments.length > 0 && !segments.includes('..');
}

export function optionalAssetPath(value, field) {
    if (value === undefined) return undefined;
    if (!isPackageRelativePath(value)) fail('must be a relative path inside the package', field, 'type');
    return value.replace(/\\/g, '/');
}

/** A string, or `{ "zh-CN": …, "en-US": … }` with at least one locale. */
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

/** Pick the text for `locale`, then zh-CN, then en-US. */
export function resolveLocalizedText(text, locale) {
    if (text === undefined) return '';
    if (typeof text === 'string') return text;
    return text[locale] ?? text['zh-CN'] ?? text['en-US'] ?? '';
}
