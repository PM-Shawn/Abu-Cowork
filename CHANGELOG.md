# Changelog

All notable changes to Abu are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/).

> This file is the **English canonical** changelog — it drives the GitHub Release
> and the English update notes. The Chinese counterpart is
> [`CHANGELOG.zh-CN.md`](./CHANGELOG.zh-CN.md); keep both in sync per release (see
> `RELEASING.md`). Entries before v0.31.0 predate this split and remain bilingual.

## v0.41.0 · 2026-08-22

### ✨ Features

- **Images now reach DeepSeek's vision models** — The adapter never declared DeepSeek's vision route, so an attached picture was silently swapped for a text placeholder. Vision-capable DeepSeek models now receive the actual image.
- **One oversized picture can no longer wedge a session** — Every provider route now budgets attached-image size and count at admission. Formats no route accepts are re-encoded even when their pixel dimensions are fine — previously a small `.bmp` walked straight through, entered durable history, and 400'ed every later request in the conversation. The downscale notice also survives retries, so a retried turn asking about coordinates or fine print no longer reads a shrunken screenshot believing it is full size.
- **Enter is now your choice** — Pick whether Enter sends or starts a new line. IME composition is double-guarded, so confirming a Chinese/Japanese candidate never fires a send, and Alt+Enter no longer reorders what you typed.
- **Browser tools drive enterprise admin forms directly** — Readonly comboboxes and antd-style custom dropdowns are now first-class: snapshots see them and click/select/fill operate them, instead of degrading to page scripts. Waiting for an element to disappear returns in milliseconds instead of burning the full 30-second timeout (a ref that stops resolving *is* the disappearance), and a popup hidden via `visibility:hidden` is no longer treated as live — the agent can no longer pick an option from a closed dropdown.
- **Model fetching without surprises** — Fetched model lists arrive unchecked instead of pre-selecting everything, built-in providers can fetch too, and the curated lists are refreshed to the current model generation. Fetch failures now tell the truth: a rejected key (401/403) is no longer shown as "this provider cannot list models" — errors are typed and carry the HTTP status — and Volcengine's fetch button appears only on plan tiers that actually support listing.
- **Windows workspace header reworked; macOS app name localizes** — The workspace header lays out properly on Windows, and on Chinese macOS locales the app now displays its Chinese name instead of the romanized one.

### 🐛 Fixes

- **The context meter told the truth about a compacted conversation** — A long conversation could read "108% used · 138.4k / 128.0k tokens" while the request being sent fit the window comfortably. The indicator was re-counting the full raw history kept for the UI, which silently undid every reduction the send path had applied. It now builds on the agent loop's own post-compression measurement and estimates only the reply still streaming. Displayed percentages are also clamped, since a reading above 100% is always a measurement artifact.
- **Overlay dialogs are clickable again over window drag lanes** — `-webkit-app-region` is an OS-level geometry union that ignores z-index, so a dialog overlapping a drag lane had its buttons silently swallowed; ~30 dialogs now opt out explicitly and a source-scan test guards new ones. macOS header rows drag the window again.
- **Copying an image inside the app pastes an image again** — not a useless file badge.
- **Two agent-loop teardown races closed** — A follow-up can no longer be staged into a run that already ended, and a run's late cleanup can no longer delete the next turn's crash-recovery checkpoint (the in-process path now uses the same loop-guarded clear as the sidecar path).

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.40.0...v0.41.0

## v0.40.0 · 2026-08-20

### ✨ Features

- **Longer conversations cost less and start answering sooner** — The system prompt is now stable across turns: the clock is day-granularity (ask the model to run `date` when it needs the exact time), and per-turn state (todos, recalled memories) rides after the conversation instead of inside the prompt. Together with a message-history cache breakpoint, a long session stops re-billing its whole history on every request. Read-only `run_command` batches (greps, listings, file reads) now run concurrently instead of one after another, and `edit_file` tolerates whitespace drift in the quoted original rather than costing a full retry round-trip.
- **Memory recall works for Chinese** — The relevance tokenizer only split on whitespace, so a whitespace-free Chinese query was a single token that matched nothing and recall was effectively dead. Chinese queries are now tokenized into character bigrams, weighted below word matches and gated so a single shared pair cannot pull in an unrelated memory.
- **Blocking a site is now one click** — v0.39.0 shipped per-site verdicts but no way to record "no": the only way to stop being asked about a site was to approve it. The confirmation dialog now offers "block this site", and Settings › Capabilities lets an already-allowed site be switched to blocked.
- **Scheduled tasks carry their own permission mode** — A task can run at a different trust level than your interactive chat, and always-ask actions no longer offer a permanent grant.
- **New `capability_snapshot` tool** — A read-only report of what the current run can actually do.

### 🔒 Security

- **`read_tools` is now an enforced ceiling, not a request** — The unattended read-only tier promised "reads information, changes nothing" but rested on a confirmation callback that a workspace-internal `safe` command never reached, so `touch`, `mkdir`, `cp`, `node` and `npm install` all ran. The tier is now a positive allowlist enforced on the tool roster, at dispatch, and at the sidecar boundary. Any tool not classified — including MCP tools — is denied.
- **Delegation no longer escapes the tier** — An `@agent` message and `delegate_to_agent`/`run_agent_batch` forwarded neither the run's allowlist nor its blocklist, so a single message on a read-only channel could spawn a subagent with no ceiling at all. All three delegation entry points now pass both restrictions, and subagents enforce them.
- **The Computer Use safety budget actually holds** — The 30-step / 5-minute cap was enforced only in the renderer and reset at the top of every batch, so a multi-batch task never reached either limit. The budget now rides the main-process task lease and its deadline is fixed the first time it is taken.
- **Crash reports carry the shape of an error, not its contents** — Automatic error reports normalize paths, URLs, emails, CJK runs and quoted spans out of the message before it leaves the machine. Raw messages stay local, in the runtime log and in a user-initiated diagnostic bundle.
- Credential-shaped content is redacted at the memory write funnel, and raw MCP connection errors are sanitized before reaching the model.

### 🐛 Fixes

- **Stopping a stream no longer loses the partial reply** — The stop revision was written outside the conversation's serial persistence queue, so under load it could overtake the assistant row's own append, find no row to revise, and be silently dropped. The visible partial answer then disappeared on the next load, with no error anywhere on the path.
- Message history is now an append-only ledger: a crash mid-write can no longer truncate a conversation, and a stale crash-leftover snapshot can no longer overwrite a finished reply or resurrect a removed one.
- Main-process and renderer crashes are recorded locally, and a sidecar crash loop is reported instead of failing quietly.
- Computer Use stop now targets the session that owns the run rather than whichever conversation is on screen, and structured-mode `get_app_state` resolves the frontmost app correctly.
- The thinking block's placeholder → thinking → done transitions are steadier: the block now animates open and rolls up instead of remounting, the status line keeps one size and position throughout, and the streaming answer pane no longer jitters from the manual bottom-stick. Some residual movement during these transitions is still under investigation and is not fully resolved in this release.
- `delegate_to_agent` is scheduled as concurrency-safe again, so fan-out is not serialized.

### ⚠️ Behavior change

- **Deleting a single message has been replaced by redoing a turn.** None of the comparable tools ship per-message delete; all answer "redo this turn" with a rewind, and a rewind is what the durable message ledger can guarantee. Redoing a turn that is not the last one now asks first and tells you how many later turns it discards.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.39.0...v0.40.0

## v0.39.0 · 2026-08-18

### ✨ Features

- **Per-site browser authorization** — The browser action confirmation now offers "Always allow this site" next to "Just this once". Verdicts are stored per exact origin (denied > allowed > ask), visible and revocable under Settings › Capabilities, and apply to both the built-in browser and the connected Chrome bridge. Page scripting (`execute_js`) never gets a permanent grant — each run asks separately. Scheduled tasks can now act on sites you pre-authorized; everything else stays fail-closed when nobody is present.
- **Approval gates for high-consequence actions** — State-changing browser automation (click, fill, navigate, scripting) asks before acting inside your logged-in sessions, in every permission mode. Self-extension (creating a subagent, installing an MCP server, rewriting the persona) requires an explicit per-act confirmation.
- **Telemetry opt-out** — Anonymous usage/error reporting can be turned off in Settings › Diagnostics.

### 🐛 Fixes

- The close-window dialog is no longer painted over by the browser pane — quitting the app with a browser tab open works again; while any modal is up, the pane shows a frozen snapshot of the page instead of flashing to blank white.
- Browser toolbar tooltips are no longer clipped by the native webview.
- The terminal pane follows the app theme (no more fixed dark palette on light theme).
- Failed runs no longer render the same error twice; the insufficient-balance message now says what to do.
- The user's input is no longer silently dropped when a run is rejected (no API key, dispatch failure, denied confirmation, aborted precompute) — it is restored to the input box.
- Tool-call intent is persisted before tools run, so a crash mid-batch can no longer be misread as "nothing executed".
- Runtime trace events now carry the conversation id across renderer, sidecar, and host planes.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.38.1...v0.39.0

## v0.38.1 · 2026-08-16

**Root cause**: The one-time Tauri→Electron localStorage migration validated its completion sentinel against a fingerprint of the legacy database's file metadata — but merely reading that database mutates its sidecar files (SQLite WAL `-shm` on macOS, LevelDB LOCK/LOG on Windows), so the sentinel never stayed valid and the migration re-imported the stale legacy snapshot on every launch, overwriting 13 renderer stores (deleted providers resurrected after restart). Separately, a broken OS keychain surfaced only as individual API-key failures with no way to see the real cause.

**Fixes**:

- A completed migration is now permanent; legacy-source drift is logged, never silently re-applied (macOS and Windows).
- Re-entering an API key clears the "could not be decrypted" banner immediately; a failed encrypted save now shows a warning on the provider card instead of failing silently (the key keeps working via the local fallback).
- New "Encrypted key storage" diagnostics row runs a real write→read→delete probe and counts undecryptable keys, so a broken system keychain is visible at a glance; the decrypt-failure message now names the encryption-key mismatch instead of guessing a hardware change.
- Image generation: a Volcengine chat-endpoint misconfiguration now returns an actionable hint (correct image endpoint + doubao-seedream models) in tool errors and an inline settings warning; orphaned `imagegen:*` secrets left by historical migration re-runs are swept at startup (macOS).

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.38.0...v0.38.1

## v0.38.0 · 2026-08-14

### Features

- **Reliable Computer Use loop** — Desktop control now follows an enforced Observe → Act → Verify cycle. Every writable action consumes a short-lived, single-use observation state bound to the target app and process, then requires a fresh observation before another action.
- **Guided permissions and recovery** — Abu requests only the macOS permissions required by the current task, explains when a relaunch is needed, and can return to the original conversation without reusing an old authorization or accessibility session.
- **Clear model capability modes** — Models are shown as full, structured, unsupported, or unknown. Tool-capable models without image input, including supported DeepSeek configurations, can use structured accessibility data without being presented as visually capable.

### Reliability and Safety

- Consequential actions are classified again by the Electron host and require a one-attempt confirmation; an ambiguous native result stops the task instead of retrying a possible side effect.
- Stale observations, target-process changes, helper restarts, renderer reloads, and duplicate writes fail closed. Windows desktop control also serializes writes across approval and native-input paths.
- Repeated no-change observations allow one bounded recovery attempt, then stop with an explicit result rather than looping indefinitely.

### Diagnostics

- The capability page and task status now show the active target, capability mode, permission state, and Observe/Act/Verify phase.
- Local runtime traces correlate the conversation, loop, tool call, observation state, helper generation, and verification result through an allowlist that excludes prompts, screenshots, accessibility labels, user input, and tool-result bodies.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.37.4...v0.38.0

## v0.37.4 · 2026-08-14

**Root cause**: A stopped turn and its queued follow-ups were reconciled through overlapping renderer and sidecar lifecycle paths. That allowed a queued message to start before the active reply had settled, disappear during state replacement, or leave an empty assistant row after Stop.

**Fix**:

- Queued follow-ups now wait for the active turn to reach a durable terminal state, then start in order with the same visible thinking feedback as a normal message.
- Queue entries stay visible and recoverable until their own run takes ownership, preventing a follow-up from disappearing or being attached to the previous answer.
- Stopping a turn now preserves an explicit stopped result while removing only truly empty streaming placeholders; the redundant per-message running label is no longer shown.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.37.3...v0.37.4

## v0.37.3 · 2026-08-13

**Root cause**: Electron Builder 26 writes external updater blockmaps without a `blockMapSize` field. Release staging treated that missing field as permission to omit the blockmap, so the three architecture feeds could reference complete installers while their differential update metadata returned 404.

**Fix**:

- macOS Apple Silicon, macOS Intel, and Windows updater feeds now publish the external blockmap beside every referenced artifact, allowing supported upgrades to use differential downloads again.
- Release staging fails before publication if any feed-referenced blockmap is missing, and still verifies its exact size whenever the feed provides one.
- Full-installer fallback behavior is unchanged for clients that cannot apply a differential update.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.37.2...v0.37.3

## v0.37.2 · 2026-08-13

**Root cause**: On Windows, Credential Manager entries can outlive AppData. The transition startup kept retrying stale or unreadable credentials after the legacy Tauri profile had been removed, while completed migration markers did not preserve enough source evidence across later launches.

**Fix**:

- A clean reset or reinstall no longer loops on `windows-secret-migration-failed` when no live Tauri data remains.
- Completed migration markers retain source inventory and trusted v2 provenance, so later launches make the same safe migration decision.
- Real or ambiguous legacy data still fails closed; Abu never silently discards credentials that may still be recoverable.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.37.1...v0.37.2

## v0.37.1 · 2026-08-13

**Root cause**: Renderer lifecycle changes and sidecar reconnects could detach a task from its event stream, leaving the message stuck in a loading state even after the run had completed or failed.

**Fix**:

- Task events now use a dedicated, sequenced sidecar channel with status replay, so Abu can restore the existing run after a renderer reload or temporary disconnect instead of spinning indefinitely.
- Terminal states are settled exactly once and stale sidecar generations are ignored, preventing duplicate tool side effects while reconnecting.
- Connection failures now surface an explicit disconnected or reconnecting state rather than leaving the task on an ambiguous loading indicator.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.37.0...v0.37.1

## v0.37.0 · 2026-08-12

### Features

- **Reliable task execution across process boundaries** — A turn is now written to disk before execution starts, receives a bounded start acknowledgement, and settles only after its completed, failed, or interrupted state is durable. If Electron or the sidecar disconnects, Abu queries the existing run and resumes observation instead of replaying tool work.
- **Actionable diagnostic bundles** — Exports now recheck live health and include a scrubbed manifest plus a renderer-to-sidecar run timeline, making it possible to distinguish persistence, startup, first-response, cancellation, and provider failures without collecting prompts, replies, credentials, or local paths.
- **Adaptive context budgeting** — Long conversations reserve space for system prompts, tools, images, and model output before sending, then compact progressively while keeping recent user intent and tool results available.

### Fixes

- **One task owner per conversation** — Rapid sends, image attachments, scheduled tasks, triggers, and IM messages can no longer start overlapping model streams in the same conversation; text follow-ups remain safely staged for an interactive task.
- **Stop and crash recovery are durable** — Stop waits for queued frames and local persistence, removes empty streaming placeholders, preserves queued follow-ups, and recovers partial replies after app termination or sidecar replacement.
- **Custom web search status is accurate** — The AI services page now reflects a configured custom search endpoint instead of reporting the capability as unavailable.
- **Update notes follow the selected language** — Switching the interface language now refreshes the update dialog with the matching English or Chinese release notes instead of keeping the previous locale.

### Platform-Specific

- **Windows** — Python launcher commands such as `py -3` and `py -3.12` are parsed as interpreter selectors, so bundled and host Python execution no longer forwards an invalid selector to CPython.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.36.1...v0.37.0

## v0.36.1 · 2026-08-12

**Root cause**: When a conversation stopped sending, previous support bundles could not show which boundary stalled between the renderer, Electron main process, sidecar, and model request; version and update surfaces could also report stale release metadata.

**Fix**:

- Runtime diagnostics now correlate renderer, Electron main, and sidecar checkpoints with run and RPC identifiers, including sidecar readiness, first response, a 30-second no-response stall, bridge acknowledgement, cancellation, and failure stages.
- Diagnostic exports automatically include the renderer trace, pending RPCs, and sidecar state. Fields are allowlisted and scrubbed so prompts, responses, credentials, and provider response bodies are not collected.
- Diagnostics and update checks now use the live app version, actively verify update status, and display localized notes only when they match the exact release metadata.
- Website download labels and bilingual release metadata now follow the latest published GitHub Release consistently.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.36.0...v0.36.1

## v0.36.0 · 2026-08-09

### ✨ Features

- **Help opens the online documentation** — The Help entry in the account menu now opens the official website guide in your language (Chinese or English) instead of the older in-app guide, so the docs stay current without shipping a new app build.
- **Unified capability center for personal and organization tools** — The toolbox brings personal and organization-provided capabilities into one place, with per-capability scope and clearer entitlement state for enterprise-managed setups.
- **Managed Agent templates for organizations** — Enterprises can distribute managed Agent templates that appear alongside personal Agents and stay in sync through a defined extension contract.

### 🐛 Fixes

- **Enterprise capabilities fail closed** — Unlicensed local capabilities are retracted and entitlements are mirrored into the sidecar, so an organization member never sees a capability they are not entitled to.

### Changed

- **Enterprise client internals isolated behind the open-core boundary** — Gateway model integration, entitlement mirroring, and bind-flow surfaces were refactored so closed logic lives in the private module while the public repository keeps only the extension shape.

### Docs

- Installation and user guides now route through the website with refreshed terminology, and `AGENTS.md` became the single source of truth for repository conventions (`CLAUDE.md` is a thin `@import` shell).

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.35.0...v0.36.0

## v0.35.0 · 2026-08-05

### Added

- **Preview file actions are easier to reach without crowding the header** — Reveal in folder, copy path, and save as now share one compact, keyboard-dismissable menu across supported file previews.
- **Image and PDF reading controls are more complete** — Images can be zoomed, rotated, panned, and reset; PDF controls and selectable document content remain usable while moving between workspace tabs.
- **Workspace context stays visible and tab state is preserved** — New unbound tasks keep the workspace chooser available, the browser-tab entry is restored, and switching between browser and preview tabs no longer discards the active preview state.

### Security

- **Electron build tooling uses patched HTTP dependencies** — The locked `undici` versions move to `7.29.0` and `6.28.0`, resolving the current High advisory and seven related advisories without changing application runtime behavior.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.34.2...v0.35.0

## v0.34.2 · 2026-08-04

### Added

- **Unsent drafts now follow each task** — Text typed in a new or existing task is restored after switching away or restarting Abu. Draft keys are scoped to the current local or enterprise account so another account on the same computer cannot see them; file and reference attachments remain session-only.
- **Custom MCP servers can be renamed safely** — Renaming a server updates its stored identifier and rewrites matching references in conversations and projects without changing built-in servers.
- **Bailian supports pay-as-you-go plans** — The provider setup now offers the matching plan and clearer configuration guidance.

### Fixed

- **Files and folders can be dragged into Electron again** — Chat attachments and Skill imports now resolve user-dropped files through a narrow preload bridge on macOS and Windows. Attachment chips also keep a consistent trailing inset.
- **Diagnostic bundle uploads no longer fail with `no_console_url` in official builds** — The upload target is validated during packaging, malformed targets produce actionable feedback, and release CI rejects a build that would ship without a usable Console URL.
- **Stopping a task completes deterministically** — The renderer and sidecar now reconcile stop/finalization events so tasks do not remain stuck in a stopping state or lose the final partial result.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.34.1...v0.34.2

## v0.34.1 · 2026-08-02

**Root cause**: Slow network setup and package verification had no moving status, while candidate builds compiled the renderer before applying their packaged version, making an RC look like the stable release it was still downloading.

**Fix**:

- Update downloads now report three visible phases—preparing, downloading, and verifying—with an indeterminate activity bar before byte totals are known and one-decimal live progress during transfer.
- macOS and Windows release jobs now compile the renderer with the exact packaged candidate version, so About, diagnostics, and the updater agree on what is actually installed.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.34.0...v0.34.1

## v0.34.0 · 2026-08-01

### Highlights

- **Abu now ships on Electron across all supported desktops** — macOS Apple Silicon, macOS Intel, and Windows x64 use the same Electron shell, Abu frontend, sidecar, built-in skills, and bundled Node/Python runtimes. Each package is built and smoked on a matching native runner; macOS is Developer ID signed and notarized.

### Fixed

- **Native window controls behave consistently** — Windows now uses a compact system title bar with working drag, minimize, maximize, close, menus, modal masking, sidebar/search controls, and panel resizing. macOS keeps the compact traffic-light layout without placing clickable controls inside drag regions.
- **The local Chrome bridge recovers more reliably** — The extension installer opens the correct parent folder, setup text matches Chrome's folder picker, and Abu reclaims only bridge processes it can identify safely instead of silently terminating unrelated listeners.
- **Transition installs preserve a usable rollback** — Windows keeps the previous Tauri installation available for one release and converges duplicate uninstall entries correctly. macOS migration rejects unsafe links, repairs supported package-manager links, and stops before opening an empty profile when validation fails.
- **Document and Browser Bridge dependencies are security-hardened** — Excel, PPT preview, MCP runtime, and the bundled Chrome bridge now use fixed versions and pass real Excel round trips, PPT preview tests, production audits/builds, and packaged document/browser smoke.
- **Automation and local-preview boundaries are stricter** — Custom-trigger tool allowlists now apply across the main loop, sidecar, and delegated agents; default-app opening no longer constructs shell commands; HTML previews deny external requests, form submission, and popup escape paths by default.
- **Secret-store failures no longer silently lose edits** — If encrypted storage fails later in a session, Abu immediately restores its data-preserving fallback so a newly edited model or auxiliary-service key survives restart.

### Migration notes

- On the first official Electron launch, the installed Tauri profile is treated as the migration source. Abu copies conversations, sessions, settings, and supported credentials into a separate Electron data root; the original Tauri data is retained.
- If an Electron profile already exists, Abu creates a recovery backup before applying the authoritative Tauri values needed for the transition. Incomplete migration records remain retryable, and a failed migration stops startup before the new shell can write an empty state.
- Source/fork packages keep migration and the official Abu updater disabled by default. Only the official release workflow can enable them.

### Known limitations

- Windows uses a current-user NSIS installer and does not require administrator rights, but it is not Authenticode-signed yet. SmartScreen may require **More info → Run anyway**.
- The Chrome extension is distributed locally and must be loaded once through Chrome's developer mode. Microsoft Store distribution, full Windows sandbox parity, and Computer Use parity are not part of this release.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.33.0...v0.34.0

## v0.33.0 · 2026-07-19

### Added

- **AI edits are now recorded in the preview's version history** — Previously the version history only tracked your own manual saves; edits the AI made to a file left no restore point (the mirror-opposite of what you'd expect). Now every AI write/edit snapshots the file's prior state — once per turn, before the first change — so you can review and revert an AI change just like one of your own. Each is marked with a "Before AI edit" badge. Reverting also auto-snapshots the current state first, so a revert itself can be undone. Snapshots are capped at 5MB each, and the seq-0 baseline is never evicted.

### Fixed

- **Generated images no longer fail to load in the packaged app** — Images returned as base64 (e.g. Volcengine Seedream, gpt-image-1) showed "Load failed" in the installed build only: the packaged app's stricter CSP blocked the `data:`-URL decode path that dev builds allow. They now decode via `atob()`, which the CSP permits. Backends that return an image URL were never affected — which is why dev smoke tests didn't catch it.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.32.0...v0.33.0

## v0.32.0 · 2026-07-19

### Added

- **Select an element in the HTML preview → add to chat** — In the HTML preview panel, toggle "select element", hover to highlight any element on the page, and click to send it to the composer as a reference (with an optional comment as an instruction). The picker is injected server-side into the loopback-served preview and returns selections over an `origin`- and nonce-checked `postMessage` channel, so it runs only on your own local files. Hover badges, click-to-reselect, and the comment shortcut (⌘/Ctrl+J) match the document-selection toolbar.
- **Localized update notes** — The in-app update dialog and the website's "What's new" now show release notes in your language (English or Chinese), driven from a single structured source per release.

### Changed

- **Local HTML opens in the preview panel** — The manually-opened browser tab's entry points are hidden; local HTML files are viewed — and now inspected — in the preview panel, where UTF-8 charset and the source toggle already live. The browser tab stays available programmatically for a future agent-browsing surface.

### Fixed

- **Markdown**: a single tilde `~` no longer renders as strikethrough — only `~~x~~` does.
- **UI**: selected/active items are now visible on the recessed canvas; scrollbars stay hidden app-wide until you scroll; the update-download progress bar no longer animates its width oddly.
- **Theme**: the Windows native title bar now follows the app's dark mode. Upgrading users are reset once to the default light theme on this update.

**Full Changelog**: https://github.com/PM-Shawn/Abu-Cowork/compare/v0.31.0...v0.32.0

## v0.31.0 · 2026-07-18

### Added

- **Multi-tab right-panel workspace** — The file-preview panel becomes a multi-tab workspace: multiple files previewed side by side (kept alive while hidden), a real PTY terminal (portable-pty backend + xterm.js frontend), and a native-webview browser tab that loads any site without iframe X-Frame-Options limits — with a task-summary default tab.
- **Card-on-canvas main-window redesign** — A card-based visual hierarchy, a top bar aligned to the macOS traffic lights, and the toolbox & automation folded into an in-layout card grid (fixed-size cards + auto-fill grid + a unified enable toggle).
- **Conversation full-text search over FTS5** — The sidebar conversation-search modal is wired to SQLite FTS5, searching across history by title + body.
- **Account menu + settings navigation** — The three bottom-sidebar buttons collapse into an avatar popover (inline theme/language switches, real check-for-update flow); settings are regrouped.

### Changed

- **8-token typography scale** — All font sizes migrate to an 8-step `--text-*` token scale (font-size + line-height + font-weight bound together); px hardcodes and named sizes are eliminated. Reading body is set to 14px and heading weight is capped at 600.
- **Semantic + link color tokenization** — Link and status colors are consolidated into `--abu-{danger/warning/success/info}` (fg/solid/bg roles) plus a dedicated `--abu-link`; 765 raw Tailwind color usages are tokenized and brought to WCAG AA, and `--abu-text-muted` is raised to AA.

### Fixed

- **Message-list bottom-lock + search jump** — The virtualized message list now locks to the bottom on open/switch; search-hit navigation lands with a fading highlight.
- **`cn()` dropping font-size tokens** — Fixed tailwind-merge misclassifying `text-[var(--)]` as a font-size and silently dropping the token (root-fixed via extendTailwindMerge, app-wide).
- **Workspace tab interactions** — Tab drag actually reorders (neutral drop indicator), the close (×) no longer starts a drag, the PDF worker loads via Vite `?url` with a memoized file object (fixes "object can not be cloned"), and the panel-collapse button is restored.
- **PTY child-process cleanup** — Reap the child when a terminal is killed; clean up orphans on a spawn race.
- **macOS top-bar clickability** — The + button above the tab strip no longer sits under the macOS drag region.

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
