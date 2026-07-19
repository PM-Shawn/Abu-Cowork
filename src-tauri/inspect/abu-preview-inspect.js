// Abu preview-tab element picker runtime.
//
// This file is injected by the Rust side (preview_server.rs) as an inline
// <script>...</script> tag inserted right before the last `</body>` (falls
// back to before `</html>`, then to end-of-file — see `inject_picker_script`)
// of every `.html`/`.htm` response served by the loopback preview server.
// Unlike the browser-tab picker this forks from (`abu-inspect.js`, injected
// via a Tauri `initialization_script` at document-start with a closed-over
// nonce), this script is *always* present in the served HTML but starts
// fully idle — it only arms once it receives a `postMessage` from its
// parent frame.
//
// Transport: the previewed HTML is rendered in a cross-origin iframe
// (`http://127.0.0.1:<port>` loopback) embedded by the Abu host window
// (`tauri://localhost` / `https://tauri.localhost` / dev `http://localhost:5173`).
// postMessage is the only channel across that origin boundary:
//   parent -> iframe: {type:'abu-preview-inspect:set-enabled', enabled, nonce, labels}
//   iframe -> parent: {type:'abu-preview-inspect:selected', nonce, payload}
// The nonce is minted by the parent on every enable and is NOT a secret (any
// script sharing this window can read it back out) — its job is anti-replay/
// anti-crosstalk (a late message from a stale enable session or a document
// that has since navigated), not authentication.
//
// Threat model (why same-window forgery is accepted, not just tolerated):
// this script runs inside HTML the *local workspace* is serving to itself
// over loopback — typically content the agent just wrote to disk. A forged
// selection some other in-page script fabricates by calling
// `window.parent.postMessage(...)` directly is bounded by the same payload
// size caps as a real one (MAX_OUTER_HTML/MAX_TEXT below, plus the host's
// 64KB belt-and-suspenders check) and, critically, only ever produces a
// *pending chat reference* the user must still review and explicitly send —
// it cannot execute anything on its own. That trust level is no higher than
// the agent's existing file-write capability. This is a deliberate
// difference from the (rejected) browser-tab design, where the injected page
// is an arbitrary *remote* site and the same class of forgery was a real
// escalation path; document this explicitly so a future reviewer doesn't
// flag the lack of a signed/opaque nonce as an oversight.
//
// The real security boundary is per-message `event.source`/`event.origin`
// validation (both directions — see the listener at the bottom of this file
// and the parent-side handler in PreviewPanel.tsx), not the nonce.
//
// Vanilla ES5-ish JS, no build step, no external deps. Runs inside preview
// HTML that may itself be low-trust (agent-authored, possibly with bugs), so
// we still: never innerHTML page-derived strings (textContent only), and
// keep the DOM footprint isolated under one `[data-abu-inspect]` root.
(function () {
  'use strict';

  if (window.__ABU_PREVIEW_INSPECT__) {
    // Re-injected into the same document — don't double-bind.
    return;
  }

  // Module state, set by the `set-enabled` message handler below.
  var currentNonce = null;
  var parentOrigin = null;

  var STYLE_WHITELIST = [
    'display', 'position', 'width', 'height', 'margin', 'padding', 'border', 'border-radius',
    'background-color', 'color', 'font-family', 'font-size', 'font-weight', 'line-height',
    'text-align', 'flex-direction', 'justify-content', 'align-items', 'gap',
    'grid-template-columns', 'overflow', 'opacity', 'box-shadow', 'z-index', 'cursor'
  ];

  var BLACKLIST_TAGS = ['script', 'style', 'link', 'meta', 'noscript', 'template', 'html', 'body'];

  var MAX_OUTER_HTML = 40960;
  var MAX_TEXT = 2000;
  var CONFIRM_FLASH_MS = 1200;

  var BRAND_COLOR = '#d97757';

  // The confirm bar / comment editor replicate `SelectionToolbar.tsx` /
  // `CommentEditor.tsx` (doc-preview selection toolbar), but this script runs
  // inside the loopback-served preview document with no access to Abu's CSS
  // tokens or Tailwind — so the host resolves the concrete `--abu-*` values
  // at toggle time and passes them in via `labels.theme` (see
  // `PreviewPanel.tsx` `resolveInspectTheme`). These are the light-theme
  // literals used only if that's ever absent/malformed, so the bar never
  // renders unstyled.
  var THEME_FALLBACK = {
    bgBase: '#fdfcf9',
    bgHover: '#e8e5de',
    borderSubtle: 'rgba(112,107,87,0.15)',
    textPrimary: '#141413',
    textTertiary: '#656358',
    danger: '#b42318'
  };

  var FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  var MAX_COMMENT = 500;

  // Pixel-identical replicas of lucide-react's message-square-plus /
  // message-square path data (node_modules/lucide-react/dist/esm/icons/).
  var ICON_COMMENT_PATHS = [
    'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z',
    'M12 8v6',
    'M9 11h6'
  ];
  var ICON_ADD_PATHS = [
    'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z'
  ];

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function createIcon(paths) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.style.cssText = 'flex-shrink:0;';
    for (var i = 0; i < paths.length; i++) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', paths[i]);
      svg.appendChild(p);
    }
    return svg;
  }

  // Best-effort default when the host hasn't told us yet (should always be
  // overridden by `labels.shortcutModifier` — see setEnabled).
  function defaultShortcutModifier() {
    try {
      return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '') ? '⌘' : 'Ctrl';
    } catch (e) {
      return 'Ctrl';
    }
  }

  var state = {
    enabled: false,
    mode: 'hover', // 'hover' | 'selected' | 'comment'
    labels: {
      addToChat: 'Add to chat',
      commentToChat: 'Comment',
      commentPlaceholder: 'Add a comment…',
      cancel: 'Cancel',
      shortcutModifier: defaultShortcutModifier()
    },
    theme: THEME_FALLBACK,
    hoverEl: null,
    selectedEl: null,
    dom: null,
    boundEvents: false
  };

  // ---------- DOM (lazy) ----------

  function ensureDom() {
    if (state.dom) {
      return state.dom;
    }

    var root = document.createElement('div');
    root.setAttribute('data-abu-inspect', '');

    var overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;display:none;background:transparent;';

    var hoverBox = document.createElement('div');
    hoverBox.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;' +
      'border:2px solid ' + BRAND_COLOR + ';background:rgba(217,119,87,0.08);display:none;';

    var hoverLabel = document.createElement('div');
    hoverLabel.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483646;display:none;white-space:nowrap;' +
      'background:' + BRAND_COLOR + ';color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;' +
      'padding:2px 6px;border-radius:3px;';

    var selectedBox = document.createElement('div');
    selectedBox.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;' +
      'border:2px solid ' + BRAND_COLOR + ';background:transparent;display:none;';

    // Tag badge for the *selected* element (e.g. `h1`, `div`), persistent while
    // the selection is up — mirrors the hover badge so the selected block keeps
    // its label even as the user hovers other elements (TRAE-style).
    var selectedLabel = document.createElement('div');
    selectedLabel.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483646;display:none;white-space:nowrap;' +
      'background:' + BRAND_COLOR + ';color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;' +
      'padding:2px 6px;border-radius:3px;';

    // Skeleton only — `applyBarChrome`/`applyEditorChrome` set the full,
    // theme-driven cssText each time the bar is (re)shown.
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;z-index:2147483647;display:none;align-items:center;';

    root.appendChild(overlay);
    root.appendChild(hoverBox);
    root.appendChild(hoverLabel);
    root.appendChild(selectedBox);
    root.appendChild(selectedLabel);
    root.appendChild(bar);

    // documentElement, not body: this script is injected right before
    // `</body>` (see preview_server.rs `inject_picker_script`), so
    // document.body already exists by the time this runs — but we still
    // anchor to documentElement for parity with the browser-tab picker and
    // to be robust against the </html>/append-at-end injection fallbacks.
    document.documentElement.appendChild(root);

    state.dom = {
      root: root,
      overlay: overlay,
      hoverBox: hoverBox,
      hoverLabel: hoverLabel,
      selectedBox: selectedBox,
      selectedLabel: selectedLabel,
      bar: bar
    };

    bindEvents();
    return state.dom;
  }

  function isAbuNode(el) {
    var d = state.dom;
    if (!d) {
      return false;
    }
    var n = el;
    while (n) {
      if (n === d.root) {
        return true;
      }
      n = n.parentElement;
    }
    return false;
  }

  // ---------- Hit testing ----------

  function ownerSvgRoot(el) {
    var node = el;
    while (node) {
      if (node.namespaceURI === 'http://www.w3.org/2000/svg') {
        if (node.tagName && node.tagName.toLowerCase() === 'svg') {
          return node;
        }
        node = node.parentElement;
      } else {
        return null;
      }
    }
    return null;
  }

  function hitTest(x, y) {
    var els = document.elementsFromPoint(x, y);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el || !el.tagName) {
        continue;
      }
      if (isAbuNode(el)) {
        continue;
      }
      var tag = el.tagName.toLowerCase();
      if (BLACKLIST_TAGS.indexOf(tag) !== -1) {
        continue;
      }
      var svgRoot = ownerSvgRoot(el);
      if (svgRoot) {
        return svgRoot;
      }
      return el;
    }
    return null;
  }

  // ---------- Highlight / label ----------

  function displayName(el) {
    var name = el.tagName ? el.tagName.toLowerCase() : 'unknown';
    if (el.id) {
      name += '#' + el.id;
    }
    if (el.classList && el.classList.length) {
      var classes = Array.prototype.slice.call(el.classList).join('.');
      if (classes) {
        name += '.' + classes;
      }
    }
    if (name.length > 60) {
      name = name.slice(0, 60);
    }
    return name;
  }

  function positionBoxToRect(box, rect) {
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  }

  function showHover(el) {
    var d = ensureDom();
    var rect = el.getBoundingClientRect();
    positionBoxToRect(d.hoverBox, rect);
    d.hoverBox.style.display = 'block';

    d.hoverLabel.textContent = displayName(el);
    var labelTop = rect.top - 20;
    if (labelTop < 0) {
      labelTop = rect.top + 2;
    }
    d.hoverLabel.style.left = rect.left + 'px';
    d.hoverLabel.style.top = labelTop + 'px';
    d.hoverLabel.style.display = 'block';
  }

  function hideHover() {
    if (!state.dom) {
      return;
    }
    state.dom.hoverBox.style.display = 'none';
    state.dom.hoverLabel.style.display = 'none';
  }

  // ---------- Payload construction ----------

  function captureComputedStyle(el) {
    var cs = window.getComputedStyle(el);
    var out = {};
    for (var i = 0; i < STYLE_WHITELIST.length; i++) {
      var key = STYLE_WHITELIST[i];
      try {
        out[key] = cs.getPropertyValue(key);
      } catch (e) {
        out[key] = '';
      }
    }
    return out;
  }

  function buildSelector(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.tagName && node !== document.body && depth < 6) {
      var seg = node.tagName.toLowerCase();
      if (node.id) {
        seg += '#' + node.id;
      }
      if (node.classList && node.classList.length) {
        var classes = Array.prototype.slice.call(node.classList).join('.');
        if (classes) {
          seg += '.' + classes;
        }
      }
      parts.unshift(seg);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function buildPayload(el, comment) {
    var rect = el.getBoundingClientRect();

    var outerHTML = el.outerHTML || '';
    if (outerHTML.length > MAX_OUTER_HTML) {
      outerHTML = outerHTML.slice(0, MAX_OUTER_HTML);
    }

    var text = el.innerText;
    if (typeof text !== 'string') {
      text = el.textContent || '';
    }
    if (text.length > MAX_TEXT) {
      text = text.slice(0, MAX_TEXT);
    }

    var classList = [];
    if (el.classList) {
      classList = Array.prototype.slice.call(el.classList);
    }

    var payload = {
      tagName: el.tagName ? el.tagName.toLowerCase() : '',
      id: el.id || '',
      classList: classList,
      selector: buildSelector(el),
      outerHTML: outerHTML,
      text: text,
      computedStyle: captureComputedStyle(el),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      pageUrl: location.href,
      pageTitle: document.title
    };
    if (comment) {
      payload.comment = comment;
    }
    return payload;
  }

  // ---------- Return channel (postMessage to parent) ----------

  function sendSelection(payload) {
    if (!currentNonce || !parentOrigin) {
      return;
    }
    try {
      window.parent.postMessage(
        { type: 'abu-preview-inspect:selected', nonce: currentNonce, payload: payload },
        parentOrigin
      );
    } catch (e) {}
  }

  // ---------- Confirm bar ----------

  function clearChildren(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  // Container chrome for the confirm bar (hover/selected mode) — replicates
  // SelectionToolbar.tsx's row: `flex items-center gap-0.5 rounded-xl
  // border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-base)] p-0.5
  // shadow-lg`.
  function applyBarChrome() {
    var th = state.theme;
    state.dom.bar.style.cssText =
      'position:fixed;z-index:2147483647;display:none;align-items:center;gap:2px;' +
      'border-radius:12px;border:1px solid ' + th.borderSubtle + ';background:' + th.bgBase + ';' +
      'padding:2px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -4px rgba(0,0,0,0.1);' +
      'font-family:' + FONT_STACK + ';';
  }

  // Container chrome for the comment editor — replicates CommentEditor.tsx's
  // `w-72 rounded-xl border border-[var(--abu-border-subtle)]
  // bg-[var(--abu-bg-base)] p-2 shadow-lg`.
  function applyEditorChrome() {
    var th = state.theme;
    state.dom.bar.style.cssText =
      'position:fixed;z-index:2147483647;display:none;flex-direction:column;gap:4px;' +
      'width:288px;border-radius:12px;border:1px solid ' + th.borderSubtle + ';background:' + th.bgBase + ';' +
      'padding:8px;box-sizing:border-box;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -4px rgba(0,0,0,0.1);' +
      'font-family:' + FONT_STACK + ';';
  }

  function makeButton(iconPaths, label, shortcut, onClick) {
    var th = state.theme;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText =
      'appearance:none;display:flex;align-items:center;gap:6px;border-radius:8px;' +
      'padding:6px 10px;font-size:14px;line-height:22px;color:' + th.textPrimary + ';' +
      'background:transparent;border:none;cursor:pointer;font-family:' + FONT_STACK + ';white-space:nowrap;';

    btn.appendChild(createIcon(iconPaths));

    var labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    btn.appendChild(labelSpan);

    var hintSpan = document.createElement('span');
    hintSpan.textContent = shortcut;
    hintSpan.style.cssText = 'font-size:11px;line-height:16px;color:' + th.textTertiary + ';';
    btn.appendChild(hintSpan);

    btn.addEventListener('mouseenter', function () {
      btn.style.background = th.bgHover;
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.background = 'transparent';
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  function makeDivider() {
    var div = document.createElement('div');
    div.style.cssText = 'width:1px;height:16px;flex-shrink:0;background:' + state.theme.borderSubtle + ';';
    return div;
  }

  function clampBarPosition(bar, rect) {
    var top = rect.bottom + 6;
    var left = rect.left;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var bw = bar.offsetWidth;
    var bh = bar.offsetHeight;
    if (left + bw > vw) {
      left = Math.max(0, vw - bw - 4);
    }
    if (left < 0) {
      left = 0;
    }
    if (top + bh > vh) {
      top = Math.max(0, rect.top - bh - 6);
    }
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
  }

  function positionBar(el) {
    var d = state.dom;
    var rect = el.getBoundingClientRect();
    d.bar.style.display = 'flex';
    clampBarPosition(d.bar, rect);
  }

  function showConfirmBar(el) {
    var d = ensureDom();
    state.mode = 'selected';
    clearChildren(d.bar);
    applyBarChrome();

    var commentBtn = makeButton(
      ICON_COMMENT_PATHS,
      state.labels.commentToChat,
      state.labels.shortcutModifier + ' J',
      function (e) {
        e.stopPropagation();
        showCommentInput(el);
      }
    );
    var addBtn = makeButton(ICON_ADD_PATHS, state.labels.addToChat, '↵', function (e) {
      e.stopPropagation();
      confirmSelection(el, '');
    });

    d.bar.appendChild(commentBtn);
    d.bar.appendChild(makeDivider());
    d.bar.appendChild(addBtn);
    positionBar(el);
  }

  function showCommentInput(el) {
    var d = ensureDom();
    var th = state.theme;
    state.mode = 'comment';
    clearChildren(d.bar);
    applyEditorChrome();

    var textarea = document.createElement('textarea');
    textarea.rows = 2;
    textarea.placeholder = state.labels.commentPlaceholder;
    textarea.style.cssText =
      'display:block;width:100%;box-sizing:border-box;resize:none;border:none;background:transparent;' +
      'outline:none;padding:0;font-size:14px;line-height:22px;color:' + th.textPrimary + ';' +
      'font-family:' + FONT_STACK + ';';

    var counter = document.createElement('div');
    counter.style.cssText = 'display:none;padding:0 2px;font-size:11px;line-height:16px;color:' + th.danger + ';';

    function updateCounter() {
      var over = textarea.value.length > MAX_COMMENT;
      if (over) {
        counter.textContent = textarea.value.length + '/' + MAX_COMMENT;
        counter.style.display = 'block';
      } else {
        counter.style.display = 'none';
      }
    }

    textarea.addEventListener('input', updateCounter);
    textarea.addEventListener('click', function (e) {
      e.stopPropagation();
    });
    textarea.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (textarea.value.length > MAX_COMMENT) {
          return;
        }
        confirmSelection(el, textarea.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        state.mode = 'selected';
        showConfirmBar(el);
      }
    });

    d.bar.appendChild(textarea);
    d.bar.appendChild(counter);
    positionBar(el);
    textarea.focus();
  }

  function showConfirmedFlash(el) {
    var d = state.dom;
    clearChildren(d.bar);
    applyBarChrome();
    var check = document.createElement('div');
    check.textContent = '✓';
    check.style.cssText =
      'padding:6px 10px;font-size:14px;line-height:22px;font-weight:600;color:' + state.theme.textPrimary + ';';
    d.bar.appendChild(check);
    positionBar(el);
  }

  function confirmSelection(el, comment) {
    var payload = buildPayload(el, comment || undefined);
    sendSelection(payload);
    showConfirmedFlash(el);
    window.setTimeout(function () {
      resetToHover();
    }, CONFIRM_FLASH_MS);
  }

  // ---------- Mode transitions ----------

  function selectElement(el) {
    state.mode = 'selected';
    state.selectedEl = el;
    hideHover();

    var d = ensureDom();
    var rect = el.getBoundingClientRect();
    positionBoxToRect(d.selectedBox, rect);
    d.selectedBox.style.display = 'block';

    // Persistent tag badge on the selected element (mirrors the hover badge).
    d.selectedLabel.textContent = displayName(el);
    var slTop = rect.top - 20;
    if (slTop < 0) {
      slTop = rect.top + 2;
    }
    d.selectedLabel.style.left = rect.left + 'px';
    d.selectedLabel.style.top = slTop + 'px';
    d.selectedLabel.style.display = 'block';

    showConfirmBar(el);
  }

  function resetToHover() {
    state.mode = 'hover';
    state.selectedEl = null;
    var d = state.dom;
    if (d) {
      d.selectedBox.style.display = 'none';
      d.selectedLabel.style.display = 'none';
      d.bar.style.display = 'none';
    }
  }

  function cancelSelection() {
    resetToHover();
  }

  // ---------- Event handlers ----------

  function onMouseMove(e) {
    // Hover-highlight in both 'hover' and 'selected' modes — with a selection
    // up, the user can still glide over other elements to pick a different one
    // (the selected block keeps its own box + badge). Suspended only while the
    // comment editor is open.
    if (state.mode !== 'hover' && state.mode !== 'selected') {
      return;
    }
    var el = hitTest(e.clientX, e.clientY);
    if (!el || el === state.selectedEl) {
      // Over nothing, or back over the already-selected element: no second
      // (hover) box on top of the selected one.
      hideHover();
      state.hoverEl = null;
      return;
    }
    state.hoverEl = el;
    showHover(el);
  }

  function onClick(e) {
    if (state.mode !== 'hover' && state.mode !== 'selected') {
      return;
    }
    var el = hitTest(e.clientX, e.clientY);
    if (!el || el === state.selectedEl) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // Clicking a different element (re)selects it — the previous selection is
    // dropped and the confirm bar re-anchors to the new one.
    selectElement(el);
  }

  function onMouseLeave() {
    hideHover();
    state.hoverEl = null;
  }

  function onKeyDown(e) {
    if (!state.enabled) {
      return;
    }
    if (e.key === 'Escape') {
      if (state.mode === 'comment') {
        state.mode = 'selected';
        showConfirmBar(state.selectedEl);
      } else if (state.mode === 'selected') {
        cancelSelection();
      }
    } else if (e.key === 'Enter') {
      if (state.mode === 'selected' && state.selectedEl) {
        confirmSelection(state.selectedEl, '');
      }
    } else if ((e.key === 'j' || e.key === 'J') && (e.metaKey || e.ctrlKey)) {
      // Mirrors SelectionToolbar's ⌘/Ctrl+J → open comment editor.
      if (state.mode === 'selected' && state.selectedEl) {
        e.preventDefault();
        showCommentInput(state.selectedEl);
      }
    }
  }

  function bindEvents() {
    if (state.boundEvents) {
      return;
    }
    state.boundEvents = true;
    var d = state.dom;
    d.overlay.addEventListener('mousemove', onMouseMove, true);
    d.overlay.addEventListener('click', onClick, true);
    d.overlay.addEventListener('mouseleave', onMouseLeave, true);
    // Keydown must be on window/document — the transparent overlay never
    // receives keyboard focus.
    window.addEventListener('keydown', onKeyDown, true);
  }

  // ---------- Public API ----------

  function setEnabled(enabled, labels) {
    state.enabled = !!enabled;

    if (labels && typeof labels === 'object') {
      if (typeof labels.addToChat === 'string') {
        state.labels.addToChat = labels.addToChat;
      }
      if (typeof labels.commentToChat === 'string') {
        state.labels.commentToChat = labels.commentToChat;
      }
      if (typeof labels.commentPlaceholder === 'string') {
        state.labels.commentPlaceholder = labels.commentPlaceholder;
      }
      if (typeof labels.cancel === 'string') {
        state.labels.cancel = labels.cancel;
      }
      if (typeof labels.shortcutModifier === 'string') {
        state.labels.shortcutModifier = labels.shortcutModifier;
      }
      if (labels.theme && typeof labels.theme === 'object') {
        var th = labels.theme;
        var merged = {};
        var keys = ['bgBase', 'bgHover', 'borderSubtle', 'textPrimary', 'textTertiary', 'danger'];
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          merged[k] = typeof th[k] === 'string' && th[k] ? th[k] : THEME_FALLBACK[k];
        }
        state.theme = merged;
      }
    }

    if (state.enabled) {
      var d = ensureDom();
      d.overlay.style.display = 'block';
      state.mode = 'hover';
    } else {
      hideHover();
      resetToHover();
      if (state.dom) {
        state.dom.overlay.style.display = 'none';
      }
    }
  }

  // Message-driven activation. The listener only trusts `event.source ===
  // window.parent` — the browser sets `source` from the real call realm, so
  // in-page script cannot forge it (unlike `event.data`, which any script in
  // this document could construct). `event.origin` of the *validated*
  // message becomes the reply targetOrigin for `sendSelection`, so we never
  // need to hardcode the parent's dev/prod origin here.
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) {
      return;
    }
    var data = e.data;
    if (!data || typeof data !== 'object' || data.type !== 'abu-preview-inspect:set-enabled') {
      return;
    }
    parentOrigin = e.origin;
    currentNonce = data.enabled ? (data.nonce || null) : null;
    setEnabled(!!data.enabled, data.labels);
  }, false);

  // Exposed for debugging/parity with the browser-tab picker's imperative
  // export — not used by the postMessage transport above.
  window.__ABU_PREVIEW_INSPECT__ = { setEnabled: setEnabled };
})();
