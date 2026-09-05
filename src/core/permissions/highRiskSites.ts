/**
 * High-risk site classification (batch-二 U5, `docs/abu-browser-batch2-brief-2026-09.md` §三 T2).
 *
 * `alwaysAskPolicy.ts` names the gap this closes: "Money movement (transfer /
 * payment / trade). A browser click on a bank's 'confirm transfer' button is
 * indistinguishable from any other click at this layer." It is indistinguishable
 * from the CLICK — but not from the ADDRESS. This module is that address-level
 * classifier, and its verdict feeds `decideBrowserOperation` as
 * `siteVerdict: 'high-risk'`:
 *
 * - unattended → deny outright (nobody can answer for a wire transfer);
 * - attended → force a confirmation, and never offer "always allow this site"
 *   (`allowPersistentGrant: false`) — a standing grant for a bank is exactly
 *   the artifact this control exists to prevent.
 *
 * ## 🔴 URL-ONLY, by construction
 *
 * This decides an AUTHORIZATION outcome, so it reads the URL and NOTHING else.
 * Never add a parameter, an import, or a heuristic that consults page-derived
 * data (a snapshot, extract_text, a tool result, the DOM, the page title): a
 * page under an attacker's control would then be able to talk its way out of
 * being classified as a payment page — the global constraint「页面内容永不视为
 * 授权」. The module deliberately has zero imports so that rule is checkable,
 * and `highRiskSites.test.ts` pins it by inspecting this file's source.
 *
 * If a page-derived signal is ever wanted, it may only TIGHTEN (turn a
 * not-high-risk URL into high-risk); it may never relax a URL-based verdict.
 *
 * ## Known evasion, and why it is acceptable
 *
 * A page can shed the PATH classifier at will — `history.replaceState({}, '',
 * '/x')` rewrites the address bar without a navigation, and the next call
 * resolves a URL with no money-movement keyword in it. That is fail-safe, not
 * a hole: evasion only returns the call to the ORDINARY gate, which for an
 * unattended run still requires a standing `'allowed'` site grant, still pins
 * the origin at execution time, and still refuses scripting. The escape route
 * leads back to the fence, not past it. The domain table is unaffected by this
 * (a host cannot be rewritten without actually navigating).
 *
 * ## Deliberately minimal, deliberately incomplete
 *
 * The domain table below is a short list of unambiguous money-movement and
 * government hosts, not an attempt at completeness — an incomplete list is not
 * a hole in the fence, because everything it misses still falls through to the
 * ordinary site-verdict + operation-policy gate. The path patterns are what
 * gives it reach beyond the list: `/checkout`, `/transfer`, `/wire` and their
 * kin appear on the long tail of sites nobody can enumerate.
 */

/** Why a URL was classified high-risk. Surfaced in the refusal/confirmation copy. */
export type HighRiskReason = 'money-domain' | 'government-domain' | 'money-movement-path';

export interface HighRiskSiteMatch {
  reason: HighRiskReason;
  /** The host suffix or path keyword that matched — for logs and copy, never for control flow. */
  matched: string;
}

/**
 * Registrable domains whose entire surface is money movement: payment
 * processors, banks, brokerages, crypto exchanges. Matched as the host itself
 * or a subdomain of it (`secure.stripe.com` yes, `evilstripe.com` no — see
 * `hostMatchesSuffix`).
 */
const MONEY_MOVEMENT_DOMAINS: readonly string[] = [
  // Payment processors / wallets
  'paypal.com',
  'stripe.com',
  'squareup.com',
  'wise.com',
  'venmo.com',
  'alipay.com',
  'unionpay.com',
  // Banks (a representative few — the path patterns carry the long tail)
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citibank.com',
  'hsbc.com',
  'icbc.com.cn',
  'ccb.com',
  'boc.cn',
  'abchina.com',
  'cmbchina.com',
  // Brokerages / crypto exchanges
  'schwab.com',
  'fidelity.com',
  'robinhood.com',
  'coinbase.com',
  'binance.com',
];

/**
 * Government hosts, matched as a suffix of the registrable-domain tail rather
 * than an enumerated list: `.gov` is a restricted TLD, and `.gov.<cc>` is the
 * same convention in the country-code namespaces.
 */
const GOVERNMENT_HOST_SUFFIXES: readonly string[] = [
  'gov',
  'gov.cn',
  'gov.uk',
  'gov.au',
  'go.jp',
  'gouv.fr',
];

/**
 * Money-movement path keywords. Anchored to path-SEGMENT-ish boundaries on
 * purpose: a bare substring match flags `/hardwired`, `/repayments` and
 * `/checkouts-are-hard`, and a control that cries wolf on a blog post is a
 * control users switch off.
 */
const MONEY_MOVEMENT_PATH_KEYWORDS: readonly string[] = [
  'transfer',
  'payment',
  'checkout',
  'wire',
  'remit',
];

const MONEY_MOVEMENT_PATH_PATTERN = new RegExp(
  `(?:^|[/_.\\-])(${MONEY_MOVEMENT_PATH_KEYWORDS.join('|')})(?:s)?(?:[/_.\\-]|$)`,
  'i',
);

/**
 * `host` is exactly `suffix`, or a subdomain of it. NOT `endsWith`: that would
 * hand `evilstripe.com` the verdict earned by `stripe.com`, and a lookalike
 * domain is the first thing an attacker reaches for.
 */
function hostMatchesSuffix(host: string, suffix: string): boolean {
  if (host === suffix) return true;
  return host.endsWith(`.${suffix}`);
}

/**
 * Percent-encoding must not be an escape hatch: `/%74%72%61%6e%73%66%65%72`
 * loads exactly the same page as `/transfer`, and `URL.pathname` keeps the
 * encoded spelling. Decoding failure (a lone `%`) falls back to the raw path —
 * matching on something is better than matching on nothing.
 */
function decodedPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Classify a full URL. Returns null for anything this module does not
 * recognize — including unparseable input and non-http(s) schemes, which have
 * no site behind them to be high-risk about.
 *
 * NOTE the single parameter: see the URL-ONLY section in this module's doc.
 */
export function classifyHighRiskUrl(url: string | null | undefined): HighRiskSiteMatch | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // Same normalization `normalizeBrowserOrigin` applies, and for the same
  // reason: `paypal.com.` and `paypal.com` resolve to one host over DNS, so
  // they must not be two different verdicts.
  const host = (parsed.hostname.endsWith('.')
    ? parsed.hostname.slice(0, -1)
    : parsed.hostname
  ).toLowerCase();
  if (!host) return null;

  for (const domain of MONEY_MOVEMENT_DOMAINS) {
    if (hostMatchesSuffix(host, domain)) return { reason: 'money-domain', matched: domain };
  }
  for (const suffix of GOVERNMENT_HOST_SUFFIXES) {
    if (hostMatchesSuffix(host, suffix)) return { reason: 'government-domain', matched: suffix };
  }

  // Only the PATH, never the query: `?q=payment` is a search for the word, not
  // a payment page, and flagging it would make the control noise.
  const match = MONEY_MOVEMENT_PATH_PATTERN.exec(decodedPath(parsed.pathname));
  if (match) return { reason: 'money-movement-path', matched: match[1].toLowerCase() };

  return null;
}

/** Boolean form of {@link classifyHighRiskUrl}, for call sites that only branch. */
export function isHighRiskUrl(url: string | null | undefined): boolean {
  return classifyHighRiskUrl(url) !== null;
}
