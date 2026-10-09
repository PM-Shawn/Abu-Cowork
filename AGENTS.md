# Abu (阿布) — AI Desktop Office Assistant

> **本文件是本仓库 AI 协作规范的唯一事实源（source of truth），Claude Code 与 Codex 共同遵循。**
> Codex 直接读本文件；Claude Code 读同目录 `CLAUDE.md`，后者用 `@AGENTS.md` 把本文件整篇导入。
> 任何规范改动只改本文件，不要维护第二份拷贝。仅 Claude Code 或仅 Codex 独有的少量差异，才分别写进各自入口文件的增量区。
>
> 父目录 `../AGENTS.md` 有跨端共享上下文（Abu 产品全景、与 console 控制台的关系、两仓库 git 分开/勿合并/脱敏约定、模型路由分档）。

## Project Overview
Local AI office assistant desktop app built with Electron + React + TypeScript.
Inspired by Claude Code's Cowork mode. Features multi-agent architecture with extensible Skills and Subagents.

## Tech Stack
- **Desktop**: Electron main/preload + isolated web renderer; Tauri remains only as the v0.34 migration/rollback compatibility path
- **Frontend**: React 19 + TypeScript (strict) + TailwindCSS v4 + Vite
- **LLM**: Anthropic API (Claude) via `@anthropic-ai/sdk`
- **State**: Zustand + Immer + persist middleware
- **Tools**: MCP Protocol (`@modelcontextprotocol/sdk`)
- **Icons**: Lucide React through `src/components/ds/icons.ts`
- **Markdown**: react-markdown + remark-gfm + react-syntax-highlighter (Prism)
- **Test**: Vitest (`node` env by default; DOM tests opt in with `// @vitest-environment happy-dom`)
- **Lint**: ESLint v10 flat config + typescript-eslint

## Git Workflow & Development Constraints

### Branches
- **`main`**: Stable release branch. **禁止直接在 main 上开发或 push commit**，只接受从 `dev` 的 **merge**（不是 cherry-pick，见下方红线）。
- **`dev`**: 日常开发分支，所有工作在这里进行；**永远是唯一集成线**，其他开发者从 `dev` 拉、开 feature 分支、PR 回 `dev`。
- **`refactor-dev`**: Electron 重构期间的历史集成指针，已完成使命并退役。不得再从它创建新分支；保留相关 worktree 只是为了保护历史报告和未提交材料。

- 🔴 **发版只用 `git merge --ff-only dev`，绝不 cherry-pick dev→main**。cherry-pick 会把同一改动复制成"内容一样、SHA 不同"的孪生 commit，两条分支历史发散 → 下次 merge 满屏假冲突 → 逼你继续 cherry-pick → **雪球债**（2026-07 已滚到 dev/main 分叉 223/124，靠一次收敛合并才解开）。main 始终是 dev 的历史子集，保留同一 SHA 才能避免再次分叉。
- 🔴 **`main` 没有"特殊内容"**：企业实现不靠维护一条特殊公开分支来隔离，而是只存在于私有 sibling 仓库，并在企业构建时注入。`dev` 到 `main` 仍走同一条集成历史，禁止用 cherry-pick 制造分叉。

### Before Starting Work (每次开始工作前必做)
1. `git branch --show-current` — 确认当前分支；禁止在 `main`、`refactor-dev` 或历史 Electron worktree 上开始新开发。
2. `git fetch origin dev` — 刷新唯一集成线；新 feature/fix 分支必须从最新 `origin/dev` 创建。

### Commit Rules
- **Conventional commits**: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`。
- **Commit frequently** — 每个有意义的变更单独提交，不要积累大的未提交 diff。
- **No auto commit/push**: 不要自动 commit 或 push，等用户手动确认。

### Pre-commit Checks (提交前必须通过)
1. `npm run build` — TypeScript 编译无错误。
2. `npm run lint` — ESLint 无错误。
3. 如果改动涉及核心逻辑，跑 `npm test` 确认测试通过。

### Release Process (发版流程)

> 📋 **照着发版用一页清单** [`RELEASE-CHECKLIST.md`](./RELEASE-CHECKLIST.md)（从上跑到下）。下面是同一流程的细节与理由。

1. 确保 `dev` 分支 CI 全绿（build + lint + test）。
2. **版本号在 `dev` 上 bump，三处同步**：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`（顺带 `src-tauri/Cargo.lock` 里 `name = "abu"` 那条）。（版本号跟着 dev 流到 main，不再出现 dev/main 版本错位。）
   - 📦 **`package-lock.json` 的两个 `version` 字段也要跟着 bump**：bump 完 `package.json` 后跑 `npm install --package-lock-only`，应该只出 2 行 diff、没有依赖变化。忘了它不会当场报错，但之后任何人一跑 `npm install` 都会被 npm 顺手改回来，把这 2 行无关 churn 漏进别人的 PR。`release:check` 现在会拦这个。
   - 🌐 **更新日志双语双维护（语言分流）** —— 每次发版在 `dev` 上把该版条目**两份都写好**，语言不混：
     - **`CHANGELOG.md`（英文 canonical）** → 驱动 **GitHub Release**（CI「Create GitHub Release」步抽该版段）+ latest.json 的 `notes`（英文默认，给 Tauri updater 和国际用户）。
     - **`CHANGELOG.zh-CN.md`（中文）** → 驱动 latest.json 的 `notes_i18n["zh-CN"]`。
     - CI publish job 把两份各抽该版段写进 `latest.json.notes_i18n`；**客户端 `checker.ts` 按 UI locale（`getLocale()`）选对应语言**推给更新弹窗，官网按页面语言取。
     - ⚠️ 两份同版号、结构对应，但**语言不混**：CHANGELOG.md 全英文、CHANGELOG.zh-CN.md 全中文。v0.31.0 之前的历史仅英文版有，不用回填。
   - ✅ **发版前跑 `npm run release:check`**（`scripts/release-preflight.mjs`）：校验五个文件的版本号一致（`package.json`、`package-lock.json` 的两个字段、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock`）+ 两份 CHANGELOG 该版段都在且语言正确（英文版无 CJK、中文版有中文）+ `sidecar/src/shims/` 下含 `throw` 语句的文件都写明了分类，并且没有一个是 `feature-gap`（分类含义见 `sidecar/src/shims/shimThrowKind.ts`）。CI 也把它挂成 `release.yml` 的 `preflight` job（tag 一推先跑，**任一项不对就整个发版红、包都不出**）；本地先跑省一次 CI 往返。
3. 在 `dev` 的候选提交上打一个最终 RC tag；等三平台原生构建、签名/公证、安装态冒烟和发布预检全部通过。
4. `git checkout main && git pull --ff-only origin main && git merge --ff-only dev` — `main` 只 fast-forward 到这个已经在 `dev` 验证过的**同一 SHA**，不使用 GitHub squash/rebase/cherry-pick 生成孪生提交。
5. `git push origin main`，然后 `git tag vX.Y.Z && git push origin vX.Y.Z`。主分支保护要求该 SHA 先在 `dev` 上获得 `promotion-ready`，任意 feature/main 直推都会被拒绝。⚠️ **别用 `git push origin main --tags`**。
6. `Release` workflow 自动构建三平台，准备一个 draft GitHub Release，上传并回读校验 OSS 产物，发布三套 Electron 更新源，并在 v0.34 中最后切换旧 Tauri 更新入口；全部成功后才公开同一个 Release。不要手工创建重复 Release。
7. 发布后验证 `git rev-list --left-right --count origin/dev...origin/main` 的 main-only 计数为 `0`；正式发布时两者应为 `0 0`。

**热修（hotfix）也不许 cherry-pick**：可以从对应 tag 拉 `release/vX.Y` 分支定位和修复，但修复必须先通过 PR 进入 `dev`，再按上面的同-SHA fast-forward 流程发布。目标永远是“任何进过 main 的提交，已经先存在于 dev”。

### Release Notes Convention (核心要点)
- **分档**：patch（vX.Y.Z++）用极简模板（根因 + 修复 2-3 行）；minor（vX.Y.0）用完整模板（Features / Fixes / English Summary）；major（vX.0.0）额外加 Migration Notes。
- **Title**：`vX.Y.Z` 或 `vX.Y.Z — 一句话主题`。patch 选最重要的特征当副标题，让 release 列表能扫读。
- 🌐 **双语双维护（语言分流，不再单文件混写）**：`CHANGELOG.md` 全英文、`CHANGELOG.zh-CN.md` 全中文，同版号两份都写；CI 按 locale 喂 `latest.json.notes_i18n`，客户端/官网按用户语言取。详见上文 Release Process 第 2 步。
- **写"为什么"**：哪怕 patch 也至少给一句"用户会看到的变化"，禁止 "See assets below" 这种空 release。
- **数字即证据**：能给数字给数字（"9 处子进程 spawn"、"TTL 从 5s 延到 30s"），不要"大幅优化"这种空话。
- **emoji**：patch 标题不加；minor+ 分区图标可加（✨ Features / 🐛 Fixes / 🪟 Windows-only）。

完整模板和示例见 [`RELEASING.md`](./RELEASING.md)。

### Forbidden
- ❌ 直接在 `main` 上 commit 或 push。
- ❌ **cherry-pick `dev`→`main`**（发版/热修一律走 merge；热修用 `release/vX.Y` 分支再合回 dev，见 Release Process）。
- ❌ 从 `main` 或已退役的 `refactor-dev` 创建普通 feature/fix 分支。
- ❌ `git push --force` 到 `main` 或 `dev`（除非用户明确要求）。
- ❌ 提交未通过 build 的代码。
- ❌ 跳过 pre-commit 检查（`--no-verify`）。

### Observability Keys (Langfuse) — 防泄露红线
- Langfuse 观测靠 `VITE_LANGFUSE_PUBLIC_KEY` / `VITE_LANGFUSE_SECRET_KEY` / `VITE_LANGFUSE_BASE_URL`，**只放 `.env.local`**（已 gitignore），绝不提交、绝不硬编码到源码。
- 缺 key 时观测自动 no-op（`src/core/observability/langfuse.ts` 的 `getLangfuse()` 返回 `null`）。**开源版默认零采集**——这是开源/隐私底线，不要破坏。
- 🔴 **绝不用带 `.env.local` 的本机环境打“对外分发”包**：`VITE_*` 会在 build 时编进前端 bundle，任何人都能从安装包里扒出 key。官方发布只走 CI（无 `.env.local`）才安全；本机 `npm run dist:electron` 出的包仅供自用，不可分发。
- 真要做面向终端用户的线上遥测（Phase B）必须：**opt-in + 服务端中转（secret key 不下发客户端）+ 脱敏**。

### Enterprise 代码隔离 — 防泄露红线（open-core）

本仓库是**公开仓库**（`github.com/PM-Shawn/Abu-Cowork`）。企业版走 open-core：核心开源，企业闭源能力在**单独的私有仓库** `Abu-enterprise-modules`（sibling 目录），构建期由 `vite.config.ts` 按 `ABU_BUILD_TARGET` 把 `@enterprise-modules` 别名切到私有仓库（enterprise）或 `src/enterprise-modules-stub`（oss）。完整说明见 [`docs/ENTERPRISE-BUILD.md`](./docs/ENTERPRISE-BUILD.md)。

加企业能力时**必须劈成两半**：

- ✅ **公开仓库（本仓）只放「形状」**：扩展点接口、空插槽、编译期转发文件、OSS no-op stub，以及 `ABU_BUILD_TARGET` 构建开关。公开代码可以定义宿主需要的稳定类型，但不能实现企业工作流。
- 🔒 **私有仓库 `Abu-enterprise-modules` 放全部客户端企业实现**：登录/绑定、SSO、token、心跳、品牌、License、策略、LiteLLM 网关与模型、Skills/MCP/知识库、迁移和员工 UI。私有入口在企业构建中注册组件并提供运行时适配器。
- 🔴 **公开仓库不得保留“协议层实现”作为例外**：`src/core/enterprise/` 只能保留类型、挂载注册表和转发到 `@enterprise-modules` 的薄文件；`src/enterprise-modules-stub` 只能返回个人模式默认值。任何网络请求、凭证持久化、策略判断或企业 UI 都属于私有仓库。
- 🔴 **`npm run build` / `npm test` 全绿 ≠ 没泄露**——这是保密违规，工具链抓不到。一旦闭源逻辑进了本仓 commit 并 push，git 历史里**洗不掉**。`npm run electron:dev` 看不到企业功能是正常的；企业功能开发和验收统一使用 `npm run electron:dev:enterprise`（需私有仓库在 sibling 位置）。

## Key Commands
- `npm run dev` — Start Vite dev server (frontend preview only; not desktop acceptance)
- `npm run setup:electron-dev` — Prepare an OSS worktree's local Electron dependencies, runtimes, bridges, and native helpers
- `npm run setup:electron-dev:enterprise` — Prepare the same environment and build the Enterprise renderer
- `npm run electron:dev` / `npm run electron:dev:enterprise` — Rebuild the intended renderer and start the Electron desktop shell with dev-isolated data
- `npm run build` — Build frontend (`tsc -b && vite build`)
- `npm run dist:electron` — Build a local Electron package (not an official distributable)
- `npm test` — Run tests once (`vitest run`)
- `npm run test:watch` — Watch mode
- `npm run test:coverage` — Coverage report
- `npm run lint` — ESLint check
- `npm run parity:check` — Static guard on renderer API ↔ Electron host parity (not a substitute for real workflow tests)
- `npm run electron:test` / `npm run test:e2e:electron` — Electron unit + E2E
- `npm run pack:electron` / `npm run smoke:electron:packaged` — Package the Electron app and smoke-test the packaged build

> **验收纪律**：改动涉及 Electron 壳 / 打包 / 更新 / 权限 / 跨平台时，`npm run build`+`npm test` 全绿**不足以**验收 —— 打包、签名、更新、权限、Windows 行为必须在真实平台跑对应命令；未在真实 Electron 壳走完受影响用户路径前，不要声明"修好了"。浏览器预览、单测、renderer build 只是支撑门禁，不是桌面验收。不要在未获用户明确批准时发布更新源或 release 产物。

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
│   └── ds/           # Design-system component library (§6.1)
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

### Electron-Only Development Architecture (关键约束)
```
electron/main.cjs          # Main-process lifecycle + native services (privileged)
electron/preload.cjs       # The narrow, safe renderer bridge — capabilities cross here
electron/tauriHost.cjs     # Compatibility shim for existing Tauri-shaped renderer calls
electron/native-helper/    # Narrowly scoped native macOS helper
sidecar/                   # Node sidecar hosting agent/runtime work
src/                       # React renderer + product logic (NO direct Node/fs/shell)
```
- **Electron is the only desktop shell for new feature development, debugging, and acceptance.** `src-tauri/` remains only for compatibility with already-shipped versions, migration, and rollback evidence. **Never use a Tauri launch or build as evidence that a new feature is complete.**
- Grant renderer capabilities only by adding them through preload→main (or sidecar), validating inputs at the privileged boundary. Node built-ins belong in `electron/`+`sidecar/`, not `src/` (see §12).
- Tauri/Rust is a **frozen** compatibility + migration path. Preserve it where transition behavior still depends on it, but do not add new product behavior there and do not run it for normal development or acceptance. `src-tauri/gen/` is generated — change its source config and regenerate, don't hand-edit or discard a generated diff.

---

## Behavioral Principles

适用于非 trivial 任务（涉及多文件改动、状态/Tauri/i18n 三方耦合、新功能、行为类 bug）。**改 typo、调 padding、补一行注释这种小活，用判断力，不必套全套。**

### B1. Think Before Coding — 先暴露歧义，再动手

Abu 的功能动辄横跨 store 持久化 / Tauri / i18n / 跨平台路径，一个词在三处可能各有定义。**不要沉默选一个解释就开干。**

- **Assumptions explicit**：动手前一句话说清楚你在假设什么。"我假设你说的'清空'是指清掉 conversation 列表，不是清掉 message 内容" — 比改完再回滚便宜。
- **多个解释都摆出来**：如果用户的请求有 ≥2 种合理解读，列出来让 user 选，**不要默认挑一个就跑**。
- **不懂就停**：发现自己在猜，就停下问。"checkpoint 这块我没读过，要我先读 `src/core/session/` 再回答吗？"
- **Push back when warranted**：如果有更简单的方案，说出来。本文件 §14（Do NOT）已经禁了一堆过度抽象，但**简单方案的提议得你先开口**。

### B2. Goal-Driven Execution — 翻译成可验证目标，再循环

Abu 是 Electron 桌面端，每轮“改 → 重启 dev → 验证”的成本比 web 项目高。**给定可验证的成功标准 → 自循环到验证通过 → 再回报**，比“我改完了你跑跑看”省一个回合。

**把祈使句翻译成可验证目标**：

| 用户说 | 翻译成 |
|---|---|
| "修这个 bug" | 先写一个 reproduce 的测试（或最少描述出 reproduce 步骤），再改，然后跑测试验证 |
| "加个校验" | 先列非法输入 case，写测试或 dry-run，再让它过 |
| "重构 X" | 列出"前后行为应该一致"的检查点（测试 / 关键路径手动跑），改前改后都验证一遍 |

**多步任务前先列 plan**（每步带 verify）：

```
1. 改 chatStore 加 pinnedAt 字段 → verify: storeVersions.test.ts 通过
2. 在 ChatList 里读 pinnedAt → verify: electron:dev 跑一遍，置顶/取消置顶都点一次
3. 持久化迁移 → verify: 删 ~/Library/.../com.abu.app.dev 重启，老 conversation 不丢
```

**项目现成的验证手段优先用**：
- `npm run build` / `npm run lint` — 抓编译和静态错误（必跑）
- `npm test` — 抓已有行为回归（涉及 store、core/agent、core/skill 时必跑）
- `npm run electron:dev` — 抓行为类 bug（UI、IPC、跨平台路径必须在真实桌面壳跑）
- 打包、签名、更新、权限和 Windows 行为必须在相应真实平台验证

**没验证就不要说"修好了"**。build 全绿 ≠ 功能正确 — Abu 大量 bug 是行为类的（看近期 commit：批量整理对齐、草稿不显示、中文文件名 docx），build 抓不到。

### B3. Surgical Changes — 只动该动的

（与系统 prompt 头部的"bug fix doesn't need surrounding cleanup"互为补充）

- 改 A 的时候不要顺手"优化"旁边的 B，哪怕 B 写得很丑。
- 不要重构没坏的东西。匹配既有风格，哪怕你不喜欢。
- **发现无关的 dead code / 可疑代码 → 提一下，不要删**。先问，再动。
- 你的改动产生的 orphan（unused import / 变量）该删；**预先存在的 dead code 不归你管**。
- 测试：每一行 diff 都能直接追溯到用户的请求。追溯不到的，删掉再提交。

---

## Development Principles

### 1. Language Convention
- **UI text**: Chinese (zh-CN). All user-facing strings go through i18n system.
- **Code**: English only — variable names, function names, comments, commit messages.
- **LLM system prompts**: **English** (in transition — see below). The reply language
  is NOT set by the prompt language; it is controlled explicitly by the
  `response-language` section (`src/core/agent/prompts/responseLanguage.ts`), which is
  driven by the resolved UI locale (zh-CN → always Chinese; en-US → English, following
  the user's message language). So an English prompt still yields Chinese replies for
  Chinese users. When adding/editing agent prompts or tool descriptions, write them in
  English.
- **Transition status (prompt English-ization)**: P0 (output-language mechanism), P1 (tool
  `description` fields), P3 (UI-facing string i18n — tool result strings via the `toolResult`
  namespace, and `commandSafety` reasons/labels), **P2 (core agent behavior prompts)**, and
  **P4 (remaining user-visible result/status/template strings)** are all done. P2 covered
  `skillsGuidance.ts`, `agentLoop.ts` (default-soul + capability), `orchestrator.ts` (all
  system-prompt sections), the built-in agent `systemPrompt`s in `registry.ts`, the
  `PRESET_AGENTS` in `agentTools.ts`/`orchestrationTools.ts`, and the subagent system prompt
  in `subagentLoop.ts`. The orchestrator IM canned replies were rewritten as behavior
  instructions (the reply's language is handled by the response-language section, not a fixed
  string). Agent-picker metadata was already bilingual (per-field
  `displayNames`/`descriptions`/`*I18n` maps). P4 i18n'd (NOT hardcoded English — these are
  user-visible, so both locales stay correct): `mcpDiscovery.ts` catalog descriptions + env
  hints + result messages (`toolResult.system.mcpCatalog`/`mcpEnvHints`/`mcp*`),
  `projectRules.ts` rule-bundle headers + truncation markers + the per-locale ABU.md template
  + `/init` results (`toolResult.projectRules`), and the `agentLoop.ts`/`subagentLoop.ts`
  runtime status/error strings (`chat.*` + `chat.subagent.*`). The one P4 exception left in
  English is the context-compression hint injected into the volatile *system prompt*
  (`agentLoop.ts` `compression-hint`) — it is LLM-facing and never rendered, so it follows the
  English-prompt rule, not i18n.
- **🔴 Exception — do NOT English-ify these (they are UI-facing, not LLM-facing)**: tool
  runtime result strings (`execute()` returns/success/error messages — rendered directly
  in `ToolCallsGroup.tsx`), `commandSafety` reason/label strings (command-confirmation
  dialog), and agent-picker metadata. These must go through i18n (already done — via the
  `toolResult` namespace resolved at execution time, and the registry per-field locale
  maps), NOT become hardcoded English — translating to a single language regresses the
  other locale's users.

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
- Icons come from `@/components/ds/icons`.

### 4. Component Rules
- **Function components only**, no class components.
- **One main export per file**, sub-components can be co-located in the same file if tightly coupled.
- **Props typed inline** in the function signature or as a local interface above the component:
  ```ts
  export default function MyComponent({ title, onClose }: { title: string; onClose: () => void }) { ... }
  ```
- **i18n**: Always use `const { t } = useI18n()` — never hardcode Chinese strings in JSX.
- **Icons**: render icons only through `Icon` + `AppIcons` from `@/components/ds/icon` and `@/components/ds/icons` (`size` = `sm` 14 / `md` 16 / `lg` 20, stroke fixed at 1.5).
- **Class merging**: Use `cn()` from `@/lib/utils` for conditional className composition.
- **Pure helper functions** for data transformation should be defined outside the component.

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

  `storeVersions.test.ts` checks that the blob each store writes is at or above the registry's `minVersion`; since the store writes its own version, this catches a registry number above the code and never a code bump without a registry update. The guard that catches a forgotten bump is a test that writes a blob through the store and asserts its `version`.

  Zustand calls `migrate` for any stored version different from the code's, newer included, runs no block for a newer one and writes the blob back under the running build's version; an older build that opens a newer store therefore makes every `if (version < N)` block run again on the next start of the newer build. Blocks that reset a user choice (V42, V54 of `abu-settings`) accept this.

### 6. Styling (TailwindCSS v4)
- TailwindCSS v4 via `@tailwindcss/vite` plugin — **no `tailwind.config.js` file**.
- Every design token lives in `src/styles/tokens.css`, the type scale included (spec: workspace `docs/2026-09-28-design-system-brief.md`). See §6.1.
- `src/styles/index.css` holds no theme and no variable. It holds the imports, the scan's `@source not` lines, two variants (`@custom-variant dark`, which keys `dark:` off the `dark` class, and `@custom-variant hover`, which takes hover out of the `hover: hover` media query), the base layer, text selection, the scrollbar rules, the window drag regions and three motion rules (`block-expand*`, `update-progress-indeterminate`, the `petNotifFade` keyframes). No class is added to it.
- Tailwind generates a class only for the files it scans, and by itself it scans this checkout, comments included: a class spelled in a comment of a scanned file is generated. `index.css` keeps test files, Markdown, `tests/`, `scripts/`, `eslint.config.js`, `electron/` and `src-tauri/` out of the scan (`@source not`), and `scripts/designTokens.test.ts` holds the two host lines. The enterprise overlay's interface files are outside this checkout: `index.css` imports `@enterprise-modules/interface-classes.css`, where the overlay names them (`@source`); the stub's file of that name names none, so the personal stylesheet holds no class of the overlay (see Enterprise overlay).

### 6.1 Design system (MANDATORY)
The interface has one component library, `src/components/ds/`, and one token file, `src/styles/tokens.css`. The rules of this section apply to every file under `src/`. ESLint enforces four groups of them (`eslint.config.js`), and `scripts/eslintDesignRules.test.ts` pins where each group applies:

| Group | Bans |
|---|---|
| Sizes | an arbitrary font size (`text-[13px]`) and Tailwind's named sizes (`text-sm`…) |
| Values | arbitrary values (`bg-[…]`, `text-[…]`, `z-[…]`, `rounded-[…]`, `shadow-[…]`, `duration-[…]`); Tailwind palette colors (`gray-*`, `white`, …); a hand-written scrim (`fixed inset-0`); shadcn color names (`bg-background`, `text-muted-foreground`…); sizes outside the type scale (`text-minor`, `text-h-*`); Tailwind's own radius, z-index, duration, shadow and easing steps (`rounded-lg`, `z-50`, `duration-150`, `shadow-md`, `ease-out`); a bare `animate-in` |
| Structure | the raw `button`, `input`, `select` and `textarea` elements |
| Imports | `lucide-react`, `radix-ui` (subpaths and `@radix-ui/*` included), `cmdk` |

- Interface code, which is every file of `src/` outside the two cases below, gets all four groups.
- `src/components/ds/**` wraps the raw controls and the underlying libraries, so it gets the size and value groups only.
- `src/core/**`, `src/stores/**`, `src/i18n/**` and `src/eval/**` hold no JSX class names, and their English prose (prompt text, translations, test titles) uses "rounded" and "shadow" as words: the size, value and structure groups do not read them. The import restriction applies there as everywhere else.
- A test file gets the groups of the code beside it, together with the determinism rules of `TESTING.md` §3.
- Every TypeScript file of the repository, outside `src/` as well, is kept off arbitrary and named font sizes and off Tailwind's status and link hues by the base rules.

**Tokens and classes**

| Category | Classes |
|---|---|
| Surfaces | `bg-desk` `bg-surface` `bg-raised` `bg-code` `bg-field` `bg-scrim` |
| Fills | `bg-fill` `bg-fill-hover` `bg-fill-selected` `bg-fill-pressed` |
| Text | `text-label` `text-label-secondary` `text-label-tertiary` `text-label-placeholder` `text-link` |
| Primary action | `bg-emphasis` + `text-on-emphasis` |
| Status | `text-{success,warning,danger,info}` on `bg-{role}-soft` |
| Lines / focus | `border-separator` `border-control-border` `ring-focus` |
| Type | UI: `text-title-lg` `text-title` `text-ui` `text-ui-sm` `text-caption`; content: `text-body` `text-h1` `text-h2` `text-h3` `text-mono` `text-code-inline` (inline code inside message text); code font: `font-code` |
| Radius / shadow | `rounded-window` `rounded-panel` `rounded-control`; `shadow-panel` `shadow-float` `shadow-dialog` `shadow-composer` (the composer card only) |
| Layers / motion | `z-sticky` `z-fullscreen` `z-popover` `z-dialog` `z-toast` `z-tooltip`; `duration-fast` `duration-base` `duration-slow`; `ease-enter` `ease-exit` |
| Identity (avatar, app icon only) | `bg-brand` `text-brand-ink` |

Tailwind's own palette is off: `--color-*: initial` is the first declaration of `@theme inline` in `tokens.css`, so a palette class (`bg-gray-100`, `text-white`, `bg-black/40`) generates nothing, in this repository and in the private one. `cn` (`src/lib/utils.ts`) registers every token name of `tokens.css` under the property it sets, and `lib/utils.test.ts` holds a case per name; a new token is registered there in the same change.

Type: message text uses the content scale (`text-body`, `text-h1`..`text-h3`, `font-code text-mono`, `text-code-inline`). Everything else is UI text: the rest of the chat area, the right panel, the settings window and every page. The source editor and the terminal use the code scale (`--text-mono`, `--ds-font-mono`). Heading weight caps at 600 (`font-semibold`, which the title and heading sizes carry by themselves): never `font-bold`.

Appearance: a color class takes no `dark:` variant. Every token follows the appearance by itself (`tokens.css` gives each one its light and its dark value), so one class is right in both.

Third-party surfaces read `--ds-*` variables, so no component checks the appearance. Code highlighting takes its colors from `--ds-syntax-*` through `src/components/chat/syntaxTheme.ts`, CodeMirror through `src/components/panel/codeMirrorTheme.ts`, and xterm through `resolveTerminalTheme`, with `useTokenRevision` re-reading the variables when the appearance changes. `--ds-selection` is the neutral selected-text color (terminal, source editor, document previews) and `--ds-page-canvas` / `bg-page-canvas` the white paper of web pages and Word pages.

A frame cannot read a host variable. The widget kit (`core/widget/designSystem.ts`) therefore carries literal copies of the host's tokens, light and dark; `designSystem.test.ts` reads `tokens.css` and holds each copy to its token, so a token change is made in both files. `--w-primary` is the emphasis color and its text is `--w-primary-fg`; `--w-series-1..4` are a chart palette of their own. The `srcdoc` styles of `HtmlWidgetBlock` write literal colors for the same reason and keep the variable names widget authors use (`--abu-primary`, `--abu-text`, `--abu-bg`, `--abu-border`, `--abu-font`).

Guards: `scripts/designTokens.test.ts` fails if a token change breaks WCAG contrast in any of the four appearances (light, dark, and each with increased contrast). A status `Tag` (`text-{role}` on `bg-{role}-soft`) and a neutral one (`text-label-secondary` on `bg-fill`) keep 4.5:1 over `bg-surface` and over `bg-raised`, and the test checks both bases; `text-label-tertiary` on `bg-fill` is outside that check. Design-preview baselines come from the CI runner; a token change that moves a picture more than 1 % needs new baselines for that picture.

**Components**

Components live in `src/components/ds/` (spec §6.4). The tree renders inside `DesignSystemProvider`, which brings the tooltips, the layer manager that keeps one dialog and one menu or popover open at a time, and `useConfirm()`. A component that renders `FullscreenSurface` or calls `useConfirm`, and its tests, need the provider.

- A modal is a `Dialog`: it draws the scrim, as only `FullscreenSurface` also does, and asks before discarding `dirty` input. A confirmation is `useConfirm()`, never `window.confirm()`. Feedback is `InlineMessage` / `Toaster` / `EmptyState` / `LoadError`.
- Buttons: icon-only buttons are `IconButton` with a `label`; `IconButton variant="primary"` is the filled icon-only action (Send). `Pressable` (`@/components/ds/pressable`) is the button for targets whose look is their content; an icon-only `Pressable` sits in a `Tooltip` with its name, so the name shows on keyboard focus. A page's one `primary` is its 「添加」 button (the todos page: 「新建待办」; the inbox has none), card buttons are `secondary size="sm"`, and a window's `primary` is its main action.
- A group of settings is a `SettingGroup` of `SettingRow`s (title, one-line description, control). Dropdowns there are `Select fullWidth` inside a width wrapper from `settings/settingsLayout.ts`, with option explanations in `SelectOption.description`.
- Choices: a small, mutually exclusive choice inside a form is a `SegmentedControl` (`fullWidth`: equal shares; the automation editors' frequency, weekday, source, filter, output) or a `RadioGroup` (listen scope, extract mode); a choice from a list (hour, minute, skill, project, channel, push platform) and both autonomy choices (a task's and a listener's) are `Select`s. A closed `Select` never changes its value from a key press, and arrow keys only move the highlight, so it is the control for consequential choices as well. A `Select` shows its placeholder while the value it holds matches no option, and leaves the owner's value alone. It mounts its list only while open (a closed Radix list keeps every option and its listeners alive per select), so it closes without an exit fade; it is not remounted to get one.
- `MultiCombobox` is the multi-select with a search box: the choice is read from `aria-checked` (cmdk's `aria-selected` follows the highlight and is left alone), Enter or a click toggles one and the list stays open, and Space types into the search box. In `Combobox` and `MultiCombobox` Tab closes the list and keeps focus on the trigger. Option objects are stable (`useMemo`), and both pass one pick callback for the life of the list, because the rows are `memo`.
- A secret field that offers show / hide is `settings/SecretField`; a secret field that only masks is a `TextField type="password"` (IM App Secret). Neither puts the value anywhere but the input.
- `TextArea bare` is the editing area of a card that draws the box itself: no border, fill, focus ring, padding, minimum height or disabled look of its own. Its one user is the composer: `chat/InlineSkillInput` renders it while the message holds no skill tag, and an editable `div role="textbox"` with the tag as a `button` once it does; both carry `data-chat-composer`. The tag and its two caret marks are built by a layout effect with DOM calls, never as JSX, because the browser owns that subtree while the user types and an input method composes. The composer card (`shadow-composer`, `focus-within:border-control-border`) is the field's border and focus mark.
- `Checkbox` takes `aria-describedby` for an explanation shown beside it. `Tag` takes `title` and data attributes on its root. `AppIcons.offline` is the glyph for a service that cannot be reached. Avatar glyphs are `AvatarGlyphs` in `ds/icons.ts`; `core/team/avatarPresets.ts` maps the stored names to them, and no stored name is renamed or removed. A `Spinner size="sm"` label is `text-ui-sm`, or `labelSize="ui"` where it trades places with 13px words.
- A tooltip is no layer: Escape hides it and still acts on the layer underneath, for as long as its box is on the page, and focus moved by code after a pointer action opens no tooltip (after a key press it does).
- `Toaster` renders its own notification list (a labelled region whose `aria-live="polite"` area holds the list, newest first) and does not use Radix Toast, so a notice never takes Escape from an open dialog.
- Every floating root — portaled overlay content, scrims, and the notification list — carries `data-electron-no-drag`; `src/__tests__/overlayDragRegions.test.ts` guards this and holds the exact list of fixed overlay roots (`ds/dialog.tsx`, `ds/toaster.tsx`).
- Motion: an enter animation belongs to a state. ds layers use the `data-[state=…]:animate-in` forms; a bare `animate-in` is the enter animation of `tw-animate-css` and plays on every mount. Animated floating layers carry `data-ds-motion` and spinners `data-ds-spinner`, so reduced motion can stop them.
- When a dialog leaves with a menu still fading in it, Radix leaves `pointer-events: none` on `body`; `ds/layer-context.ts` clears it once no `[data-ds-layer]` remains, and it is the only code that writes `pointer-events` on `body`: page code never does.

Rendering: `App` renders for every piece of a streamed reply. Pages it re-renders (`ExtensionsView`, `TeamView`) are `memo` with no props and read stores through selectors; `InboxView`, `TodoView` and `SystemSettingsDialog` are `memo` with no props, so the settings window does not render with a streamed reply. `RightPanel` and `WorkspacePanel` are `memo` and read primitive selectors, so the panel does not re-render per streamed token. Cards in long grids are `memo` and mount no Tooltip, Menu or Select root, so `IconButton` is not used on cards. Todo and inbox rows mount none either: their icon-only buttons are `Pressable`s with an `aria-label` and no tooltip, and `TodoItem` is `memo` with handlers that stay the same between renders. The one row that owns a menu root is the sidebar project row (see Sidebar rows).

**Layers, approvals, focus and stacking**

Layers: a menu, select or popover opened inside a dialog sits on the dialog's level (`useFloatingLevel`), and every floating layer keeps 8px from the window edge. A dialog keeps rendering while it fades out and its content takes no pointer input then. A layer that is closing takes no Escape: the key acts on the top open layer. `Menu`, `ContextMenu`, `Popover`, `Combobox`, `MultiCombobox` and the discard question pass Escape on while they close (`useLayer().onEscapeKeyDown` → `registry.escapeTop()`). `LayerProvider.onModalChange` feeds `previewStore.dsModalOpen`, and it follows what is painted: a layer counts until it reports the end of its fade (`registry.left`), else until a look one fade later, repeated while `isPainted()` holds. A provider that leaves the page reports nothing, and one that mounts tells both listeners (`onModalChange`, `onDecisionChange`) where it starts: no, unless a layer is open in its first commit, which says yes itself. So neither signal keeps the yes of a provider that a render error took away with a layer open (the root error page and 「重试」). The native browser view hides on that signal, on the settings window and on an open menu of the workspace tab strip (`useNativeViewOcclusion`, `BrowserTab`); no window raises a flag of its own for the native view, and no ds window watches an approval queue or another window.

Alerts: `role="alertdialog"` on a dialog that is no approval registers as an alert. It stacks over the open dialog or approval, a new alert or a new dialog replaces it, and it steps aside for an approval that arrives. It is for a question about what is on screen (a confirmation, the privacy check, a site removal), never for a form. A confirmation or alert asked while a dialog or an approval is open belongs to the innermost open one: it is answered with cancel when that layer leaves, and dialogs opened inside a dialog or an approval are closed by the registry together with it, so an owner never has to close a nested window itself.

Approvals: an approval is a `Dialog layer="approval"`. The command approval and the path or workspace grant are `role="alertdialog" outsidePress="ignore"` and open on `data-approval-cancel` (取消 / 拒绝; a workspace request that names no folder has one button, the folder picker). The task grant window keeps `role="dialog"`, refuses on a press outside, and opens on its page's way back, which refuses. Only its own buttons answer an approval; Escape and the corner button refuse. The registry never closes one, and no other layer, notification, conversation switch or window close answers one. One shows at a time; the rest wait off the page, an `urgent` one (the workspace request, which answers itself after 60 s) first. The owner keys each approval by request id, and for an owner without one `PermissionDialog` keys its window by kind and path, so no state and no focus carries over; when allow turns into grant for good under the focus, the focus moves to cancel. `ChatView` renders one approval, of the conversation in view, in the order of `common/approvalQueueView.ts`.

Arrivals: an approval that meets a dialog with unsaved input waits behind the discard question; a `busy` dialog steps aside with the dialogs around it, as does an open question; any other dialog is closed, and a question over it cancelled. What steps aside stays mounted and `hidden`, nothing in it answered or cancelled, and returns when no approval shows or is due, or when the approvals that are due wait behind a dialog the user chose to keep editing: questions about the page first, then windows, last out first, a window only to a page with no other window or question. While an approval shows, a new dialog is turned away unpainted or, if `busy`, waits unmounted; a question stacks over the approval and answers alone. A window is `busy` exactly while closing it would cancel work in flight (sign-in, `InstallDisclosureDialog`, `AddMarketplaceDialog`, `app/AppAddConfirmDialog`, `AddProviderModal`, `SkillUploadModal`).

Focus between layers: the registry hands the focus on between layers that follow each other. A layer shown while another fades marks it (`focusTaken()`), so that one gives the focus to nobody; an approval takes over the return target of the layer it follows or that steps aside for it, so the last of a run returns the focus to where it was before the run. A window that steps aside moves no focus and returns to the control that had it, else its opening control; a question returns on its opening control, and a window under it leaves the focus alone. The registry's hand-offs between layers never drop the focus onto the window; a press on an approval's scrim does (Tab brings it back). A dialog whose place to return to is no control on the page — nothing had the focus when it appeared, or that control has left since — calls `Dialog onFocusUnplaced` once it has gone, and only when the focus is its own to give back (not after the registry, the caller's `onCloseAutoFocus` or a trigger placed it). `ChatView` passes `focusComposerFromWindow` to its three approvals: an approval that arrived after Send turned into Stop, or with the focus on the window, returns the focus to the message field.

Focus in windows and pages: a dialog opens on its first control, or on the one `Dialog initialFocus` names (the settings window opens on the navigation row of the page in view); after a pointer press that first focus shows no ring (`ds/input-modality.ts`), after a key press it does. A dismissible dialog whose only control is its corner close button opens with focus on its own box. Tab from the dialog's own box goes to its first control and Shift+Tab to its last. A `SegmentedControl` that is a dialog's first control does not let Shift+Tab out. A control never drops the focus onto the window:
- a page that replaces another moves the focus to its way back, and to the control that opened it when it is left (`CapabilitiesSection`, `data-capability-entry` / `data-capability-back`);
- after a row is removed the focus goes to the row that took its place, else the one before it, else the add button;
- a control that leaves a window under the focus hands it on first (edit profile's 「恢复默认」, to the nickname field);
- the settings window puts the focus in the composer when the control that opened it has left the page (the first-run guide's link);
- `chat/composerFocus.ts` has `focusComposer()`, `focusComposerFromWindow()` (the message field takes the focus only when no control has it and no ds layer is on the page) and `focusComposerAfterPageChange()`, which does the same one frame later, for an action that replaces the page with the chat page (start a conversation with an expert, 「查看会话」 of a run, the first message of a new task: `ChatView` calls it when a message sent from the new-task page replaces that page with the chat page, whose message field is another element). All three find the field by `[data-chat-composer]` in both of its forms, the text area and the editable box of a message with a skill tag, and pass over a field that takes no input (`disabled`, `aria-disabled`). The editable box takes the focus the way it names for itself (`setComposerFieldFocus`, the `focus()` of `InlineSkillInput`'s handle), with its caret where it was left. The message field is the only target; Send and Stop never take the focus by code, and the field sends once per press of Enter, so a key still down from the control that left starts nothing. Send leaves under the focus once it has taken a message (it has nothing left to send, or Stop takes its place), so it hands the focus to the field first (`ChatInput` `resetInput`), where a send with Enter leaves it. After a project is created the composer takes the focus.

Focus helpers, one per kind of list, each acting only when the focus would otherwise be on the window (`focusIsOnWindow`):
- `toolbox/cardFocus.ts` finds a card again after a delete, an uninstall or an editor: the focus goes to that card, else the card now at its index, else the last one, else the page's 「添加」 button (`focusByTestId`).
- `automation/useListDetailFocus.ts` hands the focus between a list and the page of one item (cards through `cardProps('automation', id)`, the way back marked `data-automation-back`): to the way back on the way in, to the item's card on the way out, else the card that took its place, else the create button. It also covers an item deleted from outside while its question or its editor is open.
- `common/useRowFocus.ts` serves inbox and todo rows, which hold native buttons: after a row is deleted, an inbox item is answered or the inline form closes, the focus goes to the same row's first button, else the next row that has one, else a row before, else the header control.
- The sidebar's helpers are under Sidebar rows.

Stacking: the floating levels in `tokens.css` (`z-popover` and up) sit above every stacking value hand-written in `src/`: a modal ds layer takes pointer input from the rest of the page, so what is seen has to be what takes the press. Page code never writes a value at or above `z-popover`. `scripts/designTokens.test.ts` holds the exact list of stacking values written by hand in `src/` (one: the SVG markup in `MermaidBlock.tsx`); a new one fails it and becomes a layer utility. Its comment lists the forms it reads and the forms it cannot see, and `scripts/__fixtures__/stacking-*` holds one case per form. The two corner banners are rendered by `common/CornerBanners`, one at a time: the disclaimer until it is acknowledged, then the first unseen announcement. They sit on `z-fullscreen`, under every floating layer. The announcement appears where the disclaimer, or the announcement before it, was a moment ago: it takes no pointer press that began within `TOAST_SETTLE_MS` of its appearing, counted anew for each announcement, so a double press on the disclaimer's 「我知道了」 leaves the announcement shown and its seen mark unwritten. The keyboard is not held.

`Dialog` props: `layer`, `urgent`, `busy`, `outsidePress`, `settleKey`, `size` (`page` for the settings window, `viewer` for a viewer), a `header` slot outside the scroll area, `closeButton` (which takes data attributes for that button), `contentProps`, `initialFocus`, `onCloseAutoFocus`, `onFocusUnplaced`. `Dialog dismissible={false}` is for a window only its own buttons may close. A description renders line breaks, breaks long words and scrolls when it is taller than its box; it is then a Tab stop (`role="group"`, named by the title) that the opening focus passes over. A key handler for a `Dialog`'s whole content sits on an element around the `Dialog`. `ConfirmOptions.message` is a node. `Popover` takes `contentProps`, `label`, `onOpenAutoFocus` and scrolls inside the room beside its trigger.

**Settling: an early pointer press answers nothing**

An approval, a question (`useConfirm`, any `role="alertdialog"` window) and a window's question about unsaved input take no pointer press that began within `TOAST_SETTLE_MS` (500 ms) of their appearing; an ordinary window does not settle. The count starts when the box joins the page (for an approval: when the registry shows it), and again when it returns after standing aside, when the last layer over an approval has left the page, and when `Dialog settleKey` changes (a button of the window changed its meaning: `PermissionDialog`). The registry tells an approval when it is covered and uncovered (`LayerEntry.covered()` / `uncovered()`: a question over it, a window opened inside it); while covered it is held with no end.

An early press starts nothing in the box, does not move the focus and reaches no control, the corner button included; during the interval the box takes no hover, wheel or selection either. The keyboard is never held (`detail === 0`). The box carries `data-ds-settling` exactly while it holds presses back, and nothing inside it is the pointer's target then. A press on the scrim of the task grant window refuses at once, before and after the interval. The rule lives in `ds/dialog.tsx` only: page code writes no guard of its own.

A popover does not tell the registry that it covers an approval. No approval, question or discard question holds a menu, select list or combobox; one that gets such a control makes it report as a cover first, as a question or a window does.

**Held keys: a key acts once per press**

`ds/heldKey.ts` holds three rules, all about key repeats (`event.repeat`). A first press always acts, and a click with `detail` 0 that comes with no key always acts.

- Controls: a control that acts at once — `Button`, `IconButton`, `Pressable`, `NavItem`, `Link`, `Switch`, `Checkbox`, the `Disclosure` trigger, the closed `Select` (Enter, Space and the two arrows that open it) and the `Combobox` trigger — drops the repeats of Enter and Space before the browser makes a click from them and before the caller's `onKeyDown`, which does not hear them. `TextField` drops a repeating Enter only, never one that belongs to an input method; `TextArea` drops nothing.
- Layers: every `Dialog` and its question about unsaved input, `Menu` and its nested lists, `ContextMenu`, `Popover`, and the lists of `Select` and `Combobox` drop the repeats of every key that was already down when the layer was shown, until that key is released and pressed again. A `Dialog` counts again when it returns after standing aside, at `uncovered()`, when `settleKey` changes, and when its discard question shows or is answered. Keys pressed inside a layer repeat as its controls define (arrows walk a list, Tab moves, Backspace deletes). A menu, a nested list, a context menu and a select list choose once per press of Enter or Space; a list with a search box once per press of Enter (Space types there).
- Escape acts once per press (`dropsHeldEscape`, which reads `event.repeat` and keeps nothing): every layer drops the repeats of a held Escape where it hears of the key — a `Dialog` of any kind and its discard question through `useLayer().onEscapeKeyDown`, `Menu`, `ContextMenu`, `Popover`, `Combobox` and `MultiCombobox` through the same handler, nested menu lists and the `Select` list through their own `onEscapeKeyDown`, both forms of `FullscreenSurface` in their document listener, and the agent's question dock. So an Escape that is down when an approval arrives, or whose first press the page never heard, does not refuse it; the Escape that closed one layer does not go on to the layer under it; a held Escape on a window with unsaved input asks once. A fresh press is never dropped and acts as it always does, also while the layer it reaches is fading.

The keys that are down are tracked by `LayerProvider` by `event.code`, and forgotten when the window loses the focus or the page is hidden. A key the page never heard go down (a frame, the native view, another window, before the focus returned) is unknown to the layer rule: its Enter and Space repeats are still dropped by the controls and lists, its Tab and arrow repeats move.

Page code writes no held-key guard around a ds control. A hand-written `role="button"` or a container that acts on a key-down returns on the repeat itself: `toolbox/ToolCard`, `sidebar/rowKeys.ts` and `chat/UserQuestionDock` through the same helpers, and the tab strip's Delete by reading `e.repeat`. The message field sends once and picks a suggestion once per press of Enter; Shift+Enter, Alt+Enter and a bare Enter under 「Enter 换行」 repeat. `belongsToInputMethod` (`heldKey.ts`) is the one test for a key that belongs to an input method; `chat/composerKeys.ts` `isImeComposing` adds the composer's own composition flag to it.

**Busy controls**

A button or a switch whose own action is running is `Button busy` / `IconButton busy` / `Switch busy` and not `disabled`: `aria-disabled`, focusable, dimmed, with a plain cursor. The control takes the pointer and ends the click on itself (`preventDefault` and `stopPropagation`), so nothing behind it acts; a press puts the focus on it. A control that cannot act and may hold the focus stays focusable; a switch whose feature is unavailable stays `disabled`.

Its hover and pressed looks are off: every class of a ds button that answers the pointer is written `not-aria-disabled:hover:` / `not-aria-disabled:active:` (`button-variants.ts`), and a new one is written the same way. `cn` leaves `not-aria-disabled` out when it compares classes, so a caller's `hover:` / `active:` class on a ds button replaces the button's own; a caller on a button that can be busy writes the variant itself. Page code that marks an element of its own as working with `BUSY` gates its hover classes the same way. `isWorking(element)` (`ds/styles.ts`) is the one test for the mark; `Menu` and `sidebar/RowMenus` read it.

`busy` is presentation only: the handler keeps its own re-entry check, released on every exit path. `AddProviderModal.handleValidate` owns its check in `validatingRef`, which holds the check in flight for the current opening; every form reset clears it, and an answer from an earlier opening is dropped.

**Menus**

- `InstalledItemMenu` and `ToolboxCreateMenu` are `Menu`s. A menu item that opens a window records the action in a ref; `onCloseAutoFocus` focuses the trigger, then runs it. A question asked from a menu runs after the menu has gone.
- A menu item that cannot be chosen stays in the menu, disabled, with its reason as `title` (`InstalledItemMenu disabledReason`); it never fires. `MenuItem description` adds a second line.
- `Menu contentProps` and `MenuItem testId` carry the test ids E2E reads. The 「…」 trigger is the default `IconButton` size in every detail header.
- `Menu` content stops clicks, also for `click` listeners on `document`: outside-press code listens for `pointerdown` / `mousedown`.
- Menu buttons: a `Menu` trigger and the 「…」 of `RowMenus` open on a click with `detail` 0 (a screen reader, `element.click()`), only while the menu is closed; a pointer press opens on pointer-down and an opening key on key-down, once each. The repeats of Enter, Space and ArrowDown on a closed menu button open nothing. A trigger marked `aria-disabled` (a busy control, or one its owner marks) opens nothing from any kind of press.
- The boxes of `Popover`, `Combobox` and `MultiCombobox` have the role `dialog` and are no windows; they carry `data-ds-popover`, and code that looks for the top window excludes them by it (menus and select lists have roles of their own).

**Notices**

`common/ToasterMount` renders the ds `Toaster` from `toastStore`. The list sits at the top centre of the window, newest on top, in a `region` named 「通知」 (`t.designSystem.notifications`); nothing in it is `role="status"`, and E2E reads notices through that region. The store keeps every notice and the newest three show; one shows while the user is asked to decide (`onDecisionChange`: an approval, an alert question or a window's discard question is on the page), so no notice lies over the buttons that answer. A notice pushed out by newer ones keeps its remaining time and returns when a place frees, last out first, for at least `MIN_RETURN_MS`. Adding a notice equal to one in the list (type, title, message, action labels) shows that one again as the newest, with its full time.

A notice that has just appeared or moved takes no pointer press for `TOAST_SETTLE_MS`; the keyboard is not held. A notice takes pointer input over a modal layer (the list's own box takes none), and a press on it is no press outside a dialog. A title shows three lines and a message eight; more scrolls, and long words break. A title or a message that scrolls is a Tab stop, so the keyboard can scroll it: `role="group"`, named by the notice's title, as a `Dialog`'s scrolling description is; one that fits adds no stop, and nothing gives it the focus but Tab. A notice takes no focus when it arrives. When the one that holds the focus leaves, the focus goes back to where it was before after a pointer press, else to the close button now at its place, and back once the list is empty.

The sidebar's undo offer after a deleted conversation is a notice (`sidebar/undoOffer.ts`, `UNDO_OFFER_MS`); equal notices merge, so it undoes the last delete only. The sandbox notice's 「前往安全设置」 opens the settings window on the sandbox page (`openSystemSettings('sandbox')`).

**Windows and questions**

A window is closed (`open={false}`), never unmounted, so it fades out like every other ds window. Its owner sets `open` to false in `onOpenChange(false)`: every way of closing a window (Escape, the corner button, a press outside, the registry) arrives through that call and through nothing else. It keeps what it showed while it fades: the owner or the window holds the last item in state (`held`), and every handler reachable from the fading window returns at once (`selectedRef`, `openRef` or the `open` prop), each with a test that uses the `getComputedStyle` stub recipe (`ai-services/AddProviderModal.test.tsx`).

Closing guards: a handler in a window that closes on success (save, add, remove in a form dialog) returns once the window is closing; a page handler inside the settings window gets the same `systemSettingsOpen` check only when it starts something that cannot be taken back (export, upload, download an update, relaunch). Store writes and switches need no guard. Form baselines and held objects that contain a secret are cleared once the window has closed.

Two windows never stack: the history window replaces the skill detail, the expert editor replaces the expert detail, and a new window replaces the detail that opened it. Two cases are nested. The connector edit form opens inside the connector detail, and Escape there closes the form alone. The app market (`app/AppMarketDialog`) holds the add-market window and the add confirmation of a flow started in it, so cancelling either returns to the list; `AppAddConfirmDialog` is mounted there (`within="market"`) and at the app root (`within="page"`, for a flow started on the app home), and a flow shows in the one `appAddFlowStore.shownIn` names: `start` and `repair` set it from whether the app market is open, and the market's instance hands a flow it still shows to the page when it leaves the page with the market's window, so no flow is without a window.

Forms: a form that can fail stays in a `Dialog`. A form window fills its form when it opens or moves to another item, from the item as the store holds it at that moment, and leaves it alone when the stored values change, so a run recorded meanwhile leaves what was typed alone (the schedule and trigger editors, `Dialog size="lg"`; project settings; edit profile).

Questions: confirmations go through `useConfirm`, name what they act on (the second line of a delete question is the name of what it acts on) and re-read their target by a stable identity at the answer. `ConfirmProvider` gives every `useConfirm` question a window of its own (keyed), so no box and no focus carries over from the question it replaces, which is answered `false`. An answer belongs to the question whose window was pressed. A confirmation is a question about the current dialog: it stacks over an open dialog, and it answers `false` when another dialog opens and replaces it. A question asked inside the click handler ends with its window; one asked after an `await` keeps a mounted/open check. `useConfirm` freezes its text at asking time, so the handler takes the names before asking and acts only on those that still exist at the answer. The provider returns the focus of a question to where it was before the first of the questions that followed each other, and only when no window or approval is open or that place is inside the top one: never onto the page under an open layer. An owner whose own questions can overlap excludes them (`MemoryViewModal`, `asking`).

Deletes ask first and re-read their target at answer time — a skill (file path), a connector (store entry), an expert (file path through the registry; the "used by teams" question stays for that case), a project (its id in `useProjectStore`). The handler keeps a `deleting` / `removing` ref so one target gets one delete; a project row needs none (see Sidebar rows). A question asked from a detail window's menu runs over that window, and the window ends it when it leaves. A plugin is uninstalled through `toolbox/plugins/useUninstallPlugin(home, onClose)`, whose `ask(target)` asks and uninstalls. A market is removed after a question that names it, from the plugins page and from the app market, and the answer re-reads the list. The app switcher's 移除 is a nested list (`MenuSub`) of the apps the user added: an app from a market or a folder can be added again and is removed at once, an app the user made is asked about first, re-read by its id at the answer, one removal per app at a time (`removing`, released in `finally`).

The redo actions (regenerate, retry, edit and resend) ask through `chat/rewindQuestion.ts`, which re-reads at the answer: its row still mounted, no run started on the conversation meanwhile, the same messages and the same count of later turns. The message editor closes only when the edited message is sent. The IM end-session question goes through `useConfirm` and re-reads its session at the answer. The close question is an alert that opens on 「最小化到托盘」, unticked: only its two buttons answer, the tick is written only with a pressed answer, and its handlers return once it is closing. The MCP app link consent is a ds `ConfirmDialog` held by `McpAppBlock` and keyed per request, because the block takes it off the page when its bridge goes, which a `useConfirm` question does not allow. It shows the whole address and takes one request at a time; Escape, a press outside and a window that takes its place refuse.

The windows: the settings window is a `Dialog size="page"`. `CreateProjectDialog` (rendered by `Sidebar`, and with presets by `chat/PromoteToProjectHint`), `ProjectSettingsDialog`, `ProfileEditModal`, `GuideModal`, `InstructionsEditModal`, `MemoryViewModal` and `ShareExportDialog` are `Dialog`s.
- `dirty`: create project, project settings, edit profile, instructions. `busy`: create project while it creates, edit profile while a picture is read, instructions while saving, export while the save dialog is open or the file is written.
- The instructions window offers no field and no save for a file it cannot read; a missing file opens empty. The memory window's 「清空」 scans the folder first, so its question states the count of that scan.
- The export window holds its own open state: its owner mounts it keyed by conversation and removes it on `onClose`, which the window calls once it has left the page; a window its owner has already removed tells nobody. Its export button is `busy` after a failure.
- The first-run guide is a modal `Dialog` that opens on its dismissing button; the page behind it is out of the accessibility tree, so a spec calls `dismissFirstRunOverlays` before it reads anything by role.

Page shells: the extensions, experts and automation pages share one shell — `toolbox/TopTabNav` (buttons: E2E reads them by button name), `SourceSubNav` (a `tablist`), `ToolCard` (`div role="button"` because it nests a `Switch`; it serves task and listener cards as well), `ToolGrid`, `SourceBadge` (a `Tag`), and the window chrome `ToolDetailModal` (a `Dialog` with a hidden title named after the item). Its name row — avatar, name as a `div`, subtitle and actions — sits in the `Dialog` `header` slot, which stays above the scrolling content; the page's `h2` stays in the body. A detail window whose content is replaced while it is open (a plugin's detail, draft and preview; a connector's detail, logs and catalog entry) takes its content height from `toolbox/windowHeight.ts` (`DETAIL_WINDOW_CONTENT_HEIGHT`), so the windows of one page are one size and none scrolls an empty strip. `ToolDetailModal` keeps its props for the private repo: `maxWidth` maps to the dialog size, `panelClassName` gives only the content height, `disableEscape` is accepted and unused, `testId` goes on the dialog content through `contentProps`, and it takes `onCloseAutoFocus`. `LoadError` has two users: `AppPageView`, where the retry tooltip opens beside the button because the native page is painted over everything below the header row, and the chat page.

A conversation whose record is on disk and cannot be read is held in `chatStore.loadFailures` and in `conversations` under no form: `ChatView` shows `LoadError` with `t.chat.recordUnreadable` and a retry, never the host's error text (it goes to the console through `redactFailureText`). `loadConversation` reads strictly; a missing record is an empty conversation and a damaged line is skipped. The explanation stays while a retry reads (`LoadError busy`), and a retry that succeeds hands the focus to the message field. `chatStore.addMessage` adds nothing to a conversation in `loadFailures`, and the conversation writer rejects every write while the record cannot be read.

The agent's question dock takes no focus from a user who is writing a message (`chat/composerActivity.ts`: the focus is inside `[data-chat-composer]` and the field holds a draft or a key went down in it within `COMPOSER_TYPING_MS`, the Enter that sent the message included); it still shows, before the field in the page, and takes the focus once the user turns one of its pages. The dock is a `role="group"` named by the question on its page. A screen reader hears the dock that takes the focus; one that leaves the focus in the message field hands the words of its question (its header and its question) to `ChatView` (`onArrivedWithoutFocus`), which writes them into one polite live element that is on the chat page before any question arrives, and empties it when the dock leaves.

**Viewers and fullscreen**

The one image viewer is `ImageLightbox`, a `Dialog size="viewer"` opened only through `useImageLightboxStore.open(items, index, returnFocus)`. A saved tool image is handed over as the file its thumbnail read (`filePath`). The viewer keeps what it showed while it fades, returns the focus to the thumbnail, else to the composer, and offers download only for the four types of `ImageLightboxMediaType`. In the viewer a gallery arrow that reaches an end hands the focus to the other arrow. A viewer opens on its close or exit control, never in a frame: a frame that has the focus keeps every key.

`FullscreenSurface` covers the window without moving its content in the page and is the one other place in `src/components/ds/` that writes `fixed inset-0`: plain, a layout state on `z-fullscreen`; with `layer`, a dialog to the registry whose first focus skips frames; with `scrim`, its box passes presses to the scrim and its direct children take them, so pass-through parts sit one level down. Closed, it is `display: contents`, so its content brings its own layout box.

The HTML widget fullscreen is a `Dialog size="viewer"` with a frame of its own. It follows the appearance: `buildFullscreenHtml(code, isDark)`, and the frame's document is built again when the appearance changes, in the same frame with the same `sandbox="allow-scripts"`. A complete document is shown as authored.

The MCP app fullscreen is a `FullscreenSurface layer scrim` around the block, so the iframe node stays the same and the app is not reloaded. An app's own fullscreen request is refused while a window, a question or an approval is on the page, waits or has stepped aside (`mayGoFullscreen`, with `pageOccupied` read from `LayerRegistry.isOccupied()`; menus and popovers do not count), and the refusal spends no grace and starts no cool-down.

The preview panel fullscreen is the plain `FullscreenSurface`: on `z-fullscreen`, with no stacking class from page code, `role="group"`, no focus moved when it opens or closes. The page it covers cannot be seen, so Tab stays among the surface's own controls, round from the last to the first and back, and a Tab pressed on the covered page comes in. The surface's first and last child are its two Tab stops (`data-ds-focus-guard`), which turn the focus round when it comes out of a frame; the caller's content sits between them. While the preview is fullscreen the banners and the title bar take the pointer only; the notice list is in the round Tab makes: after the surface's last control comes the list's first stop (a title that scrolls, else a button), after its last button the surface's first control, and back with Shift+Tab; a surface with no control of its own goes round the list alone; the focus that comes out of a frame at either end goes on to the list first. The list takes no focus by itself. A ds layer opened over the surface (`[data-ds-layer]`) keeps its own keys, the surface takes no Tab at all while a window, a question or an approval shows over it or while it is not displayed (a preview tab that is not in view keeps its fullscreen state under `hidden`), and the rest of the page is never made `inert`, because floating layers are portaled there. Escape leaves the surface unless the key was pressed inside a ds layer or something else has used it (`defaultPrevented`).

**Sidebar rows**

- Conversation rows are `div role="button"`; Enter and Space on the row itself open the conversation through `sidebar/rowKeys.ts` (`opensOnKey`).
- Rows share one menu root per list through `sidebar/RowMenus`. The project row is the exception to "rows mount no Menu root": each project row owns one `ContextMenu` and one `Menu` (the 「更多操作」 button, which shows the right-click menu's items), because a menu holding 归档 and 删除 is bound statically to its row. The project's name and the three buttons beside it (项目文件, 新任务, 更多操作) are a `role="group"` named by the name button, so a screen reader hears whose buttons they are; a test finds them through that group.
- The archive and delete questions of a project read the project by id in the store twice: before the question is asked (it is asked from the menu's close hook, later than the choice, and a project that has gone meanwhile is asked nothing about) and at the answer. The delete question names the project on its second line. One archive or delete per project follows from that read and from the provider answering a question once; the row keeps no ref for it.
- `sidebar/projectRowFocus.ts`: after a project row is archived or deleted, from its menu or from its settings window, the focus goes to the row now at its place, else the last row, else the create button; `useArchivedRowFocus` serves the archived list.
- `sidebar/conversationRowFocus.ts`: after a conversation is deleted from its row menu the focus stays in the same list (the frame of one `RowMenus`: the recent tasks, or one project's tasks): it goes to the row now at its place in that list, else that list's last row, and once the list is empty to the list's home (`useConversationRowFocus(home)`: the project's own row), else 「新任务」. It moves only when it would otherwise be on the window; a row that leaves while its menu is still closing is handled from the menu's close hook, and the undo notice is never given the focus.
- Deleting a conversation goes through `sidebar/useDeleteConversation` from both row menus (recent tasks, and a project's tasks): the record is read first, a readable conversation is deleted at once (the recent tasks offer the undo notice, project rows none), and a conversation that is listed, not in memory and in `chatStore.loadFailures` is deleted only after a `useConfirm` question that names it, asked once the menu has gone and the focus is back on the row. The answer re-reads the store: gone → nothing, read meanwhile → the ordinary delete, still unreadable → deleted without undo. One delete per conversation at a time (`deleting`, released in `finally`); a question still waiting for a menu that is opened again is dropped unasked, like rename and export.

**Appearance and window material**

The appearance default is `'system'`. `index.html`'s blocking script paints by the same rule as `settingsStore` after hydration: a stored `theme` is painted unless the blob's `version` is a number below 54, and everything else follows the system; `src/__tests__/prePaintTheme.test.ts` runs the shipped script. A store bump that changes `theme` changes the script's version check with it. `styles/colorScheme.ts` `followSystemColorScheme()` keeps `dark` on `<html>` while the setting is 「跟随系统」. The `dark` class on `<html>` is the one place that tells light from dark; a component that has to know reads it (`useEffectiveThemeIsDark`).

Accessibility appearances: `src/styles/appearance.ts` sets `data-contrast="more"`, `data-transparency="reduced"` and `data-motion="reduced"` on `<html>`; `tokens.css` keys off those attributes only and holds no `prefers-*` media query.

Window material: `electron/windowChrome.cjs` `windowMaterial()` decides what the OS draws behind the window (`vibrancy` on macOS, `mica` on Windows 11 22H2+, otherwise `none`), passes it to the page as `--abu-window-material`, and `src/styles/windowMaterial.ts` writes `data-window-material` on `<html>` before the first paint. With a material the window background is transparent and `bg-desk` is translucent; with `none` tokens.css makes `desk` opaque. Content cards (`bg-surface`) and every floating layer — menus, popovers, tooltips, notices and dialogs (`bg-raised`) — are always opaque, and the page never uses `backdrop-filter` (`backdrop-blur-*`): the window material is the only translucent layer.

The root error page (`ErrorBoundary`, above `DesignSystemProvider`) fills the window with `bg-surface` and reads no context.

The pet window (`pet.html`, `src/pet/`) is an entry point of its own and mounts `DesignSystemProvider` in `pet/main.tsx`. It follows the application's color scheme through the same `followSystemColorScheme()`; the host's `set_theme` makes the two windows agree in every setting, and `pet/main.tsx` also installs the accessibility attributes. The window is transparent and exactly as large as what it shows, so nothing in it draws outside its box: no shadow, no tooltip, no floating layer; its icon-only controls are named `Pressable`s. Its status dots are `bg-current` on a status token class (`pet/petStatusMeta.ts` `STATUS_TONE`). The pet's reply field ignores an Enter that belongs to an input method (`chat/composerKeys.ts`).

**Enterprise overlay**

The private repository's interface files use the same components and tokens, and are linted with the same rules. What this repository provides for that:
- `overlayLintConfig(globs)`, a named export of `eslint.config.js`, returns the base block and, for a list that is not empty, the design-system rules on those globs; the overlay keeps its own list and runs this repository's ESLint from its own directory, so the globs are relative to it. The default export is built from the same base block.
- Every private test runs through a forwarding file under `enterprise-tests/`, one import line per test file; a private test without one is never run, so the forwarder is added together with the test, followed by `npm run test:inventory` (`TESTING.md` counts the directory). `vitest.enterprise.config.ts` resolves `@testing-library/react` and `@testing-library/user-event` for those tests from this repository's `node_modules`.
- `npm run typecheck:enterprise` compiles the private callers against the props of the components they render: `ToolCard`, `ToolGrid`, `ToolDetailModal`, `MarketplaceEntryRow`, `InstallDisclosureDialog`, and `sidebar/RowMenus` around the private plugin grid. `InstalledItemMenu` has no private user.
- `<PolicyConfirmModal />` at the app root sits inside `DesignSystemProvider`, as every private component that renders a ds component does (and its tests); it renders nothing in the OSS build.
- The class scan: `src/styles/index.css` imports `@enterprise-modules/interface-classes.css`. The overlay's file of that name holds the `@source` lines for its interface files, so a class written only there has a rule in the enterprise stylesheet; the stub's twin (`src/enterprise-modules-stub/interface-classes.css`) holds a comment and nothing else. `scripts/designTokens.test.ts` holds the import and the empty twin; `enterprise-tests/host-interface-classes.test.ts` holds the overlay's side in the enterprise suite.
- The rules for the private interface are in that repository's own `AGENTS.md`.

**Tests and helpers**

- `src/test/dsWindows.ts` holds the helpers for a window's fade and for an approval that arrives over a window.
- Settling: a unit test that presses an approval or a question with the pointer calls `passSettleInterval()` (`src/test/dsWindows.ts`) first, or advances its fake clock by `TOAST_SETTLE_MS`; `fireEvent.click` reports `detail` 0 and is a key press. A test asserts `data-ds-settling` only under fake timers. A test that presses a notice's button with the pointer advances the clock first. An Electron spec presses with `pressWhenSettled(locator)` (`tests/e2e/electronHelpers.ts`); a plain `locator.click()` also waits, because Playwright finds the box in front of the button.
- Held keys: user-event sets no `repeat`; a held key is `fireEvent.keyDown(target, { key, code, repeat: true })` after a first key-down of the same `code`, and a case reads the return value (`false` once prevented) or what the control did. happy-dom makes no click from a key, so that the browser makes none is proven in the shell (`tests/e2e/tool-approval.spec.ts`, the held-Enter case).
- Busy controls: `pointerTargetOf(element)` (`src/test/pointerTarget.ts`) gives the element a pointer press lands on, from the two ds classes that take the pointer off a control; unit tests load no stylesheet, so the hit test itself is proven in the shell.
- Closing guards and fading windows: the `getComputedStyle` stub recipe in `ai-services/AddProviderModal.test.tsx`.

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
- 🔴 **本仓测试的"宪法"是 [`TESTING.md`](./TESTING.md)** —— 分层（unit/integration/contract/e2e）、确定性铁律、门禁脚本、quarantine、覆盖率阈值、契约测试全在那，写/改测试前先读它。本节只是速览摘要。
- **门禁**：`npm run verify` 退出码为 0 才算完（= `verify:full`：lint + typecheck + 全量 + 覆盖率）；秒级自检 `npm run verify:quick`；集成 `npm run test:integration`；E2E `npm run test:e2e`（外层门禁，独立于 verify）。跨端质量底线（DoD）见 `../AGENTS.md`。
- **Vitest**, `environment: 'node'` by default; component tests opt in per file with `// @vitest-environment happy-dom` (see TESTING.md §6). Config in `vitest.config.ts`.
- **Test files co-located** next to source: `chatStore.ts` → `chatStore.test.ts`.
- **Global mocks** in `src/test/setup.ts`: All Tauri APIs and external SDKs are mocked globally.
- **Locale**: `src/test/setup.ts` pins `navigator.language` to `en-US`, so i18n's `'system'` default resolves the same on every machine as on CI (English tool-result copy is the contract). A suite that switches locale restores it in `afterEach`/`finally` (see TESTING.md §6 *Locale*).
- **Store tests**: Call `useXxxStore.setState({...})` in `beforeEach` to reset. Test via `useXxxStore.getState().action()` — no React rendering needed.
- **Timer tests**: Use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`, not `runAllTimers`.
- **Structure**: `describe('feature') > describe('action') > it('description')`.
- **Coverage**: `v8` provider, `src/components/` excluded.

### 12. File System & OS Access (Electron boundary model)
- **This is an Electron app.** File system / OS / process access lives in the privileged tiers — `electron/main.cjs` (main process + native services), `electron/preload.cjs` (the narrow renderer bridge), and `sidecar/` (Node sidecar hosting agent/runtime work). Node built-ins (`fs`, `child_process`, `path`, …) **are appropriate in `electron/` and `sidecar/`** when needed.
- **The renderer (`src/`) must NOT touch Node.js, `fs`, `child_process`, shell, or raw process APIs directly.** Add a capability by exposing it through preload→main (or sidecar) and validate inputs at the privileged boundary. Do not add direct privileged imports to `src/` just because Node built-ins are available in the process.
- **Tauri is compatibility-only.** `electron/tauriHost.cjs` implements the existing Tauri-shaped renderer calls so old renderer code keeps working. Do NOT write new features against Tauri plugin APIs (`@tauri-apps/plugin-*`); route new privileged work through the Electron preload/main/sidecar boundary instead. See the "Electron-Only Development Architecture" boundary map above.

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
- Do not add styles to `index.css` or inline `<style>` blocks — use Tailwind classes; new design tokens go only in `src/styles/tokens.css`.
- Do not add default exports to hook files.
- Do not create new Zustand stores without `persist` middleware (unless the store is purely ephemeral by design).
- Do not use `jest` syntax (`jest.fn()`, `jest.mock()`) — use Vitest (`vi.fn()`, `vi.mock()`).
- Do not hand-roll form controls (select, toggle, input, textarea) — use `src/components/ds/`. If a variant is missing, extend the component.

### 15. Reviewing review output (sanity-check-first)

Review reports — from sub-agents, static analyzers, LLM reviewers, or people — have **non-zero false-positive rates**. Empirical baseline from this project: a single 17-finding review pass produced **14 false positives (82%)**. **Never act on a 🔴/🟡 finding without empirical verification.**

**Typical false-positive patterns to watch for:**
- **Single-threaded JS read as multi-threaded race** — "check-then-act" inside one event handler is safe in JS; Zustand `setState` is synchronous.
- **Ignoring existing defenses** — code already has `if (signal.aborted) return;`, early-return branches, or `{ once: true }` listeners, but the finding claims they're missing.
- **Ignoring JSDoc / inline comments** — the author explicitly documented a deliberate trade-off (fire-and-forget is correct for best-effort writes, silent catch is intentional when memory is authoritative, etc.).
- **Cross-technology misattribution** — shell-style `$VAR` expansion claimed for AppleScript / SBPL / PowerShell single-quoted strings that don't support it.
- **Fake aggregate claims** — "module X has 0 tests" when module X actually has N tests; always verify by listing files.

**Before acting on any finding — 4-step sanity check:**
1. **Read the actual code** at the cited `file:line`. Don't trust summaries.
2. **Verify the failure mode**: reproduce it, write a targeted test, or trace an input that breaks the claim.
3. **Check for existing defenses**: guards, early returns, JSDoc invariants, surrounding tests.
4. **If the claim doesn't hold, add a regression test** codifying why. This stops the same false alarm from resurfacing in the next review pass.

Only proceed with a fix after the finding survives this check. Verification cost (~5–15 min per finding) is far less than "fixing" a non-problem (often 1–6 hours, including regressions introduced by the unneeded change).

This rule **explicitly overrides external authority**: "the sub-agent said…", "CC does…", "the docs say…" — all are hypotheses to verify in code, not conclusions to act on.
