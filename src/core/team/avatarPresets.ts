import { AvatarGlyphs, type AvatarGlyph } from '@/components/ds/icons';

/**
 * Built-in avatar references reuse the product's icons. No image files. The keys are the names
 * stored in an avatar value (`icon:<name>/<tint>`); their order is the order the picker shows.
 */
export const AVATAR_ICON_MAP: Record<string, AvatarGlyph> = {
  'chart-bar': AvatarGlyphs.chartBar, code: AvatarGlyphs.code, flask: AvatarGlyphs.flask, pen: AvatarGlyphs.pen,
  shield: AvatarGlyphs.shield, users: AvatarGlyphs.users, search: AvatarGlyphs.search, database: AvatarGlyphs.database,
  palette: AvatarGlyphs.palette, compass: AvatarGlyphs.compass, wrench: AvatarGlyphs.wrench, book: AvatarGlyphs.book,
  megaphone: AvatarGlyphs.megaphone, scale: AvatarGlyphs.scale, sparkles: AvatarGlyphs.sparkles, cpu: AvatarGlyphs.cpu,
  globe: AvatarGlyphs.globe, camera: AvatarGlyphs.camera, calculator: AvatarGlyphs.calculator, bot: AvatarGlyphs.bot,
};

export const AVATAR_ICONS = Object.keys(AVATAR_ICON_MAP);

/** The single categorical palette for avatar data, shared by picker and renderers. */
export const AVATAR_TINT_MAP: Record<string, { bg: string; fg: string }> = {
  blue: { bg: '#E6F1FB', fg: '#0C447C' },
  purple: { bg: '#EEEDFE', fg: '#3C3489' },
  teal: { bg: '#E1F5EE', fg: '#085041' },
  coral: { bg: '#FAECE7', fg: '#712B13' },
  amber: { bg: '#FAEEDA', fg: '#633806' },
  pink: { bg: '#FBEAF0', fg: '#72243E' },
};

export const AVATAR_TINTS = Object.keys(AVATAR_TINT_MAP);

export type ParsedAvatar =
  | { kind: 'icon'; icon: string; tint: string }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'default' };

const ICON_PREFIX = 'icon:';

export function buildAvatarValue(icon: string, tint: string): string {
  return `${ICON_PREFIX}${icon}/${tint}`;
}

/** Malformed stored references fall back to the default; legacy emoji stays readable. */
export function parseAvatarValue(value?: string): ParsedAvatar {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { kind: 'default' };
  if (raw.startsWith(ICON_PREFIX)) {
    const parts = raw.slice(ICON_PREFIX.length).split('/');
    const [icon, tint] = parts;
    if (parts.length === 2 && Object.hasOwn(AVATAR_ICON_MAP, icon) && Object.hasOwn(AVATAR_TINT_MAP, tint)) {
      return { kind: 'icon', icon, tint };
    }
    return { kind: 'default' };
  }
  return { kind: 'emoji', emoji: raw };
}
