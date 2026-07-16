import type { ImageGenVendor } from '@/types/provider';

/**
 * Resolve an image-generation vendor for a backend, preferring an
 * explicitly-stored `ImageGenBackend.vendor` over baseUrl-host heuristics
 * (finding F5 — a Volcengine Seedream endpoint reached via a corporate
 * proxy/gateway domain has no 'volces'/'ark' in its host, so host inference
 * alone silently resolves it to 'custom' and Seedream's min-pixel floor
 * never gets applied, causing 400s).
 *
 * `'custom'` is NOT treated as an authoritative signal: it's the default
 * every backend gets before the user deliberately picks a real vendor in
 * the add/edit form (`ImageGenSection.tsx`), and it was also the *only*
 * value the form ever persisted before the vendor picker existed — so
 * treating it as "force custom" would break vendor detection for every
 * pre-existing/migrated backend that currently only works via host
 * inference. Only a genuinely non-'custom' stored vendor short-circuits the
 * host regexes below.
 */
export function resolveImageVendor(baseUrl: string | undefined | null, storedVendor?: ImageGenVendor): ImageGenVendor {
  if (storedVendor && storedVendor !== 'custom') return storedVendor;

  const host = extractHost(baseUrl);
  if (!host) return 'custom';

  // \b boundaries keep these from matching inside unrelated hostnames (e.g.
  // "markdown.example.com" must NOT match "ark").
  if (/\bvolces\b/.test(host) || /\bark\b/.test(host)) return 'volcengine';
  if (/\bsiliconflow\b/.test(host)) return 'siliconflow';
  if (/\bbigmodel\b/.test(host)) return 'zhipu';
  if (/\bopenai\.com\b/.test(host)) return 'openai';
  return 'custom';
}

function extractHost(raw: string | undefined | null): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    return new URL(withScheme).host.toLowerCase();
  } catch {
    // Not a parseable URL (e.g. a bare host with a stray character) — fall
    // back to the raw lowercased string so the regexes above still get a
    // shot at it instead of silently resolving to 'custom'.
    return s.toLowerCase();
  }
}
