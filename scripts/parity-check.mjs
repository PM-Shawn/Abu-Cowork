/**
 * Static Tauri↔Electron command-parity guard — plain Node ESM, no deps, run
 * via `npm run parity:check` (mirrors the style of `scripts/e2e-report.mjs`).
 *
 * WHY THIS EXISTS: the Electron shell's `tauriHost.cjs` degrades any command
 * it doesn't recognize into a benign stub (`defaultFor()`) so the frontend
 * never crashes on a not-yet-ported command — but that means a genuine parity
 * gap fails SILENTLY (a no-op that reads as success) instead of loudly. This
 * script encodes a manual audit (see below) as a repeatable, CI-gatable
 * check: it statically finds every Tauri command/plugin family the frontend
 * calls and verifies the Electron side has SOME handler for it, so a gap
 * can't hide behind the graceful stub.
 *
 * That manual audit found 2 real gaps, both PLUGIN families (not custom
 * commands): `plugin:shell|open` (frontend imports `open` from
 * `@tauri-apps/plugin-shell`) and `plugin:global-shortcut|*` (the
 * computer-use abort hotkey). Both are now fixed (see globalShortcutHost.cjs
 * + desktopHost.cjs), and Check B below re-derives that same finding — this
 * script is that audit, made durable.
 *
 * Three checks:
 *   A. Custom (non-plugin) commands: every literal `invoke('cmd', ...)` /
 *      `invoke<T>('cmd')` / ternary `invoke(cond ? 'a' : 'b')` string in
 *      src/**, must have its literal command string appear somewhere in
 *      electron/*.cjs (handlers key on the literal string via Sets/switch).
 *   B. Plugin families: every `@tauri-apps/plugin-<name>` the frontend
 *      actually imports must have its `plugin:<name>|` prefix appear
 *      somewhere in electron/*.cjs.
 *   C. `@tauri-apps/api/window`: every Window method / window function the
 *      frontend calls must have a `case` handler for each `plugin:window|*`
 *      command it invokes, and every `tauri://*` window event it listens for
 *      must be emitted by electron/*.cjs (see the Check C section).
 *
 * KNOWN_DEFERRED (deliberate, NOT gaps) must be kept in sync with the
 * matching list in electron/tauriHost.cjs's `KNOWN_DEFERRED`.
 *
 * Exit 0 iff no gaps found (all checks). Exit 1 otherwise (CI-gatable).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const srcDir = path.join(repoRoot, 'src');
const electronDir = path.join(repoRoot, 'electron');

// ---------------------------------------------------------------------------
// KNOWN_DEFERRED — deliberate, not gaps. Keep in sync with
// electron/tauriHost.cjs's own `KNOWN_DEFERRED` list.
// ---------------------------------------------------------------------------
const KNOWN_DEFERRED_CUSTOM = new Set([
  'start_feishu_ws',
  'stop_feishu_ws',
  'get_feishu_ws_status', // F15 — feishu/IM line, deferred
]);

// Plugin package-name (the `@tauri-apps/plugin-<name>` suffix) families that
// are deliberately deferred — checked by NOT reporting a gap even if their
// prefix is absent from the handlers.
const KNOWN_DEFERRED_PLUGIN_FAMILIES = new Set([
  // (empty — 'updater' graduated to electron/updaterHost.cjs in F-slice #2)
]);

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** Recursively collect files under `dir` whose name ends with one of `exts`. */
function walkFiles(dir, exts, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(p, exts, out);
    } else if (exts.some((e) => ent.name.endsWith(e))) {
      out.push(p);
    }
  }
  return out;
}

const srcTestDirPrefix = path.join(srcDir, 'test') + path.sep;

function isExcludedSrcFile(filePath) {
  const base = path.basename(filePath);
  if (base.includes('.test.')) return true;
  if (filePath.startsWith(srcTestDirPrefix)) return true;
  return false;
}

const srcFiles = walkFiles(srcDir, ['.ts', '.tsx']).filter((f) => !isExcludedSrcFile(f));

/** electron/*.cjs, non-recursive (spike/** and native-helper/ etc. naturally excluded). */
const electronHandlerFiles = fs
  .readdirSync(electronDir, { withFileTypes: true })
  .filter((ent) => ent.isFile() && ent.name.endsWith('.cjs') && !ent.name.includes('.test.'))
  .map((ent) => path.join(electronDir, ent.name));

const electronHandlerSource = electronHandlerFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

// ---------------------------------------------------------------------------
// Small balanced-bracket scanner (handles nested (), {}, [], <> and skips
// over string/template-literal contents) — used to correctly locate the
// FIRST ARGUMENT of an `invoke(...)` call without being confused by commas
// inside a following options object (`invoke('cmd', { a: 1, b: 2 })`) or by
// parens inside a generic type arg (`invoke<Record<string, string>>(...)`).
// ---------------------------------------------------------------------------

function skipStringLiteral(text, i) {
  const quote = text[i];
  i++;
  while (i < text.length && text[i] !== quote) {
    if (text[i] === '\\') i++;
    i++;
  }
  return i + 1; // past closing quote
}

/** text[i] must be `openCh`; returns the index just past the matching `closeCh`. */
function skipBalanced(text, i, openCh, closeCh) {
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Replace the body of every line comment and block comment with spaces
 * (newlines kept), so indices/line-numbers stay aligned with the original
 * source. Prevents plain-English prose like "Skill to invoke (optional)" in
 * a JSDoc comment from being misread as a call site by findCallOpenParens,
 * and keeps commented-out code from feeding false command hits.
 * String/template literal contents are left untouched (a `//` inside a URL
 * string must not be treated as a line-comment start).
 */
function blankComments(text) {
  const chars = text.split('');
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringLiteral(text, i);
      continue;
    }
    const two = ch + (text[i + 1] || '');
    if (two === '//') {
      while (i < text.length && text[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }
    if (two === '/*') {
      while (i < text.length && text.slice(i, i + 2) !== '*/') {
        if (text[i] !== '\n') chars[i] = ' ';
        i++;
      }
      if (i < text.length) {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    i++;
  }
  return chars.join('');
}

/**
 * Find every call site of an identifier in `names` (word-boundary, optional
 * `<...>` generic, then `(`) in `text`. Returns an array of open-paren
 * indices (index of the `(` itself).
 */
function findCallOpenParens(text, names) {
  const sites = [];
  for (const name of names) {
    let from = 0;
    for (;;) {
      const idx = text.indexOf(name, from);
      if (idx === -1) break;
      from = idx + name.length;
      const before = idx > 0 ? text[idx - 1] : '';
      if (/[A-Za-z0-9_$]/.test(before)) continue; // not a whole-word match
      let i = idx + name.length;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === '<') {
        i = skipBalanced(text, i, '<', '>');
        while (i < text.length && /\s/.test(text[i])) i++;
      }
      if (text[i] === '(') sites.push(i);
    }
  }
  return sites;
}

/**
 * Given `text` and the index of an `invoke(`-style call's opening paren,
 * return `{ firstArgText, isLiteralFirstArg }` — the source text of the
 * FIRST top-level argument (stopping at the first depth-1 comma, so a
 * following options object's contents are excluded), and whether it
 * contains at least one string/template literal ANYWHERE in that
 * expression — not just at its start, so the ternary form
 * `invoke(cond ? 'a' : 'b')` still counts (its first arg text starts with
 * `cond`, not a quote). A fully-dynamic `invoke(cmd)` — no quotes anywhere
 * in the first-arg expression — cannot be statically resolved and is
 * reported separately as a caveat.
 */
function extractFirstArg(text, openParenIdx) {
  let i = openParenIdx + 1;
  const start = i;
  let depth = 1;
  let firstArgEnd = -1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringLiteral(text, i);
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      i++;
      continue;
    }
    if (ch === ',' && depth === 1 && firstArgEnd === -1) firstArgEnd = i;
    i++;
  }
  const firstArgText = firstArgEnd === -1 ? text.slice(start, i - 1) : text.slice(start, firstArgEnd);
  const isLiteralFirstArg = /['"`]/.test(firstArgText);
  return { firstArgText, isLiteralFirstArg };
}

// ---------------------------------------------------------------------------
// Check A — custom (non-plugin) commands
// ---------------------------------------------------------------------------

// `invoke` is the real @tauri-apps/api/core call. `invokeInbox` is a thin
// local wrapper around it (src/core/notice/inbox.ts) that takes the command
// name as its first argument at each call site with a literal string, so its
// call sites are just as auditable — included explicitly (not a generic
// "any *Invoke* identifier" match, which would also catch this codebase's
// unrelated agent-tool-invocation-routing identifiers like `getToolInvoker`/
// `handleToolInvoke`/`routeToolInvoke` and produce noise).
const INVOKE_CALL_NAMES = ['invoke', 'invokeInbox'];

const CUSTOM_CMD_RE = /^[a-z][a-z0-9_]+$/;

/** cmd -> Set(relative file paths) */
const customCommandUses = new Map();
/** cmd (plugin:...) -> Set(relative file paths) — collected the same pass, used nowhere for Check A but harmless. */
const pluginCommandUses = new Map();
/** Dynamic (non-literal) invoke() call sites we could not resolve statically — reported as an honesty caveat. */
const dynamicInvokeSites = [];

for (const file of srcFiles) {
  const rel = path.relative(repoRoot, file);
  const raw = fs.readFileSync(file, 'utf8');
  // Scan the comment-blanked text (same length/newlines as `raw`, so line
  // numbers computed off it still match the real file) — keeps prose like
  // "Skill to invoke (optional)" in a JSDoc comment from being misread as a
  // call site.
  const content = blankComments(raw);
  const openParens = findCallOpenParens(content, INVOKE_CALL_NAMES);
  for (const openParenIdx of openParens) {
    const { firstArgText, isLiteralFirstArg } = extractFirstArg(content, openParenIdx);
    if (!isLiteralFirstArg) {
      const lineNo = content.slice(0, openParenIdx).split('\n').length;
      dynamicInvokeSites.push(`${rel}:${lineNo}`);
      continue;
    }
    const strRe = /['"]([a-zA-Z][a-zA-Z0-9_:.-]*)['"]/g;
    let sm;
    while ((sm = strRe.exec(firstArgText))) {
      const cmd = sm[1];
      const target = cmd.startsWith('plugin:') ? pluginCommandUses : customCommandUses;
      if (CUSTOM_CMD_RE.test(cmd) || cmd.startsWith('plugin:')) {
        if (!target.has(cmd)) target.set(cmd, new Set());
        target.get(cmd).add(rel);
      }
    }
  }
}

const customGaps = [];
const customSatisfied = [];
for (const [cmd, files] of [...customCommandUses].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (KNOWN_DEFERRED_CUSTOM.has(cmd)) continue; // deliberate, skip entirely
  const handled = electronHandlerSource.includes(cmd);
  if (handled) {
    customSatisfied.push(cmd);
  } else {
    customGaps.push({ cmd, files: [...files] });
  }
}

// ---------------------------------------------------------------------------
// Check B — plugin families actually imported by the frontend
// ---------------------------------------------------------------------------

// `@tauri-apps/plugin-<name>` package suffix -> the `plugin:<prefix>|`
// command prefix the Electron handlers must contain. Identity for every
// plugin in this codebase EXCEPT the ones explicitly called out below (kept
// as an explicit map, not an assumption, per the task brief).
function pluginPrefixFor(pkgName) {
  const overrides = {
    'clipboard-manager': 'plugin:clipboard-manager|',
    process: 'plugin:process|',
  };
  return overrides[pkgName] || `plugin:${pkgName}|`;
}

/** pkgName -> Set(relative file paths) */
const pluginPkgUses = new Map();
for (const file of srcFiles) {
  const rel = path.relative(repoRoot, file);
  const content = blankComments(fs.readFileSync(file, 'utf8'));
  const re = /(?:from\s+|import\s*\(\s*)['"]@tauri-apps\/plugin-([a-z-]+)['"]/g;
  let m;
  while ((m = re.exec(content))) {
    const pkg = m[1];
    if (!pluginPkgUses.has(pkg)) pluginPkgUses.set(pkg, new Set());
    pluginPkgUses.get(pkg).add(rel);
  }
}

const pluginGaps = [];
const pluginSatisfied = [];
for (const [pkg, files] of [...pluginPkgUses].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (KNOWN_DEFERRED_PLUGIN_FAMILIES.has(pkg)) continue; // deliberate, skip entirely

  let handled;
  if (pkg === 'os') {
    // os plugin is served via the synchronous `tauri:os-internals` ipc
    // handler + plugin:os — either counts as satisfied.
    handled = electronHandlerSource.includes('plugin:os') || electronHandlerSource.includes('os-internals');
  } else {
    const prefix = pluginPrefixFor(pkg);
    handled = electronHandlerSource.includes(prefix);
  }

  if (handled) {
    pluginSatisfied.push(pkg);
  } else {
    pluginGaps.push({ pkg, prefix: pkg === 'os' ? 'plugin:os| / os-internals' : pluginPrefixFor(pkg), files: [...files] });
  }
}

// ---------------------------------------------------------------------------
// Check C — @tauri-apps/api/window surface (methods + window events)
// ---------------------------------------------------------------------------
//
// Checks A/B only see literal `invoke('cmd')` strings and plugin imports, so a
// `getCurrentWindow().setPosition(...)` (which invokes `plugin:window|
// set_position` from inside the library) or a `getCurrentWindow().onMoved(...)`
// (which listens for `tauri://move`) was invisible to them — both silently
// no-op'd in Electron for months (desktop pet position never persisted; the
// notification click's show/unminimize/setFocus did nothing).
//
// The method → command/event map is DERIVED from the installed library source
// (node_modules/@tauri-apps/api/window.js + event.js), not hand-maintained:
// each method/function body is scanned for `invoke('plugin:window|…')` and
// `TauriEvent.X` references. Renderer usages are found per file:
//   - `getCurrentWindow().method(`                      (direct chain)
//   - `const w = getCurrentWindow(); … w.method(`       (local binding)
//   - `primaryMonitor(`-style module functions imported from the package.
// A used command must have a `case '<cmd>'` handler in electron/*.cjs (an
// allowlist entry alone is not a handler); a used `tauri://*` event must be
// the literal argument of some `emit*(...)` call in electron/*.cjs (a listen
// allowlist entry alone does not emit anything).

// Window methods / functions the Electron shell deliberately does not support.
// name -> reason. Anything used by the renderer and not listed here must work.
const KNOWN_UNSUPPORTED_WINDOW_API = new Map([
  // (empty — every window method the renderer calls has an Electron handler)
]);

const tauriApiDir = path.join(repoRoot, 'node_modules', '@tauri-apps', 'api');

/** TauriEvent enum member -> event name, read from the installed event.js. */
function readTauriEventEnum() {
  const text = fs.readFileSync(path.join(tauriApiDir, 'event.js'), 'utf8');
  const map = new Map();
  const re = /TauriEvent\["([A-Z_]+)"\]\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) map.set(m[1], m[2]);
  return map;
}

/**
 * name -> { commands: Set, events: Set } for every Window class member and
 * module-level function in the installed window.js. A member's "body" is the
 * text from its declaration to the next declaration — enough for the
 * one-level `invoke(...)` / `this.listen(TauriEvent.X, ...)` shape this
 * library uses throughout.
 */
function readTauriWindowSurface() {
  const text = fs.readFileSync(path.join(tauriApiDir, 'window.js'), 'utf8');
  const events = readTauriEventEnum();
  const declRe = /^(?: {4}(?:static\s+)?(?:async\s+)?|(?:async\s+)?function\s+)([A-Za-z_$][\w$]*)\s*\(/gm;
  const decls = [];
  let m;
  while ((m = declRe.exec(text))) decls.push({ name: m[1], start: m.index });
  const surface = new Map();
  for (let i = 0; i < decls.length; i++) {
    const body = text.slice(decls[i].start, i + 1 < decls.length ? decls[i + 1].start : text.length);
    const entry = surface.get(decls[i].name) ?? { commands: new Set(), events: new Set() };
    for (const c of body.matchAll(/invoke\(\s*'(plugin:window\|[a-z_]+)'/g)) entry.commands.add(c[1]);
    for (const e of body.matchAll(/TauriEvent\.([A-Z_]+)/g)) {
      if (events.has(e[1])) entry.events.add(events.get(e[1]));
    }
    surface.set(decls[i].name, entry);
  }
  return surface;
}

/** name -> Set(rel file) of window methods / functions the renderer calls. */
function collectRendererWindowUsage() {
  const uses = new Map();
  const add = (name, rel) => {
    if (!uses.has(name)) uses.set(name, new Set());
    uses.get(name).add(rel);
  };
  for (const file of srcFiles) {
    const raw = fs.readFileSync(file, 'utf8');
    const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]@tauri-apps\/api\/window['"]/g;
    const imported = [];
    let im;
    while ((im = importRe.exec(raw))) {
      for (const spec of im[1].split(',')) {
        const parts = spec.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
        if (parts[0]) imported.push({ name: parts[0].trim(), local: (parts[1] ?? parts[0]).trim() });
      }
    }
    if (imported.length === 0) continue;
    const rel = path.relative(repoRoot, file);
    const content = blankComments(raw);
    // Module-level functions (primaryMonitor(), currentMonitor(), …). `new X(`
    // is a re-exported dpi class constructor (PhysicalPosition), not a call.
    for (const { name, local } of imported) {
      if (name === 'getCurrentWindow') continue;
      if (new RegExp(`(?<![\\w$.])(?<!\\bnew\\s+)${local.replace(/\$/g, '\\$')}\\s*\\(`).test(content)) add(name, rel);
    }
    const currentLocal = imported.find((i) => i.name === 'getCurrentWindow')?.local;
    if (!currentLocal) continue;
    // Direct chain: getCurrentWindow().method(  /  getCurrentWindow()\n  .method(
    const chainRe = new RegExp(`\\b${currentLocal}\\(\\)\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*[(<]`, 'g');
    let cm;
    while ((cm = chainRe.exec(content))) add(cm[1], rel);
    // Local binding: const win = getCurrentWindow(); … win.method(
    const bindRe = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${currentLocal}\\(\\)`, 'g');
    let bm;
    while ((bm = bindRe.exec(content))) {
      const useRe = new RegExp(`(?<![\\w$.])${bm[1]}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*[(<]`, 'g');
      let um;
      while ((um = useRe.exec(content))) add(um[1], rel);
    }
  }
  return uses;
}

/** Every `tauri://*` event literal passed to an emit*(...) call in electron/*.cjs. */
function collectElectronEmittedWindowEvents() {
  const emitted = new Set();
  // Drop whole-line comments (prose like "emits `tauri://move`" must not count
  // as an emitter). Not blankComments(): that scanner is quote-driven and can
  // desync on the regex literals in electron/*.cjs, then blank the `//` inside
  // a real 'tauri://…' string.
  const source = electronHandlerSource
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
  for (const m of source.matchAll(/\bemit[A-Za-z]*\s*\([^()]*?'(tauri:\/\/[\w-]+)'/g)) emitted.add(m[1]);
  return emitted;
}

const windowSurface = readTauriWindowSurface();
const windowUses = collectRendererWindowUsage();
const emittedWindowEvents = collectElectronEmittedWindowEvents();
const windowGaps = [];
const windowSatisfied = [];
const windowUnknown = [];
for (const [name, files] of [...windowUses].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (KNOWN_UNSUPPORTED_WINDOW_API.has(name)) continue;
  const entry = windowSurface.get(name);
  if (!entry) {
    windowUnknown.push(`${name} (${[...files].join(', ')})`);
    continue;
  }
  const missing = [
    ...[...entry.commands].filter((cmd) => !electronHandlerSource.includes(`case '${cmd}'`)).map((cmd) => `command ${cmd}`),
    ...[...entry.events].filter((ev) => !emittedWindowEvents.has(ev)).map((ev) => `event ${ev} (never emitted)`),
  ];
  if (missing.length > 0) windowGaps.push({ name, missing, files: [...files] });
  else windowSatisfied.push(name);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let hasGaps = false;

console.log('[parity-check] ── Check A: custom (non-plugin) commands ──');
console.log(`[parity-check] scanned ${srcFiles.length} src files, ${electronHandlerFiles.length} electron/*.cjs handler files`);
console.log(`[parity-check] ${customSatisfied.length} custom command(s) SATISFIED, ${KNOWN_DEFERRED_CUSTOM.size} KNOWN_DEFERRED`);
if (customGaps.length > 0) {
  hasGaps = true;
  console.log(`[parity-check] ❌ ${customGaps.length} GAP(S):`);
  for (const g of customGaps) {
    console.log(`  ❌ ${g.cmd}  <- used in: ${g.files.join(', ')}`);
  }
} else {
  console.log('[parity-check] ✓ no custom command gaps');
}

console.log('');
console.log('[parity-check] ── Check B: plugin families ──');
console.log(`[parity-check] ${pluginSatisfied.length} plugin family/families SATISFIED: ${pluginSatisfied.join(', ') || '(none)'}`);
console.log(`[parity-check] ${KNOWN_DEFERRED_PLUGIN_FAMILIES.size} KNOWN_DEFERRED: ${[...KNOWN_DEFERRED_PLUGIN_FAMILIES].join(', ')}`);
if (pluginGaps.length > 0) {
  hasGaps = true;
  console.log(`[parity-check] ❌ ${pluginGaps.length} GAP(S):`);
  for (const g of pluginGaps) {
    console.log(`  ❌ plugin-${g.pkg} (needs ${g.prefix})  <- used in: ${g.files.join(', ')}`);
  }
} else {
  console.log('[parity-check] ✓ no plugin family gaps');
}

console.log('');
console.log('[parity-check] ── Check C: @tauri-apps/api/window methods + window events ──');
console.log(
  `[parity-check] ${windowSatisfied.length} window method(s)/function(s) SATISFIED: ${windowSatisfied.join(', ') || '(none)'}`
);
console.log(
  `[parity-check] ${KNOWN_UNSUPPORTED_WINDOW_API.size} KNOWN_UNSUPPORTED: ${[...KNOWN_UNSUPPORTED_WINDOW_API.keys()].join(', ')}`
);
if (windowGaps.length > 0) {
  hasGaps = true;
  console.log(`[parity-check] ❌ ${windowGaps.length} GAP(S):`);
  for (const g of windowGaps) {
    console.log(`  ❌ ${g.name}() needs ${g.missing.join(' + ')}  <- used in: ${g.files.join(', ')}`);
  }
} else {
  console.log('[parity-check] ✓ no window method/event gaps');
}
if (windowUnknown.length > 0) {
  hasGaps = true;
  console.log(
    `[parity-check] ❌ ${windowUnknown.length} call(s) on a Window binding matched no member of ` +
      '@tauri-apps/api/window (library changed, or the scanner misread a call) — resolve or allowlist:'
  );
  for (const u of windowUnknown) console.log(`  ❌ ${u}`);
}

if (dynamicInvokeSites.length > 0) {
  console.log('');
  console.log(
    `[parity-check] NOTE: ${dynamicInvokeSites.length} invoke()-style call(s) had a non-literal first argument ` +
      '(e.g. a variable) and could not be resolved statically, so are NOT covered by this audit:'
  );
  for (const site of dynamicInvokeSites) console.log(`  · ${site}`);
}

console.log('');
if (hasGaps) {
  console.log('[parity-check] FAIL — parity gap(s) found (see ❌ above). Add a real Electron handler, or if the gap is');
  console.log('[parity-check] deliberate, add it to KNOWN_DEFERRED_CUSTOM/KNOWN_DEFERRED_PLUGIN_FAMILIES here AND to');
  console.log('[parity-check] electron/tauriHost.cjs\'s KNOWN_DEFERRED (keep both lists in sync); for a window');
  console.log('[parity-check] method/event, add it to KNOWN_UNSUPPORTED_WINDOW_API with the reason.');
} else {
  console.log(
    '[parity-check] PASS — every custom command, plugin family, and window method/event the frontend uses has an Electron handler.'
  );
}
process.exit(hasGaps ? 1 : 0);
