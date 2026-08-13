<div align="center">

**English** | [中文](README.zh-CN.md)

<img src="website/assets/readme-cover.en.jpg" alt="Abu — Your AI Desktop Office Assistant" width="100%" />

# Abu

**Your AI Desktop Office Assistant — Just Leave It to Abu**

A locally-run AI desktop assistant inspired by Claude Code's Cowork mode.
Tell Abu what you need — it reads files, runs commands, writes docs, and builds reports, all on your machine.

[![Release](https://img.shields.io/github/v/release/PM-Shawn/Abu-Cowork?style=flat-square)](https://github.com/PM-Shawn/Abu-Cowork/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)

[Download](#download) · [Quick Start](#quick-start) · [Features](#features) · [User Guide](docs/User-Guide.md) · [Build from Source](#build-from-source)

</div>

---

## Why Abu?

| Feature | Abu | Regular AI Chat | Traditional Automation |
|---------|-----|----------------|----------------------|
| Autonomous planning & task execution | :white_check_mark: | :x: | :x: |
| Read/write local files, run commands | :white_check_mark: | :x: | :white_check_mark: |
| Natural language interaction | :white_check_mark: | :white_check_mark: | :x: |
| 29 built-in skills + self-evolving (Abu grows its own) | :white_check_mark: | :x: | :x: |
| Multi-conversation Project aggregation | :white_check_mark: | :x: | :x: |
| Scheduled tasks & event triggers | :white_check_mark: | :x: | :white_check_mark: |
| IM bot (Lark/DingTalk/WeCom/Slack) | :white_check_mark: | :x: | Partial |
| Multi-agent parallel execution | :white_check_mark: | :x: | :x: |
| Browser & computer control | :white_check_mark: | :x: | Partial |
| 100% local data, privacy-safe | :white_check_mark: | :x: | :white_check_mark: |

---

## What's New

**[Download the latest stable release](https://github.com/PM-Shawn/Abu-Cowork/releases/latest)** · [Read the full changelog](CHANGELOG.md)

Recent highlights: **Workspace file tree + code canvas** (browse / preview / edit files in the side panel, CodeMirror source editing with auto-save, preview auto-refresh, version snapshots with rollback), **declarative progress panel** (the model declares its own plan steps and status via `report_plan`), **inline visualization widgets** (charts / HTML / Mermaid rendered inline in chat), **multi-endpoint provider presets** (Volcengine / Bailian / Zhipu access plans as curated presets + a unified add/edit modal), **per-model capabilities** (vision / tools / reasoning / token limits declared per model), plus **doc comment-to-chat**, **full internationalization**, and **signed + notarized macOS builds**.

> Full changelog per release: see [Releases](https://github.com/PM-Shawn/Abu-Cowork/releases).

## Preview

> Clean interface, powerful capabilities

<table>
<tr>
<td align="center" width="50%"><b>Welcome</b><br/>Natural language input — conversation is the command<br/><br/><img src="website/assets/screenshot-welcome.en.png" width="100%" /></td>
<td align="center" width="50%"><b>Task Execution</b><br/>Autonomous planning & tool invocation for complex tasks<br/><br/><img src="website/assets/screenshot-execution.en.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Web Pages · Live Preview</b><br/>Generate a site and preview it live, side by side<br/><br/><img src="website/assets/screenshot-web-pages.en.png" width="100%" /></td>
<td align="center"><b>Content Creation · Live Preview</b><br/>Draft documents with a real-time Markdown preview<br/><br/><img src="website/assets/screenshot-doc-edit.en.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Plan Mode</b><br/>High-risk tasks show a plan first — runs only after you confirm<br/><br/><img src="website/assets/screenshot-plan-mode.en.png" width="100%" /></td>
<td align="center"><b>Interactive Questions</b><br/>Abu pops an option card when it needs you to decide (single / multi-select)<br/><br/><img src="website/assets/screenshot-ask-question.en.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Multi-Agent Parallel</b><br/>Up to 5 background agents working at once, progress in real time<br/><br/><img src="website/assets/screenshot-multi-agent.en.png" width="100%" /></td>
<td align="center"><b>Desktop Pet · Activity Tray</b><br/>A floating pet on your desktop, its tray showing Abu's live status<br/><br/><img src="website/assets/screenshot-pet.en.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Theme · Dark</b><br/>A polished, low-glare dark theme<br/><br/><img src="website/assets/screenshot-theme.en.png" width="100%" /></td>
<td align="center"><b>Theme · Light</b><br/>Switch between light / dark / follow-system<br/><br/><img src="website/assets/screenshot-theme-light.en.png" width="100%" /></td>
</tr>
<tr>
<td align="center" colspan="2"><b>Labs</b><br/>In-progress features, off by default, opt-in (currently hosting: Desktop Pet)<br/><br/><img src="website/assets/screenshot-labs.en.png" width="60%" /></td>
</tr>
<tr>
<td align="center"><b>Permission Control</b><br/>File access requires user authorization<br/><br/><img src="website/assets/screenshot-permission.en.png" width="100%" /></td>
<td align="center"><b>IM Channel Chat</b><br/>@Abu in Lark/DingTalk to interact<br/><br/><img src="website/assets/screenshot-im-chat.en.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Skills</b><br/>29 built-in skills + self-evolving + custom<br/><br/><img src="website/assets/screenshot-skills.en.png" width="100%" /></td>
<td align="center"><b>MCP Connectors</b><br/>One-click integration with Playwright, GitHub & more<br/><br/><img src="website/assets/screenshot-mcp.en.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Scheduled Tasks</b><br/>Cron-based scheduling for automated workflows<br/><br/><img src="website/assets/screenshot-schedule-create.en.png" width="100%" /></td>
<td align="center"><b>Triggers / Watch</b><br/>HTTP, file changes, IM messages auto-trigger tasks<br/><br/><img src="website/assets/screenshot-triggers.en.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>AI Service Management</b><br/>Multi-provider management with health checks<br/><br/><img src="website/assets/screenshot-settings-ai.en.png" width="100%" /></td>
<td align="center"><b>IM Channel Config</b><br/>Connect Lark, DingTalk, WeCom & more<br/><br/><img src="website/assets/screenshot-settings-im.en.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Personal Memory</b><br/>Remembers your preferences and work habits<br/><br/><img src="website/assets/screenshot-memory.en.png" width="100%" /></td>
<td align="center"><b>Security Sandbox</b><br/>Seatbelt sandbox + network isolation for privacy<br/><br/><img src="website/assets/screenshot-security.en.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Soul (Personality)</b><br/>3 proactivity presets + custom SOUL.md for tone & style<br/><br/><img src="website/assets/screenshot-soul.en.png" width="100%" /></td>
<td align="center"><b>Diagnostic Panel</b><br/>One-click self-check across AI / MCP / skills / network + bundle export<br/><br/><img src="website/assets/screenshot-diagnostic.en.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Expert Agents</b><br/>A library of expert agents you can summon by @name<br/><br/><img src="website/assets/screenshot-agents.en.png" width="100%" /></td>
<td align="center"><b>Usage Stats</b><br/>Requests, tokens, cache hits, and per model / skill usage<br/><br/><img src="website/assets/screenshot-usage.en.png" width="100%" /></td>
</tr>
<tr>
<td align="center" colspan="2"><b>Projects & Workspaces</b><br/>Group work into projects, each with its own skills & MCP<br/><br/><img src="website/assets/screenshot-project.en.png" width="60%" /></td>
</tr>
<tr>
<td align="center" colspan="2"><b>Content Safety Scan</b><br/>Three permission modes (Request Approval / Smart Review / Full Autonomy) + scan agents / skills / memory for prompt injection & dangerous instructions<br/><br/><img src="website/assets/screenshot-security-scan.en.png" width="60%" /></td>
</tr>
</table>

## Features

### Core Capabilities

- **Autonomous Agent** — More than chat: plans, invokes tools, reads/writes files, executes commands, and completes complex tasks end-to-end
- **Plan Mode** — For high-risk steps (delete / overwrite / send / install), Abu first presents a step-by-step plan and waits for you to click "Confirm & run"; only read-only ops run while awaiting approval
- **Interactive questions** — When Abu needs you to decide (pick an approach, provide a parameter), it pops an option card above the composer; single or multi-select, with an "Other" free-text row
- **Per-conversation settings** — Permission mode (Request Approval / Smart Review / Full Autonomy) and model can be switched per conversation without bleeding across chats
- **Soul Personality System** — Three proactivity presets (Quiet / Buddy / Butler) decide when Abu speaks up; customize tone, address, reply style, and boundaries via `SOUL.md`
- **Self-Evolving Skills** — After you run a multi-step complex flow, Abu proactively offers "want to crystallize this into a skill?" — one click drafts it, you review, you accept. Next time, just name the skill; no need to re-explain
- **Smart Notification System** — Menubar unread count / sidebar badge / system notification auto-routed; notices queued to inbox while you're in fullscreen / DnD, surfaced via badges once you're back; audit trail kept for 180 days
- **Projects** — Promote a workspace into a Project: conversations in the same direction auto-aggregate; each project gets its own default model, skill set, and MCP connectors
- **Multi-Agent Parallel Execution** — Run up to 5 background agents simultaneously, each executing tasks independently with real-time progress tracking
- **Desktop Pet** (Labs) — Transparent floating window; left-click opens main window, right-click menu, drag-to-edge dock; **activity tray** shows Abu's live status (working / awaiting approval / done) and lets you reply inline while it waits
- **Theme switching** — Light / dark / system, via Settings → Appearance
- **Labs** — In-progress features, off by default, opt-in, may change or be removed (currently hosting: Desktop Pet)
- **Conversation Sharing** — Export any conversation to JSON in one click; API keys and local paths are auto-redacted before sharing
- **29 Built-in Skills** — PDF/PPTX/DOCX/Excel generation, frontend design, canvas design, algorithmic art, Mermaid/SVG/infographics, Abu's built-in browser, optional Chrome bridge, deep research, Agent self-reflection (reflect), workflow automation, and more — one-click install, fully customizable
- **MCP Protocol** — Connect to databases, search engines, GitHub, and other external services via Model Context Protocol
- **Browser Automation** — Zero-setup built-in browser for ordinary web tasks, plus an optional Chrome extension bridge for existing tabs and signed-in sessions
- **Computer Use** — Screenshot + mouse/keyboard control for desktop-level tasks, with sensitive app blocking, dangerous key interception, and a 5-minute session timeout
- **HTTP Fetch** — Built-in safety gateway: URL length cap, embedded credential blocking, cloud metadata endpoint blocking, 10 MB download limit, 60-second timeout — no more raw `curl` blind spots

### AI Services & Models

- **12+ Cloud Providers** — Anthropic Claude, OpenAI, DeepSeek, Qwen (Bailian), Doubao (Volcengine), Moonshot, Zhipu GLM, MiniMax, SiliconFlow, Qiniu, OpenRouter, and more
- **Local Models** — Zero-config Ollama integration with automatic local model discovery
- **Custom Endpoints** — Connect any OpenAI-compatible or Anthropic-compatible API
- **Provider Management** — Add, edit, delete, reorder providers with connection health checks and latency detection
- **Model Selector** — Switch models on-the-fly during conversations with capability badges (vision, tool use, web search, thinking, image generation, long context)
- **Favorites & History** — Star frequently used models, quickly switch between recent ones
- **Image Generation** — Built-in DALL-E 2 / DALL-E 3 support, plus any custom image-generation endpoint

### Web Search

- **Multiple Search Engines** — Bing, Brave, Tavily, SearXNG (self-hosted, no API key needed)
- **Independent Configuration** — Search engine settings decoupled from main AI service

### Automation & Triggers

- **Scheduled Tasks** — Cron-based scheduling (e.g., daily AI news digest at 9 AM); runs missed while the app was closed are replayed in time order on next launch
- **Trigger System** — Multiple event sources to automatically invoke agents:
  - **File Watcher** — Monitor file create/modify/delete events with glob patterns
  - **HTTP Webhook** — Auto-generated POST endpoints for external callbacks
  - **IM Messages** — Trigger tasks on specific incoming messages
  - **Cron Schedule** — Periodic execution on a time-based plan
- **Trigger Permission Model** — Four capability levels (read-only → safe tools → full access → custom whitelist) for fine-grained control

### IM Channel Integration

Turn Abu into your team bot — just @Abu in your chat:

- **Supported Platforms** — D-Chat, Feishu (Lark), DingTalk, WeCom, Slack
- **Session Management** — Auto-isolate conversations by user/group/thread, auto-archive on timeout, "continue last" recovery
- **Security Controls** — User allowlist, workspace path restrictions, capability level enforcement
- **Response Modes** — Mention-only or all-messages

### Memory & Context

- **Three-tier file-based memory (Memdir architecture)**:
  - **Personal Memory** — `~/.abu/memory/` multi-file directory, applies across all projects, auto-organized by topic with `MEMORY.md` index injected into the prompt
  - **Project Memory** — `~/.abu/projects/<workspace>/memory/` auto-isolated per workspace, each entry is a separate `.md` file for easy reading, search, and pruning
  - **Auto-migration** — Legacy `~/.abu/agents/abu/memory.md` and `{workspace}/.abu/MEMORY.md` are migrated automatically on startup
- **Project Rules** (hand-written):
  - `~/.abu/ABU.md` — User-level rules (cross-project)
  - `{workspace}/.abu/ABU.md` — Project-level rules
  - `{workspace}/.abu/rules/*.md` — Modular rules (loaded alphabetically, max 20 files)
- **Project Aggregation** — Promote a workspace into a Project to aggregate its conversations; older conversations auto-backfilled with `projectId` on startup. Each project can independently configure default model, skill set, and MCP connectors
- **Session Memory** — Large tool outputs automatically persisted to disk; compact summaries kept in-context to prevent context explosion
- **Persistent Todos** — Per-conversation `todo_write` plans persisted to disk and survive app restarts
- **Auto-Compaction** — Intelligently compresses long conversation history while preserving key context

### Security & Privacy

- **Three Permission Modes** — **Request Approval** (free read/write inside workspace; out-of-bounds writes and dangerous commands need confirmation; default) / **Smart Review** (out-of-bounds ops go to an AI reviewer: allow low-risk, block high-risk, ask only when unsure) / **Full Autonomy** (everything runs automatically except hard system red-lines); global default in Settings → Sandbox, also switchable per conversation via the chip above the composer
- **Content Safety Scan** — Scans agent-authored skills / memory entries to catch dangerous instructions, prompt injection, hardware commands, and 120+ other risk patterns
- **OS Sandbox** — macOS Seatbelt (`sandbox-exec`) / Windows PowerShell ConstrainedLanguage isolates shell command file access
- **Network Isolation** — Local proxy + domain whitelist + private-network toggle to control every outbound request
- **Path & Command Safety** — Sensitive directories (system folders, SSH keys, etc.) blocked by default; dangerous commands (`rm -rf /`, etc.) caught statically
- **Computer Use Safeguards** — 15+ blocked sensitive apps (Keychain, System Settings, WeChat, Slack, etc.), dangerous key interception (Cmd+Q, Cmd+Tab, Force Quit), session-level window hiding, 5-minute timeout
- **Encrypted API Key Storage** — Windows DPAPI / macOS AES-256-GCM with a hardware-UUID-derived key; keys are no longer written to localStorage in plaintext
- **Local-First** — Your data stays local, your API keys stay local — nothing goes through third-party servers
- **Cross-Platform** — Supports macOS (Apple Silicon / Intel) and Windows

### Diagnostics & Troubleshooting

- **One-Click Self-Check** — Settings → Diagnostic, runs through AI service connectivity, data & permissions, MCP, skills, network, app environment
- **Diagnostic Bundle Export** — When something breaks, package logs / config / version info in one click (API keys and paths auto-redacted) and send it to the maintainer

> For detailed feature documentation, see the [User Guide](docs/User-Guide.md)

## Download

Head to [GitHub Releases](https://github.com/PM-Shawn/Abu-Cowork/releases) to download the latest version:

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Abu-x.x.x-mac-arm64.dmg` |
| macOS (Intel) | `Abu-x.x.x-mac-x64.dmg` |
| Windows x64 | `Abu-x.x.x-windows-x64-setup.exe` |

> Official macOS packages are signed and notarized. The Windows installer is current-user only and does not need administrator rights, but remains Authenticode-unsigned; SmartScreen may require **More info → Run anyway**. See the [Installation Guide](docs/Installation-Guide.md).

## Quick Start

### 1. Configure AI Service

Open Abu → Settings → **AI Service Management**:

- **Quickest setup**: Choose a provider (e.g., DeepSeek, Anthropic), enter your API Key, click verify
- **Local models**: Install [Ollama](https://ollama.com) — Abu auto-discovers local models, no API key needed
- **Custom endpoint**: Enter any OpenAI-compatible API's Base URL and Key

### 2. Start Chatting

Return to the main screen, use the model selector to pick your preferred model, and start chatting.

**Try these prompts:**

```
Organize the files on my desktop by type
```
```
Extract the tables from this PDF and generate an Excel file
```
```
Every morning at 9 AM, search for the latest AI news and generate a daily digest
```
```
Use the frontend design skill to create a product landing page
```
```
Create a weekly report PPT for this week
```

### 3. Level Up

- **Install skills**: Settings → Customize → Skill Store — install PDF, PPT, frontend design, and more
- **Connect MCP**: Settings → MCP Connectors — one-click integration with GitHub, Playwright, etc.
- **Set up schedules**: Have Abu automatically search news, run data, send reports daily
- **Connect IM**: Settings → IM Channels — let your team @Abu directly in Lark/DingTalk

> For more use cases, see the [User Guide](docs/User-Guide.md)

## Built-in Skills (29 total)

| Category | Skills |
|----------|--------|
| Document Generation | PDF, PPTX, DOCX, XLSX |
| Design & Creative | Frontend Design, Canvas Design, Algorithmic Art, SVG Diagram, Mermaid Diagram, Infographic, Slack GIF Creator, HTML Widget |
| Browser Automation | **Abu-Browser** (built-in, isolated session), **Abu-Chrome-Bridge** (optional Chrome extension for existing tabs and sign-in state) |
| Developer Tools | Claude API, MCP Builder, Web Artifacts Builder, Webapp Testing (Playwright) |
| Content Writing | Doc Co-authoring, Brand Guidelines, Internal Comms |
| Automation | Schedule, Trigger, Alert SOP |
| Project Management | Skill Creator, Project Init, Create Agent |
| Agent Reflection | Reflect — lets the agent look back on a run and distill learnings |
| Theming | Theme Factory (10+ preset themes applicable to any artifact) |

> Beyond built-ins, Abu also supports **Self-Evolving Skills** — after multi-step complex flows, Abu proactively suggests "crystallize this into a skill" and grows a library tailored to your workflow. See [User Guide → Skill System](docs/User-Guide.md#skill-system).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Electron (main + preload + isolated React renderer) |
| Frontend | React 19 + TypeScript (strict) + TailwindCSS v4 + Vite |
| LLM Adapter | Dual-protocol adapter (Anthropic / OpenAI-compatible) |
| State Management | Zustand + Immer + Persist |
| Tool Protocol | MCP (`@modelcontextprotocol/sdk`) |
| Web Search | Bing / Brave / Tavily / SearXNG |
| Sandbox | macOS Seatbelt + path/command dual validation |
| UI Components | Radix UI + Lucide Icons + shadcn-style |
| Testing | Vitest + happy-dom (covers core store / agent / skill / memdir modules) |
| Evaluation | Built-in OpenAI-protocol tool-selection eval runner (`npm run eval:tool-selection`) |

## Build from Source

### Prerequisites

- Node.js 24 and npm
- Rust stable ([Install Rust](https://rustup.rs/)) for the native helper and sandbox launcher
- Platform build tools: Xcode Command Line Tools on macOS, or Visual Studio Build Tools on Windows

### Development

```bash
# Clone the repo
git clone https://github.com/PM-Shawn/Abu-Cowork.git
cd Abu-Cowork

# Prepare worktree-local dependencies, Electron/browser runtimes, sidecar,
# native helper, sandbox launcher, and the OSS renderer
npm run setup:electron-dev

# Launch the Electron desktop app. The OSS renderer is rebuilt before launch.
npm run electron:dev

# Enterprise worktree: prepare and launch the private Enterprise renderer
npm run setup:electron-dev:enterprise
npm run electron:dev:enterprise

# Frontend-only preview (not desktop acceptance)
npm run dev
```

Tauri is not a feature-development or acceptance target. Its source remains
only for compatibility with already shipped versions, migration, and rollback.

### Build

```bash
npm run dist:electron
```

Build artifacts are written to `release-electron/`. Build and validate distributable packages on the target operating system; a macOS cross-build is not Windows acceptance.

Source/fork packages do not use Abu's production updater or migrate installed Abu data. If you plan to distribute a modified build, read the [Fork & Distribution Guide](FORKING.md) first.

### Testing

```bash
npm test              # Run tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
npm run lint          # ESLint check
```

## Project Structure

```
src/
├── components/       # React UI components
│   ├── chat/         # Chat interface, messages, model selector
│   ├── sidebar/      # Sidebar navigation (with collapsed Recents search)
│   ├── panel/        # Right-side detail panel (workspace, project memory/instructions)
│   ├── customize/    # Customization (skills, agents, models)
│   ├── schedule/     # Scheduled task views
│   ├── trigger/      # Trigger ("on-call") management views
│   ├── settings/     # System settings (16 panels, see settings/sections/)
│   ├── preview/      # File preview (PDF/Office/image/Markdown)
│   └── ui/           # Base UI components (shadcn/Radix)
├── core/             # Core engine (non-UI)
│   ├── agent/        # Agent loop, background agents, project rules
│   ├── llm/          # LLM adapter layer (Claude / OpenAI-compatible / Ollama)
│   ├── tools/        # Tool registry, built-in tools, safety checks
│   ├── mcp/          # MCP client
│   ├── skill/        # Skill loading & preprocessing
│   ├── search/       # Web search (Bing/Brave/Tavily/SearXNG)
│   ├── memdir/       # File-based memory system (personal/project, multi-file + index)
│   ├── scheduler/    # Scheduling engine
│   ├── trigger/      # Trigger engine (HTTP/file/cron/IM)
│   ├── im/           # IM channel adapters (D-Chat/Lark/DingTalk/WeCom/Slack)
│   ├── permissions/  # Permission model & capability levels
│   ├── context/      # Context management & auto-compaction
│   ├── session/      # Session management & disk persistence
│   ├── sandbox/      # Sandbox configuration
│   ├── logging/      # Structured logging
│   └── updates/      # Auto-update channel
├── eval/             # Tool-call / model capability eval scaffold (developer use)
├── stores/           # Zustand state management
├── hooks/            # React Hooks
├── i18n/             # Internationalization (Chinese / English)
├── types/            # TypeScript type definitions
└── utils/            # Utility functions

builtin-skills/       # 29 built-in skills (one directory each)
builtin-agents/       # Built-in agent definitions (placeholder)
abu-browser-bridge/   # Browser bridge MCP Server
abu-chrome-extension/ # Chrome extension (used by the Abu-Chrome-Bridge skill)
electron/             # Electron main process, preload bridge, native hosts
sidecar/              # Agent/runtime sidecar process
src-tauri/
├── src/
│   ├── computer_use.rs    # Screenshot + mouse/keyboard + sensitive app blocking
│   ├── feishu_ws.rs       # Lark/Feishu WebSocket long connection
│   ├── overlay.rs         # Computer-use status overlay
│   ├── proxy.rs           # Network isolation proxy
│   ├── sandbox.rs         # macOS Seatbelt / Win ConstrainedLanguage
│   ├── trigger_server.rs  # HTTP trigger server
│   └── window_info.rs     # Behavior awareness (active app sampling)
└── tauri.conf.json
```

## Documentation

| Document | Description |
|----------|-------------|
| [User Guide](docs/User-Guide.md) | Complete product features and usage instructions |
| [Installation Guide](docs/Installation-Guide.md) | Platform-specific installation and troubleshooting |
| [Fork & Distribution Guide](FORKING.md) | App identity, updater, signing, migration, and release boundaries for forks |

## Contributing

Issues and Pull Requests are welcome. Read the [Fork & Distribution Guide](FORKING.md) before shipping a modified desktop package.

1. Fork this repo
2. Create your branch: `git checkout -b feat/my-feature`
3. Commit your changes: `git commit -m 'feat: add my feature'`
4. Push to the branch: `git push origin feat/my-feature`
5. Open a Pull Request

## License

**[Apache License 2.0](LICENSE)** — Free to use, modify, and distribute, including commercial use. Copyright notices must be retained. **Enterprise edition requires a license**, offering team collaboration, SSO, audit logs, and private deployment support. [Contact us](mailto:pmshawn@163.com).
