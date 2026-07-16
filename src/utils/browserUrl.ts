/**
 * Normalize a user-typed address into a loadable URL:
 * - already has a scheme (http://, https://, file://, ...) → unchanged.
 * - bare localhost / 127.0.0.1 (optionally with :port) → http:// (dev servers
 *   are almost never TLS-terminated locally).
 * - everything else → https:// (the safe default for real-world domains).
 */
export function normalizeBrowserUrl(raw: string): string {
  const value = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`;
  return `https://${value}`;
}
