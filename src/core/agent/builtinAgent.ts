/** Builtin / bundled agents: registered in-memory (`__builtin__`) or shipped under the
 *  app's `builtin-agents` resource dir. One predicate for every consumer. */
export function isBuiltinAgentPath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  return filePath === '__builtin__' || filePath.includes('builtin-agents');
}
