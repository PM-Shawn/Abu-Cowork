/**
 * How an MCP server's command line is shown to the user before install.
 *
 * Separate module (not a helper inside the dialog) so it can be unit-tested
 * and reused without tripping react-refresh's component-only export rule.
 */

/** Render `command + args` the way a shell would show them; fall back to `url`. */
export function formatServerCommand(server: {
  command?: string;
  args?: string[];
  url?: string;
}): string {
  if (server.command) return [server.command, ...(server.args ?? [])].join(' ');
  return server.url ?? '';
}
