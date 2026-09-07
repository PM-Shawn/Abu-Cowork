/**
 * The ONE parse for a namespaced MCP tool name (`serverName__toolName`).
 *
 * Why this exists as its own module rather than a local helper on either side:
 * the authorization layer and the dispatcher used to parse the same string
 * two different ways, and a security gate that disagrees with the executor
 * about *which tool this is* has no meaning at all.
 *
 *   "abu-browser__execute_js__x"
 *     gate       `indexOf('__')` + slice → tool = "execute_js__x"
 *                → in no known set → fell back to the gated-but-weaker
 *                  'interactive' bucket (i.e. "a click")
 *     dispatcher `split('__', 2)`        → ["abu-browser", "execute_js"]
 *                → limit-2 TRUNCATION discards the suffix → really ran
 *                  arbitrary page script
 *
 * So both layers now call this, and the drift cannot come back by editing one
 * of them.
 *
 * A name is accepted only when it round-trips: `serverName + '__' + toolName`
 * must rebuild the input exactly. `segments.length !== 2` IS that check — a
 * name with a second separator cannot be rebuilt from two halves, and a name
 * with an empty half never named a real tool. Anything rejected is refused by
 * `executeAnyTool` on the "Unknown tool" path, which is what the builtin
 * branch has always done with a name it does not recognize; the MCP branch
 * used to be the asymmetric one, accepting any suffix as long as the server
 * was connected.
 *
 * NOTE this is a STRUCTURAL check, not a membership check: it does not ask
 * whether the server actually registered `toolName`. Adding that for every
 * MCP server is a separate, larger decision (a server with a dynamic tool
 * list could be wrongly refused) and is deliberately out of scope here.
 */
export interface NamespacedToolName {
  serverName: string;
  toolName: string;
}

export function parseNamespacedToolName(name: string): NamespacedToolName | null {
  const segments = name.split('__');
  if (segments.length !== 2) return null;
  const [serverName, toolName] = segments;
  if (serverName === '' || toolName === '') return null;
  return { serverName, toolName };
}
