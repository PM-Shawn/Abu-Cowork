/**
 * Parser for `.claude-plugin/marketplace.json` marketplace manifests.
 *
 * `source` is polymorphic in the wild: a bare relative-path string, or an
 * object discriminated by its own `source` field (`"url"` | `"git-subdir"`).
 * See the real `claude-plugins-official` marketplace for examples of all
 * three shapes plus the assorted unknown top-level/plugin-level fields
 * (`$schema`, `metadata`, `lspServers`, `skills`, ...) that must survive a
 * round-trip through this parser untouched.
 */

export type PluginSource =
  | { kind: 'relative'; path: string }
  | { kind: 'url'; url: string; sha?: string }
  | { kind: 'git-subdir'; url: string; path: string; ref?: string; sha?: string };

export interface MarketplaceEntry {
  name: string;
  description?: string;
  version?: string;
  author?: string | { name: string; email?: string };
  category?: string;
  homepage?: string;
  keywords?: string[];
  tags?: string[];
  source: PluginSource;
}

export interface Marketplace {
  name: string;
  owner?: { name?: string; email?: string };
  description?: string;
  renames?: Record<string, string>;
  plugins: MarketplaceEntry[];
}

export class MarketplaceParseError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'MarketplaceParseError';
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
    `unknown source discriminant ${JSON.stringify(discriminant)} (expected "url" or "git-subdir")`,
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
    description: typeof raw.description === 'string' ? raw.description : undefined,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    author: parseAuthor(raw.author),
    category: typeof raw.category === 'string' ? raw.category : undefined,
    homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined,
    keywords: Array.isArray(raw.keywords) ? (raw.keywords as string[]) : undefined,
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : undefined,
    source,
  };
}

export function parseMarketplace(raw: unknown): Marketplace {
  if (!isPlainObject(raw)) {
    throw new MarketplaceParseError('marketplace manifest must be an object');
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new MarketplaceParseError('marketplace manifest is missing required field "name"', 'name');
  }
  if (!Array.isArray(raw.plugins)) {
    throw new MarketplaceParseError(
      'marketplace manifest is missing required field "plugins" (must be an array)',
      'plugins',
    );
  }

  const plugins = raw.plugins.map((entry, index) => {
    const entryName = isPlainObject(entry) && typeof entry.name === 'string' ? entry.name : undefined;
    const label = entryName ? `"${entryName}"` : `at index ${index}`;
    return parseEntry(entry, label);
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
  };
}

/** Resolves an old plugin name to its current name; returns `name` unchanged when there is no mapping. */
export function resolveRename(name: string, renames?: Record<string, string>): string {
  if (!renames) return name;
  return renames[name] ?? name;
}
