"use strict";
(() => {
  // src/shared/types.ts
  var MAIN_FRAME_REF = "f0";
  function isFrameRef(value) {
    return typeof value === "string" && /^f\d+$/.test(value);
  }
  function frameOfRef(ref) {
    const colon = ref.indexOf(":");
    if (colon <= 0) return MAIN_FRAME_REF;
    const prefix = ref.slice(0, colon);
    return isFrameRef(prefix) ? prefix : MAIN_FRAME_REF;
  }
  function localRef(ref) {
    const colon = ref.indexOf(":");
    if (colon <= 0) return ref;
    return isFrameRef(ref.slice(0, colon)) ? ref.slice(colon + 1) : ref;
  }
  function qualifyRef(frameId, ref) {
    return frameId === MAIN_FRAME_REF ? ref : `${frameId}:${ref}`;
  }
  function frameGoneMessage(frameId) {
    return `Embedded region "${frameId}" is not on this page any more (it reloaded, or was removed). Any refs from it are stale too. Take a fresh snapshot to get the current frame list, then use the frameId from it.`;
  }
  function frameUnreachableMessage(node) {
    if (node.inaccessibleReason === "not-a-web-page") {
      return `Embedded region "${node.frameId}" is not an ordinary web page (${node.url ?? "no address"}), so it has no addressable content. Act on the main page instead.`;
    }
    return `Embedded region "${node.frameId}" comes from ${node.origin ?? "another site"} and the built-in browser cannot reach inside a third-party embedded region: its automation runs in the main page only. Do this part in your own Chrome (the browser extension channel can address that region), or ask the user to complete it by hand. Do not try to script around it.`;
  }

  // src/content/index.ts
  var MAX_EXTRACT_TEXT_SIZE = 5e4;
  var MAX_SNAPSHOT_ELEMENTS = 200;
  var MAX_SNAPSHOT_CHARS = 3e4;
  var electronBrowserRuntime = globalThis.__ABU_ELECTRON_BROWSER_RUNTIME__;
  if (electronBrowserRuntime) {
    electronBrowserRuntime.handleAction = handleAction;
  } else {
    const reportVisible = () => {
      if (document.visibilityState === "visible") {
        chrome.runtime.sendMessage({ type: "tab_visible" }).catch(() => {
        });
      }
    };
    document.addEventListener("visibilitychange", reportVisible);
    reportVisible();
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const { action, payload } = message;
      handleAction(action, payload).then((data) => sendResponse({ data })).catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
      return true;
    });
  }
  var refByElement = /* @__PURE__ */ new WeakMap();
  var elementByRef = /* @__PURE__ */ new Map();
  var refCounter = 0;
  function refFor(el) {
    const frameId = frameIdOfElement(el);
    const existing = refByElement.get(el);
    if (existing && elementByRef.get(existing)?.deref() === el) return qualifyRef(frameId, existing);
    const ref = `e${++refCounter}`;
    refByElement.set(el, ref);
    elementByRef.set(ref, new WeakRef(el));
    return qualifyRef(frameId, ref);
  }
  function frameIdOfElement(el) {
    const doc = el.ownerDocument;
    if (!doc || doc === document) return hostFrameId;
    return frameIdByDoc.get(doc) ?? frameIdForDoc(doc);
  }
  function resolveRef(ref, scope) {
    if (frameOfRef(ref) !== scope.frameId) return null;
    const el = elementByRef.get(localRef(ref))?.deref();
    if (!el || !el.isConnected) {
      elementByRef.delete(localRef(ref));
      return null;
    }
    if (el.ownerDocument !== scope.doc) return null;
    return el;
  }
  function sweepRefs() {
    for (const [ref, weak] of elementByRef) {
      const el = weak.deref();
      if (!el || !el.isConnected) elementByRef.delete(ref);
    }
  }
  var MAX_FRAME_DEPTH = 8;
  var MAX_FRAMES = 40;
  var MAX_SHADOW_DEPTH = 10;
  var LOCAL_FRAME_WALK = !!electronBrowserRuntime;
  var hostFrameId = MAIN_FRAME_REF;
  function hostScope() {
    return { doc: document, frameId: hostFrameId };
  }
  var frameIdByDoc = /* @__PURE__ */ new WeakMap();
  var docByFrameId = /* @__PURE__ */ new Map();
  var frameIdByFrameEl = /* @__PURE__ */ new WeakMap();
  var frameElByFrameId = /* @__PURE__ */ new Map();
  var frameNodeById = /* @__PURE__ */ new Map();
  var frameCounter = 0;
  function frameIdForDoc(doc) {
    if (doc === document) return hostFrameId;
    const existing = frameIdByDoc.get(doc);
    if (existing && docByFrameId.get(existing)?.deref() === doc) return existing;
    const id = `f${++frameCounter}`;
    frameIdByDoc.set(doc, id);
    docByFrameId.set(id, new WeakRef(doc));
    return id;
  }
  function frameIdForCrossOriginEl(el) {
    const existing = frameIdByFrameEl.get(el);
    if (existing && frameElByFrameId.get(existing)?.deref() === el) return existing;
    const id = `f${++frameCounter}`;
    frameIdByFrameEl.set(el, id);
    frameElByFrameId.set(id, new WeakRef(el));
    return id;
  }
  function reachableFrameDoc(el) {
    try {
      const doc = el.contentDocument;
      if (!doc || !doc.defaultView || !doc.documentElement) return null;
      return doc;
    } catch {
      return null;
    }
  }
  function originOfDocument(doc) {
    return normalizedOrigin(doc.location.origin) ?? normalizedOrigin(doc.location.href);
  }
  function enumerateFrames() {
    const topOrigin = originOfDocument(document);
    const out = [{
      frameId: hostFrameId,
      origin: topOrigin,
      url: document.location.href,
      sameOriginAsTop: true,
      accessible: topOrigin !== null,
      ...topOrigin === null ? { inaccessibleReason: "not-a-web-page" } : {}
    }];
    const walk = (doc, parentFrameId, parentOrigin, depth) => {
      if (depth >= MAX_FRAME_DEPTH || out.length >= MAX_FRAMES) return;
      for (const el of queryAllDeep(doc, "iframe, frame")) {
        if (out.length >= MAX_FRAMES) return;
        const child = reachableFrameDoc(el);
        if (child) {
          const origin = originOfDocument(child) ?? parentOrigin;
          const id = frameIdForDoc(child);
          out.push({
            frameId: id,
            parentFrameId,
            origin,
            url: child.location.href,
            sameOriginAsTop: origin !== null && origin === topOrigin,
            accessible: origin !== null,
            ...origin === null ? { inaccessibleReason: "not-a-web-page" } : {}
          });
          if (origin !== null) walk(child, id, origin, depth + 1);
          continue;
        }
        const src = el.getAttribute("src") ?? "";
        let hinted = null;
        try {
          hinted = src ? normalizedOrigin(new URL(src, doc.baseURI).href) : null;
        } catch {
          hinted = null;
        }
        out.push({
          frameId: frameIdForCrossOriginEl(el),
          parentFrameId,
          origin: hinted,
          ...src ? { url: src } : {},
          sameOriginAsTop: false,
          accessible: false,
          inaccessibleReason: hinted === null ? "not-a-web-page" : "cross-origin-unreachable"
        });
      }
    };
    if (LOCAL_FRAME_WALK) walk(document, hostFrameId, topOrigin, 0);
    frameNodeById.clear();
    for (const node of out) frameNodeById.set(node.frameId, node);
    return out;
  }
  function resolveScope(payload) {
    const named = payload.frameId;
    if (named !== void 0 && !isFrameRef(named)) {
      throw new Error(
        `Invalid frameId ${JSON.stringify(named)}. Frame handles come from a snapshot's \`frames\` list (or get_tabs) and look like "f0", "f3". Omit it to act on the main document.`
      );
    }
    const fromRef = frameFromLocators(payload);
    if (named !== void 0 && fromRef !== null && named !== fromRef) {
      throw new Error(
        `frameId ${JSON.stringify(named)} does not match the ref you passed, which belongs to ${JSON.stringify(fromRef)}. A ref can only be used in the frame that minted it \u2014 drop the frameId, or use a ref from that frame.`
      );
    }
    const wanted = named ?? fromRef ?? hostFrameId;
    if (wanted === hostFrameId) return hostScope();
    if (!LOCAL_FRAME_WALK) {
      throw new Error(frameGoneMessage(wanted));
    }
    const doc = docByFrameId.get(wanted)?.deref();
    if (doc && doc.defaultView) return { doc, frameId: wanted };
    const known = frameNodeById.get(wanted);
    if (known && !known.accessible) throw new Error(frameUnreachableMessage(known));
    throw new Error(frameGoneMessage(wanted));
  }
  var LOCATOR_ROUTED_ACTIONS = /* @__PURE__ */ new Set(["click", "fill", "select"]);
  function resolveLocatorFrame(action, payload, scope) {
    if (!LOCAL_FRAME_WALK || !LOCATOR_ROUTED_ACTIONS.has(action)) return scope;
    if (payload.frameId !== void 0) return scope;
    const locator = payload.locator;
    if (!locator || locator.ref) return scope;
    try {
      if (findElement(scope, locator) !== null) return scope;
    } catch {
      return scope;
    }
    const hits = [];
    const ambiguous = [];
    for (const node of enumerateFrames()) {
      if (node.frameId === scope.frameId || !node.accessible) continue;
      const doc = docByFrameId.get(node.frameId)?.deref();
      if (!doc || !doc.defaultView) continue;
      const candidate = { doc, frameId: node.frameId };
      try {
        if (findElement(candidate, locator) !== null) hits.push(candidate);
      } catch {
        ambiguous.push(candidate);
      }
    }
    const all = [...hits, ...ambiguous];
    if (all.length > 1) {
      throw new Error(
        `That locator matches an element in ${all.length} different embedded regions of this page, so it does not identify one. Nothing was clicked or changed. Pass \`frameId\` to say which:
` + all.map((c) => `  ${c.frameId} (${normalizedOrigin(c.doc.location.href) ?? "unknown region"})`).join("\n")
      );
    }
    return all[0] ?? scope;
  }
  function frameFromLocators(payload) {
    const refs = [];
    const collect = (value) => {
      if (typeof value !== "object" || value === null) return;
      const ref = value.ref;
      if (typeof ref === "string" && ref !== "") refs.push(ref);
    };
    collect(payload.locator);
    const condition = payload.condition;
    if (typeof condition === "object" && condition !== null) {
      collect(condition.locator);
    }
    if (refs.length === 0) return null;
    const frames = new Set(refs.map(frameOfRef));
    if (frames.size > 1) {
      throw new Error("The refs in this call come from different frames; one call acts in one frame.");
    }
    return [...frames][0];
  }
  function shadowRootsIn(root, depth = 0) {
    if (depth >= MAX_SHADOW_DEPTH) return [];
    const found = [];
    for (const el of root.querySelectorAll("*")) {
      const shadow = el.shadowRoot;
      if (shadow) {
        found.push(shadow);
        found.push(...shadowRootsIn(shadow, depth + 1));
      }
    }
    return found;
  }
  function queryAllDeep(root, selector) {
    const out = [...root.querySelectorAll(selector)];
    for (const shadow of shadowRootsIn(root)) out.push(...shadow.querySelectorAll(selector));
    return out;
  }
  function closedShadowHostCount(scope) {
    let count = 0;
    for (const el of scope.doc.querySelectorAll("*")) {
      if (!el.tagName.includes("-")) continue;
      if (el.shadowRoot) continue;
      if (el.children.length > 0) continue;
      if ((el.textContent ?? "").trim() !== "") continue;
      count += 1;
      if (count >= 20) break;
    }
    return count;
  }
  function closedShadowNote(count) {
    return ` This page also has ${count} sealed region${count === 1 ? "" : "s"} (closed shadow DOM), whose contents no automation can read or operate \u2014 not this tool, and not a script. If what you are looking for is in one, ask the user to do that step by hand.`;
  }
  var ORIGIN_PINNED_ACTIONS = /* @__PURE__ */ new Set(["click", "fill", "select", "keyboard"]);
  function assertOriginPin(action, payload, scope) {
    if (!ORIGIN_PINNED_ACTIONS.has(action)) return;
    const expected = typeof payload.expectedOrigin === "string" ? payload.expectedOrigin : "";
    if (!expected) {
      if (payload.unattended !== true) return;
      throw new Error(
        "Refused: this unattended run sent no approved origin for the page, so the action could not be verified against what was authorized. Call get_tabs to re-read where you are, then request this action again."
      );
    }
    const current = normalizedOrigin(scope.doc.location.href);
    if (current === expected) return;
    if (scope.frameId !== MAIN_FRAME_REF || window.top !== window) {
      throw new Error(
        `Refused: this action targeted a frame from a different site than the one approved (approved ${expected}, this frame is ${current ?? "not an ordinary web page"}). Embedded third-party frames are not covered by that approval and a fresh snapshot will not change it \u2014 act on the main page, or ask for this site to be authorized separately.`
      );
    }
    throw new Error(
      `Refused: this tab is no longer on the page this action was approved for (approved ${expected}, now ${current ?? "an unknown page"}). The page moved \u2014 a redirect, a script navigation, or a reload. Take a fresh snapshot to re-read the current state before acting again; the earlier approval does not carry over to a different site.`
    );
  }
  function assertFrameAbstains(payload) {
    if (payload.locator !== void 0) return;
    throw new Error(
      "Nothing is focused in this frame, so there is nowhere to send the key press. Click the field you want to type into first, then send the key."
    );
  }
  function normalizedOrigin(href) {
    try {
      const parsed = new URL(href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      const hostname = parsed.hostname.endsWith(".") ? parsed.hostname.slice(0, -1) : parsed.hostname;
      if (!hostname) return null;
      return `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      return null;
    }
  }
  function frameServicesAction(action, payload, scope) {
    const locator = payload.locator;
    if (locator !== void 0) {
      try {
        return findElement(scope, locator) !== null;
      } catch {
        return false;
      }
    }
    const focused = scope.doc.activeElement;
    const hasRealFocus = focused !== null && focused !== scope.doc.body && focused !== scope.doc.documentElement;
    return hasRealFocus || window.top === window;
  }
  var FRAME_SCOPED_ACTIONS = /* @__PURE__ */ new Set([
    "snapshot",
    "find",
    "locate",
    "click",
    "fill",
    "select",
    "wait_for",
    "extract_text",
    "extract_table"
  ]);
  async function handleAction(action, payload) {
    const stamped = payload?.__abuFrameId;
    if (isFrameRef(stamped)) hostFrameId = stamped;
    if (!FRAME_SCOPED_ACTIONS.has(action) && payload?.frameId !== void 0) {
      throw new Error(
        `${action} does not act on a located element, so it takes no frameId. Click into the region first, then send this action.`
      );
    }
    const scope = resolveLocatorFrame(action, payload ?? {}, resolveScope(payload ?? {}));
    if (ORIGIN_PINNED_ACTIONS.has(action)) {
      if (frameServicesAction(action, payload, scope)) assertOriginPin(action, payload, scope);
      else assertFrameAbstains(payload);
    }
    return annotateAdvisory(action, await dispatchAction(action, payload, scope));
  }
  async function dispatchAction(action, payload, scope) {
    switch (action) {
      case "snapshot":
        return takeSnapshot(
          scope,
          payload.selector,
          typeof payload.maxChars === "number" ? payload.maxChars : void 0
        );
      case "find":
        return findElements(scope, payload.query, payload.limit);
      case "frames":
        return enumerateFrames();
      case "locate":
        return locateOnly(scope, payload.locator);
      case "click":
        return clickElement(scope, payload.locator);
      case "fill":
        return fillElement(scope, payload.locator, payload.value);
      case "select":
        return selectOption(scope, payload.locator, payload.value);
      case "wait_for":
        return waitFor(scope, payload.condition, payload.timeout);
      case "get_html":
        return getHtml(payload.selector);
      case "extract_text":
        return extractText(scope, payload.selector);
      case "extract_table":
        return extractTable(scope, payload.selector);
      case "scroll":
        return scrollPage(payload);
      case "keyboard":
        return sendKeyboard(payload);
      case "start_recording":
        return startRecording();
      case "stop_recording":
        return stopRecording();
      case "fullpage_prepare":
        return fullpagePrepare();
      case "fullpage_scroll":
        return fullpageScroll(payload.scrollTop);
      case "fullpage_restore":
        return fullpageRestore(payload.scrollX, payload.scrollY);
      default:
        throw new Error(`Unknown content action: ${action}`);
    }
  }
  var REDACTED_VALUE = "[value redacted]";
  function isSensitiveAutocompleteToken(token) {
    return token === "one-time-code" || token === "current-password" || token === "new-password" || token.startsWith("cc-");
  }
  function hasSensitiveValue(el) {
    const type = el.type;
    if (typeof type === "string" && type.toLowerCase() === "password") return true;
    const autocomplete = el.getAttribute("autocomplete");
    if (!autocomplete) return false;
    return autocomplete.toLowerCase().split(/\s+/).some((token) => isSensitiveAutocompleteToken(token));
  }
  function fieldLabel(el) {
    const placeholder = el.placeholder;
    return placeholder || el.getAttribute("aria-label") || el.getAttribute("name") || (el.id ? `#${el.id}` : "") || `<${el.tagName.toLowerCase()}>`;
  }
  function reportableValue(el, value, maxChars) {
    if (!value) return void 0;
    return hasSensitiveValue(el) ? REDACTED_VALUE : value.slice(0, maxChars);
  }
  var MAX_DETECTION_TEXT = 2e4;
  function detectionText() {
    const body = document.body;
    if (!body) return "";
    let text = (body.innerText ?? body.textContent ?? "").slice(0, MAX_DETECTION_TEXT);
    for (const secret of sensitiveValuesIn(body)) {
      text = text.split(secret).join(REDACTED_VALUE);
    }
    return text;
  }
  function visibleMatch(selector) {
    for (const el of document.querySelectorAll(selector)) {
      if (hasBox(el)) return el;
    }
    return null;
  }
  var CAPTCHA_FRAME_PATTERN = /(recaptcha|hcaptcha|turnstile|geetest|captcha)/i;
  var CAPTCHA_SELECTOR = '[class*="captcha" i],[id*="captcha" i],[class*="geetest" i],[class*="slide-verify" i],[class*="slider-verify" i],[class*="nc-container" i]';
  var CAPTCHA_INTERACTIVE_SELECTOR = 'iframe,canvas,input,button,textarea,[role="button"],[role="checkbox"],[tabindex]:not([tabindex^="-"]),img[src^="data:"]';
  function containerIsOperable(el) {
    if (el.matches(CAPTCHA_INTERACTIVE_SELECTOR)) return true;
    for (const child of el.querySelectorAll(CAPTCHA_INTERACTIVE_SELECTOR)) {
      if (hasBox(child)) return true;
    }
    return false;
  }
  function hasCaptcha() {
    for (const frame of document.querySelectorAll("iframe")) {
      const surface = `${frame.getAttribute("src") ?? ""} ${frame.getAttribute("title") ?? ""}`;
      if (CAPTCHA_FRAME_PATTERN.test(surface) && hasBox(frame)) return true;
    }
    for (const el of document.querySelectorAll(CAPTCHA_SELECTOR)) {
      if (hasBox(el) && containerIsOperable(el)) return true;
    }
    return false;
  }
  var QR_SELECTOR = '[class*="qrcode" i],[class*="qr-code" i],[class*="qr_code" i],[id*="qrcode" i],[class*="scan-login" i]';
  var QR_TEXT_PATTERN = /(scan (the )?(qr|code)|qr code to (log|sign) in|扫码|扫一扫|二维码)/i;
  function hasQrLogin(text) {
    if (visibleMatch(QR_SELECTOR) !== null) return true;
    return QR_TEXT_PATTERN.test(text) && visibleMatch('canvas,img[src^="data:image"],svg') !== null;
  }
  var OTP_TEXT_PATTERN = /(one[- ]?time (code|password)|verification code|security code we sent|enter the code (we )?sent|短信验证码|验证码已发送|输入验证码)/i;
  var NUMERIC_CODE_INPUT_SELECTOR = 'input[inputmode="numeric"],input[pattern*="0-9"],input[pattern*="d"]';
  var OTP_GRID_MIN_BOXES = 4;
  function hasShortCodeInput() {
    if (visibleMatch(NUMERIC_CODE_INPUT_SELECTOR) !== null) return true;
    let singleCharBoxes = 0;
    for (const el of document.querySelectorAll("input[maxlength]")) {
      const max = Number(el.getAttribute("maxlength"));
      if (!Number.isFinite(max) || !hasBox(el)) continue;
      if (max >= 4 && max <= 8) return true;
      if (max === 1 && ++singleCharBoxes >= OTP_GRID_MIN_BOXES) return true;
    }
    return false;
  }
  function hasOneTimeCodeEntry(text) {
    if (visibleMatch('input[autocomplete~="one-time-code"]') !== null) return true;
    return OTP_TEXT_PATTERN.test(text) && hasShortCodeInput();
  }
  var MFA_PUSH_PATTERN = /(approve (this |the )?(sign[- ]?in|login|request)|check your (authenticator|authentication) app|open your authenticator|we sent a (push )?notification|tap [^.]{0,20} to approve|请在(手机|移动设备)上确认|已发送(推送|通知)，请确认)/i;
  var PENDING_WIDGET_SELECTOR = '[role="progressbar"],[aria-busy="true"],[class*="spinner" i],[class*="loading" i],[class*="pending" i],[class*="waiting" i],[class*="push" i],[class*="mfa" i],[class*="2fa" i],[class*="authenticator" i]';
  var TERSE_AUTH_SURFACE_CHARS = 400;
  var AUTH_SURFACE_SEGMENTS = /* @__PURE__ */ new Set([
    "sign-in",
    "signin",
    "login",
    "sso",
    "auth",
    "oauth",
    "oauth2",
    "mfa",
    "2fa",
    "duo",
    "verify",
    "challenge"
  ]);
  function isAuthSurfacePath(pathname) {
    let decoded = pathname;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
    }
    return decoded.split("/").some((segment) => AUTH_SURFACE_SEGMENTS.has(segment.toLowerCase()));
  }
  function hasMfaPush(text) {
    if (!MFA_PUSH_PATTERN.test(text)) return false;
    if (visibleMatch(PENDING_WIDGET_SELECTOR) !== null) return true;
    return text.trim().length <= TERSE_AUTH_SURFACE_CHARS && isAuthSurfacePath(location.pathname);
  }
  var WECHAT_PATTERN = /(在浏览器中打开|即将离开微信|请在微信客户端打开|点击右上角.*浏览器)/;
  function isWeChatInterstitial(text) {
    const host = location.hostname.toLowerCase();
    const wechatHost = host === "weixin.qq.com" || host.endsWith(".weixin.qq.com");
    return wechatHost || WECHAT_PATTERN.test(text);
  }
  var OAUTH_URL_PATTERN = /(?:^|\/)(oauth2?|authorize|signin-oidc|callback)(?:\/|$)/i;
  var blankOauthObservation = null;
  function isStrandedOauthPage(text) {
    const blankNow = document.readyState !== "loading" && OAUTH_URL_PATTERN.test(location.pathname) && text.trim().length <= 40 && visibleMatch("input,button,a[href],form") === null;
    if (!blankNow) {
      blankOauthObservation = null;
      return false;
    }
    const href = location.href;
    blankOauthObservation = blankOauthObservation?.href === href ? { href, passes: blankOauthObservation.passes + 1 } : { href, passes: 1 };
    return blankOauthObservation.passes > 1;
  }
  var HANDOFF_HINTS = {
    captcha: "This page is showing a CAPTCHA (a checkbox, image, or slider challenge). Do not retry the action and do not try to solve it. Stop, tell the user which page is asking, and ask them to complete the challenge themselves before you continue.",
    qr_login: "This page signs in by QR code, which only a person holding the phone can scan. Do not retry. Stop and ask the user to scan the code shown on this page, then continue once they say they are signed in.",
    sms_code: "This page is asking for a one-time code sent to the user by SMS, email, or an authenticator. You cannot read it. Do not retry or guess. Stop and ask the user for the code, or ask them to enter it themselves.",
    mfa_push: "This page is waiting for the user to approve a push prompt in their authenticator app. NEVER retry or re-trigger it: repeated push prompts are how push-bombing attacks work, and the provider may lock or flag the account. Stop and ask the user to approve the prompt once on their device.",
    wechat_external_link: "WeChat has intercepted this link and is asking for it to be opened in a browser. Retrying inside WeChat will keep landing here. Stop and ask the user to open the link in a browser.",
    oauth_popup: "The sign-in window this page opened is gone or blank, so the OAuth flow cannot finish here. Do not retry the popup. Ask for the provider's redirect flow instead (navigate to the authorization URL in this tab), or ask the user to complete the sign-in themselves."
  };
  function detectHandoff(text) {
    const kind = isWeChatInterstitial(text) ? "wechat_external_link" : hasCaptcha() ? "captcha" : hasQrLogin(text) ? "qr_login" : hasMfaPush(text) ? "mfa_push" : hasOneTimeCodeEntry(text) ? "sms_code" : isStrandedOauthPage(text) ? "oauth_popup" : null;
    return kind === null ? null : { kind, hint: HANDOFF_HINTS[kind] };
  }
  var AUTH_WALL_TEXT_PATTERN = /(sign in to continue|log in to continue|please (sign|log) in|your session has expired|session expired|请先登录|登录已过期|请重新登录)/i;
  var NOT_A_SIGN_IN_PATTERN = /(create[ \t]+(?:[a-z]+[ \t]+){0,2}account|sign up|signing up|registration|register now|change (your )?password|new password|reset (your )?password|注册账号|注册新用户|修改密码|设置新密码|重置密码)/i;
  var IDENTIFIER_INPUT_SELECTOR = 'input[autocomplete~="username"],input[autocomplete~="email"],input[type="email"],[name*="user" i],[name*="email" i],[name*="login" i],[name*="account" i],[id*="user" i],[id*="email" i]';
  var NAVIGATION_LABEL_SELECTOR = 'a,[role="link"],button,[role="button"],input[type="button"],input[type="submit"]';
  function signInScopeText(passwordBox) {
    const scope = passwordBox.closest('form,[role="form"]') ?? passwordBox.closest("section,article,main") ?? passwordBox.parentElement ?? passwordBox;
    const clone = scope.cloneNode(true);
    for (const label of clone.querySelectorAll(NAVIGATION_LABEL_SELECTOR)) label.remove();
    return `${nearestHeadingText(scope)} ${clone.textContent ?? ""}`;
  }
  function nearestHeadingText(scope) {
    const own = scope.querySelector('h1,h2,h3,legend,[role="heading"]');
    if (own && hasBox(own)) return own.textContent ?? "";
    for (let node = scope.parentElement; node; node = node.parentElement) {
      for (const child of node.children) {
        if (!child.matches('h1,h2,h3,legend,[role="heading"]')) continue;
        if (hasBox(child)) return child.textContent ?? "";
      }
      if (node.tagName === "BODY") break;
    }
    return "";
  }
  function looksLikeSignInForm() {
    const passwords = [...document.querySelectorAll('input[type="password"]')].filter(hasBox);
    if (passwords.length !== 1) return false;
    const autocomplete = (passwords[0].getAttribute("autocomplete") ?? "").toLowerCase();
    if (autocomplete.includes("new-password")) return false;
    if (visibleMatch(IDENTIFIER_INPUT_SELECTOR) === null) return false;
    return !NOT_A_SIGN_IN_PATTERN.test(signInScopeText(passwords[0]));
  }
  function detectAuthWall(text) {
    if (looksLikeSignInForm()) return true;
    return AUTH_WALL_TEXT_PATTERN.test(text);
  }
  var ADVISORY_ANNOTATED_ACTIONS = /* @__PURE__ */ new Set([
    "snapshot",
    "click",
    "fill",
    "select",
    "wait_for",
    "extract_table"
  ]);
  function annotateAdvisory(action, result) {
    if (!ADVISORY_ANNOTATED_ACTIONS.has(action)) return result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
    const existing = result;
    if ("authState" in existing || "handoff" in existing) return result;
    let text;
    try {
      text = detectionText();
    } catch {
      return result;
    }
    const handoff = detectHandoff(text);
    const loginRequired = detectAuthWall(text);
    if (!handoff && !loginRequired) return result;
    return {
      ...existing,
      ...loginRequired ? { authState: "login_required" } : {},
      ...handoff ? { handoff } : {}
    };
  }
  function takeSnapshot(scope, scopeSelector, maxChars = MAX_SNAPSHOT_CHARS) {
    const roots = scopeSelector ? queryAllDeep(scope.doc, scopeSelector) : scope.doc.body ? [scope.doc.body] : [];
    if (roots.length === 0) {
      throw new Error(
        `Scope element not found: ${scopeSelector}. Take a snapshot without a selector to see what the page actually contains.`
      );
    }
    sweepRefs();
    const interactiveTags = /* @__PURE__ */ new Set([
      "a",
      "button",
      "input",
      "textarea",
      "select",
      "details",
      "summary"
    ]);
    const interactiveRoles = /* @__PURE__ */ new Set([
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "listbox",
      "option",
      "menuitem",
      "tab",
      "switch",
      "slider"
    ]);
    const openPopups = queryAllDeep(scope.doc, '[role="listbox"], [role="menu"], [role="grid"]').map((list) => popupRootFor(list)).filter((popup) => hasBox(popup));
    const isPopupRow = (el) => {
      if (openPopups.length === 0) return false;
      if (!hasBox(el)) return false;
      if (!openPopups.some((popup) => popup !== el && popup.contains(el))) return false;
      if ([...el.children].some((child) => hasBox(child))) return false;
      const text = normalizedText(el);
      return text.length > 0 && text.length <= 100;
    };
    const elements = [];
    const seenElements = /* @__PURE__ */ new WeakSet();
    let hitCap = false;
    const walkDeep = (root, depth, visit) => {
      if (!visit(root)) return false;
      if (depth < MAX_SHADOW_DEPTH && root.shadowRoot) {
        for (const child of root.shadowRoot.children) {
          if (!walkDeep(child, depth + 1, visit)) return false;
        }
      }
      for (const child of root.children) {
        if (!walkDeep(child, depth, visit)) return false;
      }
      return true;
    };
    for (const root of roots) {
      if (hitCap) break;
      walkDeep(root, 0, (el) => {
        const tag = el.tagName?.toLowerCase();
        const isInteractive = interactiveTags.has(tag) || el.hasAttribute("onclick") || el.hasAttribute("tabindex") || el.getAttribute("role") && interactiveRoles.has(el.getAttribute("role")) || el.contentEditable === "true" || tag === "div" && el.getAttribute("role") && interactiveRoles.has(el.getAttribute("role")) || isPopupRow(el);
        if (isInteractive && !seenElements.has(el) && isSnapshotVisible(el)) {
          seenElements.add(el);
          const info = {
            ref: refFor(el),
            tag,
            enabled: !el.disabled,
            visible: true
          };
          const text = getVisibleText(el);
          if (text) info.text = text.slice(0, 100);
          if (el.id) info.id = el.id;
          const nameAttr = el.getAttribute("name");
          if (nameAttr) info.name = nameAttr;
          if (tag === "input") {
            const input = el;
            info.type = input.type;
            if (input.placeholder) info.placeholder = input.placeholder;
            const value = reportableValue(input, input.value, 100);
            if (value !== void 0) info.value = value;
            if (input.type === "checkbox" || input.type === "radio") {
              info.checked = input.checked;
            }
          }
          if (tag === "textarea") {
            const ta = el;
            if (ta.placeholder) info.placeholder = ta.placeholder;
            const value = reportableValue(ta, ta.value, 200);
            if (value !== void 0) info.value = value;
          }
          if (tag === "select") {
            const select = el;
            info.options = [...select.options].map((o) => ({ value: o.value, text: o.text }));
            const value = reportableValue(select, select.value, 100);
            if (value !== void 0) info.value = value;
          }
          if (tag === "a") {
            info.href = el.href;
          }
          const role = el.getAttribute("role");
          if (role) info.role = role;
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) info.ariaLabel = ariaLabel;
          elements.push(info);
          if (elements.length >= MAX_SNAPSHOT_ELEMENTS) {
            hitCap = true;
            return false;
          }
        }
        return true;
      });
    }
    const hitElementCap = elements.length >= MAX_SNAPSHOT_ELEMENTS;
    const total = elements.length;
    const serializedLength = (count) => JSON.stringify(elements.slice(0, count), null, 2).length;
    let kept = total;
    if (serializedLength(total) > maxChars) {
      let low = 1;
      let high = total;
      kept = 1;
      while (low <= high) {
        const mid = low + high >> 1;
        if (serializedLength(mid) <= maxChars) {
          kept = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      elements.length = kept;
    }
    const overBudget = kept < total;
    const sealed = closedShadowHostCount(scope);
    if (elements.length === 0 && scopeSelector) {
      return {
        url: scope.doc.location.href,
        title: scope.doc.title,
        frameId: scope.frameId,
        ...frameTreeField(scope),
        elements,
        ...sealed > 0 ? { closedShadowHosts: sealed } : {},
        message: `"${scopeSelector}" matched ${roots.length} element${roots.length === 1 ? "" : "s"}, none of which contain anything interactive right now \u2014 a popup that is closed looks like this. Take a snapshot without a selector to see the whole page, or open the control first.` + (sealed > 0 ? closedShadowNote(sealed) : "")
      };
    }
    const reasons = [];
    if (hitElementCap) reasons.push(`the ${MAX_SNAPSHOT_ELEMENTS}-element cap`);
    if (overBudget) reasons.push(`the ${maxChars}-character budget`);
    return {
      url: scope.doc.location.href,
      title: scope.doc.title,
      frameId: scope.frameId,
      ...frameTreeField(scope),
      elements,
      ...sealed > 0 ? { closedShadowHosts: sealed } : {},
      ...reasons.length ? {
        truncated: true,
        message: `Showing ${elements.length} of ${total}+ interactive elements \u2014 hit ${reasons.join(" and ")}. To see the rest: pass \`selector\` to scope the snapshot to one region (e.g. the form you are filling), or raise \`maxChars\`. The elements listed above are complete and their refs are valid.`
      } : {}
    };
  }
  function frameTreeField(scope) {
    if (!LOCAL_FRAME_WALK || scope.frameId !== MAIN_FRAME_REF) return {};
    const frames = enumerateFrames();
    return frames.length > 1 ? { frames } : {};
  }
  function escapeCSS(value) {
    if (typeof CSS !== "undefined" && CSS.escape) {
      return CSS.escape(value);
    }
    return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
  }
  var NEVER_A_TARGET = /* @__PURE__ */ new Set(["html", "body", "head", "script", "style", "noscript", "title"]);
  var ABU_OVERLAY_IDS = /* @__PURE__ */ new Set(["abu-status", "abu-highlight"]);
  function isAbuOverlay(el) {
    const selector = [...ABU_OVERLAY_IDS].map((id) => `#${id}`).join(",");
    return el.closest(selector) !== null;
  }
  function styleOf(el) {
    const view = el.ownerDocument?.defaultView ?? window;
    return view.getComputedStyle(el);
  }
  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList.length ? `.${[...el.classList].slice(0, 2).join(".")}` : "";
    const text = (getVisibleText(el) ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `[${refFor(el)}] <${tag}${id}${cls}>${text ? ` "${text}"` : ""}`;
  }
  function isClickable(el) {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "select", "textarea", "summary", "label", "option"].includes(tag)) return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("tabindex")) return true;
    const role = el.getAttribute("role");
    return role !== null && ["button", "link", "option", "menuitem", "tab", "checkbox", "radio", "switch"].includes(role);
  }
  var BUTTON_INPUT_TYPES = /* @__PURE__ */ new Set(["submit", "button", "reset", "image"]);
  var TEXTBOX_INPUT_TYPES = /* @__PURE__ */ new Set(["", "text", "email", "password", "search", "tel", "url", "number"]);
  var IMPLICIT_ROLE_BY_TAG = {
    button: "button",
    textarea: "textbox",
    select: "combobox",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    summary: "button"
  };
  var IMPLICIT_ROLE_SELECTORS = {
    button: "button, input, summary",
    link: "a[href]",
    textbox: "input, textarea",
    checkbox: "input",
    radio: "input",
    combobox: "select",
    heading: "h1, h2, h3, h4, h5, h6",
    img: "img"
  };
  function inputType(el) {
    return (el.getAttribute("type") ?? "").trim().toLowerCase();
  }
  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = inputType(el);
      if (BUTTON_INPUT_TYPES.has(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (TEXTBOX_INPUT_TYPES.has(type)) return "textbox";
      return null;
    }
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "img") return el.getAttribute("alt") === "" ? null : "img";
    return IMPLICIT_ROLE_BY_TAG[tag] ?? null;
  }
  function effectiveRole(el) {
    const explicit = (el.getAttribute("role") ?? "").trim().split(/\s+/)[0];
    if (explicit) return explicit.toLowerCase();
    return implicitRole(el);
  }
  var NAME_FROM_CONTENT_ROLES = /* @__PURE__ */ new Set([
    "button",
    "link",
    "heading",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "checkbox",
    "radio",
    "switch",
    "treeitem",
    "cell",
    "gridcell",
    "columnheader",
    "rowheader",
    "row",
    "tooltip"
  ]);
  var LABELABLE_TAGS = /* @__PURE__ */ new Set(["button", "input", "meter", "output", "progress", "select", "textarea"]);
  function normalizeWhitespace(value) {
    return value.replace(/\s+/g, " ").trim();
  }
  function squashWhitespace(value) {
    return value.replace(/\s+/g, "");
  }
  function nativeLabelText(el) {
    const tag = el.tagName.toLowerCase();
    if (!LABELABLE_TAGS.has(tag)) return "";
    if (tag === "input" && inputType(el) === "hidden") return "";
    const labels = /* @__PURE__ */ new Set();
    if (el.id) {
      const root = el.getRootNode();
      for (const label of root.querySelectorAll("label[for]")) {
        if (label.getAttribute("for") === el.id) labels.add(label);
      }
    }
    const wrapping = el.closest?.("label");
    if (wrapping) labels.add(wrapping);
    const parts = [...labels].map((label) => normalizeWhitespace(label.textContent ?? ""));
    return normalizeWhitespace(parts.filter(Boolean).join(" "));
  }
  function accessibleName(el) {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const joined = labelledBy.split(/\s+/).filter(Boolean).map((id) => el.getRootNode().getElementById(id)).filter((node) => node !== null).map((node) => normalizeWhitespace(node.textContent ?? "")).filter(Boolean).join(" ");
      if (joined) return joined;
    }
    const ariaLabel = normalizeWhitespace(el.getAttribute("aria-label") ?? "");
    if (ariaLabel) return ariaLabel;
    const label = nativeLabelText(el);
    if (label) return label;
    const alt = normalizeWhitespace(el.getAttribute("alt") ?? "");
    if (alt) return alt;
    if (el.tagName.toLowerCase() === "input" && BUTTON_INPUT_TYPES.has(inputType(el))) {
      const value = normalizeWhitespace(el.value ?? "");
      if (value) return value;
    }
    const title = normalizeWhitespace(el.getAttribute("title") ?? "");
    if (title) return title;
    const role = effectiveRole(el);
    if (role !== null && NAME_FROM_CONTENT_ROLES.has(role)) {
      const text = normalizeWhitespace(el.textContent ?? "");
      if (text) return text;
    }
    return normalizeWhitespace(el.getAttribute("placeholder") ?? "");
  }
  function isLocatorVisible(el) {
    if (el.hasAttribute("hidden")) return false;
    if (el.tagName.toLowerCase() === "input" && inputType(el) === "hidden") return false;
    if (el.closest?.('[aria-hidden="true"]')) return false;
    if (el.closest?.("[inert]")) return false;
    if (isFullyTransparent(el)) return false;
    return isSnapshotVisible(el);
  }
  function isFullyTransparent(el) {
    if (!hasBox(el)) return false;
    for (let node = el; node && node !== el.ownerDocument.documentElement; node = node.parentElement) {
      if (styleOf(node).opacity === "0") return true;
    }
    return false;
  }
  function isLocatorTarget(el) {
    if (NEVER_A_TARGET.has(el.tagName.toLowerCase())) return false;
    if (isAbuOverlay(el)) return false;
    return isLocatorVisible(el);
  }
  function elementsWithRole(scope, role) {
    const wanted = role.trim().toLowerCase();
    const selectors = ["[role]"];
    const implicit = IMPLICIT_ROLE_SELECTORS[wanted];
    if (implicit) selectors.push(implicit);
    return queryAllDeep(scope.doc, selectors.join(", ")).filter(
      (el) => !NEVER_A_TARGET.has(el.tagName.toLowerCase()) && effectiveRole(el) === wanted
    );
  }
  function looselyNamed(name, wanted) {
    const normWanted = normalizeWhitespace(wanted).toLowerCase();
    if (normWanted === "") return true;
    if (normalizeWhitespace(name).toLowerCase().includes(normWanted)) return true;
    const squashedWanted = squashWhitespace(wanted).toLowerCase();
    return squashedWanted !== "" && squashWhitespace(name).toLowerCase().includes(squashedWanted);
  }
  function narrowByName(candidates, wanted, nameOf) {
    const exact = candidates.filter((el) => nameOf(el) === wanted);
    if (exact.length > 0) return exact;
    const normWanted = normalizeWhitespace(wanted).toLowerCase();
    const squashedWanted = squashWhitespace(wanted).toLowerCase();
    const normalized = candidates.filter((el) => {
      const name = nameOf(el);
      return normalizeWhitespace(name).toLowerCase() === normWanted || squashedWanted !== "" && squashWhitespace(name).toLowerCase() === squashedWanted;
    });
    if (normalized.length > 0) return normalized;
    return candidates.filter((el) => looselyNamed(nameOf(el), wanted));
  }
  function describeCandidate(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const role = effectiveRole(el);
    const name = accessibleName(el);
    const text = normalizeWhitespace(getVisibleText(el) ?? "").slice(0, 40);
    return `[${refFor(el)}] <${tag}${id}>` + (role ? ` role=${role}` : "") + (name ? ` name=${JSON.stringify(name.slice(0, 40))}` : "") + (text && text !== name ? ` text=${JSON.stringify(text)}` : "") + (isVisible(el) ? "" : " (no layout box)");
  }
  function uniqueOrAmbiguous(matches, what) {
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    throw new Error(
      `${what} matches ${matches.length} elements, so it does not identify one. Nothing on the page was clicked or changed. Pick one by ref:
` + matches.slice(0, 8).map((el) => `  ${describeCandidate(el)}`).join("\n") + (matches.length > 8 ? `
  ...and ${matches.length - 8} more` : "")
    );
  }
  function textMatches(scope, text, tag) {
    const tagScope = tag ?? "*";
    const wanted = text.trim();
    const squashed = wanted.replace(/\s+/g, "");
    const candidates = queryAllDeep(scope.doc, tagScope).filter((el) => {
      if (!isLocatorTarget(el)) return false;
      const own = normalizedText(el);
      return own.includes(wanted) || squashed !== "" && own.replace(/\s+/g, "").includes(squashed);
    });
    const laidOut = candidates.filter(hasBox);
    const matches = laidOut.length > 0 ? laidOut : candidates;
    if (matches.length === 0) return [];
    let deepest = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
    const exact = deepest.filter(
      (el) => normalizedText(el) === wanted || normalizedText(el).replace(/\s+/g, "") === squashed
    );
    if (exact.length > 0) deepest = exact;
    const clickable = deepest.filter(isClickable);
    if (clickable.length > 0) deepest = clickable;
    return deepest;
  }
  function matchElements(scope, locator) {
    if (locator.ref) {
      const el = resolveRef(locator.ref, scope);
      const what = `Ref ${JSON.stringify(locator.ref)}`;
      if (el) return { elements: [el], what, strategy: "ref" };
      const err = new Error(
        `Ref "${locator.ref}" no longer exists on this page (the element was removed or replaced). Take a fresh snapshot and use a ref from it.`
      );
      err.name = "StaleRefError";
      throw err;
    }
    if (locator.css) {
      return {
        elements: queryAllDeep(scope.doc, locator.css).filter(isLocatorTarget),
        what: `CSS selector ${JSON.stringify(locator.css)}`,
        strategy: "css"
      };
    }
    if (locator.text) {
      return {
        elements: textMatches(scope, locator.text, locator.tag),
        what: `Text ${JSON.stringify(locator.text)}`,
        strategy: "text"
      };
    }
    if (locator.role) {
      const byRole = elementsWithRole(scope, locator.role).filter(isLocatorTarget);
      return {
        elements: locator.name ? narrowByName(byRole, locator.name, accessibleName) : byRole,
        what: locator.name ? `role ${JSON.stringify(locator.role)} named ${JSON.stringify(locator.name)}` : `role ${JSON.stringify(locator.role)}`,
        strategy: "role"
      };
    }
    if (locator.testId) {
      return {
        elements: queryAllDeep(scope.doc, `[data-testid="${escapeCSS(locator.testId)}"]`).filter(isLocatorTarget),
        what: `testId ${JSON.stringify(locator.testId)}`,
        strategy: "testId"
      };
    }
    if (locator.xpath) {
      const result = scope.doc.evaluate(locator.xpath, scope.doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const el = result.singleNodeValue;
      return {
        elements: el ? [el] : [],
        what: `XPath ${JSON.stringify(locator.xpath)}`,
        strategy: "xpath"
      };
    }
    throw new Error(`Invalid locator: ${JSON.stringify(locator)}`);
  }
  function findElement(scope, locator) {
    const { elements, what, strategy } = matchElements(scope, locator);
    if (elements.length <= 1) return elements[0] ?? null;
    if (strategy === "text") {
      throw new Error(
        `Text "${locator.text}" matches ${elements.length} different elements, so it does not identify one. Pick one by ref:
${elements.slice(0, 8).map((el) => `  ${describeElement(el)}`).join("\n")}` + (elements.length > 8 ? `
  ...and ${elements.length - 8} more` : "")
      );
    }
    return uniqueOrAmbiguous(elements, what);
  }
  function nearbyCandidates(scope, locator, cap = 5) {
    if (locator.role) {
      return elementsWithRole(scope, locator.role).filter(isLocatorTarget).slice(0, cap);
    }
    const wanted = normalizeWhitespace(locator.text ?? locator.name ?? "");
    if (!wanted) return [];
    const needle = wanted.length > 2 ? wanted.slice(0, Math.ceil(wanted.length / 2)) : wanted;
    return queryAllDeep(scope.doc, "a, button, input, textarea, select, summary, [role], [onclick], [tabindex]").filter(isLocatorTarget).filter((el) => looselyNamed(`${accessibleName(el)} ${normalizeWhitespace(el.textContent ?? "")}`, needle)).slice(0, cap);
  }
  function findElementOrThrow(scope, locator) {
    const el = findElement(scope, locator);
    if (el) return el;
    const near = nearbyCandidates(scope, locator);
    const sealed = near.length === 0 ? closedShadowHostCount(scope) : 0;
    throw new Error(
      `Element not found: ${JSON.stringify(locator)}${whereClause(scope)}.` + (near.length > 0 ? ` The closest things on the page right now:
${near.map((c) => `  ${describeCandidate(c)}`).join("\n")}
Pick one by ref, or call find to search by text.` : ` Call find to search the page by text/role, or snapshot to list what is there.`) + framesNote(scope) + (sealed > 0 ? closedShadowNote(sealed) : "")
    );
  }
  function whereClause(scope) {
    return scope.frameId === MAIN_FRAME_REF ? "" : ` in embedded region ${scope.frameId}`;
  }
  function framesNote(scope) {
    if (!LOCAL_FRAME_WALK || scope.frameId !== hostFrameId) return "";
    const others = enumerateFrames().filter((f) => f.frameId !== scope.frameId);
    if (others.length === 0) return "";
    const listed = others.slice(0, 5).map(
      (f) => `${f.frameId} (${f.origin ?? "not a web page"}${f.accessible ? "" : ", not reachable from here"})`
    );
    return ` This page also has ${others.length} embedded region${others.length === 1 ? "" : "s"}: ${listed.join(", ")}${others.length > 5 ? ", \u2026" : ""}. A search only covers one document \u2014 pass \`frameId\` to look inside one of these.`;
  }
  var FIND_DEFAULT_LIMIT = 20;
  var FIND_MAX_LIMIT = 50;
  var MAX_FIND_CHARS = 16e3;
  var FIND_MAX_NAME_CHARS = 120;
  var FIND_MAX_TEXT_CHARS = 80;
  var FIND_MAX_ID_CHARS = 100;
  function capField(value, max) {
    return value.length > max ? `${value.slice(0, max)}\u2026` : value;
  }
  var FIND_QUERY_KEYS = ["role", "name", "text", "css", "testId", "label", "placeholder"];
  function findElements(scope, rawQuery, rawLimit) {
    const query = rawQuery ?? {};
    if (typeof query !== "object" || Array.isArray(query)) {
      throw new Error(`find: query must be an object with at least one of: ${FIND_QUERY_KEYS.join(", ")}`);
    }
    const used = FIND_QUERY_KEYS.filter((key) => {
      const value = query[key];
      return typeof value === "string" && value !== "";
    });
    if (used.length === 0) {
      throw new Error(`find: query must contain at least one of: ${FIND_QUERY_KEYS.join(", ")}`);
    }
    const limit = Math.max(1, Math.min(FIND_MAX_LIMIT, Math.trunc(Number(rawLimit) || FIND_DEFAULT_LIMIT)));
    let candidates;
    if (query.css) {
      candidates = queryAllDeep(scope.doc, query.css);
    } else if (query.testId) {
      candidates = queryAllDeep(scope.doc, `[data-testid="${escapeCSS(query.testId)}"]`);
    } else if (query.role) {
      candidates = elementsWithRole(scope, query.role);
    } else {
      candidates = queryAllDeep(scope.doc, "*");
    }
    candidates = candidates.filter(
      (el) => !NEVER_A_TARGET.has(el.tagName.toLowerCase()) && !isAbuOverlay(el)
    );
    if (query.role && (query.css || query.testId)) {
      const wantedRole = query.role.trim().toLowerCase();
      candidates = candidates.filter((el) => effectiveRole(el) === wantedRole);
    }
    if (query.testId && query.css) {
      candidates = candidates.filter((el) => el.getAttribute("data-testid") === query.testId);
    }
    if (query.name) {
      candidates = candidates.filter((el) => looselyNamed(accessibleName(el), query.name));
    }
    if (query.label) {
      candidates = candidates.filter((el) => looselyNamed(nativeLabelText(el), query.label));
    }
    if (query.placeholder) {
      candidates = candidates.filter(
        (el) => looselyNamed(el.getAttribute("placeholder") ?? "", query.placeholder)
      );
    }
    if (query.text) {
      candidates = candidates.filter(
        (el) => looselyNamed(normalizeWhitespace(el.textContent ?? ""), query.text)
      );
    }
    candidates = candidates.filter(isLocatorVisible);
    if (query.name) candidates = narrowByName(candidates, query.name, accessibleName);
    if (query.label) candidates = narrowByName(candidates, query.label, nativeLabelText);
    if (query.placeholder) {
      candidates = narrowByName(candidates, query.placeholder, (el) => el.getAttribute("placeholder") ?? "");
    }
    if (query.text) {
      candidates = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
    }
    const total = candidates.length;
    const matches = candidates.slice(0, limit).map((el) => {
      const rect = el.getBoundingClientRect();
      const role = effectiveRole(el);
      const name = accessibleName(el);
      const rawText = normalizeWhitespace(el.textContent ?? "");
      const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
      return {
        ref: refFor(el),
        tag: el.tagName.toLowerCase(),
        ...el.id ? { id: capField(el.id, FIND_MAX_ID_CHARS) } : {},
        ...role ? { role } : {},
        ...name ? { accessibleName: capField(name, FIND_MAX_NAME_CHARS) } : {},
        ...rawText && rawText !== name ? { text: capField(rawText, FIND_MAX_TEXT_CHARS) } : {},
        // `false` means "on the page but with no layout box" — a collapsed antd
        // combobox input, say. It is still addressable; it just is not what the
        // user is looking at. Genuinely hidden elements never reach this list.
        visible: isVisible(el),
        interactive: isClickable(el),
        ...disabled ? { disabled: true } : {},
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    });
    const describeQuery = used.map((key) => `${key}=${JSON.stringify(query[key])}`).join(" ");
    const sealed = total === 0 ? closedShadowHostCount(scope) : 0;
    const build = (kept) => ({
      url: scope.doc.location.href,
      title: scope.doc.title,
      frameId: scope.frameId,
      matches: kept,
      total,
      ...sealed > 0 ? { closedShadowHosts: sealed } : {},
      ...total === 0 ? {
        message: `Nothing${whereClause(scope) || " on this page"} matches ${describeQuery}. Hidden elements are excluded. Try one key instead of several, or a shorter \`text\`; snapshot lists everything interactive.` + framesNote(scope) + (sealed > 0 ? closedShadowNote(sealed) : "")
      } : {},
      ...total > kept.length ? {
        truncated: true,
        message: `Showing ${kept.length} of ${total} matches. Narrow the query (add \`role\`, or a longer \`text\`/\`name\`) rather than raising \`limit\` \u2014 a locator that matches ${total} elements will be refused as ambiguous by click/fill/select.`
      } : {}
    });
    const fits = (count) => JSON.stringify(build(matches.slice(0, count)), null, 2).length <= MAX_FIND_CHARS;
    if (matches.length > 0 && !fits(matches.length)) {
      let low = 1;
      let high = matches.length;
      let kept = 1;
      while (low <= high) {
        const mid = low + high >> 1;
        if (fits(mid)) {
          kept = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      matches.length = kept;
    }
    return build(matches);
  }
  function locateOnly(scope, locator) {
    try {
      return { matched: matchElements(scope, locator).elements.length };
    } catch (err) {
      if (err instanceof Error && / matches \d+ /.test(err.message)) return { matched: 2 };
      return { matched: 0 };
    }
  }
  function targetInfo(el) {
    const text = getVisibleText(el)?.replace(/\s+/g, " ").trim().slice(0, 50);
    return {
      ref: refFor(el),
      tag: el.tagName.toLowerCase(),
      ...el.id ? { id: el.id } : {},
      ...el.getAttribute("role") ? { role: el.getAttribute("role") } : {},
      ...text ? { text } : {}
    };
  }
  function dispatchClickSequence(el) {
    const opts = { bubbles: true, cancelable: true, composed: true };
    if (typeof PointerEvent === "function") {
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
    }
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    if (typeof PointerEvent === "function") {
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    }
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
  }
  function clickElement(scope, locator) {
    const el = findElementOrThrow(scope, locator);
    const target = targetInfo(el);
    el.scrollIntoView({ behavior: "instant", block: "center" });
    highlightElement(el);
    showStatus(`Click: ${target.text ?? "element"}`, "info");
    dispatchClickSequence(el);
    return {
      success: true,
      // Naming the element that was actually hit — not just the text that was
      // asked for — is what lets a caller notice it landed on the wrong thing.
      message: `Clicked ${describeElement(el)}`,
      elementText: target.text,
      target
    };
  }
  function fillElement(scope, locator, value) {
    const el = findElementOrThrow(scope, locator);
    const previousValue = reportableValue(el, el.value, 100);
    highlightElement(el);
    showStatus(`Fill: ${fieldLabel(el)}`, "info");
    const nativeSetter = Object.getOwnPropertyDescriptor(
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value"
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return {
      success: true,
      message: `Filled field with "${value.slice(0, 50)}"`,
      previousValue
    };
  }
  var DROPDOWN_OPEN_TIMEOUT_MS = 1500;
  function isRendered(el) {
    if (!el.isConnected) return false;
    const target = el;
    if (typeof target.checkVisibility === "function") {
      return target.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
    }
    for (let node = el; node; node = node.parentElement) {
      const style = styleOf(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }
  function isSnapshotVisible(el) {
    if (isVisible(el)) return true;
    const tag = el.tagName.toLowerCase();
    const isFormControl = ["input", "textarea", "select", "button"].includes(tag) || el.contentEditable === "true";
    if (!isFormControl) return false;
    if (!isRendered(el)) return false;
    let depth = 0;
    for (let node = el.parentElement; node && depth < 4; node = node.parentElement, depth++) {
      if (hasBox(node)) return true;
    }
    return false;
  }
  function hasBox(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function optionLabelOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  function clickTargetForOption(ariaOption, popup) {
    if (hasBox(ariaOption)) return ariaOption;
    const label = optionLabelOf(ariaOption);
    if (!label) return null;
    const rendered = [...popup.querySelectorAll("*")].filter(
      (el) => hasBox(el) && (el.textContent ?? "").replace(/\s+/g, " ").trim() === label
    );
    const deepest = rendered.filter((el) => !rendered.some((other) => other !== el && el.contains(other)));
    return deepest[0] ?? null;
  }
  function popupRootFor(container) {
    let node = container;
    const body = container.ownerDocument?.body ?? null;
    while (node && node !== body) {
      if (hasBox(node)) return node;
      node = node.parentElement;
    }
    return container;
  }
  function optionsFor(trigger) {
    const owned = (trigger.getAttribute("aria-controls") ?? trigger.getAttribute("aria-owns") ?? "").split(/\s+/).filter(Boolean).map((id) => trigger.getRootNode().getElementById(id)).filter((el) => el !== null);
    if (owned.length > 0) {
      return owned.flatMap((c) => [...c.querySelectorAll('[role="option"], [role="menuitem"]')]).filter(isRendered);
    }
    const ownerDoc = trigger.ownerDocument;
    const containers = queryAllDeep(ownerDoc, '[role="listbox"], [role="menu"]').filter(isVisible);
    const fromContainers = containers.flatMap((c) => [...c.querySelectorAll('[role="option"], [role="menuitem"]')]);
    const options = fromContainers.length > 0 ? fromContainers : queryAllDeep(ownerDoc, '[role="option"], [role="menuitem"]');
    return options.filter(isVisible);
  }
  function scrollerWithin(popup) {
    const scrolls = (el) => el.scrollHeight > el.clientHeight + 1;
    if (scrolls(popup)) return popup;
    for (const node of popup.querySelectorAll("*")) {
      if (scrolls(node)) return node;
    }
    return null;
  }
  function normalizedText(el) {
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  function renderedRowFor(popup, label) {
    const matches = [...popup.querySelectorAll("*")].filter(
      (el) => hasBox(el) && normalizedText(el) === label
    );
    const deepest = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
    return deepest[0] ?? null;
  }
  function renderedRowLabels(popup) {
    const labels = [];
    for (const el of popup.querySelectorAll("*")) {
      if (!hasBox(el)) continue;
      if ([...el.children].some((child) => hasBox(child))) continue;
      const text = normalizedText(el);
      if (text && text.length <= 80) labels.push(text);
    }
    return labels;
  }
  async function findOption(trigger, value) {
    const wanted = value.trim();
    const squashed = wanted.replace(/\s+/g, "");
    const seen = /* @__PURE__ */ new Set();
    const attempt = () => {
      const ariaOptions2 = optionsFor(trigger);
      if (ariaOptions2.length === 0) return null;
      const popup2 = popupRootFor(ariaOptions2[0].parentElement ?? ariaOptions2[0]);
      const labelled = ariaOptions2.map((el) => ({ el, label: optionLabelOf(el) }));
      labelled.forEach(({ label }) => label && seen.add(label));
      renderedRowLabels(popup2).forEach((label) => seen.add(label));
      const hit = labelled.find(({ label }) => label === wanted) ?? labelled.find(({ label }) => label.replace(/\s+/g, "") === squashed) ?? labelled.find(({ label }) => label.includes(wanted));
      if (hit) {
        const target = clickTargetForOption(hit.el, popup2);
        if (target) return { option: target, label: hit.label };
      }
      const rendered = renderedRowFor(popup2, wanted) ?? renderedRowFor(popup2, [...seen].find((label) => label.replace(/\s+/g, "") === squashed) ?? wanted);
      if (rendered) return { option: rendered, label: normalizedText(rendered) };
      return null;
    };
    const deadline = Date.now() + DROPDOWN_OPEN_TIMEOUT_MS;
    for (; ; ) {
      const hit = attempt();
      if (hit) return { ...hit, seen: [...seen] };
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const ariaOptions = optionsFor(trigger);
    const popup = ariaOptions.length > 0 ? popupRootFor(ariaOptions[0].parentElement ?? ariaOptions[0]) : null;
    const scroller = popup ? scrollerWithin(popup) : null;
    if (!scroller) return { option: null, label: "", seen: [...seen] };
    let previousTop = -1;
    for (let guard = 0; guard < 40 && scroller.scrollTop !== previousTop; guard++) {
      previousTop = scroller.scrollTop;
      scroller.scrollTop += Math.max(1, scroller.clientHeight - 8);
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
      const hit = attempt();
      if (hit) return { ...hit, seen: [...seen] };
    }
    return { option: null, label: "", seen: [...seen] };
  }
  async function selectOption(scope, locator, value) {
    const el = findElementOrThrow(scope, locator);
    if (el.tagName.toLowerCase() === "select") {
      const select = el;
      const options = [...select.options];
      const match = options.find((o) => o.value === value || o.text === value);
      if (!match) {
        throw new Error(
          `Option "${value}" not found. Available options: ${options.map((o) => `"${o.text}"`).join(", ") || "(none)"}`
        );
      }
      select.value = match.value;
      select.focus();
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { success: true, message: `Selected option: "${match.text}"`, target: targetInfo(select) };
    }
    const role = el.getAttribute("role");
    const isCustomDropdown = role === "combobox" || role === "listbox" || el.getAttribute("aria-haspopup") === "listbox" || optionsFor(el).length > 0;
    if (!isCustomDropdown) {
      throw new Error(
        `${describeElement(el)} is not a dropdown: it is not a <select>, has no combobox/listbox role, and owns no options. If this is a text field use fill; if the control opens a menu, click it and take a snapshot to see what appeared.`
      );
    }
    showStatus(`Select: ${fieldLabel(el)}`, "info");
    el.scrollIntoView({ behavior: "instant", block: "center" });
    if (el.getAttribute("aria-expanded") !== "true" && optionsFor(el).length === 0) {
      dispatchClickSequence(el);
    }
    const { option: chosen, label: chosenLabel, seen } = await findOption(el, value);
    if (seen.length === 0) {
      throw new Error(
        `Opened ${describeElement(el)} but no options appeared within ${DROPDOWN_OPEN_TIMEOUT_MS}ms. Take a snapshot to see the current state of the page.`
      );
    }
    if (!chosen) {
      const wasListed = seen.some(
        (label) => label === value.trim() || label.replace(/\s+/g, "") === value.trim().replace(/\s+/g, "")
      );
      throw new Error(
        wasListed ? `Option "${value}" is in ${describeElement(el)} but the dropdown never finished opening, so there was nothing to click. Take a snapshot to see the page's current state, then retry select.` : `Option "${value}" not found in ${describeElement(el)}. Options available: ${seen.map((label) => `"${label}"`).join(", ")}`
      );
    }
    highlightElement(chosen);
    chosen.scrollIntoView({ behavior: "instant", block: "nearest" });
    dispatchClickSequence(chosen);
    return {
      success: true,
      message: `Selected "${chosenLabel}" in ${describeElement(el)}`,
      target: targetInfo(chosen)
    };
  }
  async function waitFor(scope, condition, timeout = 3e4) {
    const start = Date.now();
    const condType = condition.type;
    const describeCurrentState = () => {
      if (condType === "urlContains") return `current url is ${scope.doc.location.href}`;
      let found;
      try {
        found = matchElements(scope, condition.locator);
      } catch (err) {
        if (err instanceof Error && err.name === "StaleRefError") {
          return "the locator no longer resolves (its ref is stale) \u2014 take a fresh snapshot";
        }
        return `the locator could not be evaluated: ${err instanceof Error ? err.message : String(err)}`;
      }
      const { elements } = found;
      if (elements.length === 0) return "no element matches that locator";
      if (elements.length > 1) {
        return `the locator matches ${elements.length} elements, none of which satisfy "${condType}":
` + elements.slice(0, 5).map((el2) => `  ${describeCandidate(el2)}`).join("\n") + (elements.length > 5 ? `
  ...and ${elements.length - 5} more` : "");
      }
      const el = elements[0];
      if (!isVisible(el)) return `matched <${el.tagName.toLowerCase()}> but it has no layout box (hidden or zero-sized)`;
      if (condType === "enabled" && el.disabled) {
        return `matched <${el.tagName.toLowerCase()}> but it is still disabled`;
      }
      if (condType === "textContains") {
        return `matched <${el.tagName.toLowerCase()}> whose text is ${JSON.stringify((getVisibleText(el) ?? "").slice(0, 80))}`;
      }
      return `matched <${el.tagName.toLowerCase()}>, which does not satisfy "${condType}"`;
    };
    const matched = () => matchElements(scope, condition.locator).elements;
    const check = () => {
      switch (condType) {
        case "appear": {
          return matched().some(isVisible);
        }
        case "disappear": {
          let elements;
          try {
            elements = matched();
          } catch (err) {
            if (err instanceof Error && err.name === "StaleRefError") return true;
            throw err;
          }
          return elements.every((el) => !isVisible(el));
        }
        case "enabled": {
          return matched().some((el) => isVisible(el) && !el.disabled);
        }
        case "textContains": {
          const wanted = condition.text;
          return matched().some((el) => (getVisibleText(el) ?? "").includes(wanted));
        }
        case "urlContains": {
          return scope.doc.location.href.includes(condition.pattern);
        }
        default:
          throw new Error(`Unknown wait condition: ${condType}`);
      }
    };
    const staleRefMessage = (err) => err instanceof Error && err.name === "StaleRefError" ? err.message : null;
    const frameGone = () => scope.doc.defaultView === null;
    try {
      if (check()) {
        return { success: true, message: `Condition met immediately`, timedOut: false, elapsed: 0 };
      }
    } catch (err) {
      const stale = staleRefMessage(err);
      if (stale === null) throw err;
      return { success: false, message: stale, timedOut: false, elapsed: Date.now() - start };
    }
    return new Promise((resolve) => {
      let resolved = false;
      let checkScheduled = false;
      const complete = (timedOut, failure) => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        const elapsed = Date.now() - start;
        resolve({
          success: !timedOut && failure === void 0,
          message: failure ?? (timedOut ? `Timed out after ${timeout}ms waiting for "${condType}" \u2014 ${describeCurrentState()}.` : `Condition met after ${elapsed}ms`),
          timedOut,
          elapsed,
          ...timedOut ? { observed: describeCurrentState() } : {}
        });
      };
      const tryCheck = () => {
        if (resolved) return;
        if (frameGone()) {
          complete(false, frameGoneMessage(scope.frameId));
          return;
        }
        try {
          if (check()) complete(false);
        } catch (err) {
          const stale = staleRefMessage(err);
          if (stale !== null) {
            complete(false, stale);
            return;
          }
        }
      };
      const observer = new MutationObserver(() => {
        if (!checkScheduled && !resolved) {
          checkScheduled = true;
          (scope.doc.defaultView ?? window).requestAnimationFrame(() => {
            checkScheduled = false;
            tryCheck();
          });
        }
      });
      const observed = scope.doc.body ?? scope.doc.documentElement;
      if (observed) {
        observer.observe(observed, {
          childList: true,
          subtree: true,
          attributes: true
        });
      }
      const pollTimer = setInterval(tryCheck, 500);
      const timeoutTimer = setTimeout(() => complete(true), timeout);
    });
  }
  function sameOriginFrameHtml(frame) {
    try {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) {
        return '<abu-frame-unavailable data-reason="empty"></abu-frame-unavailable>';
      }
      return serializeElementWithFrames(doc.documentElement);
    } catch {
      return '<abu-frame-unavailable data-reason="cross-origin"></abu-frame-unavailable>';
    }
  }
  function inlineFrameElement(frame, ownerDocument) {
    const inline = ownerDocument.createElement("abu-inline-frame");
    inline.setAttribute("data-src", frame.getAttribute("src") ?? "");
    inline.setAttribute("data-title", frame.getAttribute("title") ?? "");
    inline.innerHTML = sameOriginFrameHtml(frame);
    return inline;
  }
  function redactSensitiveValueAttributes(root) {
    const candidates = root.tagName === "INPUT" || root.tagName === "TEXTAREA" || root.tagName === "SELECT" ? [root, ...root.querySelectorAll("input, textarea, select")] : [...root.querySelectorAll("input, textarea, select")];
    for (const el of candidates) {
      if (!hasSensitiveValue(el)) continue;
      if (el.tagName === "TEXTAREA" && el.textContent) {
        el.textContent = REDACTED_VALUE;
      }
      if (!el.getAttribute("value")) continue;
      el.setAttribute("value", REDACTED_VALUE);
    }
  }
  function sensitiveValuesIn(scope) {
    const root = scope ?? document.body;
    if (!root) return [];
    const fields = [
      ...root.matches?.("input, textarea, select") ? [root] : [],
      ...root.querySelectorAll("input, textarea, select")
    ];
    const values = [];
    for (const el of fields) {
      if (!hasSensitiveValue(el)) continue;
      const value = el.value || el.textContent || "";
      if (value.length > 2) values.push(value);
    }
    return values;
  }
  function serializeElementWithFrames(element) {
    if (element.tagName === "IFRAME") {
      return inlineFrameElement(element, element.ownerDocument).outerHTML;
    }
    const clone = element.cloneNode(true);
    redactSensitiveValueAttributes(clone);
    const liveFrames = [...element.querySelectorAll("iframe")];
    const clonedFrames = [...clone.querySelectorAll("iframe")];
    for (let i = 0; i < liveFrames.length; i += 1) {
      const live = liveFrames[i];
      const cloned = clonedFrames[i];
      if (!cloned?.parentNode) continue;
      const inline = inlineFrameElement(live, clone.ownerDocument);
      cloned.parentNode.replaceChild(inline, cloned);
    }
    return clone.outerHTML;
  }
  function getHtml(selector) {
    const root = selector ? document.querySelector(selector) : document.documentElement;
    if (!root) {
      throw new Error(
        `Scope element not found: ${selector}. Run query_js without a selector or take a snapshot to see what the page actually contains.`
      );
    }
    return serializeElementWithFrames(root);
  }
  function extractText(scope, selector) {
    let text;
    let region;
    if (selector) {
      const el = queryAllDeep(scope.doc, selector)[0] ?? null;
      if (!el) throw new Error(`Element not found: ${selector}${whereClause(scope)}`);
      region = el;
      text = el.innerText ?? el.textContent ?? "";
    } else {
      region = scope.doc.body;
      text = scope.doc.body?.innerText ?? "";
    }
    for (const secret of sensitiveValuesIn(region)) {
      text = text.split(secret).join(REDACTED_VALUE);
    }
    if (text.length > MAX_EXTRACT_TEXT_SIZE) {
      return text.slice(0, MAX_EXTRACT_TEXT_SIZE) + `

[Truncated: ${text.length} chars total, showing first ${MAX_EXTRACT_TEXT_SIZE}]`;
    }
    return text;
  }
  function extractTable(scope, selector) {
    let table;
    if (selector) {
      table = queryAllDeep(scope.doc, selector)[0] ?? null;
    } else {
      const tables = queryAllDeep(scope.doc, "table");
      table = tables.sort((a, b) => b.rows.length - a.rows.length)[0] ?? null;
    }
    if (!table) throw new Error("No table found on the page");
    const headers = [...table.querySelectorAll("thead th, thead td")].map((th) => th.innerText?.trim() ?? "");
    if (headers.length === 0) {
      const firstRow = table.rows[0];
      if (firstRow) {
        for (const cell of firstRow.cells) {
          headers.push(cell.innerText?.trim() ?? "");
        }
      }
    }
    const rows = [];
    const bodyRows = table.querySelectorAll("tbody tr");
    const rowElements = bodyRows.length > 0 ? bodyRows : table.rows;
    for (const tr of rowElements) {
      const row = [...tr.cells].map((td) => td.innerText?.trim() ?? "");
      if (headers.length > 0 && row.join("") === headers.join("")) continue;
      rows.push(row);
    }
    const secrets = sensitiveValuesIn(table);
    const scrub = (cell) => secrets.reduce((text, secret) => text.split(secret).join(REDACTED_VALUE), cell);
    return {
      headers: headers.map(scrub),
      rows: rows.map((row) => row.map(scrub)),
      rowCount: rows.length
    };
  }
  function scrollPage(payload) {
    const direction = payload.direction;
    const amount = payload.amount ?? 500;
    const selector = payload.selector;
    const target = selector ? document.querySelector(selector) : window;
    if (selector && !target) throw new Error(`Scroll target not found: ${selector}`);
    const scrollOptions = {};
    switch (direction) {
      case "down":
        scrollOptions.top = amount;
        break;
      case "up":
        scrollOptions.top = -amount;
        break;
      case "right":
        scrollOptions.left = amount;
        break;
      case "left":
        scrollOptions.left = -amount;
        break;
    }
    if (target === window) {
      window.scrollBy({ ...scrollOptions, behavior: "smooth" });
    } else {
      target.scrollBy({ ...scrollOptions, behavior: "smooth" });
    }
    return { success: true, message: `Scrolled ${direction} by ${amount}px` };
  }
  function sendKeyboard(payload) {
    const key = payload.key;
    const modifiers = payload.modifiers ?? [];
    const eventInit = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      ctrlKey: modifiers.includes("ctrl"),
      shiftKey: modifiers.includes("shift"),
      altKey: modifiers.includes("alt"),
      metaKey: modifiers.includes("meta")
    };
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    if (key.length === 1 && !modifiers.includes("ctrl") && !modifiers.includes("meta")) {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.dispatchEvent(new InputEvent("beforeinput", {
          data: key,
          inputType: "insertText",
          bubbles: true,
          cancelable: true
        }));
        target.dispatchEvent(new InputEvent("input", {
          data: key,
          inputType: "insertText",
          bubbles: true
        }));
      }
    }
    return { success: true, message: `Key press: ${modifiers.length > 0 ? modifiers.join("+") + "+" : ""}${key}` };
  }
  var recording = false;
  var recordedSteps = [];
  var recordClickHandler = null;
  var recordInputHandler = null;
  function getBestSelector(el) {
    if (el.id) return { css: `#${CSS.escape(el.id)}` };
    const testId = el.getAttribute("data-testid");
    if (testId) return { css: `[data-testid="${CSS.escape(testId)}"]` };
    const label = el.getAttribute("aria-label");
    if (label) return { text: label };
    const tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "a") {
      const text = el.innerText?.trim();
      if (text && text.length < 50) return { text };
    }
    const path = [];
    let current = el;
    for (let i = 0; i < 3 && current && current !== document.body; i++) {
      let seg = current.tagName.toLowerCase();
      if (current.className && typeof current.className === "string") {
        const cls = current.className.trim().split(/\s+/).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join("");
        seg += cls;
      }
      path.unshift(seg);
      current = current.parentElement;
    }
    return { css: path.join(" > ") };
  }
  function startRecording() {
    if (recording) return { success: false, message: "Already recording" };
    recording = true;
    recordedSteps.length = 0;
    recordClickHandler = (e) => {
      const el = e.target;
      if (!el || isAbuOverlay(el)) return;
      recordedSteps.push({
        action: "click",
        locator: getBestSelector(el),
        timestamp: Date.now()
      });
    };
    recordInputHandler = (e) => {
      const el = e.target;
      if (!el) return;
      const tag = el.tagName.toLowerCase();
      if (tag === "select") {
        recordedSteps.push({
          action: "select",
          locator: getBestSelector(el),
          value: el.value,
          timestamp: Date.now()
        });
      } else if (tag === "input" || tag === "textarea") {
        const last = recordedSteps[recordedSteps.length - 1];
        const loc = getBestSelector(el);
        if (last && last.action === "fill" && JSON.stringify(last.locator) === JSON.stringify(loc)) {
          last.value = el.value;
          last.timestamp = Date.now();
        } else {
          recordedSteps.push({
            action: "fill",
            locator: loc,
            value: el.value,
            timestamp: Date.now()
          });
        }
      }
    };
    document.addEventListener("click", recordClickHandler, true);
    document.addEventListener("change", recordInputHandler, true);
    showStatus("Recording started...", "info");
    return { success: true, message: `Recording started. Interact with the page, then call stop_recording to get the steps.` };
  }
  function stopRecording() {
    if (!recording) return { success: false, steps: [], message: "Not recording" };
    recording = false;
    if (recordClickHandler) {
      document.removeEventListener("click", recordClickHandler, true);
      recordClickHandler = null;
    }
    if (recordInputHandler) {
      document.removeEventListener("change", recordInputHandler, true);
      recordInputHandler = null;
    }
    showStatus(`Recording stopped: ${recordedSteps.length} steps`, "success");
    return {
      success: true,
      steps: [...recordedSteps],
      message: `Recorded ${recordedSteps.length} steps. Use these as a template for automation.`
    };
  }
  var savedFixedElements = [];
  function fullpagePrepare() {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const scrollHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    savedFixedElements = [];
    const allElements = document.querySelectorAll("*");
    for (const el of allElements) {
      const htmlEl = el;
      const style = getComputedStyle(htmlEl);
      if (style.position === "fixed" || style.position === "sticky") {
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 10) continue;
        savedFixedElements.push([htmlEl, style.position, htmlEl.style.top]);
        htmlEl.style.setProperty("position", "absolute", "important");
      }
    }
    return { scrollHeight, viewportHeight, viewportWidth, scrollX, scrollY };
  }
  function fullpageScroll(scrollTop) {
    window.scrollTo({ top: scrollTop, left: 0, behavior: "instant" });
    return { success: true };
  }
  function fullpageRestore(scrollX, scrollY) {
    for (const [el, originalPosition, originalTop] of savedFixedElements) {
      el.style.position = originalPosition;
      el.style.top = originalTop;
    }
    savedFixedElements = [];
    window.scrollTo({ top: scrollY, left: scrollX, behavior: "instant" });
    return { success: true };
  }
  var highlightOverlays = /* @__PURE__ */ new WeakMap();
  function highlightElement(el) {
    const rect = el.getBoundingClientRect();
    const doc = el.ownerDocument ?? document;
    let highlightOverlay = highlightOverlays.get(doc) ?? null;
    if (!highlightOverlay || !highlightOverlay.isConnected) {
      highlightOverlay = doc.createElement("div");
      highlightOverlay.id = "abu-highlight";
      highlightOverlay.style.cssText = `
      position: fixed; pointer-events: none; z-index: 2147483647;
      border: 2px solid #d97757; border-radius: 4px;
      background: rgba(217, 119, 87, 0.12);
      transition: all 0.15s ease;
    `;
      doc.documentElement.appendChild(highlightOverlay);
      highlightOverlays.set(doc, highlightOverlay);
    }
    highlightOverlay.style.top = `${rect.top - 2}px`;
    highlightOverlay.style.left = `${rect.left - 2}px`;
    highlightOverlay.style.width = `${rect.width + 4}px`;
    highlightOverlay.style.height = `${rect.height + 4}px`;
    highlightOverlay.style.display = "block";
    highlightOverlay.style.opacity = "1";
    const ring = highlightOverlay;
    setTimeout(() => {
      ring.style.opacity = "0";
      setTimeout(() => {
        ring.style.display = "none";
      }, 300);
    }, 1500);
  }
  var statusBubble = null;
  var statusTimer = null;
  function showStatus(text, type = "info") {
    if (!statusBubble) {
      statusBubble = document.createElement("div");
      statusBubble.id = "abu-status";
      statusBubble.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;
      padding: 8px 14px; border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 12px; line-height: 1.4;
      box-shadow: 0 2px 12px rgba(0,0,0,0.3);
      pointer-events: none;
      transition: opacity 0.3s ease, transform 0.3s ease;
      transform: translateY(0);
    `;
      document.documentElement.appendChild(statusBubble);
    }
    const colors = {
      info: { bg: "#1a1a2e", border: "#d97757", text: "#e0e0e0" },
      success: { bg: "#0f2a1a", border: "#4ade80", text: "#4ade80" },
      error: { bg: "#2a0f0f", border: "#f87171", text: "#f87171" }
    };
    const c = colors[type];
    statusBubble.style.background = c.bg;
    statusBubble.style.border = `1px solid ${c.border}`;
    statusBubble.style.color = c.text;
    statusBubble.textContent = `Abu: ${text}`;
    statusBubble.style.opacity = "1";
    statusBubble.style.transform = "translateY(0)";
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (statusBubble) {
        statusBubble.style.opacity = "0";
        statusBubble.style.transform = "translateY(8px)";
      }
    }, 3e3);
  }
  function isVisible(el) {
    const htmlEl = el;
    const style = styleOf(el);
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (htmlEl.offsetParent === null && htmlEl.style?.position !== "fixed" && htmlEl.style?.position !== "sticky") {
      if (style.display === "none") return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function getVisibleText(el) {
    if (el.tagName === "INPUT") {
      const input = el;
      if (hasSensitiveValue(input)) {
        return input.placeholder || input.getAttribute("aria-label") || (input.value ? REDACTED_VALUE : null);
      }
      return input.value || input.placeholder || input.getAttribute("aria-label") || null;
    }
    if (el.tagName === "TEXTAREA") {
      const ta = el;
      if (hasSensitiveValue(ta)) {
        return ta.placeholder || ta.getAttribute("aria-label") || (ta.value ? REDACTED_VALUE : null);
      }
      return ta.value || ta.placeholder || null;
    }
    const text = el.innerText?.trim();
    return text || el.getAttribute("aria-label") || null;
  }
})();
//# sourceMappingURL=content.js.map
