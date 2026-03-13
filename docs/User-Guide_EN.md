# Abu User Guide

**English** | [中文](User-Guide.md)

This guide covers all Abu features and how to use them effectively.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Chat & Agent](#chat--agent)
- [Built-in Tools](#built-in-tools)
- [Skill System](#skill-system)
- [MCP Protocol](#mcp-protocol)
- [Scheduled Tasks](#scheduled-tasks)
- [Triggers](#triggers)
- [IM Channels](#im-channels)
- [Browser Automation](#browser-automation)
- [AI Services Configuration](#ai-services-configuration)
- [Web Search](#web-search)
- [Image Generation](#image-generation)
- [Sandbox & Security](#sandbox--security)
- [Common Use Cases](#common-use-cases)
- [FAQ](#faq)

---

## Quick Start

### 1. Install

Download the installer for your platform from [GitHub Releases](https://github.com/PM-Shawn/Abu-Cowork/releases). For first-launch security prompts, see the [Installation Guide](Installation-Guide_EN.md).

### 2. Configure a Model

1. Open Abu and click the **settings icon** at the bottom left
2. Go to **"Custom Models"**
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

### Conversation Management

- The left sidebar shows all conversation history
- Click **"New Chat"** to start a fresh task
- Search and delete conversations as needed

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

### System Operations

| Tool | Description |
|------|-------------|
| **Run Command** | Execute shell commands with background mode and timeout |
| **System Info** | Get platform, home directory, desktop path, etc. |
| **Send Notification** | Send desktop notifications |
| **Clipboard** | Read/write system clipboard |

### Advanced

| Tool | Description |
|------|-------------|
| **Manage Scheduled Tasks** | Create, view, pause, delete scheduled tasks |
| **Invoke Skill** | Dynamically call installed skills |
| **Invoke Agent** | Launch sub-agents for isolated subtasks |
| **Memory** | Store and retrieve memory at session/project/user levels |
| **Web Search** | Search the internet for up-to-date information (requires config) |

---

## Skill System

Skills are pre-defined capability modules that make Abu more professional in specific scenarios.

### How to Use

1. Open the **Toolbox** (sidebar icon)
2. Browse available Skills
3. Click **"Install"** to enable a skill
4. Describe your need in conversation — Abu auto-selects the right skill

### Built-in Skills

#### Documents & Content

| Skill | Description |
|-------|-------------|
| **Doc Co-authoring** | Structured document writing workflow |
| **Internal Comms** | Templates for weekly reports, status updates, newsletters |

#### Office Files

| Skill | Description |
|-------|-------------|
| **Word (docx)** | Create/edit Word docs with tables, TOC, headers, images |
| **Excel (xlsx)** | Create/analyze spreadsheets with formulas and charts |
| **PowerPoint (pptx)** | Build presentations with templates and layouts |
| **PDF** | Extract text/tables, merge, split, watermark, encrypt, OCR |

#### Visual Design

| Skill | Description |
|-------|-------------|
| **Frontend Design** | Generate high-quality web UI components and pages |
| **Canvas Design** | Create posters and visual art (PDF/PNG) |
| **Algorithmic Art** | Generate computational art with p5.js |
| **Web Artifacts** | Build complex React + Tailwind + shadcn/ui components |
| **Theme Factory** | 10 preset professional themes for any document/slide/page |

#### Development

| Skill | Description |
|-------|-------------|
| **MCP Builder** | Guide for creating MCP servers (TypeScript/Python) |
| **Claude API** | Complete docs and code examples for Claude API |
| **Web App Testing** | Test local web apps with Playwright |
| **Skill Creator** | Create, modify, and test custom skills |

#### Automation

| Skill | Description |
|-------|-------------|
| **Schedule** | Create and manage recurring tasks |
| **Agent Creator** | Build custom agents with specific tools and memory |
| **Project Init** | Analyze project structure and generate config files |

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

1. Click the **Scheduled Tasks** icon in the sidebar
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

### Important Notes

- Scheduled tasks run in **unattended mode** — no confirmation dialogs
- Previously authorized paths/commands are auto-allowed; unauthorized sensitive operations are auto-skipped
- Desktop **notifications** are sent on completion
- Abu must be running for scheduled tasks to execute

---

## Triggers

Triggers let Abu **automatically respond to external events** — incoming webhooks, file changes, timers, or IM messages — and execute your pre-configured tasks.

### Creating a Trigger

1. Click the **Triggers** icon in the sidebar
2. Click **"New Trigger"** (or choose from templates)
3. Enter a name and description
4. Configure the event source, filters, and action
5. Save

### Event Sources

| Source Type | Description | Configuration |
|------------|-------------|---------------|
| **HTTP Webhook** | Receive POST requests from external systems | Auto-generated unique endpoint URL |
| **File Watch** | Monitor file/directory changes | Watch path, event types (create/modify/delete), file pattern (e.g., `*.log`) |
| **Timer** | Execute at fixed intervals | Interval in seconds (minimum 10s) |
| **IM Message** | Listen for IM platform messages | Platform, App ID/Secret, listen scope (all/mentions/DMs only) |

### Filters

Control which events trigger execution:

| Filter Type | Description |
|------------|-------------|
| **Always** | Execute on every event |
| **Keyword Match** | Execute only if event contains specified keywords (comma-separated) |
| **Regex Match** | Execute only if event matches a regular expression |

### Debounce

When enabled, identical events within a time window are deduplicated. Useful for high-frequency events (log writes, repeated alerts). Default window: 300 seconds.

### Quiet Hours

Set a time range (e.g., 22:00 ~ 08:00) during which triggers won't execute. Supports cross-midnight ranges.

### Action

When triggered, Abu executes your **prompt instructions**. Use `$EVENT_DATA` in your prompt to reference the raw event payload.

You can also:
- **Bind a Skill** — select an existing Skill to invoke
- **Specify a workspace** — run in a specific directory

### Output

After execution, results can be pushed externally:

| Output Target | Description |
|--------------|-------------|
| **Webhook** | Push results to a URL (supports custom headers and templates) |
| **Reply to Source** | Reply directly to the IM message that triggered the event |

**Template variables**: `$TRIGGER_NAME`, `$EVENT_SUMMARY`, `$AI_RESPONSE`, `$RUN_TIME`, `$TIMESTAMP`, `$EVENT_DATA`

### Built-in Templates

| Template | Description |
|----------|-------------|
| **Alert Handler** | Pre-configured keywords for `error, alert, warning, P0, P1, critical` |
| **Log File Monitor** | Watch log files, auto-analyze new entries |
| **Periodic Health Check** | Timer-based system health checks with reporting |

### Run History

Each trigger logs recent executions. View them in the sidebar **"Triggers"** panel:

- Status (running / completed / error / filtered / debounced)
- Execution time
- Linked conversation
- Success rate stats

---

## IM Channels

IM Channels let external users chat with Abu directly through messaging platforms (Feishu, Slack, etc.) without opening the Abu desktop app.

### Supported Platforms

| Platform | Notes |
|----------|-------|
| **Feishu (Lark)** | Supports WebSocket — no public IP needed |
| **DingTalk** | Webhook callback |
| **WeCom** | Webhook callback |
| **Slack** | Events API |
| **D-Chat** | Webhook callback |

### Quick Setup (Feishu Example)

#### Step 1: Create an App on Feishu Open Platform

1. Visit [Feishu Open Platform](https://open.feishu.cn/) and create an enterprise app
2. Get the **App ID** and **App Secret**
3. Add the `im.message.receive_v1` event subscription
4. Enable the "Bot" capability

#### Step 2: Add a Channel in Abu

1. Open **Settings** → **IM Channels**
2. Click **"Add Channel"**
3. Enter a channel name (e.g., "Dev Team Bot")
4. Select **Feishu** as the platform
5. Enter App ID and App Secret
6. Choose a capability level
7. Save

#### Step 3: Configure Callback URL

After saving, a **Webhook URL** is auto-generated. Copy it and paste it into Feishu's event subscription request URL.

> Feishu also supports WebSocket mode — Abu connects automatically without needing a callback URL or public IP.

#### Step 4: Test

Send a message to the bot in Feishu (DM or @mention in a group). Abu will reply automatically.

### Capability Levels

| Level | Permissions | Use Case |
|-------|-----------|----------|
| **Chat Only** | Conversation only, no file access | Public-facing Q&A bot |
| **Read Only** | Can view files, no modifications | Code/doc review scenarios |
| **Standard** | Read/write files in authorized directories | Daily development collaboration (recommended) |
| **Full Control** | Complete access including command execution | Trusted admins only — requires whitelist |

### Whitelist

- **Empty**: Everyone can use the channel. If set to "Full Control", non-whitelisted users are automatically downgraded to "Standard"
- **With user IDs**: Only whitelisted users can access the channel

### Session Management

IM Channels automatically manage conversation lifecycles:

- **Session Timeout**: After a period of inactivity, the next message starts a new conversation (default: 30 minutes)
- **Max Rounds**: Conversations auto-reset after reaching the round limit (default: 50)
- **Resume Context**: Users can send "continue" to restore the previous session
- **Session Isolation**: Different users in the same group chat have independent conversations

### Viewing IM Conversations in Abu

IM messages appear in the **"Recent"** list in Abu's sidebar. Click to view the full conversation. The info bar at the top shows the source platform and round count — click the **⋯** menu for details or to end the session.

### Important Notes

- Abu must be running to receive and reply to IM messages
- Feishu WebSocket mode doesn't require a public IP; other platforms need Abu's machine to be externally accessible (or use a tunnel like ngrok)
- In IM mode, Abu won't show desktop confirmation dialogs — operations requiring confirmation are automatically skipped
- Consider creating separate channels for different teams/purposes for better access control

---

## Browser Automation

With Abu Browser Bridge and the Chrome extension, Abu can control your browser.

### Setup

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
| **Local Models** | — | Ollama, LM Studio, etc. |
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

1. Select **"Local Models"** or **"Custom API"** as provider
2. Base URL: `http://localhost:11434/v1` (Ollama default)
3. API Key: any value (e.g., `ollama`)
4. Model name: your local model name (e.g., `llama3`)

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

1. Open **Settings** → **Security Sandbox**
2. Toggle **OS Sandbox** on/off
3. Toggle **Network Isolation** on/off
4. Manage the **domain whitelist**

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

### Q: Where is my API Key stored?

API Keys are encrypted and stored in your local app data directory. They are never uploaded to any server.

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

### Q: What's the difference between triggers and scheduled tasks?

Scheduled tasks only support time-based execution. Triggers are more flexible — besides timers, they can respond to webhook requests, file changes, and IM messages, with advanced features like filtering, debounce, quiet hours, and output delivery.

### Q: Do IM Channels require a public IP?

Feishu supports WebSocket mode where Abu connects outbound to Feishu servers — **no public IP needed**. Other platforms use webhook callbacks and require Abu's machine to be externally accessible (you can use ngrok or similar tunneling tools).

### Q: Can IM users perform dangerous operations?

It depends on the channel's "Capability Level" setting. We recommend "Standard" (default) — Abu can only read/write authorized directories. "Full Control" must be paired with a whitelist; only whitelisted users get full permissions.

### Q: How do I use browser automation?

1. Install the Abu Chrome extension
2. Ensure Browser Bridge is connected (check status in Toolbox)
3. Describe what you want to do in the browser

### Q: What languages are supported?

Abu's UI supports **Simplified Chinese** and **English**. Switch in Settings, or set to "Follow System" for automatic detection.
