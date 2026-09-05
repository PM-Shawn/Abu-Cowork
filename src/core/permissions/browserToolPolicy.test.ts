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

  /**
   * U9 / C1 — the gate and the dispatcher must agree about WHICH tool a name
   * names.
   *
   * These three predicates used to slice from the first `__` and keep
   * everything after it as the tool name, so `abu-browser__execute_js__x`
   * classified as the *unknown* tool `execute_js__x` and took the
   * `'interactive'` fallback — while `registry.ts`'s dispatcher parsed the
   * same string with `split('__', 2)`, whose limit-2 truncation DISCARDS the
   * suffix and dispatches `execute_js` for real. One string, "a click" at the
   * door and script injection inside it.
   *
   * The fix is a shared parse that refuses any name which does not round-trip
   * (`serverName + '__' + toolName !== name`). A refused name is not a browser
   * tool at all here, and `executeAnyTool` fail-closes it on the "Unknown
   * tool" path — the same thing the builtin branch already does with a name it
   * does not recognize. The `'interactive'` fallback (U1 Ruling C1) is
   * untouched and still applies to names that ARE well-formed and merely
   * unknown — see the `totally-unclassified-tool` case above.
   */
  describe('namespaced-name round-trip (U9 C1)', () => {
    /** Every shape that carries a second separator, plus the empty suffix. */
    const MALFORMED_SUFFIXES = ['__x', '__', '__a__b', '__execute_js'];
    const SERVERS = ['abu-browser', 'abu-browser-bridge'];

    // The WHOLE class, not just execute_js: every browser tool, both server
    // namespaces, every malformed suffix shape.
    const CASES: Array<[string, string, string]> = SERVERS.flatMap((server) =>
      BROWSER_TOOL_SUFFIXES.flatMap((tool) =>
        MALFORMED_SUFFIXES.map((suffix) => [server, tool, suffix] as [string, string, string]),
      ),
    );

    it.each(CASES)(
      '%s__%s%s is refused by all three predicates — never silently reclassified',
      (server, tool, suffix) => {
        const name = `${server}__${tool}${suffix}`;
        expect(classifyBrowserTool(name), name).toBeNull();
        expect(isScriptingBrowserTool(name), name).toBe(false);
        expect(browserToolTargetsPage(name), name).toBe(false);
      },
    );

    it('the scripting tool specifically never degrades to the weaker interactive bucket', () => {
      // The Critical, stated as its own case: before the fix this returned
      // 'interactive', which `decideBrowserOperation` reads out of the
      // `unattended.interactive` cell (default 'allow') — the exact cell the
      // policy says scripting may never occupy.
      expect(classifyBrowserTool('abu-browser__execute_js__x')).not.toBe('interactive');
      expect(classifyBrowserTool('abu-browser-bridge__execute_js__x')).not.toBe('interactive');
    });

    it('leaves the well-formed names exactly as they were', () => {
      expect(classifyBrowserTool('abu-browser__execute_js')).toBe('scripting');
      expect(isScriptingBrowserTool('abu-browser__execute_js')).toBe(true);
      expect(classifyBrowserTool('abu-browser__click')).toBe('interactive');
      expect(classifyBrowserTool('abu-browser__snapshot')).toBe('read-only');
      expect(browserToolTargetsPage('abu-browser__snapshot')).toBe(true);
      // A well-formed but unknown tool still takes U1's gated fallback.
      expect(classifyBrowserTool('abu-browser__totally-unclassified-tool')).toBe('interactive');
    });
  });

  describe('normalizeBrowserOperationPolicy', () => {
    const VALID_POLICY: BrowserOperationPolicy = {
      readOnly: 'allow', interactive: 'ask', scripting: 'ask',
    };

    it('passes a fully well-formed policy through unchanged', () => {
      expect(normalizeBrowserOperationPolicy(VALID_POLICY)).toEqual(VALID_POLICY);
    });

    /**
     * The 2026-09-04 column collapse: every installed copy of the app has the
     * two-column shape in localStorage, and the ruling kept the ATTENDED
     * column — that is where the user said what Abu may do, and it is what
     * the merged defaults reproduce. Reading such a store as the new shape
     * instead would find no top-level rows, clamp all three to the strictest
     * state and silently reset a policy the user had configured.
     */
    describe('legacy two-column shape (settingsStore <= v46)', () => {
      it('keeps the attended column and drops the unattended one', () => {
        expect(normalizeBrowserOperationPolicy({
          attended: { readOnly: 'allow', interactive: 'ask', scripting: 'deny' },
          unattended: { readOnly: 'deny', interactive: 'deny', scripting: 'deny' },
        })).toEqual({ readOnly: 'allow', interactive: 'ask', scripting: 'deny' });
      });

      it('reads the attended column even when the unattended one is the permissive side', () => {
        // The direction that would matter if the wrong column were taken: an
        // 'allow' visible ONLY in the unattended column must not survive.
        expect(normalizeBrowserOperationPolicy({
          attended: { readOnly: 'ask', interactive: 'deny', scripting: 'deny' },
          unattended: { readOnly: 'allow', interactive: 'allow', scripting: 'allow' },
        })).toEqual({ readOnly: 'ask', interactive: 'deny', scripting: 'deny' });
      });

      it('clamps a malformed leaf inside the legacy column like any other', () => {
        expect(normalizeBrowserOperationPolicy({
          attended: { readOnly: 'maybe', interactive: 'allow' /* scripting missing */ },
          unattended: { readOnly: 'allow', interactive: 'allow', scripting: 'allow' },
        })).toEqual({ readOnly: 'ask', interactive: 'allow', scripting: 'ask' });
      });

      it('ignores a non-object attended key and reads the top level instead', () => {
        // Not the legacy shape, just a store with junk under that name — the
        // real rows are where the new shape says they are.
        expect(normalizeBrowserOperationPolicy({
          attended: null,
          readOnly: 'deny', interactive: 'deny', scripting: 'deny',
        })).toEqual({ readOnly: 'deny', interactive: 'deny', scripting: 'deny' });
      });
    });

    /**
     * A well-formed 'allow' for scripting must survive normalization: what it
     * buys an automatic run is decided at the gate (master switch + standing
     * site grant + not high-risk), not here. Clamping it would make the
     * setting silently un-saveable.
     */
    it('preserves an explicit scripting "allow"', () => {
      const withAllow: BrowserOperationPolicy = {
        readOnly: 'allow', interactive: 'allow', scripting: 'allow',
      };
      expect(normalizeBrowserOperationPolicy(withAllow)).toEqual(withAllow);
    });

    // A present-but-broken row is a signal that something went wrong, and
    // still clamps — the fail-safe posture is unchanged.
    it('clamps a MALFORMED scripting value to ask', () => {
      for (const bad of ['allowed', 'ALLOW', 1, true, null, {}]) {
        expect(normalizeBrowserOperationPolicy({
          ...VALID_POLICY, scripting: bad,
        }).scripting, JSON.stringify(bad)).toBe('ask');
      }
    });

    it('leaves an explicit scripting deny/ask alone', () => {
      for (const state of ['deny', 'ask'] as const) {
        expect(normalizeBrowserOperationPolicy({ ...VALID_POLICY, scripting: state }).scripting)
          .toBe(state);
      }
    });

    it('clamps a completely missing input to strictest-everywhere (ask)', () => {
      expect(normalizeBrowserOperationPolicy(undefined)).toEqual({
        readOnly: 'ask', interactive: 'ask', scripting: 'ask',
      });
    });

    it('clamps non-object input (string/number/null/array) to strictest-everywhere', () => {
      const strictest = { readOnly: 'ask', interactive: 'ask', scripting: 'ask' };
      for (const bad of ['nope', 42, null, [1, 2, 3]]) {
        expect(normalizeBrowserOperationPolicy(bad)).toEqual(strictest);
      }
    });

    it('clamps one missing leaf to strictest while preserving valid sibling leaves', () => {
      expect(normalizeBrowserOperationPolicy({ readOnly: 'allow' })).toEqual({
        readOnly: 'allow', interactive: 'ask', scripting: 'ask',
      });
    });

    it('clamps a leaf holding a value outside allow|deny|ask to strictest', () => {
      expect(normalizeBrowserOperationPolicy({
        readOnly: 'maybe', interactive: 'allow', scripting: true,
      })).toEqual({ readOnly: 'ask', interactive: 'allow', scripting: 'ask' });
    });
  });

  describe('decideBrowserOperation', () => {
    const OP_CLASSES: BrowserOperationClass[] = ['read-only', 'interactive', 'scripting'];
    const STATES: BrowserOperationState[] = ['allow', 'deny', 'ask'];

    /** A policy where every row is forced to `filler`, except the one row
     *  under test — isolates the matrix test from DEFAULT_BROWSER_OPERATION_POLICY. */
    function policyWith(
      key: 'readOnly' | 'interactive' | 'scripting',
      state: BrowserOperationState,
      filler: BrowserOperationState = 'allow',
    ): BrowserOperationPolicy {
      return { readOnly: filler, interactive: filler, scripting: filler, [key]: state };
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
            // ONE configured value, read identically by both execution
            // contexts (2026-09-04 ruling) — on a site the user granted, with
            // the master switch on, every row resolves to exactly what it was
            // set to. The conditions that make that safe for an automatic run
            // are the site verdict and the master switch this matrix holds
            // fixed; each is pinned on its own below.
            const expected = state;
            it(`${runMode}/${opClass} configured '${state}' → '${expected}'`, () => {
              expect(
                decideBrowserOperation({
                  opClass,
                  runMode,
                  policy: policyWith(POLICY_KEY[opClass], state),
                  masterSwitchUnattended: true,
                  siteVerdict: 'allowed',
                }),
              ).toBe(expected);
            });
          }
        }
      }
    });

    /**
     * Scripting is the one row whose configured `allow` is not taken at face
     * value for an automatic run. The conjunction pinned below is the same
     * one the 2026-09-04 opt-in ruling specified, and the column collapse did
     * not relax it:
     *   1. the unattended master switch is on,
     *   2. the site carries a standing 'allowed' verdict,
     *   3. the site is not high-risk.
     * Anything else is `deny`, never `ask`: `registry.ts` refuses a
     * state-changing action on an ungranted site anyway, so an approval
     * round-trip would wake a human to approve something already refused.
     */
    describe('unattended scripting: allow is site-scoped', () => {
      const OPTED_IN: BrowserOperationPolicy = {
        readOnly: 'allow', interactive: 'allow', scripting: 'allow',
      };
      const scripted = (
        overrides: Partial<Parameters<typeof decideBrowserOperation>[0]>,
      ) => decideBrowserOperation({
        opClass: 'scripting',
        runMode: 'unattended',
        policy: OPTED_IN,
        masterSwitchUnattended: true,
        siteVerdict: 'allowed',
        ...overrides,
      });

      it('condition 1+2+3 all hold → allow (the user allowed it, on a granted site)', () => {
        expect(scripted({})).toBe('allow');
      });

      it('condition 1 fails (master switch off) → deny', () => {
        expect(scripted({ masterSwitchUnattended: false })).toBe('deny');
      });

      it('condition 2 fails (no standing grant) → deny, not ask', () => {
        expect(scripted({ siteVerdict: 'default' })).toBe('deny');
        expect(scripted({ siteVerdict: 'denied' })).toBe('deny');
      });

      it('condition 3 fails (money movement / government URL) → deny', () => {
        expect(scripted({ siteVerdict: 'high-risk' })).toBe('deny');
      });

      it('an unknown site is a default-verdict site — deny, never a shrug', () => {
        // `getSiteVerdict` collapses "no entry" and "origin could not be
        // determined" into 'default'; both must land on the same refusal.
        expect(scripted({ siteVerdict: getSiteVerdict(null, {}) })).toBe('deny');
        expect(scripted({ siteVerdict: getSiteVerdict('https://never-granted.example', {}) }))
          .toBe('deny');
      });

      it('does not leak into the neighbouring rows or the default policy', () => {
        // Same granted site, DEFAULT policy: scripting asks rather than runs.
        expect(decideBrowserOperation({
          opClass: 'scripting',
          runMode: 'unattended',
          policy: DEFAULT_BROWSER_OPERATION_POLICY,
          masterSwitchUnattended: true,
          siteVerdict: 'allowed',
        })).toBe('ask');
        // And a scripting 'ask' still routes to the approval round-trip on a
        // site with no grant — the IM path is untouched by the site-scoping.
        expect(decideBrowserOperation({
          opClass: 'scripting',
          runMode: 'unattended',
          policy: { readOnly: 'allow', interactive: 'allow', scripting: 'ask' },
          masterSwitchUnattended: true,
          siteVerdict: 'default',
        })).toBe('ask');
      });

      it('leaves the ATTENDED reading of the same row alone — the scoping is unattended-only', () => {
        expect(
          decideBrowserOperation({
            opClass: 'scripting',
            runMode: 'attended',
            policy: OPTED_IN,
            masterSwitchUnattended: true,
            // No standing grant, and the attended reading still says allow:
            // the site-scoping belongs to the automatic context alone.
            siteVerdict: 'default',
          }),
        ).toBe('allow');
      });

      it('offers all three states for every row', () => {
        for (const opClass of OP_CLASSES) {
          expect(browserOperationStatesFor(opClass), opClass)
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
            policy: policyWith('interactive', 'allow'),
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

      /**
       * The one default that MOVED in the 2026-09-04 collapse: the unattended
       * column shipped scripting as `'deny'`, and the surviving column ships
       * it as `'ask'`. An automatic run therefore routes a default-policy
       * script to the IM approval seam instead of refusing it outright — and
       * with nobody bound to answer, `askOverIm` refuses it anyway
       * (`no_binding`). Nothing runs on the strength of the default; a human
       * answers, or it is refused.
       */
      it('unattended with the master switch on: read-only and interactive allow, scripting asks', () => {
        const base = {
          policy: DEFAULT_BROWSER_OPERATION_POLICY,
          masterSwitchUnattended: true,
          siteVerdict: 'allowed' as const,
          runMode: 'unattended' as const,
        };
        expect(decideBrowserOperation({ ...base, opClass: 'read-only' })).toBe('allow');
        expect(decideBrowserOperation({ ...base, opClass: 'interactive' })).toBe('allow');
        expect(decideBrowserOperation({ ...base, opClass: 'scripting' })).toBe('ask');
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
          // High-risk outranks an explicit scripting 'allow' — "always allow
          // this bank" plus "let scripts run" is exactly the combination this
          // control exists to prevent.
          policy: { readOnly: 'allow', interactive: 'allow', scripting: 'allow' },
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
          policy: { readOnly: 'allow', interactive: 'deny', scripting: 'ask' },
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
      it('a policy with no rows at all still asks rather than allowing', () => {
        const malformed = {} as unknown as BrowserOperationPolicy;
        for (const runMode of ['attended', 'unattended'] as const) {
          expect(
            decideBrowserOperation({
              opClass: 'interactive',
              runMode,
              policy: malformed,
              masterSwitchUnattended: true,
              siteVerdict: 'allowed',
            }),
            runMode,
          ).toBe('ask');
        }
      });

      it('a scripting row that arrives malformed never resolves to allow', () => {
        const malformed = {
          readOnly: 'allow', interactive: 'allow', scripting: 'ALLOW',
        } as unknown as BrowserOperationPolicy;
        // Unattended, on a granted site with the switch on — every
        // precedence step passes, so only the clamp stands between a
        // corrupted value and a script running unwatched.
        expect(
          decideBrowserOperation({
            opClass: 'scripting',
            runMode: 'unattended',
            policy: malformed,
            masterSwitchUnattended: true,
            siteVerdict: 'allowed',
          }),
        ).toBe('ask');
      });

      it('a policy with an invalid leaf value still returns a valid state (ask), not the garbage value', () => {
        const malformed = {
          readOnly: 'allow', interactive: 'yolo', scripting: 'ask',
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
