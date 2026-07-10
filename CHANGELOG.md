# Changelog

All notable changes to Abu are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/).

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
