import { isMap, isScalar, parse, parseDocument, stringify, type Document, type Pair, type YAMLMap } from 'yaml';

/**
 * Identity fields of an AGENT.md that the content's author does not own.
 *
 * `role-id` is what every team membership points at; it is minted only by
 * `ensureRoleId` (src/core/team/roleIdentity.ts) on first team membership.
 * `created` drives the newest-first sort; it is stamped once, when the agent
 * is first written. A write path that takes whole-file content from someone
 * else — `save_agent`, where a model writes the file — must neither drop them
 * nor let the content invent them. The editor gets the same guarantee from
 * `AgentEditor.buildMetadata`.
 */
export interface CarriedIdentity { roleId?: string; createdAt?: number }

const ROLE_ID_KEY = 'role-id';
const CREATED_KEY = 'created';

/**
 * Frontmatter fence, matched the way `parseAgentFile` matches it (the FIRST
 * `---` line after the opening one closes the block, so a horizontal rule in
 * the prompt stays prompt), CRLF-aware at every line break and without
 * letting the space after a fence swallow the newline. The closing fence may
 * end the file.
 */
const FRONTMATTER_RE = /^(---[^\S\r\n]*\r?\n)([\s\S]*?)(\r?\n---[^\S\r\n]*(?:\r?\n|$))/;
const OPENING_FENCE_RE = /^---[^\S\r\n]*\r?\n/;
/** Top-level identity lines, for salvaging from a file whose YAML no longer parses. */
const SALVAGE_ROLE_ID_RE = /^role-id:[ \t]*["']?([^\s"'#]+)/m;
const SALVAGE_CREATED_RE = /^created:[ \t]*(\d+)/m;

type ParsedFrontmatter = { open: string; inner: string; close: string; rest: string; doc: Document.Parsed; map: YAMLMap };

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return null;
  const [whole, open, inner, close] = match;
  const doc = parseDocument(inner);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  return { open, inner, close, rest: content.slice(whole.length), doc, map: doc.contents };
}

function identityOf(meta: Record<string, unknown>): CarriedIdentity {
  const identity: CarriedIdentity = {};
  const roleId = meta[ROLE_ID_KEY];
  if (typeof roleId === 'string' && roleId !== '') identity.roleId = roleId;
  const createdAt = meta[CREATED_KEY];
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) identity.createdAt = createdAt;
  return identity;
}

/** The frontmatter as the registry reads it: `yaml.parse` into a JS object, or null. */
function parseMeta(inner: string): Record<string, unknown> | null {
  try {
    const meta: unknown = parse(inner);
    return meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function salvageIdentity(text: string): CarriedIdentity {
  const identity: CarriedIdentity = {};
  const roleId = SALVAGE_ROLE_ID_RE.exec(text)?.[1];
  if (roleId) identity.roleId = roleId;
  const createdAt = Number(SALVAGE_CREATED_RE.exec(text)?.[1]);
  if (Number.isSafeInteger(createdAt)) identity.createdAt = createdAt;
  return identity;
}

/**
 * Read the identity fields from an existing AGENT.md (undefined when absent).
 *
 * The frontmatter is read the way `parseAgentFile` reads it — `yaml.parse`
 * into a JS object, alias and merge keys resolved — so this and the registry
 * agree on which identity the agent has. When the YAML no longer parses (or
 * the closing fence is gone), the identity is salvaged from top-level
 * `role-id:` / `created:` lines: an agent that broke after joining a team must
 * not lose its id on the next "fix it" save. A file with no frontmatter at all
 * has no identity to salvage.
 */
export function readAgentIdentity(raw: string | null): CarriedIdentity {
  if (raw === null) return {};
  const match = FRONTMATTER_RE.exec(raw);
  if (match) {
    const meta = parseMeta(match[2]);
    return meta ? identityOf(meta) : salvageIdentity(match[2]);
  }
  return OPENING_FENCE_RE.test(raw) ? salvageIdentity(raw) : {};
}

/**
 * The identity the carry rules demand for a write: the existing agent's
 * role-id / created as they are (a legacy agent stays unstamped), and for a
 * brand-new agent (`existing === null`) no role-id and `created: now`.
 */
export function wantedAgentIdentity(existing: CarriedIdentity | null, now: number): CarriedIdentity {
  if (existing === null) return { createdAt: now };
  const wanted: CarriedIdentity = {};
  if (existing.roleId !== undefined) wanted.roleId = existing.roleId;
  if (existing.createdAt !== undefined) wanted.createdAt = existing.createdAt;
  return wanted;
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === key);
}

function scalarText(value: string | number): string {
  return stringify(value, { lineWidth: 0 }).replace(/\r?\n$/, '');
}

/** Source range of a pair's key or value node: `[start, valueEnd, nodeEnd]`. */
function rangeOf(node: unknown): [number, number, number] | undefined {
  if (node && typeof node === 'object' && 'range' in node) {
    const range = (node as { range?: [number, number, number] | null }).range;
    return range ?? undefined;
  }
  return undefined;
}

/**
 * Return `content` with the identity frontmatter enforced — the identity
 * {@link wantedAgentIdentity} demands:
 * - `role-id`: the existing agent's id if it had one, otherwise REMOVED
 *   (ids are minted only by ensureRoleId on first team membership — a model
 *   must not invent one, a collision would make two agents share an identity);
 * - `created`: the existing agent's stamp if it had one; for a brand-new agent
 *   (`existing === null`) `now`; for an existing agent without one, left absent.
 * Every other frontmatter byte is preserved — keys, order, comments, quoting,
 * indentation, line endings. Content without a leading `---\n…\n---` block,
 * or whose frontmatter YAML cannot parse, is returned unchanged.
 *
 * How: `parseDocument` locates the two keys on the YAML syntax tree and only
 * their source lines are rewritten (in place when present, appended to the
 * frontmatter when missing, with the file's own line ending and the map's
 * indentation). `Document.toString()` is deliberately not used — it re-indents
 * sequences and respaces comments and flow collections. A flow-style map
 * (`{ name: x }`) has no lines to splice, so it alone is re-serialized.
 *
 * NOT a guarantee on its own: the registry reads the frontmatter as a JS
 * object, and some YAML reads differently there than on the syntax tree —
 * an alias key (`*k : v`), a merge key (`<<:`, `!!merge`, a `%YAML 1.1`
 * directive), or an alias to an anchor on a rewritten line. A writer must
 * therefore read its result back with `parseAgentFile` and refuse to write
 * unless it yields exactly the wanted identity (save_agent does).
 */
export function withAgentIdentity(content: string, existing: CarriedIdentity | null, now: number): string {
  const parsed = parseFrontmatter(content);
  if (!parsed) return content;
  const { open, inner, close, rest, doc, map } = parsed;

  const identity = wantedAgentIdentity(existing, now);
  const wanted: Array<[string, string | number | undefined]> = [
    [ROLE_ID_KEY, identity.roleId],
    [CREATED_KEY, identity.createdAt],
  ];
  // A key already holding the wanted value is left alone, however it is spelled.
  const changes = wanted.filter(([key, value]) => (value === undefined ? map.has(key) : map.get(key) !== value));
  if (changes.length === 0) return content;

  const eol = open.endsWith('\r\n') ? '\r\n' : '\n';
  if (map.flow) {
    for (const [key, value] of changes) {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    }
    const text = doc.toString({ lineWidth: 0 }).replace(/\r?\n$/, '').replace(/\r?\n/g, eol);
    return `${open}${text}${close}${rest}`;
  }

  // Indentation of a key's line — whitespace only, so an explicit key's `? `
  // marker is not copied onto the plain `key: value` line that replaces it.
  const indentOf = (keyStart: number, lineStart = inner.lastIndexOf('\n', keyStart - 1) + 1): string =>
    /^[ \t]*/.exec(inner.slice(lineStart, keyStart))?.[0] ?? '';
  const mapIndent = indentOf(rangeOf(map.items[0]?.key)?.[0] ?? 0);

  const splices: Array<{ start: number; end: number; text: string }> = [];
  const appends: string[] = [];
  for (const [key, value] of changes) {
    const line = value === undefined ? undefined : `${key}: ${scalarText(value)}`;
    const pair = findPair(map, key);
    const keyRange = pair ? rangeOf(pair.key) : undefined;
    if (!pair || !keyRange) {
      if (line !== undefined) appends.push(`${mapIndent}${line}`);
      continue;
    }
    const lineStart = inner.lastIndexOf('\n', keyRange[0] - 1) + 1;
    // Where the value's own text ends — not the node end, which can run on
    // over the comment lines that follow (e.g. after an empty `role-id:`).
    const valueEnd = rangeOf(pair.value)?.[1] ?? keyRange[1];
    // Extend to the end of that line (same-line comment included), taking its
    // line break along.
    const breakAt = inner[valueEnd - 1] === '\n' ? valueEnd - 1 : inner.indexOf('\n', valueEnd);
    const end = breakAt === -1 ? inner.length : breakAt + 1;
    const lineBreak = breakAt === -1 ? '' : inner[breakAt - 1] === '\r' ? '\r\n' : '\n';
    if (line !== undefined) {
      splices.push({ start: lineStart, end, text: `${indentOf(keyRange[0], lineStart)}${line}${lineBreak}` });
    } else if (breakAt === -1 && lineStart > 0) {
      // Removing the last line: drop the break that led into it instead, so no
      // blank line is left before the closing fence.
      const breakStart = inner[lineStart - 2] === '\r' ? lineStart - 2 : lineStart - 1;
      splices.push({ start: breakStart, end, text: '' });
    } else {
      splices.push({ start: lineStart, end, text: '' });
    }
  }

  let next = inner;
  for (const { start, end, text } of splices.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, start) + text + next.slice(end);
  }
  for (const line of appends) {
    next = next === '' ? line : `${next}${eol}${line}`;
  }
  return `${open}${next}${close}${rest}`;
}
