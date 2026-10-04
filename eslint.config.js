import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

const TYPOGRAPHY_SELECTORS = [
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
    message: 'Use a semantic color token (e.g. text-[var(--abu-danger)], bg-[var(--abu-success-bg)]) instead of raw Tailwind status/link colors. See CLAUDE.md §6.2.',
  },
  {
    selector: 'TemplateElement[value.raw=/\\b(text|bg|border|ring|fill)-(red|green|emerald|lime|amber|yellow|blue|sky|indigo|orange)-[0-9]/]',
    message: 'Use a semantic color token instead of raw Tailwind status/link colors (template literal). See CLAUDE.md §6.2.',
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

// Design-system migration list (docs/2026-09-28-design-system-brief.md §6.6).
// Append a glob when a directory or file finishes migrating; never remove one.
// The cleanup batch deletes both lists and applies the rules to every file.
export const DESIGN_SYSTEM_MIGRATED_FILES = [
  'src/components/design-preview/**/*.{ts,tsx}',
  'src/components/window/**/*.{ts,tsx}',
  'src/components/sidebar/**/*.{ts,tsx}',
  // Chat area, file by file (batch 4). The directory glob joins in batch 8 with the scrims.
  'src/components/chat/MarkdownRenderer*.{ts,tsx}',
  'src/components/chat/syntaxTheme*.ts',
  'src/components/chat/MermaidBlock.tsx',
  'src/components/chat/mermaidTheme.ts',
  'src/components/chat/SvgHtmlBlock.tsx',
  'src/components/chat/HtmlWidgetBlock*.{ts,tsx}',
  'src/components/chat/ShowWidgetCard*.{ts,tsx}',
  'src/components/chat/codeBlockRenderers.ts',
  'src/components/chat/MessageBubble*.{ts,tsx}',
  'src/components/chat/MessageGroup*.{ts,tsx}',
  'src/components/chat/FileAttachment*.{ts,tsx}',
  'src/components/chat/SourceCard.tsx',
  'src/components/chat/SourcesSection*.{ts,tsx}',
  'src/components/chat/CompactDivider*.{ts,tsx}',
  'src/components/chat/WelcomeAvatar.tsx',
  'src/components/chat/ThinkingStatusLine.tsx',
  'src/components/chat/TaskBlock*.{ts,tsx}',
  'src/components/chat/SmoothHeight*.{ts,tsx}',
  'src/components/chat/BrowserRunReportCard*.{ts,tsx}',
  'src/components/chat/ComputerUseRunReportCard*.{ts,tsx}',
  'src/components/chat/ComputerUseStatusBar*.{ts,tsx}',
  'src/components/chat/TeamMemberBar*.{ts,tsx}',
  'src/components/chat/AgentStatusStrip*.{ts,tsx}',
  'src/components/chat/BatchProgress*.{ts,tsx}',
  'src/components/chat/batchProgressViewModel*.ts',
  'src/components/chat/PlanStepsCard*.{ts,tsx}',
  'src/components/chat/TeamConfirmationsStrip*.{ts,tsx}',
  'src/components/chat/UserQuestionDock*.{ts,tsx}',
  'src/components/chat/UserQuestionCard*.{ts,tsx}',
  'src/components/chat/SkillProposalCard*.{ts,tsx}',
  'src/components/chat/SandboxRecoveryCard*.{ts,tsx}',
  'src/components/chat/MaxTurnsNoticeCard*.{ts,tsx}',
  'src/components/chat/ManagedProviderOfflineBar*.{ts,tsx}',
  'src/components/chat/IMInfoBar*.{ts,tsx}',
  'src/components/chat/SourceInfoBar.tsx',
  'src/components/chat/ConversationAppNotice.tsx',
  'src/components/chat/ConversationAppBadge.tsx',
  'src/components/chat/PromoteToProjectHint.tsx',
  'src/components/chat/QueuedMessagesStrip*.{ts,tsx}',
  'src/components/chat/ModelSelector*.{ts,tsx}',
  'src/components/chat/PermissionModeChip*.{ts,tsx}',
  'src/components/chat/ContextIndicator*.{ts,tsx}',
  'src/components/common/FolderSelector*.{ts,tsx}',
  'src/components/chat/ChatInput*.{ts,tsx}',
  'src/components/chat/ChatView*.{ts,tsx}',
  'src/components/chat/ChapterMenu*.{ts,tsx}',
  'src/components/chat/VoiceInputControl*.{ts,tsx}',
  'src/components/chat/ChapterRail*.{ts,tsx}',
  'src/components/chat/chapters*.ts',
  'src/components/chat/AppHome.tsx',
  'src/components/chat/ScenarioGuide.tsx',
  'src/components/chat/promptGrid.ts',
  'src/components/chat/chatSpacing.ts',
  'src/components/chat/UsageChip.tsx',
  'src/components/chat/ConvIdBadge*.{ts,tsx}',
  // Right panel, file by file (batch 5). PreviewPanel and the panel directory glob join in batch 8 with the in-place fullscreen.
  'src/components/panel/RightPanel*.{ts,tsx}',
  'src/components/panel/panelWidths*.ts',
  'src/components/panel/workspace/WorkspacePanel*.{ts,tsx}',
  'src/components/panel/workspace/TabStrip*.{ts,tsx}',
  'src/components/panel/workspace/SummaryBody.tsx',
  'src/components/panel/TaskProgressPanel*.{ts,tsx}',
  'src/components/panel/WorkspaceSection*.{ts,tsx}',
  'src/components/panel/FilesSection*.{ts,tsx}',
  'src/components/panel/ContextSection*.{ts,tsx}',
  'src/components/panel/useActiveToolCallLists*.ts',
  'src/components/panel/PreviewActionsMenu*.{ts,tsx}',
  'src/components/panel/VersionHistoryMenu*.{ts,tsx}',
  'src/components/panel/CodeMirrorEditor.tsx',
  'src/components/panel/codeMirrorTheme*.ts',
  'src/components/panel/previewToolbarConfig*.ts',
  'src/components/panel/previewFileActions*.ts',
  'src/features/reference/**/*.{ts,tsx}',
  'src/components/preview/**/*.{ts,tsx}',
  'src/components/panel/workspace/TerminalTab*.{ts,tsx}',
  'src/hooks/useTokenRevision*.ts',
  'src/components/panel/workspace/BrowserTab*.{ts,tsx}',
  'src/components/panel/workspace/SubagentTab*.{ts,tsx}',
  'src/components/panel/workspace/TeamTab*.{ts,tsx}',
  'src/components/panel/WorkspaceFileTree*.{ts,tsx}',
  // Settings window, file by file (batch 6). ToolboxModal (extensions, batch 7) and LanguageSection (unused) stay out, so no directory glob yet.
  'src/components/settings/SystemSettingsDialog*.{ts,tsx}',
  'src/components/settings/SystemSettingsModal*.{ts,tsx}',
  'src/components/settings/SettingsSectionHeader.tsx',
  'src/components/settings/settingsLayout.ts',
  'src/hooks/useBlockingApprovalVisible*.ts',
  'src/components/settings/sections/GeneralSection*.{ts,tsx}',
  'src/components/settings/sections/LabsSection*.{ts,tsx}',
  'src/components/settings/sections/PetSection*.{ts,tsx}',
  'src/components/settings/sections/SandboxSection*.{ts,tsx}',
  'src/components/settings/sections/ComputerUseGrantsCard*.{ts,tsx}',
  'src/components/settings/sections/CapabilitiesSection*.{ts,tsx}',
  'src/components/settings/sections/CapabilitySetupView*.{ts,tsx}',
  'src/components/settings/sections/ChromeConnectionCard.test.tsx',
  'src/components/settings/CapabilitySetupDialog*.{ts,tsx}',
  'src/components/settings/sections/NewBrowserPermissionCards*.{ts,tsx}',
  'src/components/settings/sections/NewBrowserSitePermissionsPage.test.tsx',
  'src/components/settings/sections/BrowserPermissionCards.tsx',
  'src/components/settings/sections/BrowserDownloadHistoryPage*.{ts,tsx}',
  'src/components/settings/sections/browserSitePermissionDraft*.ts',
  'src/components/settings/sections/browserDownloadHistoryProjection*.ts',
  'src/components/settings/SecretField*.{ts,tsx}',
  'src/components/settings/sections/AIServicesSection*.{ts,tsx}',
  'src/components/settings/sections/ai-services/ProviderCard*.{ts,tsx}',
  'src/components/settings/sections/WebSearchSection*.{ts,tsx}',
  'src/components/settings/sections/ImageGenSection*.{ts,tsx}',
  'src/components/settings/sections/ai-services/**/*.{ts,tsx}',
  'src/components/settings/sections/AccountSection*.{ts,tsx}',
  'src/components/account/**/*.{ts,tsx}',
  'src/components/settings/sections/EnterpriseSection*.{ts,tsx}',
  'src/components/settings/sections/IMChannelSection*.{ts,tsx}',
  'src/components/settings/sections/WeChatQRPanel.tsx',
  'src/components/settings/sections/WeChatQRPanel.test.tsx',
  'src/components/settings/SensitiveAuditDialog*.{ts,tsx}',
  'src/components/settings/sections/PersonalMemorySection*.{ts,tsx}',
  'src/components/settings/sections/SoulSection*.{ts,tsx}',
  'src/components/settings/sections/ProactivityPicker.tsx',
  'src/components/settings/sections/UsageSection*.{ts,tsx}',
  'src/components/settings/sections/DiagnosticSection*.{ts,tsx}',
  'src/components/settings/sections/diagnostic/**/*.{ts,tsx}',
  'src/components/settings/sections/FeedbackSection*.{ts,tsx}',
  'src/components/settings/sections/AboutSection*.{ts,tsx}',
  'src/components/settings/sections/AuthorSection*.{ts,tsx}',
  'src/components/settings/sections/VoiceInputSection*.{ts,tsx}',
  'src/components/settings/sections/index.ts',
  // Other pages, file by file (batch 7). customize/ and common/ keep legacy files, so no directory glob there.
  'src/components/toolbox/TopTabNav*.{ts,tsx}',
  'src/components/toolbox/SourceSubNav*.{ts,tsx}',
  'src/components/toolbox/ToolCard*.{ts,tsx}',
  'src/components/toolbox/ToolGrid*.{ts,tsx}',
  'src/components/toolbox/SourceBadge.tsx',
  'src/components/toolbox/extensionSource.ts',
  'src/components/common/AgentAvatar*.{ts,tsx}',
  'src/components/common/AvatarPicker*.{ts,tsx}',
  'src/components/common/PluginUpdateBadge.tsx',
  'src/components/team/TeamAvatar*.{ts,tsx}',
  'src/components/settings/ToolboxModal*.{ts,tsx}',
  'src/components/toolbox/ToolDetailModal*.{ts,tsx}',
  'src/components/toolbox/InstalledItemMenu*.{ts,tsx}',
  'src/components/toolbox/ToolboxCreateMenu*.{ts,tsx}',
  'src/components/toolbox/plugins/**/*.{ts,tsx}',
  'src/components/customize/SkillsSection*.{ts,tsx}',
  'src/components/customize/SkillEditor*.{ts,tsx}',
  'src/components/customize/SkillUploadModal*.{ts,tsx}',
  'src/components/customize/SkillHistoryModal*.{ts,tsx}',
  'src/components/customize/SkillDraftsPanel*.{ts,tsx}',
  'src/components/customize/SkillCategoryBlocksPanel*.{ts,tsx}',
  'src/components/customize/skillHistoryTime*.ts',
  'src/components/toolbox/skills/**/*.{ts,tsx}',
  'src/components/toolbox/cardFocus*.ts',
  'src/components/customize/MCPSection*.{ts,tsx}',
  'src/components/customize/MCPServerFormDialog*.{ts,tsx}',
  'src/components/customize/toolCountLabel*.ts',
  'src/components/toolbox/connectors/**/*.ts',
  'src/components/toolbox/windowHeight.ts',
  'src/components/team/TeamView*.{ts,tsx}',
  'src/components/customize/AgentsSection*.{ts,tsx}',
  'src/components/customize/AgentEditor*.{ts,tsx}',
  // The whole toolbox directory has migrated: files added to it later are checked from their first commit.
  'src/components/toolbox/**/*.{ts,tsx}',
]
export const DESIGN_SYSTEM_UI_FILES = [
  'src/components/ds/**/*.{ts,tsx}',
]

const ARBITRARY_VALUE = '\\b(bg|text|border|ring|fill|stroke|outline|divide|from|via|to|shadow|z|rounded|duration|ease)-\\['
const PALETTE_COLOR = '\\b(bg|text|border|ring|fill|stroke|outline|divide|from|via|to|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]|\\b(bg|text|border|ring|fill|stroke|outline|divide|from|via|to|shadow)-(black|white)\\b'
const HAND_WRITTEN_SCRIM = '\\bfixed\\b.*\\binset-0\\b|\\binset-0\\b.*\\bfixed\\b'
// A class name starts at the string start, after whitespace, after a variant colon, or
// after the important bang — never after a hyphen, so `drop-shadow-md` is not `shadow-md`.
const CLASS_START = '(^|[\\s:!])'
const CLASS_END = '(?![\\w-])'
const LEGACY_CLASS_PATTERNS = [
  [`${CLASS_START}-?(bg|text|border|ring|outline|fill|stroke|divide|from|via|to)-(background|foreground|card|card-foreground|popover|popover-foreground|primary|primary-foreground|secondary|secondary-foreground|muted|muted-foreground|accent|accent-foreground|destructive|input|border|ring|sidebar[a-z-]*|chart-[1-5])${CLASS_END}`, 'Design system: shadcn color names are legacy. Use a semantic token (bg-surface, text-label-secondary, bg-emphasis…).'],
  [`${CLASS_START}text-(minor|h-xs|h-sm|h-md|h-lg|h-xl)${CLASS_END}`, 'Design system: legacy font-size token. Use text-title-lg / text-title / text-ui / text-ui-sm / text-caption, or text-body / text-h1..h3 / text-mono for content.'],
  [`${CLASS_START}rounded(-(t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(-(xs|sm|md|lg|xl|2xl|3xl|4xl))?${CLASS_END}`, 'Design system: use rounded-window / rounded-panel / rounded-control (or rounded-full).'],
  [`${CLASS_START}-?z-([0-9]+|auto)${CLASS_END}`, 'Design system: use z-sticky / z-popover / z-dialog / z-toast / z-tooltip.'],
  [`${CLASS_START}duration-([0-9]+|initial)${CLASS_END}`, 'Design system: use duration-fast / duration-base / duration-slow.'],
  [`${CLASS_START}shadow(-(2xs|xs|sm|md|lg|xl|2xl|inner))?${CLASS_END}`, 'Design system: use shadow-panel / shadow-float / shadow-dialog.'],
  [`${CLASS_START}ease-(linear|in|out|in-out)${CLASS_END}`, 'Design system: use ease-enter / ease-exit.'],
  // No variant colon here: data-[state=…]:animate-in is the required form.
  ['(^|[\\s!])animate-in(?![\\w-])', 'Design system: the legacy global .animate-in rule overrides a bare animate-in. Use data-[state=…]:animate-in.'],
]

const DESIGN_VALUE_SELECTORS = [
  { selector: `Literal[value=/${ARBITRARY_VALUE}/]`, message: 'Design system: use a token class (bg-surface, text-label, z-popover, rounded-panel…) instead of an arbitrary value.' },
  { selector: `TemplateElement[value.raw=/${ARBITRARY_VALUE}/]`, message: 'Design system: use a token class instead of an arbitrary value (template literal).' },
  { selector: `Literal[value=/${PALETTE_COLOR}/]`, message: 'Design system: Tailwind palette colors are not part of the design system. Use a semantic token.' },
  { selector: `TemplateElement[value.raw=/${PALETTE_COLOR}/]`, message: 'Design system: Tailwind palette colors are not part of the design system (template literal).' },
  { selector: `Literal[value=/${HAND_WRITTEN_SCRIM}/]`, message: 'Design system: do not hand-write a full-window scrim. Use Dialog from @/components/ds/dialog.' },
  { selector: `TemplateElement[value.raw=/${HAND_WRITTEN_SCRIM}/]`, message: 'Design system: do not hand-write a full-window scrim (template literal).' },
  ...LEGACY_CLASS_PATTERNS.flatMap(([pattern, message]) => [
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
  patterns: [{ group: ['@radix-ui/*'], message: 'Design system: use the wrappers in @/components/ds.' }],
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
      // Typography guardrail — enforce the 8-token font-size scale (index.css
      // `--text-*`). Ban arbitrary `text-[Npx]` and Tailwind default named
      // sizes so the whole app stays on one scale. Both are at zero after the
      // 2026-07 migration; this keeps them there. Use text-caption/minor/body
      // /h-xs/h-sm/h-md/h-lg/h-xl. (Colors are intentionally NOT covered yet —
      // link/status colors are still raw Tailwind, a separate follow-up.)
      // Semantic-color guardrail — enforce the --abu-{danger,warning,success,
      // info,link} token scale (index.css). Ban raw Tailwind status/link hues
      // in text/bg/border/ring/fill so link + status colors stay tokenized and
      // theme-aware. Neutral grays and categorical hues (purple/teal) are NOT
      // covered. See CLAUDE.md §6.2.
      'no-restricted-syntax': ['error', ...TYPOGRAPHY_SELECTORS, ...STATUS_COLOR_SELECTORS],
    },
  },
  {
    files: DESIGN_SYSTEM_UI_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...DESIGN_TYPOGRAPHY_SELECTORS, ...DESIGN_VALUE_SELECTORS],
    },
  },
  {
    files: DESIGN_SYSTEM_MIGRATED_FILES,
    ignores: ['src/components/ds/**'],
    rules: {
      'no-restricted-syntax': ['error', ...DESIGN_TYPOGRAPHY_SELECTORS, ...DESIGN_VALUE_SELECTORS, ...DESIGN_STRUCTURE_SELECTORS],
      'no-restricted-imports': ['error', DESIGN_IMPORT_RESTRICTION],
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
      'no-restricted-syntax': ['error', ...TYPOGRAPHY_SELECTORS, ...STATUS_COLOR_SELECTORS, ...TEST_DETERMINISM_SELECTORS],
    },
  },
  // Test files inside the design-system lists: the test block above replaces
  // no-restricted-syntax wholesale, so repeat the design selectors next to the
  // determinism selectors for files that match both.
  {
    files: DESIGN_SYSTEM_UI_FILES.map((glob) => [glob, 'src/**/*.test.{ts,tsx}']),
    rules: {
      'no-restricted-syntax': ['error', ...DESIGN_TYPOGRAPHY_SELECTORS, ...DESIGN_VALUE_SELECTORS, ...TEST_DETERMINISM_SELECTORS],
    },
  },
  {
    files: DESIGN_SYSTEM_MIGRATED_FILES.map((glob) => [glob, 'src/**/*.test.{ts,tsx}']),
    ignores: ['src/components/ds/**'],
    rules: {
      'no-restricted-syntax': ['error', ...DESIGN_TYPOGRAPHY_SELECTORS, ...DESIGN_VALUE_SELECTORS, ...DESIGN_STRUCTURE_SELECTORS, ...TEST_DETERMINISM_SELECTORS],
    },
  },
])
