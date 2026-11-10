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
 * and `highRiskSites.test.ts` pins this shared implementation's source.
 *
 * If a page-derived signal is ever wanted, it may only TIGHTEN (turn a
 * not-high-risk URL into high-risk); it may never relax a URL-based verdict.
 *
 * ## What counts
 *
 * Two kinds of host, and nothing else: money-movement domains (payment
 * processors, banks, brokerages, exchanges) and government hosts. The path is
 * not read. Path keywords (`/payment`, `/transfer`, `/checkout`, …) used to
 * flag any site, which turned a company OA's `/finance/payment/list` report
 * page into a bank: every click asked, in every mode, with no way to remember.
 * On a money domain the whole host is high-risk already, so a keyword added
 * nothing there.
 *
 * The caller decides what each kind means: on a money domain every action asks
 * and nothing is remembered; on a government host the first action of a task
 * asks. Opening and reading a page is not an action (`navigatesOnly`).
 *
 * ## Deliberately minimal, deliberately incomplete
 *
 * The domain table below is a list of unambiguous money-movement hosts, not an
 * attempt at completeness — an incomplete list is not a hole in the fence,
 * because everything it misses still falls through to the ordinary site
 * configuration + operation-policy gate.
 */

/**
 * Registrable domains whose entire surface is money movement: payment
 * processors, banks, brokerages, crypto exchanges. Matched as the host itself
 * or a subdomain of it (`secure.stripe.com` yes, `evilstripe.com` no — see
 * `hostMatchesSuffix`).
 */
const MONEY_MOVEMENT_DOMAINS = [
  // Payment processors / wallets
  'paypal.com',
  'stripe.com',
  'squareup.com',
  'wise.com',
  'venmo.com',
  'alipay.com',
  'unionpay.com',
  // Banks (a representative few; an unlisted bank falls back to the ordinary site gate)
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
  'bankcomm.com',
  'psbc.com',
  'cib.com.cn',
  'spdb.com.cn',
  'cebbank.com',
  'citicbank.com',
  'cmbc.com.cn',
  'hxb.com.cn',
  'cgbchina.com.cn',
  'bank.pingan.com',
  'bankofbeijing.com.cn',
  'mybank.cn',
  'webank.com',
  // Payment and clearing services in China
  'tenpay.com',
  'pay.weixin.qq.com',
  '95516.com',
  '99bill.com',
  'yeepay.com',
  'lianlianpay.com',
  'jdpay.com',
  // Brokerages / crypto exchanges (the web trading hosts of the large Chinese securities firms first)
  'citics.com',
  'htsc.com.cn',
  'gtja.com',
  'cmschina.com',
  'gf.com.cn',
  'schwab.com',
  'fidelity.com',
  'robinhood.com',
  'coinbase.com',
  'binance.com',
  'okx.com',
];

/**
 * Government hosts, matched as a suffix of the registrable-domain tail rather
 * than an enumerated list: `.gov` is a restricted TLD, and `.gov.<cc>` is the
 * same convention in the country-code namespaces.
 */
const GOVERNMENT_HOST_SUFFIXES = [
  'gov',
  'gov.cn',
  'gov.uk',
  'gov.au',
  'go.jp',
  'gouv.fr',
];

/**
 * `host` is exactly `suffix`, or a subdomain of it. NOT `endsWith`: that would
 * hand `evilstripe.com` the verdict earned by `stripe.com`, and a lookalike
 * domain is the first thing an attacker reaches for.
 */
function hostMatchesSuffix(host, suffix) {
  if (host === suffix) return true;
  return host.endsWith(`.${suffix}`);
}

/**
 * Classify a full URL. Returns null for anything this module does not
 * recognize — including unparseable input and non-http(s) schemes, which have
 * no site behind them to be high-risk about.
 *
 * NOTE the single parameter: see the URL-ONLY section in this module's doc.
 */
export function classifyHighRiskUrl(url) {
  if (!url) return null;
  let parsed;
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

  // A money-movement keyword in the path of any other site is no longer a
  // verdict: see "What counts" in this module's doc.
  return null;
}

/** Boolean form of {@link classifyHighRiskUrl}, for call sites that only branch. */
export function isHighRiskUrl(url) {
  return classifyHighRiskUrl(url) !== null;
}
