import type { ImageGenVendor } from '@/types/provider';

/**
 * Infer an image-generation vendor from a backend's baseUrl host, using the
 * same heuristics as design doc §5/P3. This intentionally ignores
 * `ImageGenBackend.vendor` — the "add image backend" form (P2, see
 * `ImageGenSection.tsx`) dropped the vendor picker and always persists
 * `'custom'`, so the field can't be trusted as a real signal yet. baseUrl is
 * the only thing users reliably fill in, so it's the source of truth for
 * mapper selection until a vendor picker comes back.
 */
export function resolveImageVendor(baseUrl: string | undefined | null): ImageGenVendor {
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
