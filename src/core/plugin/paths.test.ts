import { describe, it, expect } from 'vitest';
import {
  PLUGIN_ROOT_DIRNAME,
  pluginRoot,
  pluginInstallDir,
  installedManifestPath,
  pluginKey,
  parsePluginKey,
} from './paths';

describe('PLUGIN_ROOT_DIRNAME', () => {
  it('is not "plugins" (avoid colliding with IM plugin dir ~/.abu/plugins/)', () => {
    expect(PLUGIN_ROOT_DIRNAME).not.toBe('plugins');
  });
});

describe('pluginRoot', () => {
  it('joins home + .abu + PLUGIN_ROOT_DIRNAME', () => {
    expect(pluginRoot('/Users/x')).toBe('/Users/x/.abu/plugin-packages');
  });
});

describe('pluginInstallDir', () => {
  it('joins home + root + marketplace + name + version', () => {
    expect(pluginInstallDir('/Users/x', 'my-mkt', 'my-plugin', '1.2.3')).toBe(
      '/Users/x/.abu/plugin-packages/my-mkt/my-plugin/1.2.3',
    );
  });
});

describe('installedManifestPath', () => {
  it('points at installed.json under the plugin root', () => {
    expect(installedManifestPath('/Users/x')).toBe('/Users/x/.abu/plugin-packages/installed.json');
  });
});

describe('pluginKey / parsePluginKey', () => {
  it('builds a composite key of name@marketplace', () => {
    expect(pluginKey('foo', 'mkt')).toBe('foo@mkt');
  });

  it('round-trips through parsePluginKey', () => {
    const key = pluginKey('foo', 'mkt');
    expect(parsePluginKey(key)).toEqual({ name: 'foo', marketplace: 'mkt' });
  });

  it('returns null when there is no @ separator', () => {
    expect(parsePluginKey('no-at-symbol')).toBeNull();
  });

  it('splits on the LAST @ when the key contains multiple @ (plugin name may contain @, e.g. npm scope)', () => {
    // key format is `${name}@${marketplace}`; name = "a@b", marketplace = "c"
    expect(parsePluginKey('a@b@c')).toEqual({ name: 'a@b', marketplace: 'c' });
  });
});
