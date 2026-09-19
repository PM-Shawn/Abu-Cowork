/** Split only the command head; the body retains its line breaks and indentation. */
export function splitInputCommand(input: string): { prefix: '/' | '@'; name: string; body: string } | null {
  const match = /^\s*([/@])([^\s]+)[ \t]?([\s\S]*)$/.exec(input);
  if (!match) return null;
  return { prefix: match[1] as '/' | '@', name: match[2], body: match[3] };
}

/** Prefills supplement an existing draft; repeated hydration is idempotent. */
export function mergeDraftPrefill(current: string, incoming: string): string {
  if (!incoming || current === incoming) return current;
  return current ? `${current}\n${incoming}` : incoming;
}
