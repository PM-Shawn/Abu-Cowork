/**
 * @vitest-environment happy-dom
 * @vitest-environment-options { "settings": { "disableCSSFileLoading": true, "handleDisabledFileLoadingAsSuccess": true } }
 *
 * disableCSSFileLoading: injecting <link rel="stylesheet"> into the live
 * happy-dom head would otherwise fire a real network fetch (flaky offline).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { WIDGET_RECEIVER_DOM_JS } from './widgetReceiverDom';
import { WIDGET_PREVIEW_PHASE_CLASS } from './widgetNormalize';

const FIXTURE_PATH = path.resolve(__dirname, '__fixtures__/whitescreen-glm52-portfolio.html');
const fixture = fs.readFileSync(FIXTURE_PATH, 'utf-8');

/**
 * Evaluate the receiver's plain-JS source (the exact string RECEIVER_HTML
 * embeds) and expose its functions. happy-dom provides DOMParser, document,
 * window and getComputedStyle, so the code runs here the same way it does
 * inside the widget iframe.
 */
interface CollectedScript { src: string; text: string; attrs: Array<{ name: string; value: string }> }
/** Shape posted for widget:sendMessage / widget:error — mirrors what
 *  HtmlWidgetBlock.tsx's receiver wiring passes as the `post` callback. */
interface PostedMessage {
  type: string;
  text?: string;
  message?: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
}
interface ReceiverDomApi {
  parseHtml: (html: string) => Document;
  injectHeadAssets: (doc: Document) => void;
  applyBodyAttributes: (doc: Document) => void;
  collectScripts: (doc: Document) => CollectedScript[];
  createScriptElement: (s: CollectedScript) => HTMLScriptElement;
  morphChildren: (target: Element, source: Element) => void;
  isWidgetBlank: () => boolean;
  applyBlankFallback: () => boolean;
  toggleTheme: (isDark: boolean) => void;
  sendPrompt: (post: (msg: PostedMessage) => void, text: unknown) => void;
  reportError: (
    post: (msg: PostedMessage) => void,
    message: unknown,
    source?: unknown,
    line?: unknown,
    col?: unknown,
    stack?: unknown,
  ) => void;
  stabilizeCanvas: () => void;
}

const buildApi = new Function(`${WIDGET_RECEIVER_DOM_JS}
  return {
    parseHtml: abuParseHtml,
    injectHeadAssets: abuInjectHeadAssets,
    applyBodyAttributes: abuApplyBodyAttributes,
    collectScripts: abuCollectScripts,
    createScriptElement: abuCreateScriptElement,
    morphChildren: abuMorphChildren,
    isWidgetBlank: abuIsWidgetBlank,
    applyBlankFallback: abuApplyBlankFallback,
    toggleTheme: abuToggleTheme,
    sendPrompt: abuSendPrompt,
    reportError: abuReportError,
    stabilizeCanvas: abuStabilizeCanvas,
  };`) as () => ReceiverDomApi;
const api = buildApi();

beforeEach(() => {
  // Reset the shared happy-dom document between tests — the receiver
  // functions operate on the ambient document/window, like in the iframe.
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  // Strip ALL body attributes (not just class/style) so data-* stamped by
  // one test can't leak into later tests.
  while (document.body.attributes.length > 0) {
    document.body.removeAttribute(document.body.attributes[0].name);
  }
  const w = window as unknown as Record<string, unknown>;
  w.__abuAuthorHeadNodes = undefined;
  w.__abuLastHeadAssetsSig = undefined;
  w.__abuAuthorBodyAttrs = undefined;
});

describe('abuParseHtml', () => {
  it('parses the full-document fixture into non-empty body content with the visible text', () => {
    const doc = api.parseHtml(fixture);
    expect(doc.body.children.length).toBeGreaterThan(0);
    expect(doc.body.textContent).toContain("Hi, I'm");
    expect(doc.body.textContent).toContain('Shawn');
  });

  it('handles a full document WITHOUT an explicit <body> tag', () => {
    const html = '<!DOCTYPE html><html><head><style>.a{color:red}</style></head><h1>Title</h1><p>Body-less but valid</p></html>';
    const doc = api.parseHtml(html);
    expect(doc.body.textContent).toContain('Title');
    expect(doc.body.textContent).toContain('Body-less but valid');
  });

  it("does not truncate at a '</body>' inside a script string literal", () => {
    const html = '<html><body><div id="before">x</div><script>var s="</bo" + "dy>";</script><div id="after">tail</div></body></html>';
    const doc = api.parseHtml(html);
    expect(doc.body.querySelector('#after')).not.toBeNull();
    expect(doc.body.textContent).toContain('tail');
  });

  it('passes a plain fragment through into body content', () => {
    const doc = api.parseHtml('<div class="card"><p>Hello <b>world</b></p></div>');
    expect(doc.body.querySelector('.card')).not.toBeNull();
    expect(doc.body.textContent).toContain('Hello world');
  });

  it("is not fooled by '<html' inside a comment in a fragment", () => {
    const doc = api.parseHtml('<!-- <html><body> --><div id="real">content</div>');
    expect(doc.body.querySelector('#real')).not.toBeNull();
    expect(doc.body.textContent).toContain('content');
  });
});

describe('abuInjectHeadAssets', () => {
  it('moves author head styles into the receiver head', () => {
    const doc = api.parseHtml(fixture);
    api.injectHeadAssets(doc);
    const styles = document.head.querySelectorAll('style');
    expect(styles.length).toBe(1);
    expect(styles[0].textContent).toContain('.fade-up');
  });

  it('skips entirely when the asset set is identical — same nodes stay in place (no FOUC churn)', () => {
    api.injectHeadAssets(api.parseHtml(fixture));
    const nodeAfterFirst = document.head.querySelector('style');
    expect(nodeAfterFirst).not.toBeNull();
    // Streaming re-sends of identical head content must not tear down and
    // re-create the nodes.
    api.injectHeadAssets(api.parseHtml(fixture));
    api.injectHeadAssets(api.parseHtml(fixture));
    expect(document.head.querySelectorAll('style').length).toBe(1);
    expect(document.head.querySelector('style')).toBe(nodeAfterFirst);
  });

  it('re-injects when the asset content changes', () => {
    api.injectHeadAssets(api.parseHtml('<html><head><style>.a{color:red}</style></head><body>x</body></html>'));
    const first = document.head.querySelector('style');
    expect(first!.textContent).toContain('.a');
    api.injectHeadAssets(api.parseHtml('<html><head><style>.a{color:red}.b{color:blue}</style></head><body>x</body></html>'));
    const styles = document.head.querySelectorAll('style');
    expect(styles.length).toBe(1);
    expect(styles[0]).not.toBe(first);
    expect(styles[0].textContent).toContain('.b');
  });

  it('carries <link rel="stylesheet"> over (CSP-allowlisted CDN styles must load)', () => {
    const html = '<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head><body><p>x</p></body></html>';
    api.injectHeadAssets(api.parseHtml(html));
    const link = document.head.querySelector('link[rel="stylesheet"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('fonts.googleapis.com');
  });

  it('removes previously injected assets when the new document has none', () => {
    api.injectHeadAssets(api.parseHtml(fixture));
    expect(document.head.querySelectorAll('style').length).toBe(1);
    api.injectHeadAssets(api.parseHtml('<div>no styles</div>'));
    expect(document.head.querySelectorAll('style').length).toBe(0);
  });
});

describe('abuApplyBodyAttributes', () => {
  it('copies author body class and style (body-scoped CSS like body.dark must work)', () => {
    const html = '<html><body class="dark theme-compact" style="background:#000"><p>x</p></body></html>';
    api.applyBodyAttributes(api.parseHtml(html));
    expect(document.body.classList.contains('dark')).toBe(true);
    expect(document.body.classList.contains('theme-compact')).toBe(true);
    expect(document.body.getAttribute('style')).toContain('background');
  });

  it('copies data-* attributes (body[data-theme=dark] CSS hooks must work)', () => {
    const html = '<html><body data-theme="dark" data-layout="wide"><p>x</p></body></html>';
    api.applyBodyAttributes(api.parseHtml(html));
    expect(document.body.getAttribute('data-theme')).toBe('dark');
    expect(document.body.getAttribute('data-layout')).toBe('wide');
  });

  it('preserves the receiver phase class while copying author classes', () => {
    document.body.classList.add(WIDGET_PREVIEW_PHASE_CLASS);
    api.applyBodyAttributes(api.parseHtml('<html><body class="dark"><p>x</p></body></html>'));
    expect(document.body.classList.contains('dark')).toBe(true);
    expect(document.body.classList.contains(WIDGET_PREVIEW_PHASE_CLASS)).toBe(true);
  });

  it('does not copy id or event-handler attributes', () => {
    const html = '<html><body id="evil" onload="hack()" onclick="hack()" class="ok"><p>x</p></body></html>';
    api.applyBodyAttributes(api.parseHtml(html));
    expect(document.body.getAttribute('id')).toBeNull();
    expect(document.body.getAttribute('onload')).toBeNull();
    expect(document.body.getAttribute('onclick')).toBeNull();
    expect(document.body.classList.contains('ok')).toBe(true);
  });

  it('resets previously copied attributes on re-injection', () => {
    api.applyBodyAttributes(api.parseHtml('<html><body class="dark" style="color:red" data-theme="dark"><p>x</p></body></html>'));
    api.applyBodyAttributes(api.parseHtml('<div>fragment without body attrs</div>'));
    expect(document.body.getAttribute('class')).toBeNull();
    expect(document.body.getAttribute('style')).toBeNull();
    expect(document.body.getAttribute('data-theme')).toBeNull();
  });
});

describe('abuCollectScripts', () => {
  it('collects head scripts before body scripts, in document order (CDN dep first)', () => {
    const html = '<html><head><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></head>'
      + '<body><p>x</p><script>new Chart();</script></body></html>';
    const doc = api.parseHtml(html);
    const scripts = api.collectScripts(doc);
    expect(scripts.length).toBe(2);
    expect(scripts[0].src).toContain('cdn.jsdelivr.net');
    expect(scripts[1].src).toBe('');
    expect(scripts[1].text).toContain('new Chart()');
  });

  it('removes collected scripts from the parsed document', () => {
    const doc = api.parseHtml(fixture);
    api.collectScripts(doc);
    expect(doc.querySelectorAll('script').length).toBe(0);
    // Non-script body content is untouched.
    expect(doc.body.textContent).toContain('Shawn');
  });

  it('collects the fixture inline scroll-reveal script', () => {
    const scripts = api.collectScripts(api.parseHtml(fixture));
    expect(scripts.length).toBe(1);
    expect(scripts[0].text).toContain('IntersectionObserver');
  });

  it('captures ALL attributes (id/type/data-*) for JSON-data blocks', () => {
    const html = '<html><body><script type="application/json" id="chart-data" data-source="api">{"a":1}</script></body></html>';
    const scripts = api.collectScripts(api.parseHtml(html));
    expect(scripts.length).toBe(1);
    const names = scripts[0].attrs.map((a) => a.name);
    expect(names).toContain('type');
    expect(names).toContain('id');
    expect(names).toContain('data-source');
    expect(scripts[0].text).toBe('{"a":1}');
  });
});

describe('abuCreateScriptElement', () => {
  it('re-creates a script with all original attributes and text preserved', () => {
    const html = '<html><body><script type="application/json" id="chart-data" data-source="api">{"a":1}</script></body></html>';
    const collected = api.collectScripts(api.parseHtml(html))[0];
    const el = api.createScriptElement(collected);
    expect(el.getAttribute('type')).toBe('application/json');
    expect(el.getAttribute('id')).toBe('chart-data');
    expect(el.getAttribute('data-source')).toBe('api');
    expect(el.textContent).toBe('{"a":1}');
  });

  it('re-creates an external script with its src attribute and no textContent', () => {
    const html = '<html><head><script src="https://cdn.jsdelivr.net/npm/chart.js" data-lib="chart"></script></head><body>x</body></html>';
    const collected = api.collectScripts(api.parseHtml(html))[0];
    const el = api.createScriptElement(collected);
    expect(el.getAttribute('src')).toContain('cdn.jsdelivr.net');
    expect(el.getAttribute('data-lib')).toBe('chart');
    expect(el.textContent).toBe('');
  });
});

describe('synthetic DOMContentLoaded (finalize lifecycle re-fire)', () => {
  it('bubbles:true reaches a window-level listener, matching native behavior', () => {
    // The finalize handler dispatches
    // new Event('DOMContentLoaded', { bubbles: true }) on document; author
    // code commonly listens on window. Verify the mechanism end-to-end.
    let windowHeard = 0;
    let documentHeard = 0;
    const onWindow = () => { windowHeard++; };
    const onDocument = () => { documentHeard++; };
    window.addEventListener('DOMContentLoaded', onWindow);
    document.addEventListener('DOMContentLoaded', onDocument);
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    window.removeEventListener('DOMContentLoaded', onWindow);
    document.removeEventListener('DOMContentLoaded', onDocument);
    expect(documentHeard).toBe(1);
    expect(windowHeard).toBe(1);
  });
});

describe('abuMorphChildren', () => {
  it('preserves an existing <canvas> element identity across a morph', () => {
    document.body.innerHTML = '<div><canvas id="chart"></canvas><p>v1</p></div>';
    const canvasBefore = document.body.querySelector('canvas');
    const next = api.parseHtml('<div><canvas id="chart"></canvas><p>v2</p></div>');
    api.morphChildren(document.body, next.body);
    expect(document.body.querySelector('canvas')).toBe(canvasBefore);
    expect(document.body.textContent).toContain('v2');
  });

  it('appends new tail nodes and removes dropped ones', () => {
    document.body.innerHTML = '<p>a</p><p>b</p>';
    api.morphChildren(document.body, api.parseHtml('<p>a</p>').body);
    expect(document.body.querySelectorAll('p').length).toBe(1);
    api.morphChildren(document.body, api.parseHtml('<p>a</p><p>b</p><p>c</p>').body);
    expect(document.body.querySelectorAll('p').length).toBe(3);
  });

  it('patches attributes in place', () => {
    document.body.innerHTML = '<div class="old" data-x="1">t</div>';
    api.morphChildren(document.body, api.parseHtml('<div class="new">t</div>').body);
    const div = document.body.querySelector('div')!;
    expect(div.getAttribute('class')).toBe('new');
    expect(div.getAttribute('data-x')).toBeNull();
  });
});

describe('blank fallback (abuIsWidgetBlank / abuApplyBlankFallback)', () => {
  it('re-adds the preview class when EVERY direct body child is invisible', () => {
    document.body.innerHTML =
      '<section style="opacity:0">a</section>'
      + '<div style="visibility:hidden">b</div>'
      + '<footer style="display:none">c</footer>';
    expect(api.isWidgetBlank()).toBe(true);
    expect(api.applyBlankFallback()).toBe(true);
    expect(document.body.classList.contains(WIDGET_PREVIEW_PHASE_CLASS)).toBe(true);
  });

  it('does NOT trigger when at least one child is visible (hidden modal + visible content)', () => {
    document.body.innerHTML =
      '<div id="modal" style="opacity:0">hidden modal</div>'
      + '<main>visible content</main>';
    expect(api.isWidgetBlank()).toBe(false);
    expect(api.applyBlankFallback()).toBe(false);
    expect(document.body.classList.contains(WIDGET_PREVIEW_PHASE_CLASS)).toBe(false);
  });

  it('does NOT trigger on a body with only script/style/link children (nothing to reveal)', () => {
    document.body.innerHTML = '<style>.a{}</style><script>1</script>';
    expect(api.isWidgetBlank()).toBe(false);
  });

  it('does NOT trigger on an empty body', () => {
    expect(api.isWidgetBlank()).toBe(false);
  });

  it('triggers when the body itself is faded out (body{opacity:0} page-fade pattern)', () => {
    document.body.setAttribute('style', 'opacity:0');
    document.body.innerHTML = '<main>content that would be visible</main>';
    expect(api.isWidgetBlank()).toBe(true);
    expect(api.applyBlankFallback()).toBe(true);
    expect(document.body.classList.contains(WIDGET_PREVIEW_PHASE_CLASS)).toBe(true);
  });

  it('triggers when the body itself is visibility:hidden', () => {
    document.body.setAttribute('style', 'visibility:hidden');
    document.body.innerHTML = '<main>content</main>';
    expect(api.isWidgetBlank()).toBe(true);
  });

  it('is reversible — no inline styles are stamped on elements', () => {
    document.body.innerHTML = '<section style="opacity:0">a</section>';
    api.applyBlankFallback();
    const el = document.body.querySelector('section')!;
    // The element keeps its author style untouched; visibility comes from
    // the class-gated stylesheet rule, so removing the class restores state.
    expect(el.getAttribute('style')).toBe('opacity:0');
  });
});

// ---------------------------------------------------------------------------
// P3 — host-runtime capabilities (theme sync, sendPrompt bridge, structured
// crash reporting, canvas stabilization)
// ---------------------------------------------------------------------------

describe('abuToggleTheme', () => {
  it('adds .dark on body when isDark is true', () => {
    api.toggleTheme(true);
    expect(document.body.classList.contains('dark')).toBe(true);
  });

  it('removes .dark on body when isDark is false', () => {
    document.body.classList.add('dark');
    api.toggleTheme(false);
    expect(document.body.classList.contains('dark')).toBe(false);
  });

  it('is idempotent — toggling the same value twice keeps a single class occurrence', () => {
    api.toggleTheme(true);
    api.toggleTheme(true);
    expect(document.body.className.split(/\s+/).filter((c) => c === 'dark').length).toBe(1);
  });
});

describe('abuSendPrompt', () => {
  it('posts a widget:sendMessage with the given text', () => {
    const posted: unknown[] = [];
    api.sendPrompt((msg) => posted.push(msg), 'Refresh the chart with Q3 data');
    expect(posted).toEqual([{ type: 'widget:sendMessage', text: 'Refresh the chart with Q3 data' }]);
  });

  it('truncates text longer than 500 chars (WorkBuddy parity)', () => {
    const posted: Array<{ text?: string }> = [];
    const long = 'x'.repeat(600);
    api.sendPrompt((msg) => posted.push(msg), long);
    expect(posted[0].text).toHaveLength(500);
    expect(posted[0].text).toBe('x'.repeat(500));
  });

  it('coerces non-string input (e.g. a number) instead of throwing', () => {
    const posted: Array<{ text?: string }> = [];
    api.sendPrompt((msg) => posted.push(msg), 42);
    expect(posted[0].text).toBe('42');
  });

  it('coerces null/undefined to an empty string', () => {
    const posted: Array<{ text?: string }> = [];
    api.sendPrompt((msg) => posted.push(msg), null);
    expect(posted[0].text).toBe('');
  });
});

describe('abuReportError', () => {
  it('posts a widget:error shape with message/source/line/col/stack', () => {
    const posted: unknown[] = [];
    api.reportError((msg) => posted.push(msg), 'Chart is not defined', 'inline', 12, 4, 'Error: Chart is not defined\n  at <anonymous>');
    expect(posted).toEqual([{
      type: 'widget:error',
      message: 'Chart is not defined',
      source: 'inline',
      line: 12,
      col: 4,
      stack: 'Error: Chart is not defined\n  at <anonymous>',
    }]);
  });

  it('truncates an oversized message/stack so the payload stays small', () => {
    const posted: Array<{ message?: string; stack?: string }> = [];
    api.reportError((msg) => posted.push(msg), 'm'.repeat(600), undefined, undefined, undefined, 's'.repeat(1200));
    expect(posted[0].message).toHaveLength(500);
    expect(posted[0].stack).toHaveLength(1000);
  });

  it('swallows a throwing post callback instead of propagating', () => {
    expect(() => {
      api.reportError(() => { throw new Error('post failed'); }, 'boom');
    }).not.toThrow();
  });

  it('handles a missing/undefined message without throwing', () => {
    const posted: Array<{ message?: string }> = [];
    expect(() => api.reportError((msg) => posted.push(msg), undefined)).not.toThrow();
    expect(posted[0].message).toBe('');
  });
});

describe('error surfaces ONLY when the widget rendered blank (C2)', () => {
  // Codifies the receiver's glue: onerror RECORDS via abuReportError(recordCb),
  // and the finalize blank-fallback path posts widget:error only when the
  // widget is actually blank AND an error was captured. A working widget with
  // a benign async error must show NO row.
  it('surfaces the captured error when the widget is blank', () => {
    let captured: string | null = null;
    api.reportError((m) => { captured = m.message; }, 'Chart is not defined');
    document.body.innerHTML = '<section style="opacity:0">a</section>'; // blank
    const posted: unknown[] = [];
    if (api.applyBlankFallback() && captured) {
      posted.push({ type: 'widget:error', message: captured });
    }
    expect(posted).toEqual([{ type: 'widget:error', message: 'Chart is not defined' }]);
  });

  it('does NOT surface a captured error when the widget rendered visible content', () => {
    let captured: string | null = null;
    api.reportError((m) => { captured = m.message; }, 'benign async rejection');
    document.body.innerHTML = '<main>fully rendered chart</main>'; // visible
    const posted: unknown[] = [];
    if (api.applyBlankFallback() && captured) {
      posted.push({ type: 'widget:error', message: captured });
    }
    expect(posted).toEqual([]);
    // The error was still recorded — just never surfaced to the host.
    expect(captured).toBe('benign async rejection');
  });
});

describe('abuStabilizeCanvas (zero-height-only)', () => {
  it('gives a fallback min-height to a canvas that rendered at ~0px', () => {
    // The broken case: a responsive canvas whose computed height is 0.
    document.body.innerHTML = '<div><canvas height="240" style="height:0px"></canvas></div>';
    api.stabilizeCanvas();
    const parent = document.body.querySelector('div')!;
    // Derived (clamped) from the height attribute since it's usable.
    expect(parent.style.minHeight).toBe('240px');
  });

  it('falls back to ~320px for a zero-height canvas with no usable height attribute', () => {
    document.body.innerHTML = '<div><canvas style="height:0px"></canvas></div>';
    api.stabilizeCanvas();
    const parent = document.body.querySelector('div')!;
    expect(parent.style.minHeight).toBe('320px');
  });

  it('clamps an oversized height attribute to the sane range', () => {
    document.body.innerHTML = '<div><canvas height="4000" style="height:0px"></canvas></div>';
    api.stabilizeCanvas();
    const parent = document.body.querySelector('div')!;
    expect(parent.style.minHeight).toBe('600px');
  });

  it('leaves a properly-sized canvas UNTOUCHED (no whitespace on sparklines/compact charts)', () => {
    document.body.innerHTML = '<div><canvas height="240" style="height:240px"></canvas></div>';
    api.stabilizeCanvas();
    const parent = document.body.querySelector('div')!;
    expect(parent.style.minHeight).toBe('');
  });

  it('does nothing when there is no canvas', () => {
    document.body.innerHTML = '<div><p>no canvas here</p></div>';
    expect(() => api.stabilizeCanvas()).not.toThrow();
    const parent = document.body.querySelector('div')!;
    expect(parent.style.minHeight).toBe('');
  });

  it('does not overwrite an already-stabilized parent (idempotent across repeated finalize calls)', () => {
    document.body.innerHTML = '<div><canvas height="240" style="height:0px"></canvas></div>';
    const parent = document.body.querySelector('div')!;
    parent.style.minHeight = '999px';
    api.stabilizeCanvas();
    expect(parent.style.minHeight).toBe('999px');
  });
});
