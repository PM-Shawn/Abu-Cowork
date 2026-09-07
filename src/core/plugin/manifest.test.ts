import { describe, it, expect } from 'vitest';
import {
  parsePluginManifest,
  normalizeAuthor,
  PluginManifestError,
  MANIFEST_CANDIDATES,
} from './manifest';

describe('normalizeAuthor', () => {
  it('author 是字符串时返回 { name }', () => {
    expect(normalizeAuthor('Jane Doe')).toEqual({ name: 'Jane Doe' });
  });

  it('author 是 { name, email } 对象时原样返回', () => {
    // Claude 官方市场 291 条清单实测：两种写法都存在
    expect(normalizeAuthor({ name: 'Jane Doe', email: 'jane@example.com' })).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
    });
  });

  it('author 为 undefined 时返回 undefined', () => {
    expect(normalizeAuthor(undefined)).toBeUndefined();
  });
});

describe('parsePluginManifest', () => {
  it('最小合法清单（只有 name）应通过', () => {
    const manifest = parsePluginManifest({ name: 'my-plugin' });
    expect(manifest.name).toBe('my-plugin');
  });

  it('缺少 name 字段应抛出 PluginManifestError，field 为 name', () => {
    expect.assertions(2);
    try {
      parsePluginManifest({});
    } catch (e) {
      expect(e).toBeInstanceOf(PluginManifestError);
      expect((e as PluginManifestError).field).toBe('name');
    }
  });

  it('name 不是字符串应抛错', () => {
    expect(() => parsePluginManifest({ name: 123 })).toThrow(PluginManifestError);
  });

  it('name 为空字符串应抛错', () => {
    expect(() => parsePluginManifest({ name: '' })).toThrow(PluginManifestError);
  });

  it('raw 不是对象应抛错', () => {
    expect(() => parsePluginManifest('not-an-object')).toThrow(PluginManifestError);
  });

  it('raw 为 null 应抛错', () => {
    expect(() => parsePluginManifest(null)).toThrow(PluginManifestError);
  });

  it('raw 为数组应抛错', () => {
    expect(() => parsePluginManifest(['name'])).toThrow(PluginManifestError);
  });

  it('mcpServers 的值不是对象应抛错', () => {
    expect(() =>
      parsePluginManifest({ name: 'p', mcpServers: { foo: 'not-an-object' } })
    ).toThrow(PluginManifestError);
  });

  it('mcpServers 合法时应通过', () => {
    const manifest = parsePluginManifest({
      name: 'p',
      mcpServers: { foo: { command: 'node', args: ['server.js'] } },
    });
    expect(manifest.mcpServers?.foo.command).toBe('node');
  });

  it('未知顶层字段应被保留、不抛错（前向兼容）', () => {
    const manifest = parsePluginManifest({ name: 'p', futureField: 'hello' }) as Record<
      string,
      unknown
    >;
    expect(manifest.futureField).toBe('hello');
  });

  describe('interface.brandColor', () => {
    it('不是 #RRGGBB 形状应抛错，field 为 interface.brandColor', () => {
      expect.assertions(2);
      try {
        parsePluginManifest({ name: 'p', interface: { brandColor: 'red' } });
      } catch (e) {
        expect(e).toBeInstanceOf(PluginManifestError);
        expect((e as PluginManifestError).field).toBe('interface.brandColor');
      }
    });

    it('#FFF 简写形式也要拒绝', () => {
      expect(() =>
        parsePluginManifest({ name: 'p', interface: { brandColor: '#FFF' } })
      ).toThrow(PluginManifestError);
    });

    it('合法 #1A2B3C 应通过', () => {
      const manifest = parsePluginManifest({
        name: 'p',
        interface: { brandColor: '#1A2B3C' },
      });
      expect(manifest.interface?.brandColor).toBe('#1A2B3C');
    });
  });

  describe('interface.screenshots', () => {
    it('有非 .png 项应抛错', () => {
      expect(() =>
        parsePluginManifest({
          name: 'p',
          interface: { screenshots: ['a.png', 'b.jpg'] },
        })
      ).toThrow(PluginManifestError);
    });

    it('全部 .png 应通过', () => {
      const manifest = parsePluginManifest({
        name: 'p',
        interface: { screenshots: ['a.png', 'b.png'] },
      });
      expect(manifest.interface?.screenshots).toEqual(['a.png', 'b.png']);
    });
  });

  describe('interface.defaultPrompt', () => {
    it('超过 3 条应抛错', () => {
      expect(() =>
        parsePluginManifest({
          name: 'p',
          interface: { defaultPrompt: ['a', 'b', 'c', 'd'] },
        })
      ).toThrow(PluginManifestError);
    });

    it('单条超过 128 字符应抛错', () => {
      expect(() =>
        parsePluginManifest({
          name: 'p',
          interface: { defaultPrompt: ['x'.repeat(129)] },
        })
      ).toThrow(PluginManifestError);
    });

    it('3 条且每条不超过 128 字符应通过', () => {
      const manifest = parsePluginManifest({
        name: 'p',
        interface: { defaultPrompt: ['a', 'b', 'x'.repeat(128)] },
      });
      expect(manifest.interface?.defaultPrompt).toHaveLength(3);
    });
  });
});

describe('MANIFEST_CANDIDATES', () => {
  it('.abu-plugin 候选路径应在 .claude-plugin 之前', () => {
    const abuIndex = MANIFEST_CANDIDATES.indexOf('.abu-plugin/plugin.json');
    const claudeIndex = MANIFEST_CANDIDATES.indexOf('.claude-plugin/plugin.json');
    expect(abuIndex).toBeGreaterThanOrEqual(0);
    expect(claudeIndex).toBeGreaterThanOrEqual(0);
    expect(abuIndex).toBeLessThan(claudeIndex);
  });
});
