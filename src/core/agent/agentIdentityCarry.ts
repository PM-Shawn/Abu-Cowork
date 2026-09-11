import { isMap, isScalar, parseDocument, stringify, type Document, type Pair, type YAMLMap } from 'yaml';

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
 * the prompt stays prompt), but CRLF-aware at every line break and without
 * letting the space after a fence swallow the newline. The closing fence may
 * end the file.
 */
const FRONTMATTER_RE = /^(---[^\S\r\n]*\r?\n)([\s\S]*?)(\r?\n---[^\S\r\n]*(?:\r?\n|$))/;

type ParsedFrontmatter = { open: string; inner: string; close: string; rest: string; doc: Document.Parsed; map: YAMLMap };

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return null;
  const [whole, open, inner, close] = match;
  const doc = parseDocument(inner);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  return { open, inner, close, rest: content.slice(whole.length), doc, map: doc.contents };
}

function identityOf(map: YAMLMap): CarriedIdentity {
  const identity: CarriedIdentity = {};
  const roleId = map.get(ROLE_ID_KEY);
  if (typeof roleId === 'string' && roleId !== '') identity.roleId = roleId;
  const createdAt = map.get(CREATED_KEY);
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) identity.createdAt = createdAt;
  return identity;
}

/** Read the identity fields from an existing AGENT.md (undefined when absent/unparseable). */
export function readAgentIdentity(raw: string | null): CarriedIdentity {
  if (raw === null) return {};
  const parsed = parseFrontmatter(raw);
  return parsed ? identityOf(parsed.map) : {};
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
 * Return `content` with the identity frontmatter enforced:
 * - `role-id`: the existing agent's id if it had one, otherwise REMOVED
 *   (ids are minted only by ensureRoleId on first team membership — a model
 *   must not invent one, a collision would make two agents share an identity);
 * - `created`: the existing agent's stamp if it had one; for a brand-new agent
 *   (`existing === null`) `now`; for an existing agent without one, left absent.
 * Other frontmatter keys, their order and comments are preserved (yaml Document API).
 * Content without a leading `---\n…\n---` block is returned unchanged.
 *
 * "Preserved" is byte-for-byte: the Document API locates the two keys, and
 * only their source lines are rewritten (in place when present, appended to
 * the frontmatter when missing, with the file's own line ending and the map's
 * indentation). `Document.toString()` is deliberately not used — it re-indents
 * sequences and respaces comments and flow collections. A flow-style map
 * (`{ name: x }`) has no lines to splice, so it alone is re-serialized.
 * Frontmatter YAML cannot parse is returned unchanged: `parseAgentFile`
 * rejects it too, so no agent — and no identity — is read from it.
 */
export function withAgentIdentity(content: string, existing: CarriedIdentity | null, now: number): string {
  const parsed = parseFrontmatter(content);
  if (!parsed) return content;
  const { open, inner, close, rest, doc, map } = parsed;

  const wanted: Array<[string, string | number | undefined]> = [
    [ROLE_ID_KEY, existing?.roleId],
    [CREATED_KEY, existing === null ? now : existing.createdAt],
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

  const firstKeyStart = rangeOf(map.items[0]?.key)?.[0] ?? 0;
  const mapIndent = inner.slice(inner.lastIndexOf('\n', firstKeyStart - 1) + 1, firstKeyStart);

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
      splices.push({ start: lineStart, end, text: `${inner.slice(lineStart, keyRange[0])}${line}${lineBreak}` });
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
