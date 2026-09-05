import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetBrowserGrantsForTests,
  BROWSER_GRANT_TTL_MS,
  classifyBrowserTool,
  getSiteVerdict,
  grantBrowserAutomation,
  hasBrowserGrant,
  isScriptingBrowserTool,
  listAllBrowserToolPatterns,
  normalizeBrowserOrigin,
  refuseBrowserBatch,
  revokeBrowserGrant,
  summarizeBrowserBatch,
} from './browserToolPolicy';
import { matchesToolName } from '../skill/toolFilter';

describe('browser tool policy', () => {
  beforeEach(() => {
    __resetBrowserGrantsForTests();
  });

  describe('classifyBrowserTool', () => {
    it('classifies actions that act inside the logged-in session as state-changing', () => {
      for (const tool of ['click', 'fill', 'select', 'keyboard', 'execute_js', 'navigate']) {
        expect(classifyBrowserTool(`abu-browser__${tool}`)).toBe('state-changing');
        expect(classifyBrowserTool(`abu-browser-bridge__${tool}`)).toBe('state-changing');
      }
    });

    it('leaves observation tools ungated', () => {
      for (const tool of ['snapshot', 'find', 'get_tabs', 'extract_text', 'extract_table', 'query_js', 'screenshot', 'scroll']) {
        expect(classifyBrowserTool(`abu-browser__${tool}`)).toBe('read-only');
      }
    });

    it('ignores non-browser tools so other MCP servers keep their current behavior', () => {
      expect(classifyBrowserTool('some-server__click')).toBeNull();
      expect(classifyBrowserTool('run_command')).toBeNull();
      expect(classifyBrowserTool('read_file')).toBeNull();
    });

    it('does not let a server name ending in the browser name slip through', () => {
      expect(classifyBrowserTool('evil-abu-browser__click')).toBeNull();
    });
  });

  describe('batch', () => {
    const clickStep = { action: 'click', locator: { css: '#a' } };

    it('is classified by its heaviest step, on both server namespaces', () => {
      for (const server of ['abu-browser', 'abu-browser-bridge']) {
        expect(classifyBrowserTool(`${server}__batch`, {
          steps: [{ action: 'find', query: { role: 'button' } }, clickStep],
        })).toBe('state-changing');
        expect(classifyBrowserTool(`${server}__batch`, {
          steps: [{ action: 'find', query: { role: 'button' } }, { action: 'read' }],
        })).toBe('read-only');
      }
    });

    it('refuses a scripting step wherever it sits in the run', () => {
      expect(refuseBrowserBatch('abu-browser__batch', {
        steps: [clickStep, { action: 'execute_js', code: '1' }, clickStep],
      })).toBe('scripting-step');
      expect(refuseBrowserBatch('abu-browser__batch', {
        steps: [{ action: 'query_js', code: '1' }],
      })).toBe('scripting-step');
    });

    it('reports a scripting step as scripting even when the run is also malformed', () => {
      // Order matters: "there was a script in it" is the answer the user needs,
      // not "one of these steps was misspelled".
      expect(refuseBrowserBatch('abu-browser__batch', {
        steps: [{ action: 'hover' }, { action: 'execute_js', code: '1' }],
      })).toBe('scripting-step');
    });

    it('says nothing about any other tool', () => {
      expect(refuseBrowserBatch('abu-browser__click', { steps: '[{"action":"execute_js"}]' })).toBeNull();
      expect(refuseBrowserBatch('other-server__batch', { steps: '[{"action":"execute_js"}]' })).toBeNull();
      expect(summarizeBrowserBatch('abu-browser__click', { steps: '[]' })).toBeNull();
    });

    it('summarizes a run as step kinds and counts, and nothing the page could have written', () => {
      const summary = summarizeBrowserBatch('abu-browser__batch', {
        steps: [
          { action: 'fill', locator: { css: '#user' }, value: 'zhangsan@example.com' },
          { action: 'fill', locator: { css: '#pw' }, value: 'hunter2' },
          { action: 'click', locator: { role: 'button', name: 'Transfer 5000' } },
        ],
      });
      expect(summary).toBe('fill ×2 → click');
      expect(summary).not.toContain('hunter2');
      expect(summary).not.toContain('example.com');
      expect(summary).not.toContain('Transfer');
    });
  });

  describe('listAllBrowserToolPatterns', () => {
    it('returns one namespace wildcard per browser server', () => {
      expect(listAllBrowserToolPatterns().sort()).toEqual(
        ['abu-browser-bridge__*', 'abu-browser__*'].sort(),
      );
    });

    it('matches every tool under those servers — state-changing, navigate, and read-only alike', () => {
      const patterns = listAllBrowserToolPatterns();
      for (const server of ['abu-browser', 'abu-browser-bridge']) {
        for (const tool of ['click', 'fill', 'navigate', 'snapshot', 'query_js', 'screenshot', 'get_tabs', 'anything-not-yet-invented']) {
          expect(
            patterns.some((p) => matchesToolName(`${server}__${tool}`, p)),
            `${server}__${tool}`,
          ).toBe(true);
        }
      }
    });

    it('does not match a differently-named server', () => {
      const patterns = listAllBrowserToolPatterns();
      expect(patterns.some((p) => matchesToolName('some-other-server__click', p))).toBe(false);
    });
  });

  describe('per-conversation grant', () => {
    it('starts ungranted and grants only the conversation that approved', () => {
      expect(hasBrowserGrant('conv-1')).toBe(false);

      grantBrowserAutomation('conv-1');

      expect(hasBrowserGrant('conv-1')).toBe(true);
      expect(hasBrowserGrant('conv-2')).toBe(false);
    });

    it('treats a missing conversation id as ungranted and ignores granting it', () => {
      grantBrowserAutomation(undefined);
      expect(hasBrowserGrant(undefined)).toBe(false);
    });

    it('drops the grant when revoked', () => {
      grantBrowserAutomation('conv-1');
      revokeBrowserGrant('conv-1');
      expect(hasBrowserGrant('conv-1')).toBe(false);
    });
  });
  describe('grant expiry', () => {
    // Without a TTL the approval would be strictly weaker than the Computer Use
    // task grant it mirrors: one approval would cover the conversation for as
    // long as the app stayed open, including after the user tightened the
    // permission mode expecting to be asked again.
    it('stops covering the conversation once the TTL elapses', () => {
      const start = 1_000_000;
      grantBrowserAutomation('conv-1', start);

      expect(hasBrowserGrant('conv-1', start + BROWSER_GRANT_TTL_MS - 1)).toBe(true);
      expect(hasBrowserGrant('conv-1', start + BROWSER_GRANT_TTL_MS)).toBe(false);
    });

    it('re-approving extends the window from the new approval', () => {
      const start = 1_000_000;
      grantBrowserAutomation('conv-1', start);
      grantBrowserAutomation('conv-1', start + BROWSER_GRANT_TTL_MS + 5);

      expect(hasBrowserGrant('conv-1', start + BROWSER_GRANT_TTL_MS + 6)).toBe(true);
    });
  });

  describe('normalizeBrowserOrigin', () => {
    it('reduces a URL to its exact origin', () => {
      expect(normalizeBrowserOrigin('https://example.com/path?q=1#frag')).toBe('https://example.com');
      expect(normalizeBrowserOrigin('http://localhost:3000/dashboard')).toBe('http://localhost:3000');
    });

    it('keeps subdomains distinct — no wildcard collapsing', () => {
      expect(normalizeBrowserOrigin('https://sub.example.com/')).toBe('https://sub.example.com');
      expect(normalizeBrowserOrigin('https://sub.example.com/'))
        .not.toBe(normalizeBrowserOrigin('https://example.com/'));
    });

    it('collapses a FQDN trailing dot — evil.com. and evil.com share one key', () => {
      expect(normalizeBrowserOrigin('https://evil.com./login')).toBe('https://evil.com');
      expect(normalizeBrowserOrigin('https://evil.com./login'))
        .toBe(normalizeBrowserOrigin('https://evil.com/other'));
    });

    it('lowercases the host and strips userinfo and default ports', () => {
      expect(normalizeBrowserOrigin('https://EXAMPLE.com/A')).toBe('https://example.com');
      expect(normalizeBrowserOrigin('https://user:pass@example.com/')).toBe('https://example.com');
      expect(normalizeBrowserOrigin('https://example.com:443/')).toBe('https://example.com');
      expect(normalizeBrowserOrigin('http://example.com:80/')).toBe('http://example.com');
      expect(normalizeBrowserOrigin('https://example.com:8443/')).toBe('https://example.com:8443');
    });

    it('refuses non-http(s) and unparseable URLs — those pages never earn a grant', () => {
      expect(normalizeBrowserOrigin('file:///etc/passwd')).toBeNull();
      expect(normalizeBrowserOrigin('chrome://settings')).toBeNull();
      expect(normalizeBrowserOrigin('about:blank')).toBeNull();
      expect(normalizeBrowserOrigin('not a url')).toBeNull();
      expect(normalizeBrowserOrigin(undefined)).toBeNull();
      expect(normalizeBrowserOrigin('')).toBeNull();
    });
  });

  describe('getSiteVerdict', () => {
    it('returns the stored verdict for an exact origin match', () => {
      const perms = { 'https://example.com': 'allowed', 'https://evil.com': 'denied' } as const;
      expect(getSiteVerdict('https://example.com', perms)).toBe('allowed');
      expect(getSiteVerdict('https://evil.com', perms)).toBe('denied');
    });

    it('falls back to default for unknown sites and unresolved origins', () => {
      expect(getSiteVerdict('https://other.com', { 'https://example.com': 'allowed' })).toBe('default');
      expect(getSiteVerdict(null, { 'https://example.com': 'allowed' })).toBe('default');
    });

    it('does not let an allowed parent domain cover a subdomain', () => {
      expect(getSiteVerdict('https://sub.example.com', { 'https://example.com': 'allowed' })).toBe('default');
    });
  });

  describe('isScriptingBrowserTool', () => {
    it('flags execute_js on both browser servers', () => {
      expect(isScriptingBrowserTool('abu-browser__execute_js')).toBe(true);
      expect(isScriptingBrowserTool('abu-browser-bridge__execute_js')).toBe(true);
    });

    it('leaves ordinary actions and other servers unflagged', () => {
      expect(isScriptingBrowserTool('abu-browser__click')).toBe(false);
      expect(isScriptingBrowserTool('abu-browser__query_js')).toBe(false);
      expect(isScriptingBrowserTool('abu-browser__navigate')).toBe(false);
      expect(isScriptingBrowserTool('other-server__execute_js')).toBe(false);
      expect(isScriptingBrowserTool('execute_js')).toBe(false);
    });
  });
});
