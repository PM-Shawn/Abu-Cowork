import { describe, it, expect } from 'vitest';
import { parseAvatarValue, buildAvatarValue, AVATAR_ICONS, AVATAR_ICON_MAP, AVATAR_TINTS } from './avatarPresets';

describe('avatarPresets', () => {
  it('keeps the twenty stored names, in the order the picker shows them, each on its own glyph', () => {
    const glyphName = (glyph: unknown) => (glyph as { displayName?: string }).displayName;
    expect(Object.entries(AVATAR_ICON_MAP).map(([name, glyph]) => [name, glyphName(glyph)])).toEqual([
      ['chart-bar', 'ChartBar'], ['code', 'Code'], ['flask', 'FlaskConical'], ['pen', 'PenLine'],
      ['shield', 'ShieldCheck'], ['users', 'UsersRound'], ['search', 'Search'], ['database', 'Database'],
      ['palette', 'Palette'], ['compass', 'Compass'], ['wrench', 'Wrench'], ['book', 'BookOpen'],
      ['megaphone', 'Megaphone'], ['scale', 'Scale'], ['sparkles', 'Sparkles'], ['cpu', 'Cpu'],
      ['globe', 'Globe'], ['camera', 'Camera'], ['calculator', 'Calculator'], ['bot', 'Bot'],
    ]);
    expect(AVATAR_ICONS).toHaveLength(20);
  });

  it('parses an icon reference', () => {
    expect(parseAvatarValue('icon:chart-bar/blue')).toEqual({ kind: 'icon', icon: 'chart-bar', tint: 'blue' });
  });

  it('preserves legacy emoji, trimming only surrounding whitespace', () => {
    expect(parseAvatarValue(' 📊 ')).toEqual({ kind: 'emoji', emoji: '📊' });
  });

  it.each([undefined, '', '  ', 'icon:missing/blue', 'icon:code/missing', 'icon:code', 'icon:code/blue/extra', 'icon:constructor/blue', 'icon:code/toString', 'icon:/blue'])('falls back for %s without throwing', (value) => {
    expect(parseAvatarValue(value)).toEqual({ kind: 'default' });
  });

  it('round-trips every icon and tint combination', () => {
    for (const icon of AVATAR_ICONS) {
      for (const tint of AVATAR_TINTS) {
        expect(parseAvatarValue(buildAvatarValue(icon, tint))).toEqual({ kind: 'icon', icon, tint });
      }
    }
  });
});
