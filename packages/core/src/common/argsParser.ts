/**
 * Parse a shell-like argument string into an array of arguments.
 * Supports double quotes, single quotes, and backslash escaping.
 *
 * Examples:
 *   'hello world'         → ['hello', 'world']
 *   '"path with spaces"'  → ['path with spaces']
 *   "'single quoted'"     → ['single quoted']
 *   'a "b c" d'           → ['a', 'b c', 'd']
 *   'a\\ b'               → ['a b']
 */
export function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  let hadQuote = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      hadQuote = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      hadQuote = true;
      continue;
    }

    if ((ch === ' ' || ch === '\t') && !inDouble && !inSingle) {
      if (current.length > 0 || hadQuote) {
        args.push(current);
        current = '';
        hadQuote = false;
      }
      continue;
    }

    current += ch;
  }

  // Handle trailing escape
  if (escaped) {
    current += '\\';
  }

  if (current.length > 0 || hadQuote) {
    args.push(current);
  }

  return args;
}
