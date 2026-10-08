import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

const TYPOGRAPHY_SELECTORS = [
  {
    selector: 'Literal[value=/text-\\[[0-9.]+px\\]/]',
    message: 'Use a font-size token (text-title-lg / text-title / text-ui / text-ui-sm / text-caption, or text-body / text-h1..h3 / text-mono for content), not an arbitrary text-[Npx] class. See AGENTS.md §6.1.',
  },
  {
    selector: 'TemplateElement[value.raw=/text-\\[[0-9.]+px\\]/]',
    message: 'Use a font-size token, not an arbitrary text-[Npx] class (template literal). See AGENTS.md §6.1.',
  },
  {
    selector: 'Literal[value=/\\btext-(xs|sm|base|lg|xl|2xl|3xl)\\b/]',
    message: 'Use a font-size token (text-ui / text-ui-sm / text-caption / text-title, or text-body / text-h1..h3 for content), not Tailwind named sizes. See AGENTS.md §6.1.',
  },
  {
    selector: 'TemplateElement[value.raw=/\\btext-(xs|sm|base|lg|xl|2xl|3xl)\\b/]',
    message: 'Use a font-size token, not Tailwind named sizes (template literal). See AGENTS.md §6.1.',
  },
]

const DESIGN_TYPOGRAPHY_SELECTORS = [
  {
    selector: 'Literal[value=/text-\\[[0-9.]+px\\]/]',
    message: 'Design system: use text-title-lg / text-title / text-ui / text-ui-sm / text-caption (UI) or text-body / text-h1..h3 / text-mono (content), not an arbitrary size.',
  },
  {
    selector: 'TemplateElement[value.raw=/text-\\[[0-9.]+px\\]/]',
    message: 'Design system: use a design-system font-size token, not an arbitrary size (template literal).',
  },
  {
    selector: 'Literal[value=/\\btext-(xs|sm|base|lg|xl|2xl|3xl)\\b/]',
    message: 'Design system: use text-ui / text-ui-sm / text-caption / text-title (UI) or text-body / text-h1..h3 (content), not Tailwind named sizes.',
  },
  {
    selector: 'TemplateElement[value.raw=/\\btext-(xs|sm|base|lg|xl|2xl|3xl)\\b/]',
    message: 'Design system: use a design-system font-size token, not Tailwind named sizes (template literal).',
  },
]

const STATUS_COLOR_SELECTORS = [
  {
    selector: 'Literal[value=/\\b(text|bg|border|ring|fill)-(red|green|emerald|lime|amber|yellow|blue|sky|indigo|orange)-[0-9]/]',
    message: 'Use a status or link token (text-success / text-warning / text-danger / text-info on bg-{role}-soft, text-link), not a Tailwind palette color. See AGENTS.md §6.1.',
  },
  {
    selector: 'TemplateElement[value.raw=/\\b(text|bg|border|ring|fill)-(red|green|emerald|lime|amber|yellow|blue|sky|indigo|orange)-[0-9]/]',
    message: 'Use a status or link token, not a Tailwind palette color (template literal). See AGENTS.md §6.1.',
  },
]

const TEST_DETERMINISM_SELECTORS = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'TESTING.md §3: no real Date.now() in tests (non-deterministic). Freeze time with vi.useFakeTimers()+vi.setSystemTime(fixedDate), or use a fixed constant.',
  },
  {
    selector: 'NewExpression[callee.name=\'Date\'][arguments.length=0]',
    message: 'TESTING.md §3: no bare `new Date()` (real current time) in tests. Pass a fixed timestamp/ISO string, or use vi.useFakeTimers()+vi.setSystemTime().',
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: "TESTING.md §3: no real Math.random() in tests (non-deterministic). Inject a seeded RNG or vi.spyOn(Math, 'random').mockReturnValue(fixedValue).",
  },
  {
    selector: "CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
    message: 'TESTING.md §3: no real crypto.randomUUID() in tests (non-deterministic). Stub via vi.spyOn(...).mockReturnValue(fixedId), or assert with expect.any(String).',
  },
]

const UPDATER_IMPORT_RESTRICTION = [{
  name: '@tauri-apps/plugin-updater',
  importNames: ['check'],
  message: 'The Electron host returns a three-state result the plugin\'s check() cannot represent. Use checkForUpdate from @/core/updates/checker instead.',
}]

// Where the design-system rules apply (AGENTS.md §6.1): every file of src/.
// - src/components/ds/ is the component library: it renders the raw controls
//   and imports the icon and primitive packages, so it gets the size and value
//   groups only.
// - The directories in DESIGN_SYSTEM_PROSE_DIRS hold no JSX class names and do
//   hold English prose (prompt text, translations, test titles) in which
//   "rounded" and "shadow" are words: no class group reads them. The import
//   restriction applies there as everywhere else.
const DESIGN_SYSTEM_SCOPE = ['src/**/*.{ts,tsx}']
const DESIGN_SYSTEM_LIBRARY = 'src/components/ds/**'
const DESIGN_SYSTEM_PROSE_DIRS = ['src/core/**', 'src/stores/**', 'src/i18n/**', 'src/eval/**']
const TEST_FILES = 'src/**/*.test.{ts,tsx}'

const ARBITRARY_VALUE = '\\b(bg|text|border|ring|fill|stroke|outline|divide|from|via|to|shadow|z|rounded|duration|ease)-\\['
const PALETTE_COLOR = '\\b(bg|text|border|ring|fill|stroke|outline|divide|from|via|to|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]|\\b(bg|text|border|ring|fill|stroke|outline|divide|from|via|to|shadow)-(black|white)\\b'
const HAND_WRITTEN_SCRIM = '\\bfixed\\b.*\\binset-0\\b|\\binset-0\\b.*\\bfixed\\b'
// A class name starts at the string start, after whitespace, after a variant colon, or
// after the important bang — never after a hyphen, so `drop-shadow-md` is not `shadow-md`.
const CLASS_START = '(^|[\\s:!])'
const CLASS_END = '(?![\\w-])'
// Class names that have no token behind them: shadcn color names, sizes outside
// the type scale, and Tailwind's own radius, level, duration, shadow and easing steps.
const OFF_SCALE_CLASS_PATTERNS = [
  [`${CLASS_START}-?(bg|text|border|ring|outline|fill|stroke|divide|from|via|to)-(background|foreground|card|card-foreground|popover|popover-foreground|primary|primary-foreground|secondary|secondary-foreground|muted|muted-foreground|accent|accent-foreground|destructive|input|border|ring|sidebar[a-z-]*|chart-[1-5])${CLASS_END}`, 'Design system: shadcn color names have no token. Use a semantic token (bg-surface, text-label-secondary, bg-emphasis…).'],
  [`${CLASS_START}text-(minor|h-xs|h-sm|h-md|h-lg|h-xl)${CLASS_END}`, 'Design system: this size is not on the type scale. Use text-title-lg / text-title / text-ui / text-ui-sm / text-caption, or text-body / text-h1..h3 / text-mono for content.'],
  [`${CLASS_START}rounded(-(t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(-(xs|sm|md|lg|xl|2xl|3xl|4xl))?${CLASS_END}`, 'Design system: use rounded-window / rounded-panel / rounded-control (or rounded-full).'],
  [`${CLASS_START}-?z-([0-9]+|auto)${CLASS_END}`, 'Design system: use z-sticky / z-fullscreen / z-popover / z-dialog / z-toast / z-tooltip.'],
  [`${CLASS_START}duration-([0-9]+|initial)${CLASS_END}`, 'Design system: use duration-fast / duration-base / duration-slow.'],
  [`${CLASS_START}shadow(-(2xs|xs|sm|md|lg|xl|2xl|inner))?${CLASS_END}`, 'Design system: use shadow-panel / shadow-float / shadow-dialog.'],
  [`${CLASS_START}ease-(linear|in|out|in-out)${CLASS_END}`, 'Design system: use ease-enter / ease-exit.'],
  // No variant colon here: data-[state=…]:animate-in is the required form.
  ['(^|[\\s!])animate-in(?![\\w-])', 'Design system: an enter animation belongs to a state. Use data-[state=…]:animate-in.'],
]

const DESIGN_VALUE_SELECTORS = [
  { selector: `Literal[value=/${ARBITRARY_VALUE}/]`, message: 'Design system: use a token class (bg-surface, text-label, z-popover, rounded-panel…) instead of an arbitrary value.' },
  { selector: `TemplateElement[value.raw=/${ARBITRARY_VALUE}/]`, message: 'Design system: use a token class instead of an arbitrary value (template literal).' },
  { selector: `Literal[value=/${PALETTE_COLOR}/]`, message: 'Design system: Tailwind palette colors are not part of the design system. Use a semantic token.' },
  { selector: `TemplateElement[value.raw=/${PALETTE_COLOR}/]`, message: 'Design system: Tailwind palette colors are not part of the design system (template literal).' },
  { selector: `Literal[value=/${HAND_WRITTEN_SCRIM}/]`, message: 'Design system: do not hand-write a full-window scrim. Use Dialog from @/components/ds/dialog.' },
  { selector: `TemplateElement[value.raw=/${HAND_WRITTEN_SCRIM}/]`, message: 'Design system: do not hand-write a full-window scrim (template literal).' },
  ...OFF_SCALE_CLASS_PATTERNS.flatMap(([pattern, message]) => [
    { selector: `Literal[value=/${pattern}/]`, message },
    { selector: `TemplateElement[value.raw=/${pattern}/]`, message: `${message} (template literal)` },
  ]),
]

const DESIGN_STRUCTURE_SELECTORS = [
  {
    selector: 'JSXOpeningElement[name.name=/^(button|input|select|textarea)$/]',
    message: 'Design system: use Button / TextField / Select / TextArea from @/components/ds instead of a raw form control.',
  },
]

const DESIGN_IMPORT_RESTRICTION = {
  paths: [
    ...UPDATER_IMPORT_RESTRICTION,
    { name: 'lucide-react', message: 'Design system: render icons through Icon + AppIcons from @/components/ds.' },
    { name: 'radix-ui', message: 'Design system: use the wrappers in @/components/ds.' },
    { name: 'cmdk', message: 'Design system: use Combobox from @/components/ds/combobox.' },
  ],
  patterns: [{ group: ['@radix-ui/*', 'radix-ui/*'], message: 'Design system: use the wrappers in @/components/ds.' }],
}

const BASE_BLOCK = {
  files: ['**/*.{ts,tsx}'],
  extends: [
    js.configs.recommended,
    tseslint.configs.recommended,
    reactHooks.configs.flat.recommended,
    reactRefresh.configs.vite,
  ],
  languageOptions: {
    ecmaVersion: 2020,
    globals: globals.browser,
  },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
    }],
    // CLAUDE.md forbids `any` — enforce via lint, not just convention.
    // Use `unknown` or proper types; opt out locally with
    // `// eslint-disable-next-line @typescript-eslint/no-explicit-any`
    // only when a third-party type is genuinely untypable.
    '@typescript-eslint/no-explicit-any': 'error',
    // The Electron host's `plugin:updater|check` is three-state: metadata /
    // null / `{ status: 'disabled' }` marker (updaterHost.cjs header). The
    // plugin's stock check() wrapper predates the marker and blindly wraps
    // any truthy result in `new Update(...)` — a caller using it would turn
    // the marker into a bogus "update available" (the v0.41.0 misleading-
    // update incident, reintroduced). All checks must go through
    // src/core/updates/checker.ts, which invokes the command directly.
    'no-restricted-imports': ['error', {
      paths: UPDATER_IMPORT_RESTRICTION,
    }],
    // These rules from React hooks recommended are too strict for legitimate patterns
    // like form initialization, syncing derived state, and dynamic icon components
    'react-hooks/set-state-in-effect': 'off',
    'react-hooks/purity': 'off',
    'react-hooks/static-components': 'off',
    // Every TypeScript file, in src/ and outside it (sidecar, scripts, tests):
    // font sizes come from the type scale of src/styles/tokens.css
    // (text-title-lg / text-title / text-ui / text-ui-sm / text-caption for
    // the interface, text-body / text-h1..h3 / text-mono for content), and
    // status and link colors from its status tokens (text-success /
    // text-warning / text-danger / text-info on bg-{role}-soft, text-link).
    // An arbitrary text-[Npx], a Tailwind named size and a Tailwind status or
    // link hue are banned. See AGENTS.md §6.1.
    'no-restricted-syntax': ['error', ...TYPOGRAPHY_SELECTORS, ...STATUS_COLOR_SELECTORS],
  },
}

// The rules for a repository that is compiled into this app from a sibling
// directory and has no node_modules of its own: the base block, plus the
// design-system rules for the globs that repository passes. Its config file
// calls this, so the globs are relative to that repository.
export function overlayLintConfig(globs) {
  if (globs.length === 0) return defineConfig([BASE_BLOCK])
  return defineConfig([
    BASE_BLOCK,
    {
      files: globs,
      rules: {
        'no-restricted-syntax': ['error', ...DESIGN_TYPOGRAPHY_SELECTORS, ...DESIGN_VALUE_SELECTORS, ...DESIGN_STRUCTURE_SELECTORS],
        'no-restricted-imports': ['error', DESIGN_IMPORT_RESTRICTION],
      },
    },
  ])
}

export default defineConfig([
  // `.wt-*/` and `.claude/worktrees/` are nested git worktrees (feature branches)
  // checked out inside the repo. Each carries its own tsconfig, which makes
  // typescript-eslint find multiple candidate TSConfig roots and fail to parse
  // EVERY file. Ignore them so local `eslint .` matches a clean CI checkout
  // (which has no worktrees).
  // sidecar/index.mjs is esbuild's generated bundle output (scripts/build-sidecar.mjs)
  // — vendored dependency code inlined into it can contain eslint-disable comments
  // referencing rules this config doesn't define for non-ts/tsx files, which ESLint
  // flags as "rule not found" rather than silently ignoring. It's a build artifact,
  // never hand-edited — same treatment as `dist`.
  globalIgnores([
    'dist',
    'dist-electron-spike', // vite build output for the Electron shell (bundled, never hand-edited)
    'release-electron', // electron-builder packaged output
    'release-electron-e2e', // pre-fuse packaged clone used only by local Playwright smoke tests
    'release-electron-computer-use-test', // isolated Windows Computer Use installer output
    'release-electron-computer-use-test-e2e', // isolated pre-fuse packaged clone
    'src-tauri',
    'coverage',
    '.wt-*/',
    '.claude/worktrees/',
    'sidecar/index.mjs',
    // electron/generated/ holds esbuild output too (scripts/gen-ledger-reader.mjs
    // bundles src/core/session/ledgerReader.ts for the main process). Generated,
    // tracked, never hand-edited — same treatment as the bundle above.
    'electron/generated',
    'abu-browser-bridge/dist',
    'electron/browser-runtime/dist',
    'electron/chrome-bridge-runtime/dist',
  ]),
  BASE_BLOCK,
  // The component library: the size and value groups.
  {
    files: [`${DESIGN_SYSTEM_LIBRARY}/*.{ts,tsx}`],
    rules: {
      'no-restricted-syntax': ['error', ...DESIGN_TYPOGRAPHY_SELECTORS, ...DESIGN_VALUE_SELECTORS],
    },
  },
  // Every other file of src/: icons, primitives and the command list come
  // through the component library.
  {
    files: DESIGN_SYSTEM_SCOPE,
    ignores: [DESIGN_SYSTEM_LIBRARY],
    rules: {
      'no-restricted-imports': ['error', DESIGN_IMPORT_RESTRICTION],
    },
  },
  // Interface code: the size, value and structure groups.
  {
    files: DESIGN_SYSTEM_SCOPE,
    ignores: [DESIGN_SYSTEM_LIBRARY, ...DESIGN_SYSTEM_PROSE_DIRS],
    rules: {
      'no-restricted-syntax': ['error', ...DESIGN_TYPOGRAPHY_SELECTORS, ...DESIGN_VALUE_SELECTORS, ...DESIGN_STRUCTURE_SELECTORS],
    },
  },
  // sidecar/src runs in a plain Node process — no DOM, no webview. But
  // `tsconfig.sidecar.json` deliberately includes the DOM lib (so type-imports
  // of DOM-dependent src/** modules resolve — see B2 / that file's comment),
  // which means `tsc` alone CANNOT catch sidecar code that misuses a browser
  // global: `window.foo` type-checks fine, then throws `window is not defined`
  // at runtime. This override closes that masking gap — forbid the browser
  // globals here, and provide Node globals so `process`/`Buffer`/`__dirname`/
  // etc. are recognized (no false no-undef). Applies ON TOP of the block above.
  {
    files: ['sidecar/src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-globals': ['error',
        { name: 'window', message: 'sidecar runs in Node — no DOM. `window` is undefined at runtime (tsconfig.sidecar\'s DOM lib masks this; see eslint.config.js).' },
        { name: 'document', message: 'sidecar runs in Node — no DOM. `document` is undefined at runtime.' },
        { name: 'navigator', message: 'sidecar runs in Node — no DOM. `navigator` is undefined at runtime.' },
        { name: 'localStorage', message: 'sidecar runs in Node — no DOM. `localStorage` is undefined at runtime.' },
        { name: 'sessionStorage', message: 'sidecar runs in Node — no DOM. `sessionStorage` is undefined at runtime.' },
        { name: 'requestAnimationFrame', message: 'sidecar runs in Node — no requestAnimationFrame. Use a timer.' },
        { name: 'cancelAnimationFrame', message: 'sidecar runs in Node — no cancelAnimationFrame.' },
        { name: 'alert', message: 'sidecar runs in Node — no DOM.' },
        { name: 'confirm', message: 'sidecar runs in Node — no DOM.' },
        { name: 'prompt', message: 'sidecar runs in Node — no DOM.' },
      ],
    },
  },
  // Determinism guardrail for vitest unit tests (TESTING.md §3 "Determinism
  // Constraints") — real Date.now() / bare `new Date()` / Math.random() /
  // crypto.randomUUID() calls make a test's outcome depend on wall-clock time
  // or OS entropy, so the same test can pass or fail differently between
  // runs. Ban the real call sites; require freezing a fixed value instead
  // (vi.useFakeTimers()+vi.setSystemTime(), a hardcoded constant, or
  // vi.spyOn(...).mockReturnValue(<fixed value>)).
  //
  // NOTE on scope: `no-restricted-syntax` rule VALUES are replaced (not
  // merged) per-rule-name across flat-config blocks that match the same
  // file (verified empirically — ESLint v10 flat config does not
  // concatenate array-valued rule options from multiple matching configs).
  // Since this block's `files` glob is a subset of the base
  // `**/*.{ts,tsx}` block above, the base block's typography and status-color
  // selectors are repeated here so test files keep both guardrails.
  //
  // Legitimate mock patterns are NOT flagged: `vi.spyOn(Date, 'now')` and
  // `vi.setSystemTime(fixedDate)` pass `Date`/`'now'` as arguments (a
  // MemberExpression/Identifier + Literal), not a `Date.now()` call — the
  // selectors below only match actual CallExpression/NewExpression call
  // sites, not references to the function.
  {
    files: [TEST_FILES],
    rules: {
      'no-restricted-syntax': ['error', ...TYPOGRAPHY_SELECTORS, ...STATUS_COLOR_SELECTORS, ...TEST_DETERMINISM_SELECTORS],
    },
  },
  // Test files of the component library and of interface code: the test block
  // above replaces no-restricted-syntax wholesale, so each repeats its design
  // groups next to the determinism selectors. Test files in the directories
  // that hold prose stay on the block above.
  {
    files: [`${DESIGN_SYSTEM_LIBRARY}/*.test.{ts,tsx}`],
    rules: {
      'no-restricted-syntax': ['error', ...DESIGN_TYPOGRAPHY_SELECTORS, ...DESIGN_VALUE_SELECTORS, ...TEST_DETERMINISM_SELECTORS],
    },
  },
  {
    files: [TEST_FILES],
    ignores: [DESIGN_SYSTEM_LIBRARY, ...DESIGN_SYSTEM_PROSE_DIRS],
    rules: {
      'no-restricted-syntax': ['error', ...DESIGN_TYPOGRAPHY_SELECTORS, ...DESIGN_VALUE_SELECTORS, ...DESIGN_STRUCTURE_SELECTORS, ...TEST_DETERMINISM_SELECTORS],
    },
  },
])
