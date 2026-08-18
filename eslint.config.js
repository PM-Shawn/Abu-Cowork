import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

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
    'src-tauri',
    'coverage',
    '.wt-*/',
    '.claude/worktrees/',
    'sidecar/index.mjs',
    'electron/browser-runtime/dist',
    'electron/chrome-bridge-runtime/dist',
  ]),
  {
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
      // These rules from React hooks recommended are too strict for legitimate patterns
      // like form initialization, syncing derived state, and dynamic icon components
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/static-components': 'off',
      // Typography guardrail — enforce the 8-token font-size scale (index.css
      // `--text-*`). Ban arbitrary `text-[Npx]` and Tailwind default named
      // sizes so the whole app stays on one scale. Both are at zero after the
      // 2026-07 migration; this keeps them there. Use text-caption/minor/body
      // /h-xs/h-sm/h-md/h-lg/h-xl. (Colors are intentionally NOT covered yet —
      // link/status colors are still raw Tailwind, a separate follow-up.)
      'no-restricted-syntax': ['error',
        {
          selector: 'Literal[value=/text-\\[[0-9.]+px\\]/]',
          message: 'Use a font-size token (text-caption/minor/body/h-xs..h-xl) instead of an arbitrary text-[Npx] class.',
        },
        {
          selector: 'TemplateElement[value.raw=/text-\\[[0-9.]+px\\]/]',
          message: 'Use a font-size token instead of an arbitrary text-[Npx] class (template literal).',
        },
        {
          selector: 'Literal[value=/\\btext-(xs|sm|base|lg|xl|2xl|3xl)\\b/]',
          message: 'Use a font-size token (text-minor/body/h-*) instead of Tailwind named sizes. One scale only.',
        },
        {
          selector: 'TemplateElement[value.raw=/\\btext-(xs|sm|base|lg|xl|2xl|3xl)\\b/]',
          message: 'Use a font-size token instead of Tailwind named sizes (template literal).',
        },
        // Semantic-color guardrail — enforce the --abu-{danger,warning,success,
        // info,link} token scale (index.css). Ban raw Tailwind status/link hues
        // in text/bg/border/ring/fill so link + status colors stay tokenized and
        // theme-aware. Neutral grays and categorical hues (purple/teal) are NOT
        // covered. See CLAUDE.md §6.2.
        {
          selector: 'Literal[value=/\\b(text|bg|border|ring|fill)-(red|green|emerald|lime|amber|yellow|blue|sky|indigo|orange)-[0-9]/]',
          message: 'Use a semantic color token (e.g. text-[var(--abu-danger)], bg-[var(--abu-success-bg)]) instead of raw Tailwind status/link colors. See CLAUDE.md §6.2.',
        },
        {
          selector: 'TemplateElement[value.raw=/\\b(text|bg|border|ring|fill)-(red|green|emerald|lime|amber|yellow|blue|sky|indigo|orange)-[0-9]/]',
          message: 'Use a semantic color token instead of raw Tailwind status/link colors (template literal). See CLAUDE.md §6.2.',
        },
      ],
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
  // `**/*.{ts,tsx}` block above, the base block's typography/color-token
  // selectors are repeated here so test files keep both guardrails instead
  // of silently losing the earlier ones.
  //
  // Legitimate mock patterns are NOT flagged: `vi.spyOn(Date, 'now')` and
  // `vi.setSystemTime(fixedDate)` pass `Date`/`'now'` as arguments (a
  // MemberExpression/Identifier + Literal), not a `Date.now()` call — the
  // selectors below only match actual CallExpression/NewExpression call
  // sites, not references to the function.
  {
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: 'Literal[value=/text-\\[[0-9.]+px\\]/]',
          message: 'Use a font-size token (text-caption/minor/body/h-xs..h-xl) instead of an arbitrary text-[Npx] class.',
        },
        {
          selector: 'TemplateElement[value.raw=/text-\\[[0-9.]+px\\]/]',
          message: 'Use a font-size token instead of an arbitrary text-[Npx] class (template literal).',
        },
        {
          selector: 'Literal[value=/\\btext-(xs|sm|base|lg|xl|2xl|3xl)\\b/]',
          message: 'Use a font-size token (text-minor/body/h-*) instead of Tailwind named sizes. One scale only.',
        },
        {
          selector: 'TemplateElement[value.raw=/\\btext-(xs|sm|base|lg|xl|2xl|3xl)\\b/]',
          message: 'Use a font-size token instead of Tailwind named sizes (template literal).',
        },
        {
          selector: 'Literal[value=/\\b(text|bg|border|ring|fill)-(red|green|emerald|lime|amber|yellow|blue|sky|indigo|orange)-[0-9]/]',
          message: 'Use a semantic color token (e.g. text-[var(--abu-danger)], bg-[var(--abu-success-bg)]) instead of raw Tailwind status/link colors. See CLAUDE.md §6.2.',
        },
        {
          selector: 'TemplateElement[value.raw=/\\b(text|bg|border|ring|fill)-(red|green|emerald|lime|amber|yellow|blue|sky|indigo|orange)-[0-9]/]',
          message: 'Use a semantic color token instead of raw Tailwind status/link colors (template literal). See CLAUDE.md §6.2.',
        },
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
      ],
    },
  },
])
