# Abu (阿布) — AI Desktop Office Assistant

## Project Overview
Local AI office assistant desktop app built with Tauri 2.0 + React + TypeScript.
Inspired by Claude Code's Cowork mode. Features multi-agent architecture with extensible Skills and Subagents.

## Tech Stack
- **Desktop**: Tauri 2.0 (Rust + Web)
- **Frontend**: React 18 + TypeScript (strict) + TailwindCSS v4 + Vite
- **LLM**: Anthropic API (Claude) via `@anthropic-ai/sdk`
- **State**: Zustand + Immer + persist middleware
- **Tools**: MCP Protocol (`@modelcontextprotocol/sdk`)
- **Icons**: Lucide React
- **Markdown**: react-markdown + remark-gfm + react-syntax-highlighter (Prism)
- **Test**: Vitest + happy-dom
- **Lint**: ESLint v9 flat config + typescript-eslint

## Git Workflow & Development Constraints

### Branches
- **`main`**: Stable release branch. **禁止直接在 main 上开发或 push commit**，只接受从 `dev` 的 merge。
- **`dev`**: 日常开发分支，所有工作在这里进行。

### Before Starting Work (每次开始工作前必做)
1. `git branch --show-current` — 确认当前分支。如果在 `main`，先 `git checkout dev`。
2. `git pull origin dev` — 拉取最新代码，避免冲突。

### Commit Rules
- **Conventional commits**: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`。
- **Commit frequently** — 每个有意义的变更单独提交，不要积累大的未提交 diff。
- **No auto commit/push**: 不要自动 commit 或 push，等用户手动确认。

### Pre-commit Checks (提交前必须通过)
1. `npm run build` — TypeScript 编译无错误。
2. `npm run lint` — ESLint 无错误。
3. 如果改动涉及核心逻辑，跑 `npm test` 确认测试通过。

### Release Process (发版流程)
1. 确保 `dev` 分支 CI 全绿（build + lint + test）。
2. **三处版本号必须同步更新**：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。
3. `git checkout main && git merge dev` — 合并到 main。
4. `git tag vX.Y.Z` — 打 tag，格式为 `v` + 语义化版本号。
5. `git push origin main --tags` — 推送 main 和 tag。
6. 在 GitHub 创建 Release，附上 changelog。

### Forbidden
- ❌ 直接在 `main` 上 commit 或 push。
- ❌ `git push --force` 到 `main` 或 `dev`（除非用户明确要求）。
- ❌ 提交未通过 build 的代码。
- ❌ 跳过 pre-commit 检查（`--no-verify`）。

## Key Commands
- `npm run dev` — Start Vite dev server (frontend only)
- `npm run tauri dev` — Start full Tauri desktop app
- `npm run build` — Build frontend (`tsc -b && vite build`)
- `npm run tauri build` — Build desktop app bundle
- `npm test` — Run tests once (`vitest run`)
- `npm run test:watch` — Watch mode
- `npm run test:coverage` — Coverage report
- `npm run lint` — ESLint check

## Architecture
```
src/
├── components/       # React UI components (by feature folder)
│   ├── chat/         # Chat view, message bubbles, markdown renderer
│   ├── common/       # Shared UI primitives
│   ├── customize/    # Customization panels
│   ├── panel/        # Side panels
│   ├── preview/      # File preview
│   ├── schedule/     # Scheduled tasks
│   ├── settings/     # Settings modal & sections
│   ├── sidebar/      # Navigation sidebar
│   └── ui/           # shadcn-style base components
├── stores/           # Zustand state stores
├── core/             # Core engine (non-UI)
│   ├── llm/          # LLM adapter layer (Claude + OpenAI-compatible)
│   ├── agent/        # Agent loop (async function, not class)
│   ├── tools/        # Tool registry & built-in tools
│   ├── mcp/          # MCP client
│   ├── context/      # Context management & token estimation
│   ├── scheduler/    # Task scheduler
│   ├── session/      # Session management
│   └── skill/        # Skill loader
├── hooks/            # React hooks (named exports only)
├── i18n/             # Custom i18n system (zero-dependency)
├── types/            # TypeScript type definitions
├── utils/            # Pure utility functions
├── lib/              # Third-party wrappers (cn utility etc.)
└── test/             # Test setup & global mocks
```

---

## Development Principles

### 1. Language Convention
- **UI text**: Chinese (zh-CN). All user-facing strings go through i18n system.
- **Code**: English only — variable names, function names, comments, commit messages.
- **LLM system prompts**: Chinese.

### 2. TypeScript Strictness
- All strict mode options enabled (`strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`).
- `erasableSyntaxOnly` is enabled — **do NOT use** `enum` or `namespace` with runtime semantics. Use union types instead:
  ```ts
  // ✅ Good
  type Status = 'idle' | 'running' | 'completed' | 'error'
  // ❌ Bad
  enum Status { Idle, Running, Completed, Error }
  ```
- Use `Record<string, unknown>` instead of `any` for dynamic objects.
- Discriminated unions for polymorphic types (e.g. `MessageContent`, `StreamEvent`).

### 3. Import Convention
- Use `@/` path alias for all internal imports (maps to `src/`).
  ```ts
  import { useI18n } from '@/i18n'
  import { cn } from '@/lib/utils'
  ```
- Lucide icons: import individually, never import the entire package.

### 4. Component Rules
- **Function components only**, no class components.
- **One main export per file**, sub-components can be co-located in the same file if tightly coupled.
- **Props typed inline** in the function signature or as a local interface above the component:
  ```ts
  export default function MyComponent({ title, onClose }: { title: string; onClose: () => void }) { ... }
  ```
- **i18n**: Always use `const { t } = useI18n()` — never hardcode Chinese strings in JSX.
- **Icons**: Lucide React, rendered with explicit size classes (`className="h-4 w-4"`).
- **Class merging**: Use `cn()` from `@/lib/utils` for conditional className composition.
- **Pure helper functions** for data transformation should be defined outside the component.

### 4.1 UI Component Library (MANDATORY)
All form controls **MUST** use components from `src/components/ui/`. **Do NOT** hand-roll `<input>`, `<textarea>`, `<select>`, or toggle switches with inline styling.

- **Select** (`@/components/ui/select`): Use `variant="default"` for form fields (full-width), `variant="inline"` for compact settings rows.
  ```tsx
  import { Select } from '@/components/ui/select';
  <Select value={v} options={opts} onChange={setV} />                // form field
  <Select variant="inline" value={v} options={opts} onChange={setV} /> // settings row
  ```
- **Toggle** (`@/components/ui/toggle`): Use `size="sm"` for lists, `size="md"` for forms, `size="lg"` for settings pages. Supports `disabled` prop.
  ```tsx
  import { Toggle } from '@/components/ui/toggle';
  <Toggle checked={on} onChange={() => setOn(!on)} size="lg" />
  ```
- **Input** (`@/components/ui/input`): Drop-in replacement for `<input>`. Override styles via `className`.
  ```tsx
  import { Input } from '@/components/ui/input';
  <Input type="text" value={v} onChange={e => setV(e.target.value)} placeholder="..." />
  ```
- **Textarea** (`@/components/ui/textarea`): Drop-in replacement for `<textarea>`.
- **Button** (`@/components/ui/button`): Use CVA variants (`default`, `secondary`, `ghost`, `outline`, `destructive`, `link`) and sizes (`xs`, `sm`, `default`, `lg`, `icon`, `icon-xs`, `icon-sm`, `icon-lg`).
- **Tooltip** (`@/components/ui/tooltip`): Radix-based tooltip.
- **ScrollArea** (`@/components/ui/scroll-area`): Radix-based custom scrollbar.

**Violations**: Do NOT define local `CustomSelect`, inline toggle `<button>` with `rounded-full translate-x-*`, or raw `<input>` with hand-rolled focus/border styles. If a UI component is missing a needed variant, **extend the component in `ui/`** rather than hand-rolling a one-off.

### 5. State Management (Zustand)
- All stores use `persist` middleware with `partialize` to whitelist persistent fields. Ephemeral UI state must be excluded.
- **Split interfaces**: Separate `XxxState` (data) and `XxxActions` (methods) interfaces, combined into `XxxStore`:
  ```ts
  interface ChatState { conversations: Conversation[]; activeId: string | null }
  interface ChatActions { addMessage: (msg: Message) => void }
  type ChatStore = ChatState & ChatActions
  ```
- **Complex stores**: Use `immer` middleware for mutable-style updates.
- **Simple stores**: Plain `set()` calls without immer.
- **Outside React**: Use `useXxxStore.getState()` for imperative access in core modules (e.g. agent loop).
- **Derived state**: Export selector hooks alongside the store (`useActiveConversation`, etc.).
- **ID generation**: `Date.now().toString(36) + Math.random().toString(36).substring(2, 8)`.
- **Module-level singletons** for non-reactive state (e.g. `AbortController` maps).
- **Persist versioning**: Every store using `persist` middleware MUST have a `version: N` field.
  When changing a persisted store's schema (adding/removing/renaming/retyping fields):
  1. Increment `version`
  2. Add `migrate` function with `if (version < N)` branch
  3. Update `storeVersions.test.ts` registry
  4. Zustand calls migrate once — function must handle full chain (v0→v1→v2→...→N)

### 6. Styling (TailwindCSS v4)
- TailwindCSS v4 via `@tailwindcss/vite` plugin — **no `tailwind.config.js` file**.
- Dark theme as default design direction.
- Custom colors use hex literals in class strings (`bg-[#faf9f5]`, `text-[#29261b]`).
- Custom CSS classes (`btn-ghost`, `btn-claude-primary`, `streaming-cursor`) defined in global CSS files.

### 7. Core Module Patterns
- **Interface-first design**: Define interfaces before implementations (e.g. `LLMAdapter` interface → `ClaudeAdapter` / `OpenAICompatibleAdapter`).
- **Custom error classes** with classification (`LLMError` with `code`, `retryable`, `retryAfterMs`).
- **Streaming via event callbacks**: `onEvent: (event: StreamEvent) => void` pattern, not observables.
- **Agent loop is a plain `async` function**, not a class — called imperatively.
- **Tool definitions are object literals**, not classes. Each has `name`, `description`, `inputSchema`, and an async `execute` function.
- **`Promise.allSettled`** for parallel tool execution.
- **`withRetry`** for exponential backoff with `AbortSignal` cancellation support.

### 8. Hook Patterns
- **Named exports only** — no default exports for hooks.
- **Dual ref pattern** for performance-critical state: `useRef` for callback reads + `useState` for React renders.
- **Observer-based DOM watching**: `MutationObserver` + `ResizeObserver` with RAF debouncing.
- **Passive event listeners** (`{ passive: true }`) on scroll/touch handlers.
- **Cleanup all side effects** in `useEffect` return — observers, listeners, animation frames, Tauri unlisten functions.
- **`useCallback`** to stabilize callback references passed as props.
- **`useSyncExternalStore`** to bridge non-React external state (agent loop dialog state) into React.

### 9. i18n System
- Fully custom, zero-dependency, backed by `useSyncExternalStore`.
- **`TranslationDict` interface** in `src/i18n/types.ts` defines the complete type-safe shape. Both `zh-CN.ts` and `en-US.ts` must satisfy this interface.
- **Adding new text**: Add the key to `TranslationDict` first, then add translations to both locale files.
- **Outside React**: Use `getI18n()` for non-component code.
- **Interpolation**: `format(template, { key: value })` for `{placeholder}` patterns.

### 10. Type Definitions
- **Barrel file**: `src/types/index.ts` exports core domain types. Feature-specific types in separate files (`execution.ts`, `schedule.ts`, etc.).
- **Union types over enums**: `type Status = 'idle' | 'running'` not `enum`.
- **Discriminated unions**: For polymorphic types, use a `type` discriminator field.
- **Metadata pattern**: Separate metadata interface + full interface extending it (`SkillMetadata` → `Skill extends SkillMetadata`).

### 11. Testing
- **Vitest** with `happy-dom` environment. Config in `vitest.config.ts`.
- **Test files co-located** next to source: `chatStore.ts` → `chatStore.test.ts`.
- **Global mocks** in `src/test/setup.ts`: All Tauri APIs and external SDKs are mocked globally.
- **Store tests**: Call `useXxxStore.setState({...})` in `beforeEach` to reset. Test via `useXxxStore.getState().action()` — no React rendering needed.
- **Timer tests**: Use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`, not `runAllTimers`.
- **Structure**: `describe('feature') > describe('action') > it('description')`.
- **Coverage**: `v8` provider, `src/components/` excluded.

### 12. File System & OS Access
- Use Tauri plugin APIs (`@tauri-apps/plugin-fs`, `@tauri-apps/plugin-shell`, etc.) for all file system and OS operations.
- Never use Node.js `fs` or `child_process` — this is a Tauri app, not an Electron/Node app.

### 13. Cross-Platform (macOS + Windows)
- **Target platforms**: macOS (primary), Windows (supported). Linux may be added later.
- **Platform detection**: Use `src/utils/platform.ts` singleton (`isWindows()`, `isMacOS()`, `getPlatform()`). Initialized once at app startup via `initPlatform()`.
- **Path handling**: Always use `src/utils/pathUtils.ts` helpers (`normalizeSeparators`, `joinPath`, `getBaseName`, `getParentDir`). Internally all paths use `/` as separator — never hardcode `\` or assume a specific separator.
- **Shell commands**: Platform-aware safety rules live in `commandSafety.ts`. When adding new safe/dangerous patterns, add both Unix and Windows variants.
- **File system paths**: Use Tauri path APIs (`homeDir`, `appDataDir`, etc.) — never hardcode `/Users/` or `C:\Users\`.
- **Keyboard shortcuts**: Use `Cmd` on macOS, `Ctrl` on Windows. Use `platform.ts` to pick the correct modifier at runtime. Display shortcut hints via i18n so they adapt per platform.
- **Sensitive paths**: Both macOS and Windows blocked paths are maintained in `pathSafety.ts`. When adding new blocked paths, add entries for both platforms.
- **Temp directories**: macOS uses `/tmp`, Windows uses `~/AppData/Local/Temp` — handled in `pathSafety.ts` whitelists.
- **Shell**: macOS uses `zsh`/`bash`, Windows uses `cmd`/`powershell`. Tool execution code must not assume a specific shell.

### 14. Do NOT
- Do not use `any` — use `unknown` or proper types.
- Do not use `enum` or `namespace` with runtime semantics.
- Do not use Node.js built-in modules directly.
- Do not hardcode Chinese strings in components — use i18n.
- Do not use `index.css` or inline `<style>` blocks — use Tailwind classes.
- Do not add default exports to hook files.
- Do not create new Zustand stores without `persist` middleware (unless the store is purely ephemeral by design).
- Do not use `jest` syntax (`jest.fn()`, `jest.mock()`) — use Vitest (`vi.fn()`, `vi.mock()`).
- Do not hand-roll form controls (select, toggle, input, textarea) — always use `src/components/ui/` components. If a variant is missing, extend the UI component.
