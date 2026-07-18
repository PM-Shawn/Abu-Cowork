import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `.wt-*/` are nested git worktrees (feature branches) checked out inside the
  // repo. Each carries its own tsconfig, which makes typescript-eslint find
  // multiple candidate TSConfig roots and fail to parse EVERY file. Ignore them
  // so local `eslint .` matches a clean CI checkout (which has no worktrees).
  globalIgnores(['dist', 'src-tauri', 'coverage', '.wt-*/']),
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
])
