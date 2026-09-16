import { describe, it, expect } from 'vitest';
import { parseAvatarValue, buildAvatarValue, AVATAR_ICONS, AVATAR_TINTS } from './avatarPresets';

describe('avatarPresets', () => {
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
