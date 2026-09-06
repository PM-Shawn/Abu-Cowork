/**
 * MCP Apps host — pure helpers (spec §4.2 / §4.5).
 *
 * Everything here is deliberately side-effect free and DOM free so the parts
 * that carry the security guarantees (the sandbox attribute, the CSP, the
 * srcdoc assembly) can be unit-tested without an iframe. `McpAppBlock` owns
 * the React/DOM side and `appBridgeSession` owns the protocol side.
 */
import type { McpUiHostContext, McpUiStyles, McpUiTheme } from '@modelcontextprotocol/ext-apps/app-bridge';
import { WIDGET_THEME_VARS } from '@/core/widget/designSystem';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The ONLY sandbox token an MCP App iframe ever gets.
 *
 * `allow-same-origin` is the load-bearing omission: Abu's renderer runs from a
 * privileged `file://`-ish origin, so granting it would give the server's HTML
 * the host's own origin (DOM, storage, preload bridge). Without it the srcdoc
 * document has an opaque origin and can only talk through postMessage.
 * `allow-popups` / `allow-downloads` / `allow-forms` /
 * `allow-top-navigation` are omitted for the same fail-closed reason — spec
 * §4.5 requires this and appHost.test.ts pins it.
 */
export const APP_IFRAME_SANDBOX = 'allow-scripts';

/**
 * Height ceiling for an app iframe, mirroring `HtmlWidgetBlock`'s
 * `MAX_IFRAME_HEIGHT`: a runaway `size-changed` must not be able to grow the
 * transcript without bound. Visual clipping stays the container's job.
 */
export const MAX_APP_IFRAME_HEIGHT = 4000;

/**
 * How many app bridges may stay mounted in one conversation (spec §4.5
 * "渲染并发上限"). Older blocks collapse to a click-to-load placeholder.
 */
export const MAX_ACTIVE_MCP_APPS = 6;

// ---------------------------------------------------------------------------
// Resource `_meta.ui` shapes (structural copies of the SDK types — kept local
// so this module stays importable from tests that never load the SDK).
// ---------------------------------------------------------------------------

export interface McpAppCspDeclaration {
  connectDomains?: string[];
  resourceDomains?: string[];
  /** Ignored — `frame-src` is forced to `'none'`. Kept so we can disclose it. */
  frameDomains?: string[];
  /** Ignored — `base-uri` is forced to `'none'`. Kept so we can disclose it. */
  baseUriDomains?: string[];
}

export interface McpAppResourceMeta {
  csp?: McpAppCspDeclaration;
  /** Ignored this batch — no device permissions are ever granted. */
  permissions?: Record<string, unknown>;
  /** Ignored this batch — we never give the iframe a real origin. */
  domain?: string;
  prefersBorder?: boolean;
}

// ---------------------------------------------------------------------------
// CSP
// ---------------------------------------------------------------------------

/**
 * Character whitelist for the `host[:port]` part of a declared domain.
 *
 * `URL` is not enough on its own: it happily keeps `;` and `,` inside the host
 * (`https://a.com;frame-src` parses, and `origin` echoes it back), which would
 * let a server smuggle extra directives into the policy string we build. Only
 * letters, digits, `.`, `-` and an optional numeric port may reach the CSP.
 *
 * Uppercase and non-ASCII (IDN) inputs fail closed by design: the `candidate
 * === url.origin` comparison below is case- and encoding-sensitive, so a server
 * that wants a domain allowed must declare it lowercase and punycoded.
 */
const DOMAIN_HOST_PORT_RE = /^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

const HTTPS_PREFIX = 'https://';

/**
 * A declared domain is accepted only when it is a bare `https://host[:port]`
 * origin — no scheme other than https, no wildcard, no path/query/fragment, no
 * credentials, no CSP separators. Everything else is dropped (spec §4.5:
 * `connectDomains` must not accept `*`).
 */
export function isAppDomainAllowed(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw || raw.includes('*') || !raw.startsWith(HTTPS_PREFIX)) return false;
  // A single trailing slash is the only decoration tolerated.
  const candidate = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (candidate.endsWith('/')) return false;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  if (url.pathname !== '/' && url.pathname !== '') return false;
  if (candidate !== url.origin) return false;
  // Last gate: whatever `URL` decided to keep as the authority must still be
  // plain `host[:port]` — see DOMAIN_HOST_PORT_RE.
  return DOMAIN_HOST_PORT_RE.test(candidate.slice(HTTPS_PREFIX.length));
}

function normalizeDomains(
  input: string[] | undefined,
  rejected: string[],
): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const entry of input) {
    if (isAppDomainAllowed(entry)) {
      const origin = new URL((entry as string).trim()).origin;
      if (!out.includes(origin)) out.push(origin);
    } else {
      // Blank padding is not worth reporting as a rejection; anything else is.
      const shown = typeof entry === 'string' ? entry : String(entry);
      if (typeof entry === 'string' && entry.trim() === '') continue;
      if (!rejected.includes(shown)) rejected.push(shown);
    }
  }
  return out;
}

function join(prefix: string, domains: string[]): string {
  return domains.length > 0 ? `${prefix} ${domains.join(' ')}` : prefix;
}

/**
 * Build the `<meta http-equiv="Content-Security-Policy">` value for an app
 * resource. The base policy is the spec default; the server may only WIDEN the
 * asset and connect directives, and only with valid https origins.
 * `frame-src` / `form-action` / `base-uri` are hard-coded to `'none'` and can
 * never be widened (so `frameDomains` / `baseUriDomains` are inert by design).
 */
export function buildAppCsp(declared?: McpAppCspDeclaration): { csp: string; rejected: string[] } {
  const rejected: string[] = [];
  const resourceDomains = normalizeDomains(declared?.resourceDomains, rejected);
  const connectDomains = normalizeDomains(declared?.connectDomains, rejected);

  const directives = [
    "default-src 'none'",
    join("script-src 'self' 'unsafe-inline'", resourceDomains),
    join("style-src 'self' 'unsafe-inline'", resourceDomains),
    join("img-src 'self' data: blob:", resourceDomains),
    join("font-src 'self' data:", resourceDomains),
    join("media-src 'self' data: blob:", resourceDomains),
    connectDomains.length > 0 ? `connect-src ${connectDomains.join(' ')}` : "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ];

  return { csp: directives.join('; '), rejected };
}

// ---------------------------------------------------------------------------
// srcdoc
// ---------------------------------------------------------------------------

/** Attribute-safe CSP text — the policy itself only uses single quotes, but a
 *  malformed/hostile value must not be able to close the `content="…"` attr.
 *  Only the DOM-less fallback shell needs this; `DOMParser` output is escaped
 *  by the serializer. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function cspMetaTag(csp: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`;
}

/**
 * Host-owned shell: the server's HTML goes in the body, so it is textually
 * *after* our meta no matter what it contains. Used for the environments that
 * have no `DOMParser` (non-DOM unit runners) — never as a regex fallback.
 */
function wrapInHostShell(html: string, csp: string): string {
  return `<!DOCTYPE html><html><head>${cspMetaTag(csp)}</head><body>${html}</body></html>`;
}

/**
 * Produce the iframe `srcdoc` for an app resource: the server's HTML with the
 * host-built CSP meta as the FIRST child of `<head>` (a meta CSP only governs
 * what comes after it, so position matters).
 *
 * The location of `<head>` is decided by an HTML parser, never by a regex: in
 * `<!-- <head> -->…` a regex match lands inside a comment and the document ends
 * up with no policy at all. Parsing also normalises the three input shapes
 * (full document, `<html>` without a head, bare fragment) into one code path,
 * since the parser synthesizes `<head>`/`<body>` for us.
 */
export function buildAppSrcdoc(html: string, csp: string): string {
  if (typeof DOMParser === 'undefined') return wrapInHostShell(html, csp);

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return wrapInHostShell(html, csp);
  }
  const head = doc.head;
  if (!head) return wrapInHostShell(html, csp);

  // `base-uri 'none'` already neuters it; dropping the element removes the
  // ambiguity (and any relative-URL surprise) instead of relying on the policy.
  for (const base of Array.from(doc.querySelectorAll('base'))) base.remove();

  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', csp);
  // First child, so a server-supplied CSP meta / <script> / <base> can only
  // ever come after ours.
  head.insertBefore(meta, head.firstChild);

  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

// ---------------------------------------------------------------------------
// hostContext
// ---------------------------------------------------------------------------

function themeValue(name: string, isDark: boolean): string {
  const spec = WIDGET_THEME_VARS.find((v) => v.name === name);
  if (!spec) return '';
  return isDark ? spec.dark : spec.light;
}

const FONT_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * Map Abu's widget design tokens (`designSystem.ts`, the same values the
 * `--w-*` widget CSS ships) onto the SDK's documented `styles.variables` names
 * so an app styled against the spec looks native in either theme.
 *
 * Typography/radius values mirror Abu's 8-token text scale (AGENTS.md §6.1).
 */
export function buildAppStyleVariables(isDark: boolean): Record<string, string> {
  /* eslint-disable no-restricted-syntax -- `--font-text-xs-size` and friends are
     the MCP Apps spec's own CSS custom-property names (McpUiStyleVariableKey),
     not Tailwind classes. The font-size-token rule only means to catch class
     strings; renaming these would break the contract with every app. */
  return {
    '--color-background-primary': themeValue('--w-bg', isDark),
    '--color-background-secondary': themeValue('--w-card', isDark),
    '--color-background-tertiary': themeValue('--w-muted', isDark),
    '--color-background-ghost': themeValue('--w-accent', isDark),
    '--color-background-inverse': themeValue('--w-fg', isDark),
    '--color-text-primary': themeValue('--w-fg', isDark),
    '--color-text-secondary': themeValue('--w-muted-fg', isDark),
    '--color-text-tertiary': themeValue('--w-muted-fg', isDark),
    '--color-text-inverse': themeValue('--w-bg', isDark),
    '--color-border-primary': themeValue('--w-border', isDark),
    '--color-border-secondary': themeValue('--w-border', isDark),
    '--color-ring-primary': themeValue('--w-primary', isDark),
    '--font-sans': FONT_SANS,
    '--font-mono': FONT_MONO,
    '--font-weight-normal': '400',
    '--font-weight-medium': '500',
    '--font-weight-semibold': '600',
    '--font-weight-bold': '600',
    '--font-text-xs-size': '11px',
    '--font-text-sm-size': '12px',
    '--font-text-md-size': '14px',
    '--font-text-lg-size': '16px',
    '--font-text-xs-line-height': '16px',
    '--font-text-sm-line-height': '18px',
    '--font-text-md-line-height': '22px',
    '--font-text-lg-line-height': '24px',
    '--font-heading-xs-size': '14px',
    '--font-heading-sm-size': '16px',
    '--font-heading-md-size': '20px',
    '--font-heading-lg-size': '22px',
    '--font-heading-xl-size': '24px',
    '--font-heading-xs-line-height': '22px',
    '--font-heading-sm-line-height': '24px',
    '--font-heading-md-line-height': '28px',
    '--font-heading-lg-line-height': '30px',
    '--font-heading-xl-line-height': '32px',
    '--border-radius-xs': '4px',
    '--border-radius-sm': '6px',
    '--border-radius-md': '8px',
    '--border-radius-lg': '10px',
    '--border-radius-xl': '14px',
    '--border-radius-full': '9999px',
    '--border-width-regular': '1px',
  };
  /* eslint-enable no-restricted-syntax */
}

/** Container size the app may lay itself out against. */
export type AppContainerDimensions = McpUiHostContext['containerDimensions'];

export interface HostContextInput {
  isDark: boolean;
  locale: string;
  timeZone: string;
  appVersion: string;
  containerDimensions?: AppContainerDimensions;
}

/**
 * Assemble the `hostContext` handed to the app at `ui/initialize` (and diffed
 * into `host-context-changed` later). This batch is inline-only — fullscreen
 * arrives with the display-mode work.
 */
export function buildHostContext(input: HostContextInput): McpUiHostContext {
  const theme: McpUiTheme = input.isDark ? 'dark' : 'light';
  return {
    theme,
    locale: input.locale,
    timeZone: input.timeZone,
    userAgent: `Abu/${input.appVersion}`,
    platform: 'desktop',
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
    deviceCapabilities: { touch: false, hover: true },
    styles: { variables: buildAppStyleVariables(input.isDark) as McpUiStyles },
    ...(input.containerDimensions ? { containerDimensions: input.containerDimensions } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool-name resolution
// ---------------------------------------------------------------------------

/**
 * Split a renderer tool name (`<server>__<tool>`, see client.ts) using the list
 * of servers that actually exist. Matching against real names rather than the
 * first `__` is what makes server names containing `__` work; the longest match
 * wins so `a__b` beats `a` for `a__b__c`.
 */
export function splitMcpToolName(
  toolName: string,
  serverNames: readonly string[],
): { server: string; tool: string } | undefined {
  let best: { server: string; tool: string } | undefined;
  for (const server of serverNames) {
    const prefix = `${server}__`;
    if (!toolName.startsWith(prefix) || toolName.length === prefix.length) continue;
    if (!best || server.length > best.server.length) {
      best = { server, tool: toolName.slice(prefix.length) };
    }
  }
  return best;
}
