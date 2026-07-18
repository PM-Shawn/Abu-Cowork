# Changelog

All notable changes to Abu are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/).

## v0.31.0 · 2026-07-18

### Added

- **右栏多页签工作区**：右栏文件预览升级为多页签工作区 —— 多文件预览并存（keep-alive 隐藏不卸载）、真 PTY 终端（portable-pty 后端 + xterm.js 前端）、原生 webview 浏览器页签（任意站点，不受 iframe 的 X-Frame-Options 限制），并以「任务摘要」作为默认页签。Multi-tab workspace: multi-file preview + real PTY terminal + native-webview browser.
- **主窗口卡片化改版**：卡片化视觉层次（card-on-canvas）、顶栏与 macOS 红绿灯对齐、工具箱与自动化收进主布局的卡片网格（固定尺寸横卡 + 自适应铺满 + 统一启用开关）。Panel visual-hierarchy redesign with an in-layout toolbox/automation card grid.
- **会话全文搜索接入 FTS5**：侧栏会话搜索弹窗接入 SQLite FTS5，可按标题 + 正文跨历史会话检索。Conversation search modal wired to FTS5 (title + body).
- **账户菜单 + 设置导航整理**：左下角三个按钮收进头像 popover（内联切主题/语言、接真实检查更新流），设置分组重组。Account-menu popover + regrouped settings navigation.

### Changed

- **字号排版体系（8-token）**：全部字号迁移到 8 档 `--text-*` token（font-size + line-height + font-weight 三绑定），清零 px 硬编码与命名字号；阅读正文号定为 14px（对齐主流聊天客户端），标题字重封顶 600。Migrated all font sizes to an 8-token typography scale.
- **语义色 + 链接色 tokenization**：链接与状态色收敛为 `--abu-{danger/warning/success/info}`（fg/solid/bg 三角色）+ 专用 `--abu-link`（品牌橙不复用 accent）；765 处裸 Tailwind 色阶转 token 并达 WCAG AA，`--abu-text-muted` 也提到 AA。Link + status colors tokenized to a semantic scale, all AA.

### Fixed

- **消息列表底部锁定 + 搜索跳转**：虚拟化消息列表在打开/切换会话时正确锁定到底部；搜索命中跳转配淡出高亮。Virtualized list bottom-lock on open/switch + search-hit jump.
- **`cn()` 吞字号 token**：修复 tailwind-merge 把 `text-[var(--)]` 误判为 font-size 从而吞掉字号 token 的问题（extendTailwindMerge 根治，app 级）。Stop tailwind-merge from silently dropping font-size tokens in `cn()`.
- **工作区页签交互**：页签拖拽真正重排 + 中性插入线、关闭（×）不再误触发拖拽、PDF worker 经 Vite `?url` 加载并 memoize file 对象（修「object can not be cloned」）、恢复面板收起按钮。Workspace tab drag / close / PDF-preview fixes.
- **PTY 子进程回收**：终端被杀后回收子进程，spawn 竞态下清理孤儿进程。Reap killed pty child + orphan on spawn race.
- **macOS 顶栏可点性**：页签条上方的 + 按钮曾落在 macOS 拖拽区导致不可点，已修。Tab-strip + button no longer sits under the macOS drag region.

### English Summary

v0.31.0 is a UI-focused feature release. Highlights: a multi-tab right-panel workspace (multi-file preview + a real PTY terminal via portable-pty/xterm.js + a native-webview browser tab that loads any site without iframe X-Frame limits, task-summary as the default tab); a card-on-canvas panel redesign folding the toolbox and automation into an in-layout card grid; conversation search wired to SQLite FTS5; and an account-menu popover with regrouped settings. It also lands two systemic design-token migrations — an 8-token typography scale (reading body set to 14px, heading weight capped at 600) and a semantic color/link tokenization covering 765 raw Tailwind color usages, all brought to WCAG AA — plus fixes to message-list bottom-lock, a tailwind-merge bug that dropped font-size tokens, workspace tab drag/close and PDF preview, PTY child-process cleanup, and a macOS drag-region click issue.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.30.0...v0.31.0

## v0.30.0 · 2026-07-16

### Added

- **会话全文搜索**：侧栏新增会话级全文搜索，基于 SQLite FTS5（trigram 分词，支持中文），可跨历史会话按内容检索，配套单字符即搜、整行点击、自然收起的搜索交互。Conversation-level full-text search over FTS5.
- **AI 安全删除到废纸篓**：新增 `delete_file` 工具，AI 删除文件走系统废纸篓（可在访达/资源管理器恢复）而非永久删除，并加了删除礼仪提示与灾难性删除目标的硬拦截。Safe delete to trash instead of permanent removal.
- **长会话 `/compact`**：手动 `/compact` 命令主动压缩上下文并保留最近一轮，配合持久化的 compact 边界标记与原生 O(1) 消息追加；分享时自动剔除边界标记保护隐私。Manual context compaction with persistent boundary markers.
- **内置 Node.js 运行时**：打包内置 Node 22 LTS，npx 系 MCP 服务器无需用户预装 Node 即可运行（系统 Node 优先，内置兜底）。Bundled Node runtime so npx-based MCP servers run out of the box.
- **图片生成收编进模型体系**：图片生成成为独立能力维度，拥有独立配置区、按厂商的适配层（火山 Seedream / 硅基流动 / 智谱等）与厂商选择器，不再靠手填端点。Image generation as a first-class, per-vendor capability.
- **预览面板多格式升级**：缩放控件、应用内全屏（Esc 退出）、「在应用/浏览器中打开」统一、CodeMirror 编辑器跟随明暗主题、pptx 默认白底、mermaid 触控板捏合缩放、删除工作区文件夹后恢复自动重识别。Zoom, fullscreen, open-in-app, theme-aware editor, pinch-zoom.
- **聊天消息列表虚拟化**：基于 react-virtuoso 虚拟化长会话消息列表，流式跟随到底与「回到最新」跳转，退役旧的 useAutoScroll。Virtualized chat list with stick-to-bottom + jump-to-latest.
- **诊断反馈增强**：反馈打包支持多选会话、附加文字描述与截图，草稿跨页面持久化。Diagnostic feedback bundle with multi-select, description & screenshots.
- **账户菜单 + 设置导航改版**：左下角三按钮收进头像 popover（内联切主题/语言、接真实检查更新流）；设置从 13 个 tab 重组为 5 个细线分簇。Account popover + regrouped settings navigation.

### Fixed

- **日志目录路径分隔符**：`appData` 路径拼接缺分隔符，日志曾被写进兄弟目录 `com.abu.app*logs`；现正确落在 app-data/logs。
- **`_parse_error` 与日志预览解耦**：工具参数日志预览（2000 字）与回放的 `_parse_error` 截断（200 字）解耦；空的 Claude 工具 input 兜底为 `{}`，弱模型发送空/未转义参数不再崩。
- **OpenAI 兼容适配层加固**：修复 tool-call、文档与超时相关的边界问题；`edit_file` 逐字替换 + 空路径边界校验；`@agent` 中止正确上报为 aborted，MCP tools-changed diff 修正。
- **图片生成回退修复**（发版前 review）：恢复零配置文生图回退（未配置图片后端时走当前 OpenAI provider）；迁移的 API key 在瞬时解密失败时不再被永久孤立；补回默认 size；厂商经代理域名时尺寸策略仍生效。
- **预览「在应用中打开」跨平台修复**：opener 白名单拒绝路径（Windows 非 $HOME 盘符、Linux /opt 等）时回退到 shell 打开，恢复旧行为。
- **recall 计数 / FTS 搜索 / 计数一致性**：会话在内存时 recall 优先用准确的内存条数，编辑/重试截断后不再多报；FTS MATCH 路径对查询做 trim，前后空格不再影响结果；ghost 消息删除的 catalog 计数与落盘 +1 平衡。

### English Summary

v0.30.0 is a feature release. Highlights: conversation-level full-text search (FTS5), AI safe-delete to the system trash, a manual `/compact` command with persistent boundary markers, a bundled Node.js runtime so npx-based MCP servers work without a user-installed Node, image generation promoted to a first-class per-vendor capability, a multi-format preview upgrade (zoom / fullscreen / open-in-app / theme-aware editor), a virtualized chat list, a richer diagnostic feedback bundle, and an account-menu + settings-navigation redesign. It also folds in a pre-release code-review pass that restored the zero-config image path, fixed a migration that could orphan an image API key, restored cross-platform "open in app", and corrected conversation message-count reporting and FTS whitespace handling.

## v0.29.0 · 2026-07-12

### Added

- **Workspace file tree + code canvas**: a file tree in the left panel — click a file to preview it, right-click to create / rename / delete (delete goes to the system trash, recoverable from Finder). Source files are editable inline in a CodeMirror editor with debounced auto-save, the preview auto-refreshes when a file changes, and per-file version snapshots let you roll back.
- **Declarative progress panel**: the model now declares its plan steps and each step's status directly (via `report_plan`) instead of the framework inferring progress from tool-call order. This is accurate for steps that use several tools or none, where the old positional inference drifted.
- **Inline visualization widgets**: new `show_widget` / `read_me` tools render charts, HTML, and diagrams inline in the chat; static-structure diagrams route to Mermaid. Includes a modest design system and a host runtime (theme sync, `sendPrompt`, error/canvas handling).
- **Multi-endpoint provider presets**: vendors with several access plans (Volcengine API / Coding / Agent, Bailian Token Plan / Coding, Zhipu, …) are now curated presets with per-plan base URLs, formats, and models. The add / edit AI-service dialog was unified into a single modal.
- **Per-model capabilities**: tool-calling, vision, reasoning, and token limits are now declared per model rather than per provider, so one provider can mix vision and non-vision models without the capability of one bleeding onto another (store v40 migration).

### Fixed

- **Newly-added builtin preset providers now sort to the front** (newest-first), matching how custom providers already behaved — previously a preset stayed stuck at its catalog position.
- **Diagnostics surface real failures**: empty error bodies fall back to a meaningful message (e.g. `HTTP 404 · not_found`), and a real per-provider call failure downgrades a misleading "passed" self-check to a warning.
- **Inline HTML widget white-screen** rendering fixed.

### Improved

- **macOS release builds are Developer ID signed + notarized**.

## v0.28.2 · 2026-07-10

### Fixed

- **Image conversations no longer brick after a restart**: uploaded images are persisted with their base64 stripped (only the file path is kept, to save disk), but the LLM send path used that empty data directly. After an app restart the reloaded history carried empty base64, so the provider rejected the whole request (`Invalid base64 image_url`) and the conversation froze on **every** following turn — plain text included — forcing a brand-new conversation. The base64 is now re-read from the image file (or its snapshot) before sending, and degrades to a text placeholder when the file is gone, so an empty image can never reach the model. Long-standing (image stripping exists since v0.10); an update surfaced it by forcing the restart that reloads the stripped copy.

## v0.28.1 · 2026-07-10

### Fixed

- **File preview split no longer crushes the chat**: when a file preview is open, the chat column now keeps a stable width and the preview flex-fills the rest — so opening the sidebar shrinks the preview instead of squeezing the chat into vertical one-character-per-line text. The preview also stays the big "main stage" (~60% of the window). The composer's status line was tidied up too: the redundant request count was dropped and the line no longer wraps.

## v0.28.0 · 2026-07-10

### Added

- **Doc comment-to-chat**: select any snippet in the markdown preview, attach a note, and send it back to the agent as a reference chip. Selections leave an in-place highlight trail (`CSS.highlights`), the selection toolbar positions itself edge-aware and dismisses on scroll, and the reference is serialized into your message on send.
- **Full internationalization (P1–P4)**: the app now follows your UI locale everywhere, and a new locale-driven output-language mechanism controls the reply language independently of the prompt language (Chinese stays Chinese; English follows your message). LLM-facing prompts and tool descriptions were English-ized (P1–P2), and tool result strings, command-safety prompts, the built-in MCP catalog, project rules / `ABU.md` / `/init` output, and agent runtime status/errors were localized bilingually (P3–P4). UI strings across the model selector, file attachment, permission card, memory badges, marketplace catalog, computer-use overlay, and settings were localized as well.

### Fixed

- **CJK mojibake in HTML previews**: generated HTML now declares UTF-8, so Chinese/Japanese/Korean text no longer renders as garbled characters in the preview.
- **Markdown tables collapsing to vertical CJK text**: table columns no longer shrink to one-character-per-line vertical stacks.
- **User-message markdown invisible on the light theme**: headings, blockquotes, bold, and inline code in user messages were hard-coded to white (a leftover from the dark-bubble era) and disappeared on the light theme — now readable in both themes.

## v0.27.0 · 2026-07-09

### Added

- **Better multi-model compatibility**: request parameters are now translated per provider through an expanded normalization pipeline, so more OpenAI-compatible / third-party models work out of the box without manual tweaking.
- **Complete `finish_reason` handling + compatibility observability**: abnormal stream endings are handled safely, and compatibility events are surfaced as diagnostics instead of being silently swallowed.
- **Advanced capabilities are now editable after adding a model**: the "advanced config" section (tool calling, vision, reasoning, per-model token limits) appears in a provider's edit form too — previously it only existed at add-time, so caps couldn't be changed later. It's also now available for Anthropic-format custom endpoints, which are often proxies fronting non-Claude models (fields that don't apply are hidden).

### Fixed

- **Mermaid diagrams and HTML widgets broke in packaged builds**: in the released (non-dev) app, Mermaid nodes rendered as black blocks and HTML widgets collapsed into unstyled vertical text, because the production Content-Security-Policy stripped runtime-injected inline styles. Both now render correctly.
- **Advanced-settings checkboxes were un-checkable on macOS**: the capability checkboxes in the add/edit provider form couldn't be toggled on macOS.
- **Safe tool-call flush on abnormal `finish_reason`**, plus a Gemini multi-call signature fix.

### Improved

- **English-first marketing site**: the landing page and docs now lead with English, with zh-CN companion pages alongside.

## v0.26.0 · 2026-07-08

### Added

- **Custom-model advanced configuration**: when adding a custom / local (Ollama) model, you can now declare its capabilities (tool calling, vision, reasoning, …) with checkboxes. Abu then sends only the request parameters that model actually supports, so unsupported fields no longer cause failed requests.
- **Per-model token limits**: set input / output token caps per custom model, with quick presets.

### Fixed

- **Custom API address no longer mangled**: the chat endpoint URL is normalized idempotently — pasting a full URL (with or without `/v1`, `/chat/completions`, or a trailing slash) now resolves to the correct endpoint instead of a broken concatenation.
- **gpt-5.5 + tools**: the `reasoning_effort` drop guard is now host-agnostic and respects a model's declared "no reasoning" capability, folded into the new request rule engine.
- **About page disclaimer link**: now opens the disclaimer that matches your current language.

### Improved

- **Add-model dialog polish**: validate-connection moved to the footer, a denser layout keeps the token presets visible, advanced config is collapsible, redundant copy and number-input spinners are gone, and re-selecting an already-added model works.
- **English-first repository docs**: README / SECURITY / DISCLAIMER / CHANGELOG and the language navigation now lead with English, with zh-CN companions.

## v0.25.5 · 2026-07-07

### Fixed

- **"More" wouldn't expand when a project has many conversations**: conversations under a project folder only showed the first 5, and the bottom "+N more" was supposed to expand the rest — but it was wrongly wired to "collapse the folder", and the list never had a "show all" capability, so older conversations couldn't be expanded at all. Clicking "N more" now expands all conversations in place (click "Collapse" to fold back), without affecting the folder's own expand/collapse state.

## v0.25.4 · 2026-07-07

### Fixed

- **Slow models' "thinking" mistaken for a timeout**: the streaming idle timeout is relaxed from 90s to 180s. Reasoning models that think for a long time (pauses before the first token or between tokens) are no longer cut off prematurely and forced into pointless retries; slow generation with local Ollama + tool calls is no longer killed mid-way.

## v0.25.3 · 2026-07-05

### Improved

- **Corrected reply rendering order**: thinking, execution plans, and tool calls now display in the exact order they actually happened (previously the plan was pushed to the top and thinking was folded into "called a tool", which didn't match the real process).
- **Collapsible "work process" (à la Codex)**: after a turn completes, intermediate steps (thinking / plan / tools) auto-collapse into a single "Handled X" line (or "You stopped after X" when manually aborted), highlighting only the final reply; click to expand the full timeline.
- **Less fragmentation**: consecutive "thinking + tool" steps are merged into one expandable step block, instead of a long string of repeated "thought for N seconds".
- More accurate duration on the collapsed line (never less than the sum of the visible step times).

## v0.25.2 · 2026-07-05

### Fixed

- **UI froze after clicking "Approve" in long conversations**: context compaction now runs with its own timeout (30s) plus a circuit breaker, so a slow or unstable model channel no longer stalls the whole turn. Compaction/retry now shows "Compacting long conversation context…" and "Retrying N/M…" instead of silent dead air.
- **Offline diagnostic export stuck on "Exporting"**: exporting very large conversations (thousands of messages) no longer freezes the UI — by default only the most recent 200 messages are bundled; enable "Include all messages" if you need the full history.

### Improved

- **Conversation export**: shows progress and can be cancelled at any time.

## v0.25.1 · 2026-07-04

### Improved

- **Default theme changed to light**: fresh installs now default to the light theme (previously dark), a better fit for office scenarios. Existing users who already picked a theme are unaffected and can switch between light / dark / follow-system anytime under Preferences → Appearance.

## v0.25.0 · 2026-07-04

### Added

- **Experimental features**: a new "Labs" section in Settings lets you manually enable experimental features to try out.
- **Desktop Pet**: a floating pet on your desktop that shows task status and notifications — click to type, right-click for a menu. Off by default; enable it in Labs first, then turn it on in system settings.
- **Theme switching**: dark / light / follow-system.
- **Redesigned feedback page**: add a description when uploading diagnostics, plus a new WeChat QR code.

### Fixed

- **Plan approval card restored**: fixed the approval card not showing since v0.24.0; messages typed during approval are now queued, and aborting is more robust.
- **MCP crash in packaged builds**: MCP tools no longer fail to load and crash due to Content Security Policy blocking in packaged builds.
- **Non-vision models reading images**: images are no longer sent to models that don't support vision, avoiding request errors.
- **Smoother Skill installation**: supports click-to-select / drag-and-drop upload; fixes dotfile filenames and interrupted installs.
- **Command output encoding**: command output in non-UTF-8 encodings (e.g. GBK) is no longer dropped entirely.
- **Windows permission guidance**: shows the correct guidance when Accessibility permission is missing, instead of the Mac wording by mistake.
- Permission-mode label colors and de-duplication, clearer memory tags in dark mode, and unified settings-menu styling.

## v0.13.5 · 2026-04-24

### Fixed

- 🔌 **Volcengine models no longer crash out of the box**: Volcengine defaults to the Coding Plan aggregation endpoint (an aggregation point for many vendors' models), which only accepts OpenAI-standard function tools, not Ark's proprietary `web_search` extension. Previously every message was rejected with `missing tools.function parameter`. Removed the mismatched webSearch declaration and ran a persist migration to strip stale capability flags from existing users' local cache.
- 🎞️ **PPT preview failures no longer dump a stack trace at you**: the `pptx-preview` library swallows parse exceptions on some python-pptx slides and ends up throwing raw technical errors like `undefined is not an object` to users. Replaced with a friendly fallback card: filename + "Open in PowerPoint" + "Show in file manager". PPTs that render normally are unaffected.

## v0.13.4 · 2026-04-22

### Fixed

- 🖱️ **Switching back to Abu no longer needs a "throwaway first click"**: after switching back from another app, clicking an input / button works immediately, no second click needed. Enabled macOS `acceptFirstMouse`, matching VSCode / Chrome / Figma and other mainstream desktop apps.

## v0.13.1 · 2026-04-20

### Fixed

- 🛟 **Atomic conversation-history writes**: every write path for `messages.jsonl` and `index.json` (append, replaceMessage, updateLastMessage, flushIndex, backup) now uses atomic tempfile + fsync + rename. Previously a crash mid read-modify-write (power loss, force kill, disk full) could truncate the file and lose the entire conversation history; now readers see either the old file or the new file, never an intermediate state.
- 🛟 **Crash-proof settings migration**: each version migration branch in `settingsStore` is isolated in its own try/catch. Previously an exception in one migration step failed the entire rehydrate → Zustand fell back to initial defaults → users lost all providers / models / preferences. Now a failing step is logged and skipped, and the other branches keep running.

## v0.13.0 · 2026-04-20

### Added

- 🧠 **Self-Evolving Skills: Abu learns to remember the workflows you teach it**. After running a complex flow, Abu proactively asks "Want to crystallize this into a skill?" — one click drafts it, you review and adopt, and next time you just call it by name. Settings → Soul lets you tune the suggestion frequency: off / normal / companion.

- 🔔 **Notifications now read the room: quiet during fullscreen, speak up when you're back**. Previously, notifications during fullscreen video or meetings would either interrupt you or vanish silently. Now:
  - Fullscreen / Do Not Disturb → Abu stays quiet, the menu-bar icon tracks the unread count
  - Back in the main window → a sidebar dot tells you what happened while you were away
  - Scheduled tasks, skill suggestions, errors, and messages all go through one pipeline

- 📁 **Projects: conversations can finally be organized by project**. A workspace can be upgraded to a Project, and conversations under the same folder are automatically grouped.
  - Existing conversations are backfilled into their project on startup
  - The Welcome page shows a non-blocking hint "upgrade this workspace to a project?" (can be dismissed permanently)

### Improved

- ⏰ **Scheduled-task cold-start catch-up**: scheduled tasks that should have run while the app was closed are caught up in chronological order on next launch
- ✅ **Todo lists survive restarts**: todo plans in a conversation persist locally, so you can pick up where you left off after a restart
- 🗑️ **Skill draft recycle bin**: deleted drafts go to `.trash` first and are auto-cleaned after 24h, so accidental deletes can be recovered

### Fixed

- 🐛 Creating a new conversation no longer accidentally clears the bound global workspace
- 🐛 Tool-call argument preview no longer blows up in height on very long content
- 🐛 Project Settings multi-select dropdown no longer gets clipped inside the modal
- 🐛 More reliable category display for skill drafts in the toolbox

### Notes

- ⚠️ **Known issue**: skill drafts may not appear under Toolbox → Skills on certain paths; restarting the app or switching workspaces and back usually restores them, with a proper fix in the next release

## v0.12.0 · 2026-04-17

### Security

- 🔒 **Encrypted API key storage**: API keys are no longer stored in plaintext in localStorage
  - **Windows**: uses the system Credential Manager (DPAPI encryption, bound to your login account)
  - **macOS**: local AES-256-GCM encryption, with the key derived from the hardware UUID
  - Upgrading from 0.11 migrates automatically on first launch — seamless and under 1 second
- Settings → AI Services now has a "Clear all saved keys" button at the bottom as a hard-reset escape hatch

### Notes

- ⚠️ **One-way migration**: 0.12 is not backward-compatible with 0.11. If you need to roll back, back up your API keys manually before upgrading
- ⚠️ **Switching machines**: because the key is bound to the current hardware, migrating to a new Mac or replacing the mainboard requires re-entering your API key in settings. This is a **security feature** (preventing key leakage if a backup drive is stolen); affected provider cards show a red "Please re-enter API key" prompt
- If encrypted storage fails to initialize for any reason during upgrade, Abu keeps the plaintext localStorage as a fallback and **won't lose your keys**; it migrates automatically on the next normal launch

### Fixed

- Thinking bubble stuck spinning forever when the user cancels during the thinking stream
- Occasional "Error: Request cancelled" bubble when the user cancels a request

## v0.11.3 · 2026-04-17

### Improved
- More timely auto-update checks: checks once 30 seconds after launch, then every 6 hours in the background, so you won't miss a new version even with Abu open for a long time
- Clearer changelog display, with support for Markdown lists and links

### Fixed
- Fixed a release-pipeline defect (which prevented v0.11.2 from being distributed): an incorrect `actions/checkout` step order in the release pipeline wiped the downloaded installers, leaving the `platforms` field empty in `latest.json` so clients couldn't detect the new version

## v0.11.2 · 2026-04-17

> ⚠️ This version was not successfully distributed to users due to a release-pipeline defect and has been superseded by v0.11.3. The entry is kept for the record only.

### Improved
- More timely auto-update checks: checks once 30 seconds after launch, then every 6 hours in the background, so you won't miss a new version even with Abu open for a long time
- Clearer changelog display, with support for Markdown lists and links

## v0.11.1 · 2026-04-16

### Fixed
- Context menu getting clipped at screen edges
- Modals unexpectedly closing when dragged outside

## v0.11.0 · 2026-04-16

### Added
- **In-app auto-update**: when a new version is found you can download and install it right from Settings → About, no more jumping to a browser to download manually, and updates no longer trigger the macOS Gatekeeper prompt
- The sidebar gear icon shows a red dot when a new version is available

### Improved
- Auto-update support across three platforms: macOS (Intel + Apple Silicon) and Windows

---

For older versions, see the [GitHub Releases](https://github.com/PM-Shawn/Abu-Cowork/releases).
