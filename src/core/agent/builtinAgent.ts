/** Builtin agents are registered in memory (`__builtin__`) and have no file on
 *  disk. One predicate for every consumer. */
export function isBuiltinAgentPath(filePath: string | undefined): boolean {
  return filePath === '__builtin__';
}
