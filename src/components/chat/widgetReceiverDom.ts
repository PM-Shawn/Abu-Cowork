import { WIDGET_PREVIEW_PHASE_CLASS } from './widgetNormalize';

/**
 * DOM logic for HtmlWidgetBlock's iframe receiver, kept as a plain-JS source
 * string (ES5, self-contained, no imports) so that:
 * - RECEIVER_HTML can embed it verbatim via template interpolation, and
 * - vitest (happy-dom provides DOMParser/getComputedStyle) can evaluate the
 *   same string with `new Function` and exercise the functions directly —
 *   no iframe needed, and no risk of a bundler/minifier drifting the embedded
 *   code away from what the tests ran against.
 *
 * Why DOMParser instead of string surgery: LLM-generated widget code ranges
 * from clean fragments to full `<!DOCTYPE html>` documents, with or without
 * an explicit <body> tag, with `</body>` inside script string literals, with
 * `<html>` inside comments, etc. Regex-based document unwrapping mishandles
 * all of those; `DOMParser.parseFromString(html, 'text/html')` is the HTML5
 * parsing algorithm and normalizes every case the same way a browser would.
 *
 * The functions operate on the *receiver's* globals (document/window) at call
 * time. All names are `abu`-prefixed to avoid clashing with author scripts.
 *
 * Deliberate non-goal: no per-element "repair" of hidden content after
 * scripts ran — computed style cannot distinguish "stuck hidden" (broken
 * reveal) from "intentionally hidden" (modals, tooltips, carousel slides),
 * and inline !important overrides would break the latter irreversibly. The
 * only runtime net is the whole-widget blank fallback below.
 *
 * KNOWN LIMITATIONS (accepted residual gaps):
 * (a) Blank detection inspects body + direct children only — a visible
 *     wrapper div enclosing all-hidden content defeats it (walking deeper
 *     re-opens the modal/tooltip false-positive class we removed).
 * (b) Transform-offscreen, zero-area, and off-screen-position hiding are not
 *     detected as blank — only opacity/visibility/display are inspected.
 * (c) isFullDocument can be fooled by '<html>' inside script string literals
 *     — affects only the fullscreen wrap choice, where either outcome renders.
 * (d) Head-asset dedup keys on content signature, so a stylesheet <link>
 *     whose fetch transiently failed is not retried at finalize (retrying
 *     would mean re-churning assets on every update — the FOUC we removed).
 * (e) Author CSS using 100vh is not rewritten — inside an auto-sized iframe
 *     it tracks the iframe's own height (host caps the height; rewriting
 *     author CSS proved too error-prone: calc(), shorthands, ...).
 * All of (a)-(d) are strictly narrower than the original bug class (full
 * document + scroll-reveal → permanently blank widget). Industry peers ship
 * NO blank fallback at all (ChatGPT's visualize relies on its prompt
 * contract, WorkBuddy's show_widget on schema validation); the designed
 * mitigation layer for these residual gaps is P1 tool-schema validation +
 * P4 prompt guardrails.
 */
export const WIDGET_RECEIVER_DOM_JS = `
// --- Parse author HTML (fragment or full document) via the platform parser.
function abuParseHtml(html){
  return new DOMParser().parseFromString(html,'text/html');
}

// --- Move author head assets (styles, stylesheet links) into the receiver's
// <head>. Content-aware: if the assets are identical to what's already
// injected (the common case for every ~150ms streaming update once the head
// has fully streamed), skip entirely — tearing down and re-appending a
// stylesheet <link> would re-fetch it async and flash unstyled content.
function abuInjectHeadAssets(doc){
  var nodes=doc.head.querySelectorAll('style,link[rel="stylesheet"]');
  var sig='';
  for(var i=0;i<nodes.length;i++){sig+=nodes[i].outerHTML;}
  if(sig===window.__abuLastHeadAssetsSig){return;}
  var prev=window.__abuAuthorHeadNodes||[];
  for(var j=0;j<prev.length;j++){
    if(prev[j].parentNode){prev[j].parentNode.removeChild(prev[j]);}
  }
  var injected=[];
  for(var k=0;k<nodes.length;k++){
    var clone=nodes[k].cloneNode(true);
    document.head.appendChild(clone);
    injected.push(clone);
  }
  window.__abuAuthorHeadNodes=injected;
  window.__abuLastHeadAssetsSig=sig;
}

// --- Copy author <body> attributes onto the receiver's body (body-scoped
// CSS like body.dark or body[data-theme=dark] must keep working). Blocklist:
// id (receiver identity) and on* event handlers (never execute author JS via
// attribute). Fully resets the previously copied set each time, preserving
// the receiver's own phase class.
function abuApplyBodyAttributes(doc){
  var body=document.body;
  var phase=body.classList.contains('${WIDGET_PREVIEW_PHASE_CLASS}');
  // NOTE (P3): deliberately NOT preserving a host-driven '.dark' class here
  // the way the phase class is preserved below — 'dark' is a plain class
  // name authors are documented (and tested) to use themselves for their
  // own body-scoped CSS (e.g. body.dark), so "was dark before this call"
  // can't distinguish "host set it via widget:theme" from "author's own
  // previous doc had class=dark". In practice this is a non-issue: widgets
  // are fragment-only (HARD_RULES), so doc.body carries no attributes at
  // all and this function never touches 'class' — the widget:theme-set
  // '.dark' class is untouched. Only a defensively-parsed full-document
  // widget with an explicit <body class=...> could lose it, which is
  // already out of contract.
  var prev=window.__abuAuthorBodyAttrs||[];
  for(var i=0;i<prev.length;i++){body.removeAttribute(prev[i]);}
  var applied=[];
  var attrs=doc.body.attributes;
  for(var j=0;j<attrs.length;j++){
    var name=attrs[j].name;
    var lower=name.toLowerCase();
    if(lower==='id'||lower.indexOf('on')===0){continue;}
    body.setAttribute(name,attrs[j].value);
    applied.push(name);
  }
  if(phase){body.classList.add('${WIDGET_PREVIEW_PHASE_CLASS}');}
  window.__abuAuthorBodyAttrs=applied;
}

// --- Collect all author scripts in document order (head before body — a CDN
// <script src> in <head> must load before the inline body script that uses
// it), removing them from the parsed doc so they never enter the DOM as
// inert markup. The full attribute list is captured so re-creation preserves
// id/type/data-* — e.g. <script type="application/json" id="chart-data">
// JSON-data blocks that inline scripts read back via getElementById.
function abuCollectScripts(doc){
  var out=[];
  var list=doc.querySelectorAll('script');
  for(var i=0;i<list.length;i++){
    var s=list[i];
    var attrs=[];
    for(var a=0;a<s.attributes.length;a++){
      attrs.push({name:s.attributes[a].name,value:s.attributes[a].value});
    }
    out.push({src:s.getAttribute('src')||'',text:s.textContent||'',attrs:attrs});
    if(s.parentNode){s.parentNode.removeChild(s);}
  }
  return out;
}

// --- Re-create a collected script element with ALL original attributes.
// No filtering: on* attributes on <script> tags don't execute via attribute,
// and finalize deliberately executes author scripts anyway.
function abuCreateScriptElement(s){
  var el=document.createElement('script');
  for(var a=0;a<s.attrs.length;a++){el.setAttribute(s.attrs[a].name,s.attrs[a].value);}
  if(!s.src){el.textContent=s.text;}
  return el;
}

// --- Minimal DOM morph: walk children pairwise, patch attributes/text in
// place instead of a blind innerHTML replace, so scroll position, focus and
// live <canvas> drawings survive streaming preview updates.
function abuPatchAttributes(oldEl,newEl){
  var oldAttrs=oldEl.attributes;
  for(var i=oldAttrs.length-1;i>=0;i--){
    var name=oldAttrs[i].name;
    if(!newEl.hasAttribute(name)){oldEl.removeAttribute(name);}
  }
  var newAttrs=newEl.attributes;
  for(var j=0;j<newAttrs.length;j++){
    var attr=newAttrs[j];
    if(oldEl.getAttribute(attr.name)!==attr.value){oldEl.setAttribute(attr.name,attr.value);}
  }
}
function abuMorphChildren(target,source){
  var oldNodes=Array.prototype.slice.call(target.childNodes);
  var newNodes=Array.prototype.slice.call(source.childNodes);
  var len=Math.max(oldNodes.length,newNodes.length);
  for(var i=0;i<len;i++){
    var oldNode=oldNodes[i], newNode=newNodes[i];
    if(!newNode){ if(oldNode){target.removeChild(oldNode);} continue; }
    if(!oldNode){ target.appendChild(newNode); continue; }
    if(oldNode.nodeType!==newNode.nodeType||
       (oldNode.nodeType===1&&oldNode.tagName!==newNode.tagName)){
      target.replaceChild(newNode,oldNode); continue;
    }
    if(oldNode.nodeType===3||oldNode.nodeType===8){
      if(oldNode.nodeValue!==newNode.nodeValue){oldNode.nodeValue=newNode.nodeValue;}
      continue;
    }
    if(oldNode.nodeType===1){
      // Preserve existing <canvas> (and any live drawing on it) untouched.
      if(oldNode.tagName==='CANVAS'){continue;}
      abuPatchAttributes(oldNode,newNode);
      abuMorphChildren(oldNode,newNode);
    }
  }
}

// --- Whole-widget blank fallback — the ONLY runtime safety net, run once
// shortly after the neutralizer class is lifted post-finalize.
//
// Rationale: per-element repair is unsound (computed style can't tell a
// broken reveal from an intentionally hidden modal/tooltip, and inline
// !important is irreversible). But TOTAL blankness — the body itself faded
// out, or every direct body child invisible — is precisely the bug class
// this widget system exists to fix, and no legitimate widget renders as a
// fully invisible page. False-positive analysis: a hidden modal/tooltip
// never triggers this because its visible sibling content keeps the check
// false; a widget that is only <script>/<style>/<link> children has no
// content to reveal, so it's skipped. The remedy is class-level and
// reversible: re-add the preview neutralizer class, no inline styles, no
// per-element !important.
function abuIsWidgetBlank(){
  var bcs;
  try{bcs=getComputedStyle(document.body);}catch(err0){return false;}
  var bop=parseFloat(bcs.opacity);
  // body-level page-fade pattern (body{opacity:0} revealed by JS). NaN-safe:
  // unknown opacity counts as visible so we never trigger spuriously.
  if(bop<0.05||bcs.visibility==='hidden'){return true;}
  var kids=document.body.children;
  var contentCount=0;
  for(var i=0;i<kids.length;i++){
    var el=kids[i];
    var tag=el.tagName;
    if(tag==='SCRIPT'||tag==='STYLE'||tag==='LINK'){continue;}
    contentCount++;
    var cs;
    try{cs=getComputedStyle(el);}catch(err){return false;}
    var op=parseFloat(cs.opacity);
    var visible=!(op<0.05)&&cs.visibility!=='hidden'&&cs.display!=='none';
    if(visible){return false;}
  }
  return contentCount>0;
}
function abuApplyBlankFallback(){
  if(abuIsWidgetBlank()){
    document.body.classList.add('${WIDGET_PREVIEW_PHASE_CLASS}');
    return true;
  }
  return false;
}

// --- P3 host-runtime capabilities ---------------------------------------
// Kept as small, dependency-injected pure functions (a 'post' callback
// instead of a hardcoded window.parent.postMessage) so they're unit-
// testable the same way as the P0 DOM helpers above, without needing to
// fight happy-dom's window.parent semantics. RECEIVER_HTML wires these to
// the real postMessage channel (see HtmlWidgetBlock.tsx).

// --- Toggle the '.dark' class that activates designSystem.ts's dormant
// dark-theme CSS block, driven by a host 'widget:theme' postMessage.
function abuToggleTheme(isDark){
  document.body.classList.toggle('dark',!!isDark);
}

// --- window.sendPrompt(text) bridge: widget -> chat composer. Truncated to
// 500 chars (mirrors WorkBuddy's cap) so a runaway widget can't dump an
// enormous string into the user's input box.
function abuSendPrompt(post,text){
  var s=String(text==null?'':text).slice(0,500);
  post({type:'widget:sendMessage',text:s});
}

// --- Structured crash reporting: window.onerror / unhandledrejection wire
// into this so a broken widget surfaces a signal instead of silently
// rendering blank. Payload kept small (truncated) and the call itself is
// wrapped so a failure in reporting can never throw back into the caller.
function abuReportError(post,message,source,line,col,stack){
  try{
    post({
      type:'widget:error',
      message:String(message==null?'':message).slice(0,500),
      source:source?String(source).slice(0,200):undefined,
      line:line,
      col:col,
      stack:stack?String(stack).slice(0,1000):undefined,
    });
  }catch(e){ /* swallow — error reporting must never itself throw */ }
}

// --- Zero-height canvas guard (lib-agnostic). The real defect: a responsive
// canvas (e.g. a Chart.js chart with no resolvable container height) renders
// at ~0px inside the auto-height iframe, showing dead space or an invisible
// chart. Fix ONLY that case: give a fallback min-height to canvases whose
// computed height is effectively zero (< ~8px) after finalize. Properly-
// sized canvases (sparklines, compact charts) are left completely untouched,
// so no whitespace is injected under a chart that already sized itself. The
// fallback derives from the canvas's height attribute when usable (clamped
// to a sane range), else ~320px.
function abuStabilizeCanvas(){
  var canvases=document.querySelectorAll('canvas');
  for(var i=0;i<canvases.length;i++){
    var c=canvases[i];
    var parent=c.parentElement;
    if(!parent||parent.style.minHeight){continue;}
    var h;
    try{h=parseFloat(getComputedStyle(c).height);}catch(e){continue;}
    // Only the broken near-zero case. Unknown height (NaN) is left alone.
    if(!(h<8)){continue;}
    var attrH=parseFloat(c.getAttribute('height')||'');
    var target=(attrH&&attrH>0)?Math.max(120,Math.min(attrH,600)):320;
    parent.style.minHeight=target+'px';
  }
}
`;
