// Minimal glob matcher for file trigger filters.
// Only supports `*` (any chars except `/`) and `**` (any chars including `/`).
// Sufficient for file trigger patterns like "*.log" or "src/subdir/*.ts".

function compileGlobPattern(pattern: string): RegExp {
  // Escape regex special chars except * and /
  const escaped = pattern.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  const regex = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${regex}$`);
}

export function matchesGlob(path: string, pattern: string): boolean {
  if (!pattern) return true;
  return compileGlobPattern(pattern).test(path);
}
