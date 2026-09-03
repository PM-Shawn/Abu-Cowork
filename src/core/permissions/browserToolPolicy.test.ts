import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetBrowserGrantsForTests,
  BROWSER_GRANT_TTL_MS,
  classifyBrowserTool,
  DEFAULT_BROWSER_OPERATION_POLICY,
  decideBrowserOperation,
  getSiteVerdict,
  grantBrowserAutomation,
  hasBrowserGrant,
  isScriptingBrowserTool,
  listAllBrowserToolPatterns,
  browserOperationStatesFor,
  browserToolTargetsPage,
  normalizeBrowserOperationPolicy,
  normalizeBrowserOrigin,
  revokeBrowserGrant,
  toLegacyBrowserToolConsequence,
  type BrowserOperationClass,
  type BrowserOperationPolicy,
  type BrowserOperationState,
} from './browserToolPolicy';
import { matchesToolName } from '../skill/toolFilter';
// The REAL tool list, not a hand-copied duplicate — a 20th tool added to
// BROWSER_TOOL_SUFFIXES without a matching row in READ_ONLY/INTERACTIVE/
// SCRIPTING below now fails the partition test instead of silently passing.
import { BROWSER_TOOL_SUFFIXES } from '../tools/toolPrefetch';

/**
 * Test-side classification table, matched against the product spec
 * (`docs/abu-browser-batch2-brief-2026-09.md` §二) — but see the "byte
 * compatibility" note on the interactive/read-only split below.
 *
 * `READ_ONLY`, `INTERACTIVE`, and `SCRIPTING` are asserted (in the
 * "partitions the real tool list" test) to together equal exactly
 * `BROWSER_TOOL_SUFFIXES`, with no overlap — so this table cannot silently
 * drift from the real tool list the way a hand-copied `Array<[string,
 * class]>` could.
 */
const SCRIPTING = ['execute_js'];

/**
 * Byte-compatibility with the pre-three-state gate: the legacy
 * `STATE_CHANGING_TOOLS` set (registry.ts, before this module existed) was
 * `{click, fill, select, keyboard, execute_js, navigate}` — everything else,
 * including `scroll`, `start_recording`, and `stop_recording`, was
 * `'read-only'` (ungated). `INTERACTIVE` must stay exactly that set minus
 * `execute_js` (which is `SCRIPTING` above): moving scroll/recording here
 * would make `toLegacyBrowserToolConsequence` newly gate actions that used
 * to run free in the attended flow — see `LEGACY_STATE_CHANGING_TOOLS` below
 * for the pinned regression test.
 */
const INTERACTIVE = ['click', 'fill', 'select', 'keyboard', 'navigate'];

const READ_ONLY = [
  'get_tabs',
  'snapshot',
  'wait_for',
  'extract_text',
  'extract_table',
  'query_js',
  'screenshot',
  'screenshot_full_page',
  'connection_status',
  'get_downloads',
  'scroll',
  'start_recording',
  'stop_recording',
];

/** The pre-three-state `STATE_CHANGING_TOOLS` set, pinned for the regression
 *  test in the `toLegacyBrowserToolConsequence` describe block below. */
const LEGACY_STATE_CHANGING_TOOLS = ['click', 'fill', 'select', 'keyboard', 'execute_js', 'navigate'];

const CLASS_OF: Record<string, BrowserOperationClass> = Object.fromEntries([
  ...READ_ONLY.map((t) => [t, 'read-only'] as const),
  ...INTERACTIVE.map((t) => [t, 'interactive'] as const),
  ...SCRIPTING.map((t) => [t, 'scripting'] as const),
]);

const ALL_BROWSER_TOOLS: Array<[string, BrowserOperationClass]> = BROWSER_TOOL_SUFFIXES.map(
  (tool) => [tool, CLASS_OF[tool]],
);

describe('browser tool policy', () => {
  beforeEach(() => {
    __resetBrowserGrantsForTests();
  });

  describe('classifyBrowserTool', () => {
    it.each(ALL_BROWSER_TOOLS)('classifies %s as %s on both browser servers', (tool, expected) => {
      // If `tool` were a real BROWSER_TOOL_SUFFIXES entry with no row in
      // READ_ONLY/INTERACTIVE/SCRIPTING above, `expected` is `undefined`
      // here and this assertion fails loudly (classifyBrowserTool never
      // returns undefined) instead of silently passing.
      expect(classifyBrowserTool(`abu-browser__${tool}`)).toBe(expected);
      expect(classifyBrowserTool(`abu-browser-bridge__${tool}`)).toBe(expected);
    });

    it('the three explicit buckets exactly partition the REAL 19-tool list — no gaps, no overlap, no extras', () => {
      expect(BROWSER_TOOL_SUFFIXES.length).toBe(19);
      const buckets = [READ_ONLY, INTERACTIVE, SCRIPTING];
      const union = buckets.flat();
      // No overlap between buckets.
      expect(union.length).toBe(new Set(union).size);
      // Union covers exactly the real list — nothing missing, nothing extra.
      expect(new Set(union)).toEqual(new Set(BROWSER_TOOL_SUFFIXES));
    });

    it('falls back to the gated "interactive" bucket for an unrecognized tool under a real browser server — fail-safe, not fail-open', () => {
      // A tool that ships before this module is updated to classify it must
      // not silently become ungated: 'read-only' would be fail-open for a
      // surface that acts inside the user's live, logged-in sessions.
      expect(classifyBrowserTool('abu-browser__totally-unclassified-tool')).toBe('interactive');
      expect(classifyBrowserTool('abu-browser-bridge__totally-unclassified-tool')).toBe('interactive');
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

  describe('toLegacyBrowserToolConsequence', () => {
    it('maps read-only straight through', () => {
      expect(toLegacyBrowserToolConsequence('read-only')).toBe('read-only');
    });

    it('maps both interactive and scripting to the old state-changing bucket', () => {
      expect(toLegacyBrowserToolConsequence('interactive')).toBe('state-changing');
      expect(toLegacyBrowserToolConsequence('scripting')).toBe('state-changing');
    });

    it.each(BROWSER_TOOL_SUFFIXES)(
      'reproduces the pre-U1 STATE_CHANGING_TOOLS gate exactly for %s (byte-compatibility regression)',
      (tool) => {
        const expected = LEGACY_STATE_CHANGING_TOOLS.includes(tool) ? 'state-changing' : 'read-only';
        const opClass = classifyBrowserTool(`abu-browser__${tool}`);
        expect(opClass).not.toBeNull();
        expect(toLegacyBrowserToolConsequence(opClass!)).toBe(expected);
      },
    );
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

  describe('browserToolTargetsPage', () => {
    const PAGELESS = ['get_tabs', 'connection_status', 'get_downloads'];

    it('says no only for the tools that act on no page', () => {
      for (const tool of BROWSER_TOOL_SUFFIXES) {
        expect(browserToolTargetsPage(`abu-browser__${tool}`), tool)
          .toBe(!PAGELESS.includes(tool));
      }
    });

    it('treats an unknown browser tool as page-acting — unknown means verify, not skip', () => {
      expect(browserToolTargetsPage('abu-browser__some_future_tool')).toBe(true);
    });

    it('is false for anything that is not a browser tool', () => {
      expect(browserToolTargetsPage('read_file')).toBe(false);
      expect(browserToolTargetsPage('github__get_tabs')).toBe(false);
    });

    it('covers the Chrome bridge namespace too', () => {
      expect(browserToolTargetsPage('abu-browser-bridge__screenshot')).toBe(true);
      expect(browserToolTargetsPage('abu-browser-bridge__get_tabs')).toBe(false);
    });
  });

  describe('normalizeBrowserOperationPolicy', () => {
    const VALID_POLICY: BrowserOperationPolicy = {
      attended: { readOnly: 'allow', interactive: 'ask', scripting: 'ask' },
      unattended: { readOnly: 'deny', interactive: 'deny', scripting: 'deny' },
    };

    it('passes a fully well-formed policy through unchanged', () => {
      expect(normalizeBrowserOperationPolicy(VALID_POLICY)).toEqual(VALID_POLICY);
    });

    // A site grant is minted from a human approving a CLICK. Letting
    // unattended scripting be 'allow' would turn that consent into standing
    // permission to run arbitrary code in the logged-in session.
    it('clamps unattended scripting "allow" to "ask" — that cell has no allow', () => {
      const withAllow: BrowserOperationPolicy = {
        attended: { readOnly: 'allow', interactive: 'allow', scripting: 'allow' },
        unattended: { readOnly: 'allow', interactive: 'allow', scripting: 'allow' },
      };
      const normalized = normalizeBrowserOperationPolicy(withAllow);

      expect(normalized.unattended.scripting).toBe('ask');
      // Only that one cell — attended scripting and the unattended siblings
      // keep what they were given.
      expect(normalized.attended.scripting).toBe('allow');
      expect(normalized.unattended.interactive).toBe('allow');
      expect(normalized.unattended.readOnly).toBe('allow');
    });

    it('leaves an explicit unattended scripting deny/ask alone', () => {
      for (const state of ['deny', 'ask'] as const) {
        expect(normalizeBrowserOperationPolicy({
          ...VALID_POLICY,
          unattended: { ...VALID_POLICY.unattended, scripting: state },
        }).unattended.scripting).toBe(state);
      }
    });

    it('clamps a completely missing input to strictest-everywhere (attended=ask, unattended=deny)', () => {
      expect(normalizeBrowserOperationPolicy(undefined)).toEqual({
        attended: { readOnly: 'ask', interactive: 'ask', scripting: 'ask' },
        unattended: { readOnly: 'deny', interactive: 'deny', scripting: 'deny' },
      });
    });

    it('clamps non-object input (string/number/null/array) to strictest-everywhere', () => {
      const strictest = {
        attended: { readOnly: 'ask', interactive: 'ask', scripting: 'ask' },
        unattended: { readOnly: 'deny', interactive: 'deny', scripting: 'deny' },
      };
      for (const bad of ['nope', 42, null, [1, 2, 3]]) {
        expect(normalizeBrowserOperationPolicy(bad)).toEqual(strictest);
      }
    });

    it('clamps a missing run-mode key to strictest for that entire column, keeping the other column', () => {
      const attendedOnly = { attended: { readOnly: 'allow', interactive: 'allow', scripting: 'ask' } };
      expect(normalizeBrowserOperationPolicy(attendedOnly)).toEqual({
        attended: { readOnly: 'allow', interactive: 'allow', scripting: 'ask' },
        unattended: { readOnly: 'deny', interactive: 'deny', scripting: 'deny' },
      });
    });

    it('clamps one missing leaf to strictest while preserving valid sibling leaves', () => {
      const partial = {
        attended: { readOnly: 'allow' /* interactive, scripting missing */ },
        unattended: { readOnly: 'allow', interactive: 'allow' /* scripting missing */ },
      };
      expect(normalizeBrowserOperationPolicy(partial)).toEqual({
        attended: { readOnly: 'allow', interactive: 'ask', scripting: 'ask' },
        unattended: { readOnly: 'allow', interactive: 'allow', scripting: 'deny' },
      });
    });

    it('clamps a leaf holding a value outside allow|deny|ask to strictest', () => {
      const malformed = {
        attended: { readOnly: 'maybe', interactive: 'allow', scripting: true },
        unattended: { readOnly: 'allow', interactive: 42, scripting: 'deny' },
      };
      expect(normalizeBrowserOperationPolicy(malformed)).toEqual({
        attended: { readOnly: 'ask', interactive: 'allow', scripting: 'ask' },
        unattended: { readOnly: 'allow', interactive: 'deny', scripting: 'deny' },
      });
    });
  });

  describe('decideBrowserOperation', () => {
    const OP_CLASSES: BrowserOperationClass[] = ['read-only', 'interactive', 'scripting'];
    const STATES: BrowserOperationState[] = ['allow', 'deny', 'ask'];

    /** A policy where every cell is forced to `filler`, except the one cell
     *  under test — isolates the matrix test from DEFAULT_BROWSER_OPERATION_POLICY. */
    function policyWith(
      runMode: 'attended' | 'unattended',
      key: 'readOnly' | 'interactive' | 'scripting',
      state: BrowserOperationState,
      filler: BrowserOperationState = 'allow',
    ): BrowserOperationPolicy {
      const row = { readOnly: filler, interactive: filler, scripting: filler };
      return {
        attended: { ...row },
        unattended: { ...row },
        [runMode]: { ...row, [key]: state },
      } as BrowserOperationPolicy;
    }

    const POLICY_KEY: Record<BrowserOperationClass, 'readOnly' | 'interactive' | 'scripting'> = {
      'read-only': 'readOnly',
      interactive: 'interactive',
      scripting: 'scripting',
    };

    describe('exhaustive matrix — runMode × opClass × configured state (site allowed, master switch on)', () => {
      for (const runMode of ['attended', 'unattended'] as const) {
        for (const opClass of OP_CLASSES) {
          for (const state of STATES) {
            // The one cell that cannot say what it was configured to say:
            // unattended scripting has no 'allow' (see
            // `browserOperationStatesFor`), so a configured 'allow' resolves
            // to 'ask' — a site grant minted from a click must never buy
            // silent page scripting in a run nobody is watching.
            const expected = runMode === 'unattended' && opClass === 'scripting' && state === 'allow'
              ? 'ask'
              : state;
            it(`${runMode}/${opClass} configured '${state}' → '${expected}'`, () => {
              expect(
                decideBrowserOperation({
                  opClass,
                  runMode,
                  policy: policyWith(runMode, POLICY_KEY[opClass], state),
                  masterSwitchUnattended: true,
                  siteVerdict: 'allowed',
                }),
              ).toBe(expected);
            });
          }
        }
      }
    });

    describe('unattended scripting has no allow', () => {
      it('never returns allow, even for a policy object that says allow', () => {
        expect(
          decideBrowserOperation({
            opClass: 'scripting',
            runMode: 'unattended',
            policy: {
              attended: { readOnly: 'allow', interactive: 'allow', scripting: 'allow' },
              unattended: { readOnly: 'allow', interactive: 'allow', scripting: 'allow' },
            },
            masterSwitchUnattended: true,
            siteVerdict: 'allowed',
          }),
        ).toBe('ask');
      });

      it('still lets ATTENDED scripting be allowed — the restriction is unattended-only', () => {
        expect(
          decideBrowserOperation({
            opClass: 'scripting',
            runMode: 'attended',
            policy: {
              attended: { readOnly: 'allow', interactive: 'allow', scripting: 'allow' },
              unattended: { readOnly: 'allow', interactive: 'allow', scripting: 'ask' },
            },
            masterSwitchUnattended: true,
            siteVerdict: 'allowed',
          }),
        ).toBe('allow');
      });

      it('offers only ask/deny for that cell, all three everywhere else', () => {
        expect(browserOperationStatesFor('unattended', 'scripting')).toEqual(['ask', 'deny']);
        for (const [runMode, opClass] of [
          ['attended', 'scripting'],
          ['attended', 'interactive'],
          ['attended', 'read-only'],
          ['unattended', 'interactive'],
          ['unattended', 'read-only'],
        ] as const) {
          expect(browserOperationStatesFor(runMode, opClass), `${runMode}/${opClass}`)
            .toEqual(['allow', 'ask', 'deny']);
        }
      });
    });

    describe('precedence', () => {
      it('a denied site overrides an otherwise-allowing policy', () => {
        expect(
          decideBrowserOperation({
            opClass: 'read-only',
            runMode: 'attended',
            policy: DEFAULT_BROWSER_OPERATION_POLICY,
            masterSwitchUnattended: true,
            siteVerdict: 'denied',
          }),
        ).toBe('deny');
      });

      it('a denied site overrides the unattended master switch and policy alike', () => {
        expect(
          decideBrowserOperation({
            opClass: 'interactive',
            runMode: 'unattended',
            policy: policyWith('unattended', 'interactive', 'allow'),
            masterSwitchUnattended: true,
            siteVerdict: 'denied',
          }),
        ).toBe('deny');
      });

      it('unattended with the master switch off denies even a read-only, allow-everywhere policy', () => {
        expect(
          decideBrowserOperation({
            opClass: 'read-only',
            runMode: 'unattended',
            policy: DEFAULT_BROWSER_OPERATION_POLICY,
            masterSwitchUnattended: false,
            siteVerdict: 'allowed',
          }),
        ).toBe('deny');
      });

      it('the master switch is irrelevant when attended', () => {
        expect(
          decideBrowserOperation({
            opClass: 'read-only',
            runMode: 'attended',
            policy: DEFAULT_BROWSER_OPERATION_POLICY,
            masterSwitchUnattended: false,
            siteVerdict: 'allowed',
          }),
        ).toBe('allow');
      });

      it('a default (unset) site verdict falls through to policy, not to deny', () => {
        expect(
          decideBrowserOperation({
            opClass: 'read-only',
            runMode: 'unattended',
            policy: DEFAULT_BROWSER_OPERATION_POLICY,
            masterSwitchUnattended: true,
            siteVerdict: 'default',
          }),
        ).toBe('allow');
      });
    });

    describe('default policy = current shipped semantics (fail-safe defaults)', () => {
      it('attended: read-only and interactive allow, scripting asks — today\'s behavior unchanged', () => {
        const base = {
          policy: DEFAULT_BROWSER_OPERATION_POLICY,
          masterSwitchUnattended: true,
          siteVerdict: 'allowed' as const,
          runMode: 'attended' as const,
        };
        expect(decideBrowserOperation({ ...base, opClass: 'read-only' })).toBe('allow');
        expect(decideBrowserOperation({ ...base, opClass: 'interactive' })).toBe('allow');
        expect(decideBrowserOperation({ ...base, opClass: 'scripting' })).toBe('ask');
      });

      it('unattended with the master switch on: read-only and interactive allow, scripting is denied', () => {
        const base = {
          policy: DEFAULT_BROWSER_OPERATION_POLICY,
          masterSwitchUnattended: true,
          siteVerdict: 'allowed' as const,
          runMode: 'unattended' as const,
        };
        expect(decideBrowserOperation({ ...base, opClass: 'read-only' })).toBe('allow');
        expect(decideBrowserOperation({ ...base, opClass: 'interactive' })).toBe('allow');
        expect(decideBrowserOperation({ ...base, opClass: 'scripting' })).toBe('deny');
      });

      it('unattended with the master switch off (the shipped default): everything denies', () => {
        const base = {
          policy: DEFAULT_BROWSER_OPERATION_POLICY,
          masterSwitchUnattended: false,
          siteVerdict: 'allowed' as const,
          runMode: 'unattended' as const,
        };
        expect(decideBrowserOperation({ ...base, opClass: 'read-only' })).toBe('deny');
        expect(decideBrowserOperation({ ...base, opClass: 'interactive' })).toBe('deny');
        expect(decideBrowserOperation({ ...base, opClass: 'scripting' })).toBe('deny');
      });
    });

    /**
     * U5 gave `'high-risk'` teeth. The assertion inverted here is the pin the
     * reserved-value test used to hold ("falls through to policy exactly like
     * 'default' — no deny yet"); its replacement below is the intended
     * behavior, in the same commit as the fix (the file's own convention).
     */
    describe('high-risk site verdict (U5 — money movement / government URLs)', () => {
      it('unattended: denies EVERY class, even under a permissive policy and an allowed site', () => {
        const base = {
          runMode: 'unattended' as const,
          policy: {
            attended: DEFAULT_BROWSER_OPERATION_POLICY.attended,
            unattended: { readOnly: 'allow', interactive: 'allow', scripting: 'ask' },
          } as BrowserOperationPolicy,
          masterSwitchUnattended: true,
          siteVerdict: 'high-risk' as const,
        };
        expect(decideBrowserOperation({ ...base, opClass: 'read-only' })).toBe('deny');
        expect(decideBrowserOperation({ ...base, opClass: 'interactive' })).toBe('deny');
        expect(decideBrowserOperation({ ...base, opClass: 'scripting' })).toBe('deny');
        // Contrast: the same policy on an ordinary site allows the same calls.
        expect(decideBrowserOperation({ ...base, siteVerdict: 'default', opClass: 'interactive' }))
          .toBe('allow');
      });

      it('attended: upgrades an acting-class \'allow\' to \'ask\', leaves read-only alone', () => {
        const base = {
          runMode: 'attended' as const,
          policy: DEFAULT_BROWSER_OPERATION_POLICY,
          masterSwitchUnattended: true,
          siteVerdict: 'high-risk' as const,
        };
        // attended.interactive ships as 'allow' → forced confirmation here.
        expect(decideBrowserOperation({ ...base, opClass: 'interactive' })).toBe('ask');
        // attended.scripting already asks; unchanged.
        expect(decideBrowserOperation({ ...base, opClass: 'scripting' })).toBe('ask');
        // attended.readOnly ships as 'allow' and STAYS 'allow' — byte-compat
        // for the observation path a human is watching.
        expect(decideBrowserOperation({ ...base, opClass: 'read-only' })).toBe('allow');
      });

      it('attended: a configured \'deny\' is not relaxed into an ask', () => {
        expect(decideBrowserOperation({
          opClass: 'interactive',
          runMode: 'attended',
          policy: {
            attended: { readOnly: 'allow', interactive: 'deny', scripting: 'ask' },
            unattended: DEFAULT_BROWSER_OPERATION_POLICY.unattended,
          },
          masterSwitchUnattended: true,
          siteVerdict: 'high-risk',
        })).toBe('deny');
      });

      it('\'denied\' still outranks \'high-risk\' — a blocked site stays blocked', () => {
        expect(decideBrowserOperation({
          opClass: 'read-only',
          runMode: 'attended',
          policy: DEFAULT_BROWSER_OPERATION_POLICY,
          masterSwitchUnattended: true,
          siteVerdict: 'denied',
        })).toBe('deny');
      });
    });

    describe('reserved input (targetOrigin) — accepted, no effect', () => {
      it('passing targetOrigin does not change the outcome', () => {
        const withoutOrigin = decideBrowserOperation({
          opClass: 'scripting',
          runMode: 'attended',
          policy: DEFAULT_BROWSER_OPERATION_POLICY,
          masterSwitchUnattended: true,
          siteVerdict: 'allowed',
        });
        const withOrigin = decideBrowserOperation({
          opClass: 'scripting',
          runMode: 'attended',
          policy: DEFAULT_BROWSER_OPERATION_POLICY,
          masterSwitchUnattended: true,
          siteVerdict: 'allowed',
          targetOrigin: 'https://evil.example.com',
        });
        expect(withOrigin).toBe(withoutOrigin);
      });
    });

    describe('runtime defense against a malformed policy (I3)', () => {
      it('a policy missing the unattended column still denies unattended scripting (strictest fallback)', () => {
        const malformed = { attended: DEFAULT_BROWSER_OPERATION_POLICY.attended } as unknown as BrowserOperationPolicy;
        expect(
          decideBrowserOperation({
            opClass: 'scripting',
            runMode: 'unattended',
            policy: malformed,
            masterSwitchUnattended: true,
            siteVerdict: 'allowed',
          }),
        ).toBe('deny');
      });

      it('a policy with an invalid leaf value still returns a valid state (ask), not the garbage value', () => {
        const malformed = {
          attended: { readOnly: 'allow', interactive: 'yolo', scripting: 'ask' },
          unattended: DEFAULT_BROWSER_OPERATION_POLICY.unattended,
        } as unknown as BrowserOperationPolicy;
        expect(
          decideBrowserOperation({
            opClass: 'interactive',
            runMode: 'attended',
            policy: malformed,
            masterSwitchUnattended: true,
            siteVerdict: 'allowed',
          }),
        ).toBe('ask');
      });
    });
  });
});
