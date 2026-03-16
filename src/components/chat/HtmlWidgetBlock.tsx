import { useI18n } from '@/i18n';
import RenderableCodeBlock, { type CodeBlockRendererConfig } from './RenderableCodeBlock';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_IFRAME_HEIGHT = 800;

const CDN_ALLOWLIST = [
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://esm.sh',
].join(' ');

const BASE_STYLES = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px; line-height: 1.6;
  color: #29261b; background: #fff; padding: 16px; overflow: hidden;
}
:root {
  --abu-primary: #d97757; --abu-text: #29261b; --abu-text-muted: #888579;
  --abu-bg: #fff; --abu-bg-secondary: #f5f3ee; --abu-border: #e5e2db;
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${CDN_ALLOWLIST}; style-src 'unsafe-inline'; img-src data: blob: ${CDN_ALLOWLIST}; connect-src ${CDN_ALLOWLIST}; font-src ${CDN_ALLOWLIST};">
<style>${BASE_STYLES}</style>
</head><body>
<script>
(function(){
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
      document.body.innerHTML=e.data.html;
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
      var tmp=document.createElement('div');
      tmp.innerHTML=e.data.html;
      var scripts=[];
      tmp.querySelectorAll('script').forEach(function(s){
        scripts.push({src:s.src,text:s.textContent});s.remove();
      });
      var cur=document.createElement('div');
      cur.innerHTML=document.body.innerHTML;
      cur.querySelectorAll('script').forEach(function(s){s.remove();});
      if(tmp.innerHTML!==cur.innerHTML){document.body.innerHTML=tmp.innerHTML;}
      // Chain script execution: external scripts must finish loading
      // before inline scripts run (e.g. Chart.js CDN → new Chart())
      function runNext(i){
        if(i>=scripts.length){
          // Re-fire load event so window.onload handlers set by inline
          // scripts actually execute (iframe's real load already fired earlier)
          window.dispatchEvent(new Event('load'));
          setTimeout(reportHeight,100);
          return;
        }
        var s=scripts[i];var el=document.createElement('script');
        if(s.src){
          el.src=s.src;
          el.onload=function(){reportHeight();runNext(i+1);};
          el.onerror=function(){runNext(i+1);};
          document.body.appendChild(el);
        }else{
          el.textContent=s.text;
          document.body.appendChild(el);
          reportHeight();
          runNext(i+1);
        }
      }
      runNext(0);
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
const bufferMap = new WeakMap<HTMLIFrameElement, { type: string; html: string }>();
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

function sanitizeForStreaming(html: string): string {
  // Remove complete <script>...</script> blocks
  let safe = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Truncate unclosed <script tag to prevent raw JS leaking as text
  const lastOpen = safe.lastIndexOf('<script');
  if (lastOpen !== -1 && !/<\/script>/i.test(safe.substring(lastOpen))) {
    safe = safe.substring(0, lastOpen);
  }
  // Strip inline event handlers during preview
  safe = safe.replace(/\s(on\w+)="[^"]*"/gi, '');
  // Replace empty <canvas> with loading placeholder (charts need script to render)
  safe = safe.replace(
    /<canvas([^>]*)><\/canvas>/gi,
    '<div$1 style="display:flex;align-items:center;justify-content:center;min-height:200px;background:var(--abu-bg-secondary);border-radius:8px;color:var(--abu-text-muted);font-size:13px;">图表加载中…</div>',
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
      // First report: snap instantly (no transition). Subsequent: smooth.
      iframe.style.transition = d.first ? 'none' : 'height 0.2s ease';
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
      iframe.contentWindow?.postMessage(buf, '*');
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
  const msg = { type, html, ...extra };
  if (readyMap.get(iframe)) {
    iframe.contentWindow?.postMessage(msg, '*');
  } else {
    bufferMap.set(iframe, msg);
  }
}

// ---------------------------------------------------------------------------
// Preview / Render / Cleanup — wired into RenderableCodeBlock config
// ---------------------------------------------------------------------------

// Throttle preview updates to avoid iframe innerHTML flicker (~60fps → ~7fps)
let lastPreviewTime = 0;
let pendingPreview: ReturnType<typeof setTimeout> | undefined;
const PREVIEW_INTERVAL = 150;

function previewHtmlWidget(code: string, container: HTMLDivElement): void {
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
}

async function renderHtmlWidget(code: string, container: HTMLDivElement): Promise<string> {
  const iframe = getOrCreateIframe(container, code);
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
// Fullscreen — opens widget in a new browser window
// ---------------------------------------------------------------------------

function buildFullHtml(widgetCode: string): string {
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
