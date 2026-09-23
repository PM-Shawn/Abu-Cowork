import { describe, it, expect } from 'vitest';
import { pluginInstallDir, pluginRoot, PluginPathError } from './paths';

/**
 * A marketplace's `name`, and a plugin's `name`/`version`, are third-party
 * strings that become path segments of the install directory.
 *
 * Without validation, a marketplace named `../../Library` plus a plugin named
 * `LaunchAgents` and version `.` resolves to `~/Library/LaunchAgents` — still
 * inside $HOME, so Electron's capability scope (`fsHost.cjs` `assertAllowed`)
 * lets it through. Installing then writes into a login-item directory, and
 * uninstalling calls `remove(recursive: true)` on it.
 *
 * On Windows the exposure is worse: `assertAllowed` returns early with no
 * scope check at all, so a traversal is bounded only by the filesystem.
 */

// Written with String.raw / explicit escapes so each case is the character
// it claims to be: a plain 'a\b' would be a backspace, and the backslash —
// the separator that matters on Windows — would go untested.
const SEPARATORS = ['a/b', String.raw`a\b`, 'a\u0000b', 'a\bb'];
const TRAVERSALS = ['..', '../..', '../../Library', 'a/../..', './..'];
const DEGENERATE = ['.', '', '   '];
// C0, DEL and C1. None is part of a real package name, and one embedded in a
// name hides what the path is from whoever reads the install confirmation —
// the same rule `isSafeSkillDirName` and `isPlainSegment` apply to the names
// they turn into directories under $HOME.
const CONTROLS = ['a\u0001b', 'a\u007fb', 'a\u0080b', 'a\u0085b', 'a\u009fb'];

describe('install-path segment safety', () => {
  describe.each([
    ['marketplace', (v: string) => () => pluginInstallDir('/home/u', v, 'p', '1.0.0')],
    ['plugin name', (v: string) => () => pluginInstallDir('/home/u', 'm', v, '1.0.0')],
    ['version', (v: string) => () => pluginInstallDir('/home/u', 'm', 'p', v)],
  ])('%s segment', (_label, build) => {
    it.each(TRAVERSALS)('rejects the traversal %j', (evil) => {
      expect(build(evil)).toThrow(PluginPathError);
    });

    it.each(DEGENERATE)('rejects the degenerate value %j', (evil) => {
      expect(build(evil)).toThrow(PluginPathError);
    });

    it.each(SEPARATORS)('rejects a separator or NUL in %j', (evil) => {
      expect(build(evil)).toThrow(PluginPathError);
    });

    it.each(CONTROLS)('rejects the control character in %j', (evil) => {
      expect(build(evil)).toThrow(PluginPathError);
    });
  });

  it('still accepts ordinary names, including npm scopes and prereleases', () => {
    expect(pluginInstallDir('/home/u', 'official', '@acme_weather', '1.0.0-rc.1')).toBe(
      '/home/u/.abu/plugin-packages/official/@acme_weather/1.0.0-rc.1',
    );
  });

  it('keeps every produced path inside the plugin root', () => {
    const root = pluginRoot('/home/u');
    expect(pluginInstallDir('/home/u', 'm', 'p', '1.0.0').startsWith(`${root}/`)).toBe(true);
  });

  it('names the offending field so the UI can say what was wrong', () => {
    try {
      pluginInstallDir('/home/u', '../evil', 'p', '1.0.0');
      throw new Error('expected a PluginPathError');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginPathError);
      expect((error as PluginPathError).field).toBe('marketplace');
    }
  });
});
