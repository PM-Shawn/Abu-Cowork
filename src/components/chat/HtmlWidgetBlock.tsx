import { useI18n, getI18n } from '@/i18n';
import RenderableCodeBlock, { type CodeBlockRendererConfig } from './RenderableCodeBlock';
import {
  buildPreviewNeutralizeCss,
  ensureDoctype,
  isFullDocument,
  WIDGET_PREVIEW_PHASE_CLASS,
} from './widgetNormalize';
import { WIDGET_RECEIVER_DOM_JS } from './widgetReceiverDom';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Max iframe height — generous limit to prevent runaway content.
// Visual clipping is handled by RenderableCodeBlock's container maxHeight.
const MAX_IFRAME_HEIGHT = 4000;

const CDN_ALLOWLIST = [
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://esm.sh',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
].join(' ');

const BASE_STYLES = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: auto !important; min-height: 0 !important; }
body {
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px; line-height: 1.6;
  color: var(--abu-text-primary); background: #fff; padding: 16px; overflow: hidden;
}
:root {
  --abu-primary: var(--abu-clay); --abu-text: var(--abu-text-primary); --abu-text-muted: var(--abu-text-muted);
  --abu-bg: #fff; --abu-bg-secondary: var(--abu-bg-muted); --abu-border: var(--abu-bg-pressed);
  --abu-font: system-ui, -apple-system, sans-serif;
}
button {
  cursor: pointer; font-family: inherit;
  border: 1px solid var(--abu-border); border-radius: 6px;
  padding: 6px 12px; background: var(--abu-bg); color: var(--abu-text);
  font-size: 13px; transition: background 0.15s;
}
button:hover { background: var(--abu-bg-secondary); }
button:active { transform: scale(0.98); }
input[type="range"] { accent-color: var(--abu-primary); }
`;

// Receiver page loaded once into iframe.srcdoc — all updates come via postMessage.
const RECEIVER_HTML = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${CDN_ALLOWLIST}; style-src 'unsafe-inline' ${CDN_ALLOWLIST}; img-src data: blob: ${CDN_ALLOWLIST}; media-src data: blob: ${CDN_ALLOWLIST}; connect-src ${CDN_ALLOWLIST}; font-src data: ${CDN_ALLOWLIST};">
<style>${BASE_STYLES}
${buildPreviewNeutralizeCss()}
</style>
</head><body>
<script>
(function(){
  // Shared DOM logic (DOMParser injection, morph, blank fallback) — sourced
  // from widgetReceiverDom.ts so vitest can exercise the exact same code.
${WIDGET_RECEIVER_DOM_JS}
  var lastH=0, first=true;
  function reportHeight(){
    var h=document.documentElement.scrollHeight;
    if(h!==lastH){lastH=h;
      window.parent.postMessage({type:'abu-widget-resize',height:h,first:first},'*');
      first=false;
    }
  }
  new MutationObserver(reportHeight).observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});
  new ResizeObserver(reportHeight).observe(document.documentElement);
  window.addEventListener('load',reportHeight);

  document.addEventListener('click',function(e){
    var a=e.target&&e.target.closest?e.target.closest('a'):null;
    if(a&&a.href){e.preventDefault();
      window.parent.postMessage({type:'abu-widget-link',url:a.href},'*');
    }
  });

  window.addEventListener('message',function(e){
    if(!e.data)return;
    if(e.data.type==='widget:update'){
      // Platform parser handles fragments AND full documents (missing <body>,
      // '</body>' inside script strings, '<html' in comments, ...) uniformly.
      var udoc=abuParseHtml(e.data.html);
      // Drop any script that slipped through (host strips them for preview;
      // this is defense in depth — preview must never execute author JS).
      abuCollectScripts(udoc);
      abuInjectHeadAssets(udoc);
      abuApplyBodyAttributes(udoc);
      document.body.classList.add('${WIDGET_PREVIEW_PHASE_CLASS}');
      abuMorphChildren(document.body,udoc.body);
      // Prefetch external scripts during preview so they're cached by finalize.
      // Uses <link rel="prefetch"> — downloads without executing.
      if(e.data.scripts){
        e.data.scripts.forEach(function(src){
          if(!document.querySelector('link[href="'+src+'"]')){
            var link=document.createElement('link');
            link.rel='prefetch';link.as='script';link.href=src;
            document.head.appendChild(link);
          }
        });
      }
      reportHeight();
    }
    if(e.data.type==='widget:finalize'){
      // NOTE: the preview neutralizer class stays ON through the whole
      // script chain — content must remain visible while (possibly slow)
      // CDN scripts load, and IntersectionObservers attach while everything
      // is visible so in-view items get their reveal class before the
      // neutralizer lifts. Failure direction flips from "blank" to
      // "no animation".
      // Finalize receives the RAW author code — head scripts (e.g. a CDN
      // <script src>) arrive here for the first time and must run before
      // body scripts, in document order.
      var fdoc=abuParseHtml(e.data.html);
      var scripts=abuCollectScripts(fdoc);
      abuInjectHeadAssets(fdoc);
      abuApplyBodyAttributes(fdoc);
      var cur=document.createElement('div');
      cur.innerHTML=document.body.innerHTML;
      cur.querySelectorAll('script').forEach(function(s){s.remove();});
      if(fdoc.body.innerHTML!==cur.innerHTML){document.body.innerHTML=fdoc.body.innerHTML;}
      // Chain script execution: external scripts must finish loading
      // before inline scripts run (e.g. Chart.js CDN → new Chart())
      function runNext(i){
        if(i>=scripts.length){
          // Re-fire lifecycle events so author handlers actually execute:
          // the receiver's readyState is already 'complete', so author
          // DOMContentLoaded/onload reveal handlers would never fire on
          // their own. bubbles:true so window-level DOMContentLoaded
          // listeners fire too (the native event bubbles to window).
          document.dispatchEvent(new Event('DOMContentLoaded',{bubbles:true}));
          window.dispatchEvent(new Event('load'));
          document.body.classList.remove('${WIDGET_PREVIEW_PHASE_CLASS}');
          setTimeout(reportHeight,100);
          // Whole-widget blank fallback (see widgetReceiverDom.ts): if
          // lifting the neutralizer leaves EVERY body child invisible,
          // re-add the class. rAF + delay lets author reveal effects settle.
          requestAnimationFrame(function(){
            setTimeout(function(){
              if(abuApplyBlankFallback()){reportHeight();}
            },150);
          });
          return;
        }
        // abuCreateScriptElement copies ALL original attributes (id/type/
        // data-* — e.g. application/json data blocks read via getElementById).
        var s=scripts[i];var el=abuCreateScriptElement(s);
        if(s.src){
          el.onload=function(){reportHeight();runNext(i+1);};
          el.onerror=function(){runNext(i+1);};
          document.body.appendChild(el);
        }else{
          document.body.appendChild(el);
          reportHeight();
          runNext(i+1);
        }
      }
      runNext(0);
    }
    if(e.data.type==='widget:capture'){
      // Load html2canvas from CDN (lazy, cached after first load)
      function doCapture(){
        html2canvas(document.body,{scale:2,useCORS:true,backgroundColor:'#ffffff'}).then(function(canvas){
          window.parent.postMessage({type:'abu-widget-capture',png:canvas.toDataURL('image/png')},'*');
        }).catch(function(){
          window.parent.postMessage({type:'abu-widget-capture',png:null},'*');
        });
      }
      if(typeof html2canvas!=='undefined'){doCapture();}
      else{
        var s=document.createElement('script');
        s.src='https://cdn.jsdelivr.net/npm/html2canvas@1/dist/html2canvas.min.js';
        s.onload=doCapture;
        s.onerror=function(){window.parent.postMessage({type:'abu-widget-capture',png:null},'*');};
        document.body.appendChild(s);
      }
    }
  });
})();
</script>
</body></html>`;

// ---------------------------------------------------------------------------
// Module-level state (shared across instances, survives remount)
// ---------------------------------------------------------------------------

const iframeMap = new WeakMap<HTMLDivElement, HTMLIFrameElement>();
const readyMap = new WeakMap<HTMLIFrameElement, boolean>();
/** Message queued for an iframe that hasn't finished loading its srcdoc yet. */
type PendingWidgetMessage = Record<string, unknown> & { type: string; html: string };
// Two slots — update and finalize buffered separately. On the history-reload
// path both arrive before the iframe is ready; a single slot would let the
// debounced finalize overwrite the buffered update, so the preview phase
// class (applied by widget:update) would never be set before the script
// chain runs.
const bufferMap = new WeakMap<HTMLIFrameElement, { update?: PendingWidgetMessage; finalize?: PendingWidgetMessage }>();
const listenerMap = new WeakMap<HTMLDivElement, (e: MessageEvent) => void>();

/** Height cache — survives component remount, prevents 0→actual height jump. */
const heightCache = new Map<string, number>();
const HEIGHT_CACHE_MAX = 100;
function hKey(code: string): string { return code.substring(0, 200); }
function setHeightCache(key: string, h: number) {
  if (heightCache.size >= HEIGHT_CACHE_MAX) {
    const first = heightCache.keys().next().value;
    if (first !== undefined) heightCache.delete(first);
  }
  heightCache.set(key, h);
}

// ---------------------------------------------------------------------------
// Sanitize — strip/truncate scripts for safe streaming preview
// ---------------------------------------------------------------------------

/** Check if HTML has visible content (not just style/script/meta tags) */
function hasVisibleContent(html: string): boolean {
  // Strip style blocks, script blocks, and HTML comments
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(meta|link|title)[^>]*>/gi, '')
    .replace(/<\/?[^>]+(>|$)/g, '') // strip remaining tags
    .trim();
  return stripped.length > 0;
}

function sanitizeForStreaming(html: string): string {
  // Remove complete <script>...</script> blocks
  let safe = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Strip <title> to prevent its text from rendering visibly when injected into body
  safe = safe.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
  // Truncate unclosed <script tag to prevent raw JS leaking as text
  const lastOpen = safe.lastIndexOf('<script');
  if (lastOpen !== -1 && !/<\/script>/i.test(safe.substring(lastOpen))) {
    safe = safe.substring(0, lastOpen);
  }
  // Strip inline event handlers during preview
  safe = safe.replace(/\s(on\w+)="[^"]*"/gi, '');
  // Replace empty <canvas> with loading placeholder (charts need script to render)
  const loadingText = getI18n().chat.htmlWidgetLoading;
  safe = safe.replace(
    /<canvas([^>]*)><\/canvas>/gi,
    `<div$1 style="display:flex;align-items:center;justify-content:center;min-height:200px;background:var(--abu-bg-secondary);border-radius:8px;color:var(--abu-text-muted);font-size:13px;">${loadingText}</div>`,
  );
  return safe;
}

// ---------------------------------------------------------------------------
// Iframe lifecycle
// ---------------------------------------------------------------------------

function getOrCreateIframe(container: HTMLDivElement, code: string): HTMLIFrameElement {
  const existing = iframeMap.get(container);
  if (existing && existing.isConnected) return existing;

  // Stale reference (iframe was removed from DOM, e.g. by innerHTML='') — clean up
  if (existing) {
    const oldListener = listenerMap.get(container);
    if (oldListener) {
      window.removeEventListener('message', oldListener);
      listenerMap.delete(container);
    }
    iframeMap.delete(container);
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.srcdoc = RECEIVER_HTML;
  iframe.style.cssText = 'width:100%;border:none;overflow:hidden;display:block;';

  // Initial height from cache (prevents 0→actual jump on remount).
  // Use a small default so partial HTML during streaming doesn't create
  // a large empty white area before content renders.
  const cached = heightCache.get(hKey(code));
  iframe.style.height = cached ? `${cached}px` : '60px';

  // Height & link messages
  const onMessage = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return;
    const d = e.data;
    if (d?.type === 'abu-widget-resize' && typeof d.height === 'number') {
      const h = Math.min(d.height, MAX_IFRAME_HEIGHT);
      // No transition — instant height changes ensure scrollHeight is always
      // up-to-date so auto-scroll can track content growth accurately.
      iframe.style.transition = 'none';
      iframe.style.height = `${h}px`;
      setHeightCache(hKey(code), h);
    }
    if (d?.type === 'abu-widget-link' && typeof d.url === 'string') {
      window.open(d.url, '_blank', 'noopener');
    }
  };
  window.addEventListener('message', onMessage);
  listenerMap.set(container, onMessage);

  // onLoad fallback for iframe ready race
  iframe.onload = () => {
    readyMap.set(iframe, true);
    const buf = bufferMap.get(iframe);
    if (buf) {
      // Flush update first so the preview phase class is applied before
      // finalize's script chain (preserves the neutralizer-on-through-
      // script-chain guarantee for reopened conversations).
      if (buf.update) iframe.contentWindow?.postMessage(buf.update, '*');
      if (buf.finalize) iframe.contentWindow?.postMessage(buf.finalize, '*');
      bufferMap.delete(iframe);
    }
  };

  container.appendChild(iframe);
  iframeMap.set(container, iframe);
  return iframe;
}

/** Extract external script URLs from HTML for prefetching */
function extractScriptUrls(html: string): string[] {
  const urls: string[] = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) urls.push(m[1]);
  return urls;
}

function sendToIframe(
  iframe: HTMLIFrameElement,
  type: 'widget:update' | 'widget:finalize',
  html: string,
  extra?: Record<string, unknown>,
) {
  const msg: PendingWidgetMessage = { type, html, ...extra };
  if (readyMap.get(iframe)) {
    iframe.contentWindow?.postMessage(msg, '*');
  } else {
    const buf = bufferMap.get(iframe) ?? {};
    if (type === 'widget:update') buf.update = msg;
    else buf.finalize = msg;
    bufferMap.set(iframe, buf);
  }
}

// ---------------------------------------------------------------------------
// Preview / Render / Cleanup — wired into RenderableCodeBlock config
// ---------------------------------------------------------------------------

// Throttle preview updates to avoid iframe innerHTML flicker (~60fps → ~7fps)
let lastPreviewTime = 0;
let pendingPreview: ReturnType<typeof setTimeout> | undefined;
const PREVIEW_INTERVAL = 150;

function previewHtmlWidget(code: string, container: HTMLDivElement): boolean {
  // Don't create iframe until HTML has visible content — avoids a blank
  // white block sitting for seconds while LLM outputs <style> etc.
  if (!hasVisibleContent(code)) return false;

  const iframe = getOrCreateIframe(container, code);
  const now = Date.now();

  const doSend = () => {
    lastPreviewTime = Date.now();
    const scripts = extractScriptUrls(code);
    sendToIframe(iframe, 'widget:update', sanitizeForStreaming(code),
      scripts.length > 0 ? { scripts } : undefined);
  };

  if (now - lastPreviewTime >= PREVIEW_INTERVAL) {
    // Enough time passed — send immediately
    if (pendingPreview) { clearTimeout(pendingPreview); pendingPreview = undefined; }
    doSend();
  } else if (!pendingPreview) {
    // Schedule trailing update to ensure the latest content always arrives
    pendingPreview = setTimeout(() => {
      pendingPreview = undefined;
      doSend();
    }, PREVIEW_INTERVAL - (now - lastPreviewTime));
  }
  return true;
}

async function renderHtmlWidget(code: string, container: HTMLDivElement): Promise<string> {
  const iframe = getOrCreateIframe(container, code);
  // Raw code — the receiver parses it with DOMParser (fragment or full
  // document alike) and needs the head scripts/styles intact.
  sendToIframe(iframe, 'widget:finalize', code);
  // Return empty string to skip RenderableCodeBlock's innerHTML cache
  // (iframe state can't be restored from cached HTML string)
  return '';
}

function cleanupHtmlWidget(container: HTMLDivElement) {
  const onMessage = listenerMap.get(container);
  if (onMessage) {
    window.removeEventListener('message', onMessage);
    listenerMap.delete(container);
  }
  iframeMap.delete(container);
}

// ---------------------------------------------------------------------------
// Image capture — serialize iframe DOM as SVG foreignObject
// ---------------------------------------------------------------------------

/** Capture HTML widget as PNG via html2canvas running inside the iframe */
function captureHtmlWidgetImage(_code: string, container: HTMLDivElement): Promise<string | null> {
  const iframe = iframeMap.get(container);
  if (!iframe?.contentWindow) return Promise.resolve(null);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 8000);

    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow) return;
      if (e.data?.type === 'abu-widget-capture') {
        cleanup();
        resolve(e.data.png ?? null);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    };

    window.addEventListener('message', onMessage);
    iframe.contentWindow!.postMessage({ type: 'widget:capture' }, '*');
  });
}

// ---------------------------------------------------------------------------
// Fullscreen — opens widget in a new browser window
// ---------------------------------------------------------------------------

function buildFullHtml(widgetCode: string): string {
  // Fullscreen is a REAL viewport — the author's fixed/vh choices are correct
  // there, so no neutralization. Full documents render verbatim (wrapping
  // them in another document would nest <html> inside <body>), with a
  // doctype guaranteed so they don't fall into quirks mode; fragments get
  // the base-style wrap.
  if (isFullDocument(widgetCode)) return ensureDoctype(widgetCode);
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${BASE_STYLES} body { overflow: auto; }</style>
</head><body>${widgetCode}</body></html>`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HtmlWidgetBlock({ code }: { code: string }) {
  const { t } = useI18n();

  const config: CodeBlockRendererConfig = {
    label: t.chat.htmlWidgetLabel,
    fallbackLanguage: 'html',
    seamless: true,
    render: renderHtmlWidget,
    captureImage: captureHtmlWidgetImage,
    cleanup: cleanupHtmlWidget,
    buildFullscreenHtml: buildFullHtml,
    debounceMs: 200,
    errorSettleMs: 1000,
    maxHeight: 600,
    preview: {
      render: previewHtmlWidget,
    },
    i18n: {
      loading: t.chat.htmlWidgetLoading,
      renderError: t.chat.htmlWidgetRenderError,
      expand: t.chat.htmlWidgetExpand,
      collapse: t.chat.htmlWidgetCollapse,
      fullscreen: t.chat.htmlWidgetFullscreen,
      copyCode: t.chat.htmlWidgetCopyCode,
      copied: t.chat.htmlWidgetCopied,
      download: t.chat.htmlWidgetDownload,
      viewCode: t.chat.htmlWidgetViewCode,
      viewPreview: t.chat.htmlWidgetViewPreview,
    },
  };

  return <RenderableCodeBlock code={code} config={config} />;
}
