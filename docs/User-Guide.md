# Abu User Guide

**English** | [中文](User-Guide.zh-CN.md)

This guide covers all Abu features and how to use them effectively.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Chat & Agent](#chat--agent)
- [Workspace & Memory](#workspace--memory)
- [Projects](#projects-v0130)
- [Built-in Tools](#built-in-tools)
- [Skill System](#skill-system) (incl. **Self-Evolving Skills**)
- [MCP Protocol](#mcp-protocol)
- [Scheduled Tasks](#scheduled-tasks)
- [Triggers](#triggers)
- [IM Channels](#im-channels)
- [Browser Automation](#browser-automation)
- [Computer Use](#computer-use)
- [AI Services Configuration](#ai-services-configuration)
- [Web Search](#web-search)
- [Image Generation](#image-generation)
- [Sandbox & Security](#sandbox--security)
- [Notification System](#notification-system-v0130)
- [Behavior Awareness](#behavior-awareness)
- [Appearance & Theme](#appearance--theme)
- [Labs](#labs)
- [Common Use Cases](#common-use-cases)
- [FAQ](#faq)

---

## Quick Start

### 1. Install

#### Download

Download the installer for your platform from [GitHub Releases](https://github.com/PM-Shawn/Abu-Cowork/releases):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `Abu_x.x.x_aarch64.dmg` |
| macOS (Intel) | `Abu_x.x.x_x64.dmg` |
| Windows | `Abu_x.x.x_x64-setup.exe` |

#### macOS

1. Double-click the `.dmg` file and drag Abu into the `Applications` folder
2. **First launch will show an "App is Damaged" warning** (because the app is not yet Apple-signed). Open Terminal and run:
   ```bash
   xattr -cr /Applications/Abu.app
   ```
3. Double-click Abu again to open it

> If Abu is installed elsewhere, replace the path accordingly. You can also type `xattr -cr ` and drag Abu.app into the Terminal window to auto-fill the path.

> If the command above doesn't work, go to **System Settings → Privacy & Security**, scroll to the bottom and click **"Open Anyway"**. Note: macOS 15 (Sequoia) and later removed `sudo spctl --master-disable`.

#### Windows

1. Double-click the `.exe` installer and follow the prompts
2. **SmartScreen may block the first launch** (because the app is not yet code-signed). Click **"More info"** → **"Run anyway"**

> If the installer won't run after downloading: right-click the `.exe` → Properties → check "Unblock" at the bottom → OK, then double-click to install.

> Abu is open-source software. The security warnings appear because the app hasn't been signed with a commercial certificate, not because there's anything wrong with the app. macOS requires re-running `xattr -cr` after each update; Windows usually only needs SmartScreen approval on first launch.

### 2. Configure a Model

1. Open Abu and click the **settings icon** at the bottom left
2. Go to **"AI Services"**
3. Select your API provider (Anthropic, DeepSeek, OpenAI, etc.)
4. Enter your API Key
5. Choose the model to use

### 3. Start Chatting

Return to the main screen and describe what you need in natural language. Abu will plan and execute the task automatically.

---

## Chat & Agent

Abu's core is the **autonomous Agent execution mode** — it's not a simple Q&A chatbot.

### Workflow

1. **Understand** — Abu analyzes your request
2. **Plan** — Breaks down the task into steps
3. **Execute** — Reads/writes files, runs commands, searches for information
4. **Iterate** — Adjusts strategy based on results
5. **Report** — Tells you what was done and what files were created

### Permission Prompts

Abu asks for your confirmation before sensitive operations:

- **Command execution** — Asks before running shell commands for the first time
- **File writes** — Shows the changes before creating or modifying files
- **Path access** — Requests authorization for sensitive directories

You can **Allow**, **Deny**, or set **Always Allow** for specific operations.

### Permission Modes (three levels, switchable per conversation)

How much Abu asks before acting is controlled by the **permission mode**. The global default is in **Settings → Sandbox**; the permission-mode chip above the composer lets you switch the current conversation without touching the global default:

| Mode | Behavior |
|------|----------|
| **Request Approval** (default) | Free read/write inside workspace; out-of-bounds writes and dangerous commands need your confirmation |
| **Smart Review** | Out-of-bounds ops go to an AI reviewer: low-risk is allowed, high-risk is blocked, only ambiguous cases ask you (may occasionally be wrong — use when you can tolerate the odd correction) |
| **Full Autonomy** | Everything runs automatically except hard system red-lines (`rm -rf /`, sensitive directories, etc.) — use only when you fully trust the current task |

> Tip: new conversations inherit the global default; switching within a conversation is temporary and does not write back to settings.

### Plan Mode (high-risk tasks need approval)

When a task involves high-risk steps like **delete / move / overwrite / send / install / push**, Abu first draws up a **step-by-step execution plan**, shown in chat as an "Execution Plan · N steps" card (amber "awaiting approval" marker) with a confirmation card above the composer:

- **Approve** — requires you to **explicitly click "Confirm & run"** (simply selecting an option does not fire it, to prevent accidental approval); Abu then starts executing
- **Reject, re-plan** — sends it back so Abu can propose an alternative

While the plan is awaiting approval, Abu **can only perform read-only operations** (read files, search, fetch web content); writes and commands are locked until you approve. Auto-cancels after 10 minutes with no response.

### Interactive Questions

At decision forks (choosing an approach, providing a parameter, confirming a detail), Abu pops a **question card** above the composer instead of burying the question in a long paragraph:

- Up to **4 questions** per card, **2–4 options** each
- **Single-select** (radio — auto-advances to the next question / submits) or **multi-select** (checkbox — manual "Next / Submit")
- Every question has an **"Other…"** row for a free-text custom answer, and a **"Skip"** option
- Keyboard: ↑↓ to select, Enter to confirm, ←→ to page, Esc to cancel
- After you answer, your choices remain as a read-only card in chat; auto-cancels after 10 minutes with no response

### Per-Conversation Model Pin

When you pick a model in the composer's **model selector**, that choice is also **pinned to the current conversation**: the conversation continues using that model, and a later global model switch won't bleed in. On first run, the current global model is automatically pinned to the conversation. New conversations inherit the global / project-level default.

### Conversation Management

- The left sidebar shows all conversation history
- Click **"New Chat"** to start a fresh task
- Search and delete conversations as needed

---

## Workspace & Memory

Workspace and memory let Abu understand your project context and personal preferences without repeating yourself.

### Workspace

A workspace is the root directory Abu operates in. Once set, Abu can read and write files within it.

1. Click the **Workspace** area in the right panel
2. Select your project folder
3. Grant access permissions

Below the workspace, you'll see two entries: **Project Instructions** and **Project Memory**.

### Memdir Architecture

Starting in v0.9.x, Abu's memory uses a **file-based (Memdir) architecture**: each memory entry is a separate `.md` file named by topic, and a `MEMORY.md` index file in the same directory is automatically injected into every conversation as context.

> Legacy `~/.abu/agents/abu/memory.md` and `{workspace}/.abu/MEMORY.md` are migrated automatically the first time you launch the new version — no manual action needed.

#### 1. Personal Memory (cross-project)

| Property | Description |
|----------|-------------|
| **Location** | Settings → Personal Memory (grouped by workspace) |
| **Storage** | `~/.abu/memory/` directory containing multiple `.md` files + a `MEMORY.md` index |
| **Scope** | Applies across all projects |
| **Who writes** | Abu accumulates automatically; you can also edit manually |
| **Content** | Your name, communication preferences, tools you use, etc. |

**Example**: When you say "Remember my name is Shawn", Abu writes a `user_name.md` file to the personal memory directory and adds an entry to `MEMORY.md`. She'll remember you in future conversations.

#### 2. Project Memory (per-workspace)

| Property | Description |
|----------|-------------|
| **Location** | Settings → Personal Memory → workspace-grouped view |
| **Storage** | `~/.abu/projects/<workspace-key>/memory/` directory |
| **Scope** | Current workspace only |
| **Who writes** | Abu accumulates automatically; you can also edit manually |
| **Content** | Tech stack, recent decisions, gotchas, external resource pointers |

**New behavior**: Project memory now lives under your **home directory at `~/.abu/projects/`** (sub-folder per workspace path hash) instead of inside `{workspace}/.abu/MEMORY.md`. Benefits:

- Doesn't pollute your project directory or get accidentally committed to git
- Easier to sync across machines (just sync `~/.abu/projects/`)
- Long workspace paths are auto-truncated with a DJB2 hash to stay under filename length limits

#### 3. Project Instructions (hand-written rules)

Project instructions are rules **you write by hand** that Abu must follow. They have the highest priority.

| Property | Description |
|----------|-------------|
| **Location 1** | `~/.abu/ABU.md` — User-level rules (cross-project) |
| **Location 2** | `{workspace}/.abu/ABU.md` — Project-level rules (current workspace only) |
| **Location 3** | `{workspace}/.abu/rules/*.md` — Modular rules (loaded alphabetically, max 20 files) |
| **Who writes** | You write manually |
| **Priority** | Highest — Abu follows these strictly |

**User-level `~/.abu/ABU.md`** is a new capability for cross-project rules (e.g. "use bilingual commit messages", "don't make large changes without a plan first").

**Project-level `{workspace}/.abu/ABU.md`** is recommended to commit to git so your team shares the same rules. Click **"Instructions · Click to add"** in the right panel to edit. Supports Markdown format.

**Modular rules**: For large projects, split rules into multiple `.md` files under `{workspace}/.abu/rules/` (e.g. `01-style.md`, `02-testing.md`, `03-deployment.md`). Abu loads them all alphabetically.

**Example project instructions**:

```markdown
## Overview
This is a React + Tailwind admin dashboard

## Tech Stack
- Frontend: React 18 + TypeScript + Tailwind CSS
- Build: Vite, run pnpm dev to start
- Testing: Vitest, run pnpm test

## Coding Standards
- Use function components + Hooks, no class components
- camelCase for variables, PascalCase for components
- Run pnpm lint before committing
```

### Memory Priority

When processing your requests, Abu injects context in this order:

```
User-level rules (~/.abu/ABU.md)
  → Project-level rules ({workspace}/.abu/ABU.md)
    → Modular rules ({workspace}/.abu/rules/*.md)
      → Project memory (auto-accumulated)
        → Personal memory (auto-accumulated)
```

Hand-written rules always take priority over auto-accumulated memory. If project-level and user-level rules conflict, project-level wins.

---

## Projects (v0.13.0+)

**Projects** is a conversation-aggregation feature: promote a workspace into a Project, and subsequent new conversations automatically belong to that project — related chats stay organized together.

### What is a Project

A Project = **one workspace** + **multiple conversations** + **a set of project-level defaults**.

Typical scenario: you have a "PRD Collaboration" folder where, over time, you've opened 20+ conversations with Abu — drafting PRDs, sketching flowcharts, generating slide decks, writing weekly reports. Originally these scatter across your sidebar. After promoting the workspace to a Project:

- The sidebar groups them under a single "PRD Collaboration" project node
- Clicking the project shows all its conversations in one list
- Project-level defaults (model / skills / MCP) are independent from global settings

### Creating a Project

Two entry points:

1. **Welcome page non-blocking hint**: when the Welcome page has a bound workspace, Abu hints "Would you like to promote this workspace to a Project?" — click "Promote" to upgrade, or "Dismiss" to silence the prompt for this workspace forever
2. **Sidebar manual upgrade**: right-click a workspace node in the sidebar → "Promote to Project"

### Backfill of older conversations

Conversations that already existed in the same workspace before the upgrade don't need manual handling. On next startup, Abu scans every conversation once and backfills `projectId` on those whose `workspacePath` matches. This backfill is **one-shot**, running only on the first launch after the upgrade.

### Project-level Configuration

Each Project can independently set:

- **Icon** — the emoji shown on the project node
- **Default model** — overrides the global default for new conversations in this project
- **Skill set** — skills loaded by default for new conversations
- **MCP connectors** — default MCP servers wired into new conversations
- **Custom instructions** — project-level prompt supplement (analogous to `~/.abu/ABU.md` but scoped to this project)

Entry: right-click the project node in the sidebar → "Project Settings".

### Projects vs Workspace

They live on different axes:

- **Workspace** is a folder path — it decides "which files Abu can access"
- **Project** is an aggregation container — it decides "how multiple conversations are organized and which defaults apply"

A workspace **maps to at most one Project** (one-to-one); a Project can hold unlimited conversations.

---

## Built-in Tools

Abu comes with built-in system tools — no extra installation needed:

### File Operations

| Tool | Description |
|------|-------------|
| **Read File** | Read text files; PDFs auto-extract text |
| **Write File** | Create or overwrite files |
| **Edit File** | Find-and-replace editing within files |
| **List Directory** | List all files and subdirectories |
| **Find Files** | Find files by name pattern (glob) |
| **Search Files** | Search file contents by keyword/regex (ripgrep-based) |

### System Operations

| Tool | Description |
|------|-------------|
| **Run Command** | Execute shell commands (subject to sandbox) with background mode and timeout |
| **System Info** | Get platform, home directory, desktop path, etc. |
| **Send Notification** | Send desktop notifications |
| **Clipboard** | Read/write system clipboard |
| **Computer Use** | Screenshot + mouse + keyboard control (see "Computer Use" section) |

### Network & Media

| Tool | Description |
|------|-------------|
| **Web Search** | Call Bing/Brave/Tavily/SearXNG or built-in provider search |
| **HTTP Fetch** | Download web pages / call REST APIs with **built-in safety gateway**: 2000-char URL limit, embedded credential blocking, cloud metadata endpoint blocking (AWS/Azure/GCP/Alibaba), 10 MB download cap, 60-second timeout; supports automatic article extraction (Mozilla Readability) |
| **Generate Image** | Call DALL·E / Tongyi Wanxiang / Zhipu Image and similar services |
| **Process Image** | Resize, crop, compress, format conversion |

### Advanced

| Tool | Description |
|------|-------------|
| **Manage Scheduled Tasks** | Create, view, pause, delete scheduled tasks |
| **Manage Triggers** | Create, view, delete triggers |
| **Manage File Watch** | Configure file change watch rules |
| **Invoke Skill** | Dynamically call installed skills |
| **Delegate to Agent** | Launch sub-agents for isolated subtasks (up to 5 concurrent) |
| **Memory Update** | Write to personal/project memory (Memdir) |
| **Memory Recall** | Search historical memory by keyword |
| **Manage MCP Servers** | Search, install, and manage MCP server connections |
| **TODO Management** | Maintain a task checklist during long workflows |
| **Update Soul** | Adjust Abu's global personality settings |

---

## Skill System

Skills are pre-defined capability modules that make Abu more professional in specific scenarios.

### How to Use

1. Open the **Toolbox** (sidebar icon)
2. Browse available Skills
3. Click **"Install"** to enable a skill
4. Describe your need in conversation — Abu auto-selects the right skill

### Built-in Skills (28 total)

> Skills live at `builtin-skills/<skill-name>/SKILL.md`. Each skill is its own directory and can be edited directly.

#### Documents & Content

| Skill | ID | Description |
|-------|------|-------------|
| **Doc Co-authoring** | `doc-coauthoring` | Structured document writing workflow |
| **Internal Comms** | `internal-comms` | Templates for status reports, leadership updates, newsletters |
| **Brand Guidelines** | `brand-guidelines` | Apply Anthropic and other brand color/typography guidelines |

#### Office Files

| Skill | ID | Description |
|-------|------|-------------|
| **Word** | `docx` | Create/edit Word docs with tables, TOC, headers, images |
| **Excel** | `xlsx` | Create/analyze spreadsheets with formulas and charts |
| **PowerPoint** | `pptx` | Build presentations with templates and layouts |
| **PDF** | `pdf` | Extract text/tables, merge, split, watermark, encrypt, OCR |

#### Visual Design

| Skill | ID | Description |
|-------|------|-------------|
| **Frontend Design** | `frontend-design` | Generate high-quality web UI components and pages |
| **Canvas Design** | `canvas-design` | Create posters and visual art (PDF/PNG) |
| **Algorithmic Art** | `algorithmic-art` | Generate computational art with p5.js |
| **HTML Widget** | `html-widget` | Single-file HTML widgets / micro pages |
| **Infographic** | `infographic` | Data-driven infographic design |
| **Mermaid Diagram** | `mermaid-diagram` | Flowcharts, sequence diagrams, architecture diagrams |
| **SVG Diagram** | `svg-diagram` | Custom SVG graphics |
| **Slack GIF** | `slack-gif-creator` | Animated GIFs optimized for Slack |
| **Theme Factory** | `theme-factory` | 10+ preset professional themes for any document/slide/page |

#### Browser Automation

| Skill | ID | Description |
|-------|------|-------------|
| **Abu-Browser** | `Abu-Browser` | Drives a real browser via native Chrome bridge, **auto-installs the extension on first use**. Lighter than Playwright; great for daily web automation (clicks, forms, screenshots, scraping) |
| **Webapp Testing** | `webapp-testing` | Use Playwright to test local web apps in an isolated environment |

#### Developer Tools

| Skill | ID | Description |
|-------|------|-------------|
| **MCP Builder** | `mcp-builder` | Guide for creating MCP servers (TypeScript/Python) |
| **Claude API** | `claude-api` | Complete docs and code examples for the Claude API (with prompt caching best practices) |
| **Web Artifacts Builder** | `web-artifacts-builder` | Build complex React + Tailwind + shadcn/ui multi-component artifacts |

#### Automation

| Skill | ID | Description |
|-------|------|-------------|
| **Schedule** | `schedule` | Create and manage recurring scheduled tasks |
| **Trigger** | `trigger` | Create event-driven triggers |
| **Alert SOP** | `alert-sop` | Standard operating procedure templates for alert handling |

#### Project Management

| Skill | ID | Description |
|-------|------|-------------|
| **Skill Creator** | `skill-creator` | Create, modify, and test custom skills |
| **Project Init** | `init` | Analyze project structure and generate config files like `.abu/ABU.md` |
| **Create Agent** | `create-agent` | Build custom agents with specific tools and memory |

#### Agent Reflection

| Skill | ID | Description |
|-------|------|-------------|
| **Reflect** | `reflect` | After finishing a task, Abu reviews and reflects to distill lessons and spot improvements |

### Self-Evolving Skills (v0.13.0+)

Beyond manual install and custom authoring, Abu from v0.13.0 **proactively suggests crystallizing your ad-hoc flows into reusable skills** — so you don't have to re-explain the same thing next time.

#### When Abu offers

Abu evaluates whether to suggest a skill in situations like:

- You completed a **multi-step complex flow** (e.g. a cross-tool task chain like "export Lark spreadsheet → format → upload to Slack")
- The task involved **multiple tool calls** and ran for a while
- The workflow is **reusable** (clear logic, well-defined inputs/outputs)

When Abu thinks it's worth crystallizing, it drops a **skill-proposal card** in chat.

#### Full flow: offer → draft → review → accept

1. **Offer stage**: card shows Abu's proposed name + one-line description for the flow; three actions:
   - **Generate draft** — Abu runs `skill-creator` to author a full draft (~8-15 s)
   - **Later** — keep the proposal, decide on this conversation's next turn
   - **Not useful** — reject; Abu remembers "don't suggest this class of task again"
2. **Draft ready**: when generation finishes, the card becomes "Draft ready · Review"; clicking jumps to the Toolbox skill-review page
3. **Review stage**: the Toolbox page displays the full SKILL.md + triggers + usage. Three actions:
   - **Accept directly** — skill goes live, available next time
   - **Edit** — rename / rewrite description / adjust content, then accept
   - **Discard** — sent to `.trash`, recoverable within 24 hours
4. **After accept**: the skill appears under Toolbox → Skills → "Abu's Deposit" category, callable like any built-in

#### Tuning offer frequency

Settings → Soul → "Abu Proactivity" has three levels:

- **Off** — Abu never offers spontaneously; only responds to explicit "save this as a skill" requests
- **Normal** (default) — Abu offers at a pace bounded by a 2-hour dedup window; the same class of task isn't re-offered
- **Companion** — Abu is more eager to spot reusable flows

#### Content safety (Content Guard)

All self-evolved drafts go through **Content Guard**: 120+ rules catching common sensitive patterns (API keys, tokens, phone numbers, ID numbers, etc.). Drafts that leak sensitive content are blocked before acceptance.

Settings → Security → Content Guard lets you adjust the rules or add allow-list exceptions. Enabled by default.

#### History & revert

Every mutation to a skill (accept, edit, patch) is recorded. From the skill's detail page in the Toolbox, click "History" to view all revisions with unified diff and one-click revert.

### Custom Skills

Use the **Skill Creator** to build your own:

1. Say "Help me create a new skill" in conversation
2. Abu guides you through defining the skill's name, triggers, and behavior
3. Skills are stored as Markdown files and can be edited directly

---

## MCP Protocol

MCP (Model Context Protocol) lets Abu connect to external services and tools.

### What is MCP?

MCP is an open protocol that lets AI assistants call external tools through a standardized interface:

- Connect to **databases** for querying and analysis
- Integrate with **GitHub** for repo and issue management
- Use **search engines** for real-time information
- Connect to **Slack/messaging** for sending messages

### Adding MCP Servers

1. Open **Toolbox** → **MCP Tools** tab
2. Click **"Add MCP Server"**
3. Choose connection type:
   - **Stdio** — Local command-line tool (most common)
   - **HTTP** — Remote HTTP service
4. Enter server config (command, args, environment variables)
5. Click **"Connect"**

### Configuration Examples

**Filesystem server:**
```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
  "env": {}
}
```

**GitHub server:**
```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "your-token-here"
  }
}
```

### MCP Discovery

Ask Abu to search and install MCP servers for you:

```
Search for an MCP server that connects to Notion
```

---

## Scheduled Tasks

Let Abu automatically run recurring work on a schedule.

### Creating Tasks

**Method 1: Via conversation**

```
Every morning at 9 AM, search for the latest AI news and create a daily digest on my desktop
```

```
Every Monday at 10 AM, organize last week's meeting notes into a weekly report
```

**Method 2: Task panel**

1. Click **"Automation"** in the sidebar → **"Scheduled Tasks"** tab
2. Click **"Create Task"**
3. Set frequency (hourly / daily / weekly / custom)
4. Enter task description
5. Save

### Frequency Options

| Frequency | Description |
|-----------|-------------|
| Hourly | Runs every hour |
| Daily | Runs at a specified time each day |
| Weekly | Runs on a specified day and time each week |
| Custom | Custom interval |

### Managing Tasks

- **Pause/Resume** — Temporarily pause a task
- **Edit** — Modify description or frequency
- **Delete** — Permanently remove a task
- **View History** — See results of each execution

### Push to IM Channels

After a scheduled task completes, the result can be pushed to IM channels in addition to the desktop notification:

1. In the task editor, find **"Push to IM channel"** at the bottom
2. Pick a configured IM channel (set up in Settings → IM Channels first)
3. Fill in the push targets:
   - **Push to group** — group chat IDs (comma-separated for multiple)
   - **Push to user** — user IDs (comma-separated for multiple)

> At least one push target (group or user) is required, otherwise nothing will be pushed.

### Important Notes

- Scheduled tasks run in **unattended mode** — no confirmation dialogs
- Previously authorized paths/commands are auto-allowed; unauthorized sensitive operations are auto-skipped
- Desktop **notifications** are sent on completion; you can also push to IM channels
- Abu must be running for scheduled tasks to execute
- Tasks can be bound to a specific Skill so they run in that skill's context

---

## Triggers

Triggers are event-driven automation. When an external event happens, Abu automatically runs a preset task — no human in the loop.

### Trigger Types

| Type | Description |
|------|-------------|
| **HTTP Receive** | Abu exposes a local HTTP endpoint; an external system can POST to trigger the task |
| **File Change** | Watch a file or directory for create/modify/delete events |
| **Cron / Interval** | Periodic execution at fixed intervals (in seconds) |
| **IM Message** | Listen to a configured IM channel and trigger when a message arrives |

### Creating a Trigger

**Method 1: Manual creation**

1. Click **"Automation"** in the sidebar → **"Triggers"** tab
2. Click **"New Trigger"**
3. Fill in the trigger configuration and save

**Method 2: Let Abu create it**

Click **"Let Abu create one"**, describe the trigger you need in natural language, and Abu will generate the config.

**Method 3: Templates**

Three preset templates are provided:
- **Alert SOP** — HTTP receive + keyword filter, ideal for alert handling
- **Log Monitor** — File watcher, good for log file analysis
- **Periodic Inspection** — Cron timer, good for recurring health checks

### Configuration

#### Basic

- **Name** (required) — must be unique
- **Description** (optional) — what this trigger does

#### Execution Instructions

The instructions Abu runs when the trigger fires. Use `$EVENT_DATA` to reference the event payload — Abu replaces it with the actual event content at runtime.

**Example:**

```
Received an alert: $EVENT_DATA
Analyze the alert content, judge severity, and provide handling suggestions.
```

#### Trigger Conditions

| Condition | Description |
|-----------|-------------|
| **All events** | Every event triggers execution |
| **Keyword match** | Only triggers when the event data contains specific keywords (comma-separated for multiple) |
| **Regex match** | Only triggers when event data matches a regex |

You can also specify a **match field** to apply matching only to a specific JSON field of the event payload.

#### Debounce

When enabled, identical events within a configurable window (default 5 minutes) only trigger once — prevents duplicate execution.

#### Quiet Hours

When enabled, the trigger doesn't fire during a configured time range (e.g. 22:00 ~ 08:00) — avoids late-night disturbance.

#### File Change Configuration

When using "File Change":

- **Watch path** (required) — file or directory to watch
- **Event types** — pick one or more of create / modify / delete
- **File pattern** (optional) — glob pattern (e.g. `*.log`); only matching files trigger

#### Interval Configuration

When using "Interval":

- **Interval (seconds)** — minimum 10s, default 60s

#### IM Source Configuration

When using "IM Message":

- **Channel** — pick from configured IM channels
- **Listen scope** — mention-only / DM-only / all messages
- **Group ID** (optional) — only listen to a specific group
- **Sender filter** (optional) — only respond to specific user IDs

### Result Push

After a trigger executes, the result can be pushed to external destinations:

**Webhook push:**

| Platform | Description |
|----------|-------------|
| D-Chat | D-Chat group bot webhook |
| Lark/Feishu | Lark custom bot webhook |
| DingTalk | DingTalk group bot webhook |
| WeCom | WeCom group bot webhook |
| Slack | Slack incoming webhook |
| HTTP | Custom HTTP endpoint (with headers) |

**IM channel push:** Select a configured IM channel and specify a group or DM target.

**Extract mode:**

| Mode | Description |
|------|-------------|
| Last message | Only push Abu's final reply |
| Full conversation | Push the entire conversation transcript |
| Custom template | Use template variables to customize the push body |

### Managing Triggers

- **Enable/Disable** — toggle a trigger on or off
- **View endpoint** — for HTTP triggers, the POST endpoint URL is shown after saving
- **Execution history** — see status of every fire (running / completed / errored / filtered / debounced)
- **Delete** — remove triggers you don't need

### Permission Model

Triggers run unattended via a **four-tier capability system**:

| Tier | Description |
|------|-------------|
| **Read-only** | Only file reads and web fetches; no modifications allowed |
| **Safe tools** | Can read/write workspace files and run safe commands (default) |
| **Full access** | All operations allowed (still subject to OS sandbox) |
| **Custom** | Fine-grained allowlist of commands, paths, and tools |

---

## IM Channels

IM Channels turn Abu into your team bot — just @Abu in your chat to interact.

### Supported Platforms

| Platform | Description |
|----------|-------------|
| **Lark/Feishu** | ByteDance's Lark/Feishu (with WebSocket long connection support) |
| **DingTalk** | Alibaba's DingTalk |
| **WeCom** | Tencent's WeCom |
| **Slack** | Slack |
| **D-Chat** | D-Chat |

### Adding an IM Channel

1. Open **Settings** → **IM Channels**
2. Click **"Add channel"**
3. Fill in the configuration:
   - **Channel name** — display name (e.g. "Work Lark Bot")
   - **Platform** — select an IM platform
   - **App ID** — created in the IM platform's developer portal
   - **App Secret** — the corresponding secret
   - **Capability tier** — controls what operations Abu can perform
4. After saving, copy the displayed **Webhook URL**
5. Paste the Webhook URL into the IM platform's developer portal as the **event callback URL**
6. Toggle the channel switch to enable it

### Capability Tiers

| Tier | Description |
|------|-------------|
| **Chat-only** | Pure chat, no tool calls |
| **Read-only** | File reads and web fetches; no modifications |
| **Safe tools** | Read/write authorized files, run safe commands (default) |
| **Full access** | All operations (still subject to sandbox) |

### Session Management

Each channel can configure:

| Setting | Description | Default |
|---------|-------------|---------|
| **Response mode** | Mention-only / All messages | Mention-only |
| **Session timeout** | Conversation context retention (minutes) | Configurable 1–1440 |
| **Max turns** | Maximum dialogue turns per session | Configurable 1–500 |

### Access Control

Use the **Allowed users** list to control who can interact with Abu:

- Empty list = anyone can interact
- After adding user IDs, only listed users can use Abu

### Connection Status

Each channel shows a connection status indicator:

- 🟢 Green — Connected
- 🔴 Red — Connection error
- ⚫ Gray — Disconnected

---

## Browser Automation

Abu offers **two** browser automation paths — pick by use case:

| Path | Best for | Setup |
|------|----------|-------|
| **Abu-Browser** (recommended) | Daily web tasks (clicks/forms/screenshots/scraping) — lightweight, integrates with your everyday browser | Install the `Abu-Browser` skill; first use will guide you to **auto-install the Chrome extension** |
| **Webapp Testing** | End-to-end testing of local web apps with an isolated environment | Install the `webapp-testing` skill, uses Playwright |

### Using Abu-Browser (recommended)

1. Install the `Abu-Browser` skill from **Toolbox → Skills**
2. The first time you give Abu a browser-related task, it will guide you to **auto-install the Chrome extension**
3. After that, just describe what you want, e.g.:
   ```
   Open Wikipedia, search for "AI desktop assistants", and send me the first 5 result titles
   ```

> Abu-Browser uses a native bridge to talk to the Chrome extension, so it **drives the browser you actually use every day** — no extra Playwright browser overhead.

### Manually installing the Chrome extension (optional)

If you want to install from source manually:

1. **Install the Chrome Extension**
   - Open Chrome → `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" → select the `abu-chrome-extension` directory

2. **Bridge Service**
   - Abu manages the Browser Bridge connection automatically

### Capabilities

| Feature | Description |
|---------|-------------|
| **Page Snapshot** | Get structured info about the current page |
| **Click Elements** | Click buttons, links, and other elements |
| **Fill Forms** | Auto-fill input fields, dropdowns, etc. |
| **Navigate** | Open URLs, go back/forward, switch tabs |
| **Screenshot** | Capture the current page |
| **Wait Conditions** | Wait for elements to appear/disappear, URL changes |
| **Run Scripts** | Execute JavaScript on the page |

### Examples

```
Open Google, search for "Abu AI assistant", and compile the top 5 results into a table
```

```
Open my GitHub repo, check for new Issues, and summarize them for me
```

---

## Computer Use

Let Abu directly control your computer — screenshot, click, type, scroll — like having someone help you operate the machine. Abu's Computer Use ships with multi-layered safeguards to prevent accidental control of sensitive apps or system-level dangerous keys.

### Enabling Computer Use

1. Open **Settings** → **Preferences**
2. Find **"Computer Use"** and toggle it on
3. On first enable, Abu will test screen recording permission

### System Permissions (macOS)

macOS requires two permissions:

| Permission | Purpose | Path |
|-----------|---------|------|
| **Screen Recording** | Screenshot capability | System Settings → Privacy & Security → Screen Recording |
| **Accessibility** | Mouse/keyboard control | System Settings → Privacy & Security → Accessibility |

> Windows usually doesn't need extra permissions.

### Supported Operations

| Operation | Description | Parameters |
|-----------|-------------|------------|
| **Screenshot** | Capture screen, with optional region | `x, y, width, height` (optional) |
| **Click** | Click at coordinates | `x, y`, button (left/right/middle/double) |
| **Move** | Move mouse to coordinates | `x, y` |
| **Scroll** | Scroll at coordinates | `x, y`, direction (up/down/left/right), magnitude |
| **Drag** | Drag from one point to another (with smooth animation) | start and end coordinates |
| **Type** | Type text (handles CJK input) | text content |
| **Press Key** | Press keyboard combo | key name + modifiers (ctrl/shift/alt/meta) |
| **Wait** | Wait for UI to settle | duration in ms (max 10s) |
| **Check Permissions** | Check macOS Screen Recording / Accessibility permission status | none |

### Safety Guards (important)

Abu's Computer Use is not a raw `enigo` call — it's wrapped in multiple guards in the Rust backend:

#### 1. Sensitive App Blocking

15+ apps are on a built-in blocklist. **When the active app is on the list, all mouse/keyboard operations are rejected**:

- **System-level**: Keychain Access, System Settings, Activity Monitor, Terminal, iTerm 2, Warp, VS Code (to prevent accidental code edits)
- **Communication/Meeting**: WeChat, Messages, Mail, Outlook, Slack, Lark, DingTalk, Discord, Zoom

> Want Abu to operate inside a blocked app? You'd need to manually allow it in settings (UI not yet exposed, planned).

#### 2. Dangerous Key Interception

The following key combos are rejected outright to prevent Abu from accidentally logging out or locking the screen:

- `Cmd+Q` / `Cmd+Shift+Q` (Quit / Logout)
- `Alt+Meta+Esc` (Force Quit dialog)
- `Cmd+Tab` (App switcher)
- `Ctrl+Meta+Q` (macOS lock screen)
- `Cmd+Shift+Delete` (Empty trash)
- `Alt+F4` (Windows close window)
- `Ctrl+Alt+Delete` (Windows secure menu)
- `Meta+L` (Windows lock screen)
- `Alt+Tab` (Windows app switch)

Modifier names are normalized (`cmd→meta`, `control→ctrl`, `option→alt`) so spelling differences can't bypass the blocklist.

#### 3. Session-level Window Management

- When entering a Computer Use session, **the Abu main window and status overlay are hidden for the entire session** to avoid blocking the target UI
- On macOS, screenshots use `CGWindowListCreateImage` to exclude Abu's window and overlay — they **don't appear in screenshots without actually hiding the window**
- The session end automatically restores window visibility

#### 4. Session Timeout & Step Limit

| Limit | Default |
|-------|---------|
| **Max session duration** | 5 minutes |
| **Max steps per session** | 30 |

Exceeding either limit forces the session to end — prevents runaway loops or prolonged keyboard/mouse hijacking.

#### 5. Status Overlay + Global Stop Shortcut

- A semi-transparent **status overlay** at the screen edge shows the current step count and action in real time
- A configurable global keyboard shortcut stops the session at any time
- A **Stop button window** is also available at the screen edge during the session

### Examples

```
Open System Preferences and switch the wallpaper to dark mode
```

> ⚠️ This example will be blocked by sensitive-app blocking in the new version (System Settings is on the blocklist). For scenarios like this, manually open the target app first, then let Abu do the specific operations.

```
Open Finder and create a folder called "Work" on the desktop
```

```
Tidy up my desktop: drag all PDFs into ~/Documents/PDFs/
```

### How It Works

- Abu first takes a screenshot to "see" the current screen (auto-excludes Abu's own window)
- Locates the target element from the screenshot
- Executes click/type and **automatically takes another screenshot** to verify the result
- All coordinates are in the screenshot image space (max width 1280px) and auto-converted to actual screen coordinates
- Drags use a smooth animation to avoid being treated as "instant teleport" by some apps

### Notes

- Disabled by default; user must explicitly enable
- Sensitive app + dangerous key blocking lives in the Rust backend — **frontend cannot bypass**
- Screenshots are saved in the workspace directory (or desktop if no workspace)
- The 5-minute timeout is a hard cap and cannot be changed in the UI; for longer work, split into multiple sessions
- Can be disabled at any time in settings, takes effect immediately

---

## AI Services Configuration

Abu supports multiple LLM providers and offers three core AI capabilities: **Chat**, **Web Search**, and **Image Generation**.

Open **Settings** → **AI Services** to view your current configuration.

### Supported Providers

| Provider | Built-in Web Search | Notes |
|----------|:---:|-------|
| **Anthropic** | ✅ | Claude models, recommended |
| **Volcengine** | ✅ | ByteDance cloud, Doubao models |
| **Bailian (Alibaba)** | ✅ | Alibaba Cloud, Qwen and more |
| **Zhipu AI** | ✅ | Tsinghua's GLM series |
| **Moonshot** | ✅ | Kimi's underlying model |
| **OpenAI** | — | GPT series |
| **SiliconFlow** | — | Multi-model aggregation |
| **DeepSeek** | — | Cost-effective, reasoning models |
| **Qiniu** | — | Multi-model aggregation, 15+ models |
| **OpenRouter** | — | International model router |
| **MiniMax** | — | MiniMax M2.7/M2.5 series |
| **Ollama** | — | Local Ollama service, no API key needed |
| **Local Models** | — | LM Studio and other local inference engines |
| **Custom API** | — | Any OpenAI/Anthropic-compatible endpoint |

> **✅** = Provider natively supports web search — works out of the box.
> **—** = Not built-in, but can be configured separately via custom settings.

### Model Configuration Steps

1. Open **Settings** → **AI Services**
2. Select a **Provider** (e.g., Anthropic, DeepSeek, Bailian)
3. Enter your **API Key**
4. Choose a **Model** (each provider offers different models)
5. (Optional) Expand **Advanced Options** to adjust temperature

### Custom API Configuration

When using the "Custom API" provider:

- **API URL** — The service's Base URL
- **Model Name** — The model ID
- **API Format** — `OpenAI Compatible` or `Anthropic`
- **API Key**

### Local Model Setup

For Ollama or similar local models:

**Ollama** (recommended):
1. Select **"Ollama"** as provider — no API key needed
2. Base URL defaults to `http://localhost:11434`
3. Enter your local model name (e.g., `llama3`)

**Other local engines** (LM Studio, etc.):
1. Select **"Local Models"** or **"Custom API"** as provider
2. Base URL: your engine's URL
3. API Key: any value
4. Model name: your local model name

### Advanced Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| **Temperature** | Controls response randomness (lower = more deterministic) | 0.7 |
| **Extended Thinking** | Enables deep reasoning before answering (supported models only) | Off |
| **Thinking Budget** | Token budget for extended thinking | 10000 |

---

## Web Search

Web search allows Abu to fetch up-to-date information from the internet.

### Two Ways to Use

#### Option 1: Built-in Provider Search (Recommended)

If your provider supports built-in web search (Anthropic, Bailian, Zhipu, etc.), a green ✅ badge appears in **AI Services** settings.

- **Enabled by default** — toggle with the "Use built-in search" switch
- No extra configuration needed

**Try it:**
```
Search for the latest AI news today
```

#### Option 2: Configure Custom Search

If your provider doesn't support built-in search, or you prefer a specific search engine:

1. In **AI Services** settings, find the "Web Search" section
2. Expand **"Configure Custom Search"**
3. Select a search provider and enter credentials

### Supported Search Providers

| Provider | Requires | Notes |
|----------|----------|-------|
| **Brave Search** | API Key | Generous free tier, recommended. [Get API Key](https://brave.com/search/api/) |
| **Tavily** | API Key | AI-optimized search engine. [Get API Key](https://tavily.com/) |
| **Bing Search** | API Key | Microsoft Bing Search API. [Get API Key](https://www.microsoft.com/en-us/bing/apis/bing-web-search-api) |
| **SearXNG** | Base URL | Self-hosted meta search engine, no API key needed. [Docs](https://docs.searxng.org/) |

### Search Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `query` | Search keywords | (required) |
| `count` | Number of results | 8 (max 20) |
| `market` | Search locale | zh-CN |
| `freshness` | Time filter | None (optional: Day/Week/Month) |

---

## Image Generation

Abu can generate images from text descriptions.

### Two Ways to Use

#### Option 1: Built-in Provider Image Gen

If your provider supports built-in image generation (Bailian, Zhipu, OpenAI, SiliconFlow), a green ✅ badge appears in **AI Services** settings — use it directly.

#### Option 2: Configure Custom Image Gen

If your provider doesn't support built-in image generation:

1. In **AI Services** settings, find the "Image Generation" section
2. Expand **"Configure Custom Image Generation"**
3. Fill in the following:

| Setting | Description |
|---------|-------------|
| **API Key** | Image generation API key (auto-reuses main API Key if using OpenAI provider) |
| **API URL** | Base URL for image generation (defaults to OpenAI if left blank) |
| **Model** | Choose `DALL-E 3`, `DALL-E 2`, or enter a custom model name |

### Image Generation Parameters

| Parameter | Description | Options |
|-----------|-------------|---------|
| `prompt` | Image description | (required) |
| `size` | Image dimensions | `1024x1024` (default), `1792x1024`, `1024x1792` |
| `style` | Visual style | `vivid` (default), `natural` |
| `save_path` | Save location | Auto-saves to workspace if omitted |

### Examples

```
Generate a cyberpunk cityscape at night
```

```
Draw a cute cartoon cat avatar, 1024x1024
```

```
Create a wide banner image about "AI Shaping the Future", 1792x1024
```

---

## Sandbox & Security

Abu includes multiple layers of security to protect your system.

### OS-Level Sandbox

| Platform | Technology | Effect |
|----------|-----------|--------|
| macOS | Seatbelt (sandbox-exec) | Restricts file access for shell commands |
| Windows | PowerShell ConstrainedLanguage | Restricts script execution capabilities |

### Network Isolation

- **Domain whitelist** — Only allows access to whitelisted domains
- **Private network control** — Toggle access to local networks (127.0.0.1, 192.168.*, etc.)
- **Proxy mechanism** — Routes network traffic through a local proxy

### Path Protection

Abu will not access without permission:

- System directories (`/System`, `/usr`, `C:\Windows`, etc.)
- Other users' directories
- Sensitive config files (SSH keys, browser data, etc.)

### Command Safety

- Dangerous commands (e.g., `rm -rf /`) are automatically blocked
- First-time commands require user confirmation
- Authorized commands can be auto-allowed

### Configuring the Sandbox

1. Open **Settings** → **Security**
2. Toggle **Sandbox Protection** on/off
3. Toggle **Network Isolation** on/off
4. Manage the **domain whitelist**

---

## Notification System (v0.13.0+)

Previously, Abu's various proactive notifications (task complete, scheduled-task fires, errors, IM inbound, skill proposals) took ad-hoc paths. v0.13.0 unifies them behind a **Notice pipeline** and adds "**read-the-room**" intelligence.

### Three fallback channels

Each notice picks the most appropriate channel based on current context:

| Channel | When it's used |
|---------|---------------|
| **In-chat card** | Event happens inside the conversation you're viewing — shown directly in chat |
| **Sidebar badge** | Event belongs to another conversation — small red dot + count on its sidebar node |
| **Menubar unread count** | Fallback when the main window isn't focused / you're in fullscreen |
| **System notification** | L1 important events (task done, errors, meeting prep) — OS-level banner |

### Read-the-room policy

Abu decides whether to interrupt based on your state:

- **Fullscreen** (Bilibili, Keynote, video calls) — Abu stays silent; notices are queued to an inbox (SQLite-persisted) and surfaced via unread count once you return
- **Over quota** (default L2 cap: 3/hour) — excess notices queue, don't pop
- **Do-Not-Disturb** — deferred to v1.1

### Priority tiers

| Tier | Meaning | Examples |
|------|---------|----------|
| **L1** | Cannot be dropped (important + time-sensitive) | Meeting prep, permission request, task complete, errors |
| **L2** | Droppable (valuable but not urgent) | Skill proposals, scheduled-task fires, IM messages |
| **L3** | Status-light only | Deep-focus enter/exit, context resume |

L1 notices are **never dropped** — even in fullscreen / over quota they fall back to system notifications.

### Audit trail

Every notice's delivery (emit time, channels dispatched, whether the user clicked, response latency) is written to SQLite. Settings → Notifications → History shows the last 180 days, letting you review "when did Abu interrupt me, and how did I respond?"

This data also helps Abu **learn**: if L2 response rate in a given time window stays persistently low, Abu auto-lowers the interruption cadence for that window (L2 → L3, status-light only).

---

## Behavior Awareness

Behavior Awareness lets Abu understand your work patterns so it can give context-aware answers.

### How It Works

- Samples the **active window's title** (e.g. Chrome, VS Code) every 5 minutes
- Data is retained for 7 days, then auto-cleaned
- Aggregated into a 3–5 line summary that's injected into the conversation context

**Example injection:**
```
- Today: Chrome 1.5h, Xcode 45min, Terminal 30min
- Current: Using Xcode
- Common hours: 9-12, 14-18
```

### Enabling It

1. Open **Settings** → **Preferences**
2. Find **"Behavior Awareness"** and toggle it on
3. macOS first-time enable requires **Automation** permission (System Settings → Privacy & Security → Automation, allow Abu to control "System Events")

### Privacy Protections

| Protection | Description |
|-----------|-------------|
| **Off by default** | User must explicitly enable |
| **Window title only** | Doesn't record screen content or screenshots |
| **Raw data stays local** | Only the aggregated summary is sent to the AI; raw logs are never sent |
| **Clearable anytime** | Once enabled, the settings page shows a "Clear Behavior Data" button |

### Storage

- Storage path: `~/.abu/behavior-log.json`
- Retention: 7 days

---

## Appearance & Theme

Switch the UI theme in **Settings → Appearance**:

| Option | Description |
|--------|-------------|
| **Light** | Always use the light theme |
| **Dark** | Always use the dark theme (default) |
| **System** | Follows your OS dark/light setting, switching live |

UI language (Simplified Chinese / English) is also switched in Settings, including a "Follow System" option.

---

## Labs

**Labs** collects features still in active development: **off by default, opt-in**, may change or be removed at any time. Entry: **Settings → Experiments**; each experiment is a card (title + description + "where to find it" hint + toggle). Shows a placeholder when no experiments are active.

> Experiments may be unstable and their behavior may change between versions. Once stable, they graduate to full features.

### Desktop Pet

The current experiment in Labs is **Desktop Pet** — a floating Abu that stays on your desktop and is always ready to chat.

**Two-step enable** (two levels are intentional to prevent accidentally pinning a floating window):

1. **Settings → Experiments** — turn on "Desktop Pet" → a "Desktop Pet" settings page appears in the sidebar
2. **Settings → Desktop Pet** — toggle it on → the pet window appears on your desktop

**Interactions:**

| Action | Effect |
|--------|--------|
| **Left-click** | Open Abu main window |
| **Right-click** | Menu (view status / open main window / close pet) |
| **Drag** | Move; drag to a screen edge to **dock and hide** (only a sliver remains visible); position is remembered |

**Activity tray**: When Abu is doing work, a status bubble floats beside the pet showing the current conversation title + latest reply line, color-coded by state:

| State | Color | Meaning |
|-------|-------|---------|
| Working | Blue | Abu is executing a task |
| Awaiting input | Orange | Needs your authorization or a reply — **you can reply inline right in the bubble** (press Enter to send) |
| Done | Green | Task complete (auto-dismisses after ~6 s) |
| Problem | Red | An error occurred |

No need to switch back to the main window — a quick glance at the pet tells you where Abu is at and whether it needs a hand.

---

## Common Use Cases

### Office Productivity

```
Organize the files on my desktop into folders by type
```

```
Extract tables from this PDF, create an Excel file, and add column totals
```

```
Write a weekly report based on this week's meeting notes and project docs
```

### Data Processing

```
Analyze sales data in data.csv, group by month, and generate a bar chart report
```

```
Merge these 10 Excel files into one, deduplicate, and sort
```

### Development

```
Check all TypeScript files in src/ for unused imports and clean them up
```

```
Generate TypeScript type definitions from this API response
```

### Information Retrieval

```
Search for the latest React 19 features and compile them into a document
```

```
Every morning, search for the latest AI news and create a summary
```

### Design

```
Design a modern product landing page
```

```
Create a tech-themed poster about "AI Shaping the Future"
```

---

## FAQ

### Q: Does Abu upload my data?

No. Abu is a local-first app — your files and data are processed locally. The only network traffic is API requests to your LLM provider.

### Q: Where is my API Key stored? Is it safe?

Starting with v0.12, API Keys live in your OS-level secret manager — never in plaintext localStorage, and never uploaded to any server:

- **Windows**: Credential Manager (encrypted via DPAPI, bound to your login account)
- **macOS**: local AES-256-GCM encryption with a key derived from your hardware UUID
- **Linux**: not officially supported

**Upgrading from 0.11**: legacy plaintext keys are automatically migrated to the encrypted store on first launch. The migration is silent and completes in under a second.

**Moving machines**: the derived key is bound to the current hardware, so after migrating to a new Mac or swapping the logic board, you will need to re-enter your API keys in Settings. This is intentional — it prevents stolen backup drives from leaking your keys. Affected provider cards display a red "please re-enter API Key" hint.

**Hard reset**: the Settings → AI Services page has a "Clear all stored keys" button at the bottom for wiping every stored credential at once.

### Q: Where is my memory and where are my project rules stored?

- **Personal memory**: `~/.abu/memory/` multi-file directory, each entry is a separate `.md` file
- **Project memory**: `~/.abu/projects/<workspace-key>/memory/`, auto-isolated per workspace
- **User-level rules**: `~/.abu/ABU.md` (hand-written)
- **Project-level rules**: `{workspace}/.abu/ABU.md` (hand-written, recommended to commit to git)
- **Modular rules**: `{workspace}/.abu/rules/*.md` (loaded alphabetically, max 20 files)

Legacy locations (`~/.abu/agents/abu/memory.md` and `{workspace}/.abu/MEMORY.md`) are **automatically migrated** the first time you launch the new version — no manual action needed.

### Q: Can I use multiple models at once?

Currently only one model config can be active at a time. You can switch between providers and models in settings at any time.

### Q: Scheduled tasks aren't running?

- Make sure Abu is running (the app must stay open)
- Check if the task is in "Paused" state
- Check the task execution history for error messages

### Q: How do I create custom Skills?

Say "Help me create a new skill" in conversation. Abu will guide you through the process. Skills are stored as Markdown files in `builtin-skills/` and can be edited directly.

### Q: MCP server won't connect?

- Verify the server command and arguments are correct
- Check that required runtimes are installed (Node.js, Python, etc.)
- Verify environment variables are correctly configured
- For HTTP servers, confirm the URL is accessible

### Q: How do I use browser automation?

The easiest way is to install the **Abu-Browser** skill — on first use, Abu will guide you through auto-installing the Chrome extension. Then just describe what you want to do in the browser.

### Q: How can the trigger HTTP endpoint be reached from outside?

Trigger HTTP endpoints listen on `127.0.0.1` (localhost) by default. To reach them from external systems, use a tunneling tool (e.g. ngrok) or run Abu on a server with a reachable address.

### Q: I configured an IM channel but I'm not receiving messages?

- Verify the Webhook URL is correctly set in the IM platform's developer portal
- Verify the IM platform can reach your Webhook (you may need a tunnel for local development)
- Verify the channel toggle is on
- Check if access control allowlist is restricting users

### Q: Computer Use says insufficient permissions?

On macOS, grant **Screen Recording** and **Accessibility** to Abu in **System Settings → Privacy & Security**, then restart Abu.

### Q: Does Behavior Awareness leak my privacy?

No. Behavior Awareness only records window titles (e.g. app names), not screen content or screenshots. Raw data stays local; only the aggregated summary is injected into the conversation context. You can disable it and clear data at any time in Settings.

### Q: What languages are supported?

Abu's UI supports **Simplified Chinese** and **English**. Switch in Settings, or set to "Follow System" for automatic detection. Theme (light / dark / system) is also switched in Settings → Appearance — see [Appearance & Theme](#appearance--theme).

### Q: Will Abu ask before doing something dangerous?

Yes — and the extent of confirmation is controlled by the **permission mode**. Under the default "Request Approval" mode, Abu reads and writes freely inside your workspace but asks before any out-of-bounds write or dangerous command. Beyond that, when a task involves high-risk steps like delete / overwrite / send / install, Abu enters **Plan Mode**: it shows a step-by-step plan first, and only proceeds after you explicitly click "Confirm & run" on the card — read-only ops run in the meantime. See [Chat & Agent → Permission Modes / Plan Mode](#permission-modes-three-levels-switchable-per-conversation).

### Q: How do I enable the desktop pet?

The desktop pet is a **Labs** experiment — it needs two steps to enable: first go to **Settings → Experiments** and turn on "Desktop Pet", then go to **Settings → Desktop Pet** and toggle it on. See [Labs → Desktop Pet](#desktop-pet).

### Q: Will Abu remember flows I've taught it?

Yes. The **Self-Evolving Skills** feature introduced in v0.13.0 recognizes multi-step complex flows you've run and proactively suggests "want to crystallize this into a skill?" Once you review and accept, the next similar task is just a skill-name away — no re-explaining. See [Skill System → Self-Evolving Skills](#self-evolving-skills-v0130).

You can tune offer frequency under Settings → Soul → Abu Proactivity (Off / Normal / Companion).

### Q: What's the difference between Projects and Workspaces?

**Workspace** is a folder path — it decides "which files Abu can access". **Project** is an aggregation container — it groups multiple conversations under the same workspace together, with project-level defaults.

One-to-one binding: a workspace maps to at most one Project; a Project can hold unlimited conversations. Upgrade is reversible — a project can be dissolved at any time; the underlying workspace stays intact.

### Q: I don't get notifications in fullscreen — is that a bug?

It's **by design**, not a bug. From v0.13.0, Abu reads your state before interrupting: in fullscreen, L2-tier notices (skill proposals, scheduled tasks, etc.) queue to inbox, surfaced via menubar unread count + sidebar badge once you return.

L1-tier notices (meeting prep, errors, permission requests) **are not affected** — they always fall back to system notifications. See [Notification System](#notification-system-v0130).
