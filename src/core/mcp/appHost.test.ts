// @vitest-environment happy-dom
//
// `buildAppSrcdoc` parses the server HTML with `DOMParser` (the renderer has
// one; a bare node runner does not), and these cases assert on the PARSED
// output rather than on the string, so the DOM is part of the contract here.
import { describe, it, expect } from 'vitest';
import {
  APP_IFRAME_SANDBOX,
  MAX_ACTIVE_MCP_APPS,
  MAX_APP_IFRAME_HEIGHT,
  buildAppCsp,
  buildAppSrcdoc,
  buildAppStyleVariables,
  buildHostContext,
  isAppDomainAllowed,
  splitMcpToolName,
} from './appHost';
import { WIDGET_THEME_VARS } from '@/core/widget/designSystem';

function directive(csp: string, name: string): string | undefined {
  return csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
}

describe('appHost', () => {
  describe('APP_IFRAME_SANDBOX', () => {
    it('is exactly allow-scripts', () => {
      expect(APP_IFRAME_SANDBOX).toBe('allow-scripts');
    });

    it('never grants an origin, popups, downloads, forms or navigation', () => {
      for (const forbidden of [
        'allow-same-origin',
        'allow-popups',
        'allow-downloads',
        'allow-forms',
        'allow-top-navigation',
        'allow-modals',
        'allow-pointer-lock',
        'allow-presentation',
      ]) {
        expect(APP_IFRAME_SANDBOX).not.toContain(forbidden);
      }
    });
  });

  describe('buildAppCsp', () => {
    it('locks everything down when the resource declares nothing', () => {
      const { csp, rejected } = buildAppCsp();
      expect(rejected).toEqual([]);
      expect(directive(csp, 'default-src')).toBe("default-src 'none'");
      expect(directive(csp, 'script-src')).toBe("script-src 'self' 'unsafe-inline'");
      expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
      expect(directive(csp, 'img-src')).toBe("img-src 'self' data: blob:");
      expect(directive(csp, 'font-src')).toBe("font-src 'self' data:");
      expect(directive(csp, 'media-src')).toBe("media-src 'self' data: blob:");
      expect(directive(csp, 'connect-src')).toBe("connect-src 'none'");
    });

    it('always forces frame-src, form-action and base-uri to none', () => {
      const { csp } = buildAppCsp({
        connectDomains: ['https://api.example.com'],
        resourceDomains: ['https://cdn.example.com'],
        frameDomains: ['https://evil.example.com'],
        baseUriDomains: ['https://evil.example.com'],
      });
      expect(directive(csp, 'frame-src')).toBe("frame-src 'none'");
      expect(directive(csp, 'form-action')).toBe("form-action 'none'");
      expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
      expect(csp).not.toContain('evil.example.com');
    });

    it('adds declared resource domains to the asset directives only', () => {
      const { csp, rejected } = buildAppCsp({ resourceDomains: ['https://cdn.example.com:8443'] });
      expect(rejected).toEqual([]);
      expect(directive(csp, 'script-src')).toBe("script-src 'self' 'unsafe-inline' https://cdn.example.com:8443");
      expect(directive(csp, 'img-src')).toBe("img-src 'self' data: blob: https://cdn.example.com:8443");
      expect(directive(csp, 'connect-src')).toBe("connect-src 'none'");
    });

    it('adds declared connect domains to connect-src only', () => {
      const { csp } = buildAppCsp({ connectDomains: ['https://api.example.com'] });
      expect(directive(csp, 'connect-src')).toBe('connect-src https://api.example.com');
      expect(directive(csp, 'script-src')).toBe("script-src 'self' 'unsafe-inline'");
    });

    it('rejects wildcards, non-https schemes, paths and junk', () => {
      const bad = [
        '*',
        'https://*.example.com',
        'http://example.com',
        'https://example.com/path',
        'https://example.com?q=1',
        'https://example.com#x',
        'data:',
        "'unsafe-eval'",
        'example.com',
        'https://user:pass@example.com',
        '',
        '   ',
      ];
      const { csp, rejected } = buildAppCsp({ connectDomains: bad, resourceDomains: bad });
      expect(directive(csp, 'connect-src')).toBe("connect-src 'none'");
      expect(directive(csp, 'script-src')).toBe("script-src 'self' 'unsafe-inline'");
      for (const entry of bad) {
        if (entry.trim() === '') continue;
        expect(rejected).toContain(entry);
      }
    });

    it('deduplicates domains and tolerates a trailing slash', () => {
      const { csp, rejected } = buildAppCsp({
        connectDomains: ['https://api.example.com', 'https://api.example.com/'],
      });
      expect(rejected).toEqual([]);
      expect(directive(csp, 'connect-src')).toBe('connect-src https://api.example.com');
    });

    it('drops non-string entries without throwing', () => {
      const { rejected, csp } = buildAppCsp({
        connectDomains: [42 as unknown as string, null as unknown as string, 'https://ok.example.com'],
      });
      expect(directive(csp, 'connect-src')).toBe('connect-src https://ok.example.com');
      expect(rejected).toHaveLength(2);
    });
  });

  describe('isAppDomainAllowed', () => {
    it('accepts an https origin with an optional port', () => {
      expect(isAppDomainAllowed('https://a.example.com')).toBe(true);
      expect(isAppDomainAllowed('https://a.example.com:8443')).toBe(true);
    });
    it('rejects anything that is not a bare https origin', () => {
      expect(isAppDomainAllowed('http://a.example.com')).toBe(false);
      expect(isAppDomainAllowed('https://*.example.com')).toBe(false);
      expect(isAppDomainAllowed('*')).toBe(false);
      expect(isAppDomainAllowed('https://a.example.com/x')).toBe(false);
    });

    it('rejects CSP separators that URL happily keeps inside the host', () => {
      // `new URL('https://a.example.com;frame-src')` parses and echoes the
      // separator back from `.origin`, so the charset gate is what stops it.
      for (const smuggled of [
        'https://a.example.com;frame-src https://evil.example.com',
        'https://a.example.com;',
        'https://a.example.com,https://evil.example.com',
        'https://a.example.com,',
        'https://a.example.com b.example.com',
        'https://a.example.com\thttps://evil.example.com',
        'https://a.example.com\nhttps://evil.example.com',
        "https://a.example.com;script-src 'unsafe-eval'",
      ]) {
        expect(isAppDomainAllowed(smuggled)).toBe(false);
      }
    });

    it('keeps a separator-smuggling domain out of the built policy', () => {
      const { csp, rejected } = buildAppCsp({
        connectDomains: ['https://a.example.com;frame-src https://evil.example.com'],
      });
      expect(directive(csp, 'connect-src')).toBe("connect-src 'none'");
      expect(directive(csp, 'frame-src')).toBe("frame-src 'none'");
      expect(csp).not.toContain('evil.example.com');
      expect(rejected).toHaveLength(1);
    });
  });

  describe('buildAppSrcdoc', () => {
    const CSP = "default-src 'none'";

    it('injects the CSP meta immediately after an existing head tag', () => {
      const out = buildAppSrcdoc('<!DOCTYPE html><html><head><title>t</title></head><body>x</body></html>', CSP);
      expect(out).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${CSP}">`);
      expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'));
    });

    it('handles a head tag with attributes', () => {
      const out = buildAppSrcdoc('<html><head lang="en"><title>t</title></head><body></body></html>', CSP);
      expect(out).toContain(`<head lang="en"><meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    });

    it('synthesizes a head for a document that has html but no head', () => {
      const out = buildAppSrcdoc('<html><body>hi</body></html>', CSP);
      expect(out).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${CSP}"></head>`);
      expect(out).toContain('<body>hi</body>');
    });

    it('wraps a bare fragment in a document with the CSP head', () => {
      const out = buildAppSrcdoc('<div id="app"></div>', CSP);
      expect(out).toContain('Content-Security-Policy');
      expect(out).toContain('<div id="app"></div>');
      expect(out).toMatch(/^<!DOCTYPE html>/i);
    });

    it('always guarantees a doctype and never duplicates one', () => {
      expect(buildAppSrcdoc('<html><head></head><body></body></html>', CSP)).toMatch(/^<!DOCTYPE html>/i);
      const already = buildAppSrcdoc('<!doctype html><html><head></head><body></body></html>', CSP);
      expect(already.match(/<!doctype html>/gi)).toHaveLength(1);
    });

    it('never lets a CSP value break out of the meta attribute', () => {
      const out = buildAppSrcdoc('<html><head></head><body></body></html>', 'default-src "none"; x');
      expect(out).not.toContain('content="default-src "none"');
      expect(out).toContain('&quot;');
    });

    describe('the meta lands in the real head, whatever the HTML looks like', () => {
      /** Re-parse the produced srcdoc the way the iframe will, then report the
       *  first element of its head. Regex assertions cannot tell a meta inside
       *  a comment / script from a live one — this can. */
      const firstHeadElement = (out: string): Element | null =>
        new DOMParser().parseFromString(out, 'text/html').head?.firstElementChild ?? null;

      const expectOurMetaFirst = (out: string) => {
        const first = firstHeadElement(out);
        expect(first?.tagName.toLowerCase()).toBe('meta');
        expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
        expect(first?.getAttribute('content')).toBe(CSP);
      };

      it('is not fooled by a commented-out head before the real one', () => {
        const out = buildAppSrcdoc(
          '<!-- <head> --><html><head><title>t</title></head><body>x</body></html>',
          CSP,
        );
        expectOurMetaFirst(out);
      });

      it('is not fooled by a head tag inside a script string', () => {
        const out = buildAppSrcdoc(
          '<html><body><script>var s = "<head>";</script></body></html>',
          CSP,
        );
        expectOurMetaFirst(out);
      });

      it('comes before a CSP meta the server supplied itself', () => {
        const out = buildAppSrcdoc(
          '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><title>t</title></head><body></body></html>',
          CSP,
        );
        expectOurMetaFirst(out);
        const metas = Array.from(
          new DOMParser().parseFromString(out, 'text/html').querySelectorAll('meta[http-equiv="Content-Security-Policy"]'),
        );
        expect(metas).toHaveLength(2);
        expect(metas[1].getAttribute('content')).toBe('default-src *');
      });

      it('drops a server-supplied base element', () => {
        const out = buildAppSrcdoc(
          '<html><head><base href="https://evil.example.com/"></head><body>x</body></html>',
          CSP,
        );
        expectOurMetaFirst(out);
        expect(new DOMParser().parseFromString(out, 'text/html').querySelector('base')).toBeNull();
        expect(out).not.toContain('evil.example.com');
      });

      it('synthesizes a head for a bare fragment', () => {
        const out = buildAppSrcdoc('<div id="app">hi</div>', CSP);
        expectOurMetaFirst(out);
        const doc = new DOMParser().parseFromString(out, 'text/html');
        expect(doc.querySelector('#app')?.textContent).toBe('hi');
      });
    });
  });

  describe('buildHostContext', () => {
    const base = {
      isDark: false,
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai',
      appVersion: '0.42.0',
    };

    it('reports the desktop inline host', () => {
      const ctx = buildHostContext(base);
      expect(ctx.platform).toBe('desktop');
      expect(ctx.displayMode).toBe('inline');
      expect(ctx.availableDisplayModes).toEqual(['inline', 'fullscreen']);
      expect(ctx.locale).toBe('zh-CN');
      expect(ctx.timeZone).toBe('Asia/Shanghai');
      expect(ctx.userAgent).toBe('Abu/0.42.0');
      expect(ctx.theme).toBe('light');
      expect(ctx.deviceCapabilities).toEqual({ touch: false, hover: true });
    });

    it('follows the host theme', () => {
      expect(buildHostContext({ ...base, isDark: true }).theme).toBe('dark');
    });

    it('passes container dimensions through when known', () => {
      const ctx = buildHostContext({ ...base, containerDimensions: { width: 640, maxHeight: 4000 } });
      expect(ctx.containerDimensions).toEqual({ width: 640, maxHeight: 4000 });
    });

    it('omits container dimensions when unknown', () => {
      expect(buildHostContext(base).containerDimensions).toBeUndefined();
    });

    it('publishes style variables under the spec names', () => {
      const vars = buildHostContext(base).styles?.variables ?? {};
      expect(vars['--color-background-primary']).toBeDefined();
      expect(vars['--color-text-primary']).toBeDefined();
      expect(vars['--color-border-primary']).toBeDefined();
      expect(vars['--font-sans']).toContain('system-ui');
    });
  });

  describe('buildAppStyleVariables', () => {
    const value = (name: string, dark: boolean) => {
      const spec = WIDGET_THEME_VARS.find((v) => v.name === name);
      return dark ? spec?.dark : spec?.light;
    };

    it('maps Abu design tokens onto the spec variable names, per theme', () => {
      const light = buildAppStyleVariables(false);
      const dark = buildAppStyleVariables(true);
      expect(light['--color-background-primary']).toBe(value('--w-bg', false));
      expect(dark['--color-background-primary']).toBe(value('--w-bg', true));
      expect(light['--color-text-primary']).toBe(value('--w-fg', false));
      expect(dark['--color-text-primary']).toBe(value('--w-fg', true));
      expect(light['--color-border-primary']).toBe(value('--w-border', false));
      expect(light['--color-ring-primary']).toBe(value('--w-primary', false));
    });

    it('ships typography and radius scales that do not depend on the theme', () => {
      const light = buildAppStyleVariables(false);
      const dark = buildAppStyleVariables(true);
      expect(light['--font-text-md-size']).toBe('14px');
      expect(light['--font-text-md-size']).toBe(dark['--font-text-md-size']);
      expect(light['--border-radius-md']).toBeDefined();
      expect(light['--border-width-regular']).toBe('1px');
    });
  });

  describe('splitMcpToolName', () => {
    it('splits a prefixed MCP tool name against the connected servers', () => {
      expect(splitMcpToolName('weather__forecast', ['weather', 'other'])).toEqual({
        server: 'weather',
        tool: 'forecast',
      });
    });

    it('prefers the longest matching server name', () => {
      expect(splitMcpToolName('a__b__c', ['a', 'a__b'])).toEqual({ server: 'a__b', tool: 'c' });
    });

    it('returns undefined for a non-MCP or unknown-server tool name', () => {
      expect(splitMcpToolName('read_file', ['weather'])).toBeUndefined();
      expect(splitMcpToolName('gone__forecast', ['weather'])).toBeUndefined();
    });
  });

  describe('limits', () => {
    it('caps iframe height and concurrent mounted apps', () => {
      expect(MAX_APP_IFRAME_HEIGHT).toBe(4000);
      expect(MAX_ACTIVE_MCP_APPS).toBe(6);
    });
  });
});
