/** Recognize the two error envelopes produced by tool implementations and the registry. */
export function isToolResultError(result: string): boolean {
  return result.startsWith('Error:')
    || /^Error executing tool "[^"]+":/.test(result);
}
