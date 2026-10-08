/**
 * Parser for `marketplace.json` marketplace manifests. The loader
 * (`loadMarketplace.ts`, `MARKETPLACE_MANIFEST_CANDIDATES`) finds the file at
 * `.abu-plugin/`, `.claude-plugin/` or `.agents/plugins/` — the same schema in
 * every location.
 *
 * `source` is polymorphic in the wild: a bare relative-path string, or an
 * object discriminated by its own `source` field (`"local"` | `"url"` | `"git-subdir"`).
 * Claude and Codex marketplaces use these shapes plus unknown top-level/plugin-level fields
 * (`$schema`, `metadata`, `lspServers`, `skills`, ...) that must survive a
 * round-trip through this parser untouched.
 */

import { validateMinAbuVersion } from '../../../electron/shared/pluginSpec.mjs';

export type PluginSource =
  | { kind: 'relative'; path: string }
  | { kind: 'url'; url: string; sha?: string }
  | { kind: 'git-subdir'; url: string; path: string; ref?: string; sha?: string };

export interface MarketplaceEntry {
  name: string;
  /** What the listing calls this package, mirroring the manifest's `interface.displayName`. */
  displayName?: string;
  description?: string;
  version?: string;
  author?: string | { name: string; email?: string };
  category?: string;
  homepage?: string;
  keywords?: string[];
  tags?: string[];
  /** Mirror of the manifest's `minAbuVersion`, so a listing can mark packages this Abu cannot use. */
  minAbuVersion?: string;
  source: PluginSource;
}

/**
 * One app a market lists (docs/app-spec.md). A relative source needs only
 * `name` and `source`: the listing reads the rest from the app's own
 * `app.json`. A remote source also states `version`, `description` and
 * `minAbuVersion`, so the listing can show it without downloading it first;
 * the add step checks them against the downloaded file.
 */
export interface AppMarketEntry {
  name: string;
  source: PluginSource;
  version?: string;
  description?: string;
  minAbuVersion?: string;
}

export interface Marketplace {
  name: string;
  owner?: { name?: string; email?: string };
  description?: string;
  renames?: Record<string, string>;
  plugins: MarketplaceEntry[];
  apps: AppMarketEntry[];
}

export class MarketplaceParseError extends Error {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'MarketplaceParseError';
    this.field = field;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSource(raw: unknown): PluginSource {
  if (typeof raw === 'string') {
    return { kind: 'relative', path: raw };
  }

  if (!isPlainObject(raw)) {
    throw new MarketplaceParseError(
      `source must be a string or an object, got ${raw === undefined ? 'undefined' : JSON.stringify(raw)}`,
      'source',
    );
  }

  const discriminant = raw.source;

  if (discriminant === 'local') {
    if (typeof raw.path !== 'string' || raw.path.trim().length === 0) {
      throw new MarketplaceParseError('source of kind "local" requires a non-empty path', 'source.path');
    }
    // Reuse the existing resolver and its marketplace containment check.
    return { kind: 'relative', path: raw.path };
  }

  if (discriminant === 'url') {
    if (typeof raw.url !== 'string') {
      throw new MarketplaceParseError(
        'source of kind "url" is missing required field "url"',
        'source.url',
      );
    }
    return {
      kind: 'url',
      url: raw.url,
      sha: typeof raw.sha === 'string' ? raw.sha : undefined,
    };
  }

  if (discriminant === 'git-subdir') {
    if (typeof raw.url !== 'string') {
      throw new MarketplaceParseError(
        'source of kind "git-subdir" is missing required field "url"',
        'source.url',
      );
    }
    if (typeof raw.path !== 'string') {
      throw new MarketplaceParseError(
        'source of kind "git-subdir" is missing required field "path"',
        'source.path',
      );
    }
    return {
      kind: 'git-subdir',
      url: raw.url,
      path: raw.path,
      ref: typeof raw.ref === 'string' ? raw.ref : undefined,
      sha: typeof raw.sha === 'string' ? raw.sha : undefined,
    };
  }

  throw new MarketplaceParseError(
    `unknown source discriminant ${JSON.stringify(discriminant)} (expected "local", "url" or "git-subdir")`,
    'source.source',
  );
}

function parseAuthor(raw: unknown): MarketplaceEntry['author'] {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return raw;
  if (isPlainObject(raw) && typeof raw.name === 'string') {
    return {
      name: raw.name,
      email: typeof raw.email === 'string' ? raw.email : undefined,
    };
  }
  throw new MarketplaceParseError(
    `author must be a string or an object with a "name" field, got ${JSON.stringify(raw)}`,
    'author',
  );
}

function parseEntry(raw: unknown, label: string): MarketplaceEntry {
  if (!isPlainObject(raw)) {
    throw new MarketplaceParseError(`plugin entry ${label} must be an object`, 'plugins');
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new MarketplaceParseError(
      `plugin entry ${label} is missing required field "name"`,
      'plugins.name',
    );
  }

  let source: PluginSource;
  try {
    source = parseSource(raw.source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new MarketplaceParseError(
      `plugin entry "${raw.name}" (${label}) has an invalid source: ${reason}`,
      'plugins.source',
    );
  }

  // Spread first so unknown fields (lspServers, skills, ...) pass through,
  // then overwrite the known/typed ones with their parsed values.
  return {
    ...(raw as unknown as MarketplaceEntry),
    name: raw.name,
    displayName: typeof raw.displayName === 'string' && raw.displayName.length > 0 ? raw.displayName : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    author: parseAuthor(raw.author),
    category: typeof raw.category === 'string' ? raw.category : undefined,
    homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined,
    keywords: Array.isArray(raw.keywords) ? (raw.keywords as string[]) : undefined,
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : undefined,
    minAbuVersion: typeof raw.minAbuVersion === 'string' ? raw.minAbuVersion : undefined,
    source,
  };
}

function parseAppEntry(raw: unknown, index: number): AppMarketEntry {
  const field = `apps[${index}]`;
  if (!isPlainObject(raw)) throw new MarketplaceParseError(`${field} must be an object`, field);
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new MarketplaceParseError(`${field} is missing required field "name"`, `${field}.name`);
  }
  let source: PluginSource;
  try {
    source = parseSource(raw.source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new MarketplaceParseError(`app entry "${raw.name}" has an invalid source: ${reason}`, `${field}.source`);
  }
  const optional = (key: 'version' | 'description' | 'minAbuVersion') => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) throw new MarketplaceParseError(`${field}.${key} must be a non-empty string`, `${field}.${key}`);
    return value;
  };
  const entry: AppMarketEntry = {
    name: raw.name,
    source,
    version: optional('version'),
    description: optional('description'),
    minAbuVersion: optional('minAbuVersion'),
  };
  if (source.kind !== 'relative') {
    for (const key of ['version', 'description', 'minAbuVersion'] as const) {
      if (entry[key] === undefined) throw new MarketplaceParseError(`app entry "${raw.name}" comes from a remote source, so "${key}" is required`, `${field}.${key}`);
    }
  }
  // A listing compares it with this Abu's version, so it has to be one.
  validateMinAbuVersion(entry.minAbuVersion);
  return entry;
}

export function parseMarketplace(raw: unknown): Marketplace {
  if (!isPlainObject(raw)) {
    throw new MarketplaceParseError('marketplace manifest must be an object');
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new MarketplaceParseError('marketplace manifest is missing required field "name"', 'name');
  }
  if (raw.plugins !== undefined && !Array.isArray(raw.plugins)) {
    throw new MarketplaceParseError('"plugins" must be an array', 'plugins');
  }
  if (raw.apps !== undefined && !Array.isArray(raw.apps)) {
    throw new MarketplaceParseError('"apps" must be an array', 'apps');
  }
  if (raw.plugins === undefined && raw.apps === undefined) {
    throw new MarketplaceParseError('marketplace manifest lists neither "plugins" nor "apps"', 'plugins');
  }

  const plugins = ((raw.plugins as unknown[] | undefined) ?? []).map((entry, index) => {
    const entryName = isPlainObject(entry) && typeof entry.name === 'string' ? entry.name : undefined;
    const label = entryName ? `"${entryName}"` : `at index ${index}`;
    return parseEntry(entry, label);
  });
  const apps = ((raw.apps as unknown[] | undefined) ?? []).map(parseAppEntry);
  const appNames = new Set<string>();
  apps.forEach((entry, index) => {
    if (appNames.has(entry.name)) throw new MarketplaceParseError(`app "${entry.name}" is listed twice`, `apps[${index}].name`);
    appNames.add(entry.name);
  });

  return {
    ...(raw as unknown as Marketplace),
    name: raw.name,
    owner: isPlainObject(raw.owner)
      ? {
          name: typeof raw.owner.name === 'string' ? raw.owner.name : undefined,
          email: typeof raw.owner.email === 'string' ? raw.owner.email : undefined,
        }
      : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    renames: isPlainObject(raw.renames) ? (raw.renames as Record<string, string>) : undefined,
    plugins,
    apps,
  };
}

/** Resolves an old plugin name to its current name; returns `name` unchanged when there is no mapping. */
export function resolveRename(name: string, renames?: Record<string, string>): string {
  if (!renames) return name;
  return renames[name] ?? name;
}
