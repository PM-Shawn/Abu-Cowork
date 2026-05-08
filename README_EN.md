<div align="center">

[中文](README.md) | **English**

<img src="website/assets/abu-avatar.png" width="120" height="120" style="border-radius: 24px" />

# Abu (阿布)

**Your AI Desktop Office Assistant — Just Leave It to Abu**

A locally-run AI desktop assistant inspired by Claude Code's Cowork mode.
Tell Abu what you need — it reads files, runs commands, writes docs, and builds reports, all on your machine.

[![Release](https://img.shields.io/github/v/release/PM-Shawn/Abu-Cowork?style=flat-square)](https://github.com/PM-Shawn/Abu-Cowork/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)

[Download](#-download) · [Quick Start](#-quick-start) · [Features](#-features) · [User Guide](docs/User-Guide_EN.md) · [Build from Source](#-build-from-source)

</div>

---

## Why Abu?

| Feature | Abu | Regular AI Chat | Traditional Automation |
|---------|-----|----------------|----------------------|
| Autonomous planning & task execution | :white_check_mark: | :x: | :x: |
| Read/write local files, run commands | :white_check_mark: | :x: | :white_check_mark: |
| Natural language interaction | :white_check_mark: | :white_check_mark: | :x: |
| 28 built-in skills + self-evolving (Abu grows its own) | :white_check_mark: | :x: | :x: |
| Multi-conversation Project aggregation | :white_check_mark: | :x: | :x: |
| Scheduled tasks & event triggers | :white_check_mark: | :x: | :white_check_mark: |
| IM bot (Lark/DingTalk/WeCom/Slack) | :white_check_mark: | :x: | Partial |
| Multi-agent parallel execution | :white_check_mark: | :x: | :x: |
| Browser & computer control | :white_check_mark: | :x: | Partial |
| 100% local data, privacy-safe | :white_check_mark: | :x: | :white_check_mark: |

---

## What's New

- **v0.15** — **Soul personality system**: 3 proactivity presets (Quiet / Buddy / Butler) + custom `SOUL.md` for tone, address, and reply style; **Content safety scan**: scans agents / skills / memory for prompt injection and dangerous instructions (120+ patterns)
- **v0.13.12** — **Diagnostic panel**: one-click self-check across AI services / data & permissions / MCP / skills / network / app, plus diagnostic-bundle export
- **v0.13** — **Self-Evolving Skills**, **Projects** (multi-conversation aggregation), **Notification Center**, **Persistent Todos**

> Full changelog: [Releases](https://github.com/PM-Shawn/Abu-Cowork/releases).

## Preview

> Clean interface, powerful capabilities

<table>
<tr>
<td align="center" width="50%"><b>Welcome</b><br/>Natural language input — conversation is the command<br/><br/><img src="website/assets/screenshot-welcome.png" width="100%" /></td>
<td align="center" width="50%"><b>Task Execution</b><br/>Autonomous planning & tool invocation for complex tasks<br/><br/><img src="website/assets/screenshot-execution.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Permission Control</b><br/>File access requires user authorization<br/><br/><img src="website/assets/screenshot-permission.png" width="100%" /></td>
<td align="center"><b>IM Channel Chat</b><br/>@Abu in Lark/DingTalk to interact<br/><br/><img src="website/assets/screenshot-im-chat.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Skills</b><br/>28 built-in skills + self-evolving + custom<br/><br/><img src="website/assets/screenshot-skills.png" width="100%" /></td>
<td align="center"><b>MCP Connectors</b><br/>One-click integration with Playwright, GitHub & more<br/><br/><img src="website/assets/screenshot-mcp.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Scheduled Tasks</b><br/>Cron-based scheduling for automated workflows<br/><br/><img src="website/assets/screenshot-schedule-create.png" width="100%" /></td>
<td align="center"><b>Triggers / Watch</b><br/>HTTP, file changes, IM messages auto-trigger tasks<br/><br/><img src="website/assets/screenshot-triggers.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>AI Service Management</b><br/>Multi-provider management with health checks<br/><br/><img src="website/assets/screenshot-settings-ai.png" width="100%" /></td>
<td align="center"><b>IM Channel Config</b><br/>Connect Lark, DingTalk, WeCom & more<br/><br/><img src="website/assets/screenshot-settings-im.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Personal Memory</b><br/>Remembers your preferences and work habits<br/><br/><img src="website/assets/screenshot-memory.png" width="100%" /></td>
<td align="center"><b>Security Sandbox</b><br/>Seatbelt sandbox + network isolation for privacy<br/><br/><img src="website/assets/screenshot-security.png" width="100%" /></td>
</tr>
<tr>
<td align="center"><b>Soul (Personality)</b><br/>3 proactivity presets + custom SOUL.md for tone & style<br/><br/><img src="website/assets/screenshot-soul.png" width="100%" /></td>
<td align="center"><b>Diagnostic Panel</b><br/>One-click self-check across AI / MCP / skills / network + bundle export<br/><br/><img src="website/assets/screenshot-diagnostic.png" width="100%" /></td>
</tr>
<tr>
<td align="center" colspan="2"><b>Content Safety Scan</b><br/>Three permission modes (Standard / Auto / Strict) + scan agents / skills / memory for prompt injection & dangerous instructions<br/><br/><img src="website/assets/screenshot-security-scan.png" width="60%" /></td>
</tr>
</table>

## Features

### Core Capabilities

- **Autonomous Agent** — More than chat: plans, invokes tools, reads/writes files, executes commands, and completes complex tasks end-to-end
- **Soul Personality System** — Three proactivity presets (Quiet / Buddy / Butler) decide when Abu speaks up; customize tone, address, reply style, and boundaries via `SOUL.md`
- **Self-Evolving Skills** — After you run a multi-step complex flow, Abu proactively offers "want to crystallize this into a skill?" — one click drafts it, you review, you accept. Next time, just name the skill; no need to re-explain
- **Smart Notification System** — Menubar unread count / sidebar badge / system notification auto-routed; notices queued to inbox while you're in fullscreen / DnD, surfaced via badges once you're back; audit trail kept for 180 days
- **Projects** — Promote a workspace into a Project: conversations in the same direction auto-aggregate; each project gets its own default model, skill set, and MCP connectors
- **Multi-Agent Parallel Execution** — Run up to 5 background agents simultaneously, each executing tasks independently with real-time progress tracking
- **Desktop Pet** — Transparent circular floater pinned to your desktop, follows you across Spaces, summon a quick chat without stealing focus
- **Conversation Sharing** — Export any conversation to JSON in one click; API keys and local paths are auto-redacted before sharing
- **28 Built-in Skills** — PDF/PPTX/DOCX/Excel generation, frontend design, canvas design, algorithmic art, Mermaid/SVG/infographics, Web Artifacts, Chrome automation (Abu-Browser), deep research, Agent self-reflection (reflect), workflow automation, and more — one-click install, fully customizable
- **MCP Protocol** — Connect to databases, search engines, GitHub, and other external services via Model Context Protocol
- **Browser Automation** — Built-in Browser Bridge + Chrome extension for web element interaction, form filling, screenshots, and JS execution
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

- **Three Permission Modes** — Standard (confirm dangerous ops + new-directory writes) / Auto (only confirm automated tasks; writes still confirmed) / Strict (every tool call requires confirmation)
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

> For detailed feature documentation, see the [User Guide](docs/User-Guide_EN.md)

## Download

Head to [GitHub Releases](https://github.com/PM-Shawn/Abu-Cowork/releases) to download the latest version:

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Abu_x.x.x_aarch64.dmg` |
| macOS (Intel) | `Abu_x.x.x_x64.dmg` |
| Windows | `Abu_x.x.x_x64-setup.exe` |

> **macOS Users**: If you see a "damaged" warning on first launch, run `xattr -cr /Applications/Abu.app`. See the [Installation Guide](docs/Installation-Guide_EN.md) for details.

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

> For more use cases, see the [User Guide](docs/User-Guide_EN.md)

## Built-in Skills (28 total)

| Category | Skills |
|----------|--------|
| Document Generation | PDF, PPTX, DOCX, XLSX |
| Design & Creative | Frontend Design, Canvas Design, Algorithmic Art, SVG Diagram, Mermaid Diagram, Infographic, Slack GIF Creator, HTML Widget |
| Browser Automation | **Abu-Browser** (Chrome bridge with auto extension setup, drives a real browser) |
| Developer Tools | Claude API, MCP Builder, Web Artifacts Builder, Webapp Testing (Playwright) |
| Content Writing | Doc Co-authoring, Brand Guidelines, Internal Comms |
| Automation | Schedule, Trigger, Alert SOP |
| Project Management | Skill Creator, Project Init, Create Agent |
| Agent Reflection | Reflect — lets the agent look back on a run and distill learnings |
| Theming | Theme Factory (10+ preset themes applicable to any artifact) |

> Beyond built-ins, Abu also supports **Self-Evolving Skills** — after multi-step complex flows, Abu proactively suggests "crystallize this into a skill" and grows a library tailored to your workflow. See [User Guide → Skill System](docs/User-Guide_EN.md#skill-system).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Tauri 2.0 (Rust + Web) |
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

- Node.js >= 18
- Rust >= 1.75 ([Install Rust](https://rustup.rs/))
- Tauri 2.0 system dependencies ([See docs](https://v2.tauri.app/start/prerequisites/))

### Development

```bash
# Clone the repo
git clone https://github.com/PM-Shawn/Abu-Cowork.git
cd Abu-Cowork

# Install dependencies
npm install

# Launch desktop app (uses dev-isolated config, fully separate from your installed Abu)
npm run tauri:dev

# Frontend only (no Rust required)
npm run dev
```

### Build

```bash
npm run tauri build
```

Build artifacts are located in `src-tauri/target/release/bundle/`.

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

builtin-skills/       # 28 built-in skills (one directory each)
builtin-agents/       # Built-in agent definitions (placeholder)
abu-browser-bridge/   # Browser bridge MCP Server
abu-chrome-extension/ # Chrome extension (used by the Abu-Browser skill)
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
| [User Guide](docs/User-Guide_EN.md) | Complete product features and usage instructions |
| [Installation Guide](docs/Installation-Guide_EN.md) | Platform-specific installation and troubleshooting |

## Contributing

Issues and Pull Requests are welcome!

1. Fork this repo
2. Create your branch: `git checkout -b feat/my-feature`
3. Commit your changes: `git commit -m 'feat: add my feature'`
4. Push to the branch: `git push origin feat/my-feature`
5. Open a Pull Request

## Feedback & Community

Got questions or ideas? Scan the QR code to join the WeChat group:

<img src="src/assets/wechat-qr.png" width="200" />

## Support

If Abu has been helpful to you, feel free to buy the author a coffee:

<img src="src/assets/sponsor-qr.png" width="200" />

## License

[Abu License](LICENSE) — Free for personal, educational, and non-commercial use. Copyright notices must be retained and may not be modified or removed. Commercial use requires authorization. See [LICENSE](LICENSE) for details.
