/**
 * The payment pages of a government site: paying a tax, a fee, a fine. Acting
 * on a government site asks once per task (`taskGrants.ts`), but a payment
 * there moves money like a bank page does, so each click or fill on one asks
 * every time and no task grant covers it.
 *
 * Read from the address path and from the page title. The title is written by
 * the page, so it may only tighten: a title that says 「缴费」 makes the page a
 * payment page, and nothing a page says makes it anything less
 * (`highRiskSites.mjs`, the URL-only rule, still decides what is high-risk at
 * all). Called only for a host that rule classifies as a government host.
 */

/** `/pay`, `/payment`, `/online-payments`, `/jiaofei`: a keyword bounded by separators. */
const PAYMENT_ROUTE_PATTERN = /(?:^|[/_.-])(?:pay|payments?|jiaofei|jiaokuan|zhifu)(?:[/_.-]|$)/iu;
/** Query parameters that name the action or page, as against a search box (`?q=payment`). */
const ROUTE_PARAMS = new Set(['action', 'act', 'op', 'do', 'method', 'page', 'route', 'path', 'type', 'step', 'service', 'module', 'mod', 'view', 'tab', 'a', 'm', 'c', 'cmd']);
/** The words a payment page is titled with, in either language. */
const PAYMENT_TITLE_PATTERN = /缴款|缴费|缴纳|缴税|支付|付款|\bpay(?:ment)?s?\b/iu;
/** The same words in a path, which may also spell them in Chinese. */
const PAYMENT_PATH_CJK = /缴款|缴费|缴纳|缴税|支付|付款/u;

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // A lone `%`: matching on the raw text beats matching on nothing.
    return text;
  }
}

/**
 * The parts of the address that can name a page: the path, the fragment route
 * of a single-page app (`#/pay/confirm`) and the query (`?action=pay`).
 */
function decodedRoutes(url: string): string[] | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // The path, the fragment route, and the value of each query parameter that names an action or page.
  const queryRoutes = [...parsed.searchParams].filter(([key]) => ROUTE_PARAMS.has(key.toLowerCase())).map(([, value]) => `/${value}`);
  return [decode(parsed.pathname), decode(parsed.hash), ...queryRoutes];
}

export function isPaymentPagePath(url: string | null | undefined): boolean {
  if (!url) return false;
  const routes = decodedRoutes(url);
  return routes !== null && routes.some((route) => PAYMENT_ROUTE_PATTERN.test(route) || PAYMENT_PATH_CJK.test(route));
}

export function isPaymentPageTitle(title: string | null | undefined): boolean {
  return typeof title === 'string' && PAYMENT_TITLE_PATTERN.test(title);
}
