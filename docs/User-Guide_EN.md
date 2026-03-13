# Abu User Guide

**English** | [中文](User-Guide.md)

This guide covers all Abu features and how to use them effectively.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Chat & Agent](#chat--agent)
- [Workspace & Memory](#workspace--memory)
- [Built-in Tools](#built-in-tools)
- [Skill System](#skill-system)
- [MCP Protocol](#mcp-protocol)
- [Scheduled Tasks](#scheduled-tasks)
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

## Workspace & Memory

Workspace and memory let Abu understand your project context and personal preferences without repeating yourself.

### Workspace

A workspace is the root directory Abu operates in. Once set, Abu can read and write files within it.

1. Click the **Workspace** area in the right panel
2. Select your project folder
3. Grant access permissions

Below the workspace, you'll see two entries: **Project Instructions** and **Project Memory**.

### Three Layers of Memory

Abu has three types of memory, each serving a different scope:

#### 1. Personal Memory

| Property | Description |
|----------|-------------|
| **Location** | Settings → Personal Memory |
| **Storage** | `~/.abu/agents/abu/memory.md` |
| **Scope** | Applies across all projects |
| **Who writes** | Abu accumulates automatically; you can also edit manually |
| **Content** | Your name, communication preferences, tools you use, etc. |

**Example**: When you say "Remember my name is Shawn", Abu stores this in personal memory. She'll remember you in future conversations.

#### 2. Project Memory

| Property | Description |
|----------|-------------|
| **Location** | Right panel → Project Memory |
| **Storage** | `{workspace}/.abu/MEMORY.md` |
| **Scope** | Current workspace only |
| **Who writes** | Abu accumulates automatically; you can also edit manually |
| **Content** | Tech stack, common issues, architecture patterns, etc. |

**Note**: This file is AI-generated — **do not commit to git**.

#### 3. Project Instructions

| Property | Description |
|----------|-------------|
| **Location** | Right panel → Project Instructions |
| **Storage** | `{workspace}/.abu/ABU.md` |
| **Scope** | Current workspace only |
| **Who writes** | You write manually |
| **Content** | Coding standards, build commands, team conventions |
| **Priority** | Highest — Abu strictly follows these |

**Recommended to commit to git** so team members share the same rules.

Click **"Instructions · Click to add"** in the right panel to edit. Supports Markdown format.

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

### Modular Rules

For large projects, split rules into multiple `.md` files under `{workspace}/.abu/rules/`. Abu loads them all alphabetically (max 20 files).

### Memory Priority

When processing your requests, Abu injects context in this order:

```
Project Instructions (highest) → Project Memory → Personal Memory (lowest)
```

If project instructions conflict with personal memory, project instructions take precedence.

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

### Q: How do I use browser automation?

1. Install the Abu Chrome extension
2. Ensure Browser Bridge is connected (check status in Toolbox)
3. Describe what you want to do in the browser

### Q: What languages are supported?

Abu's UI supports **Simplified Chinese** and **English**. Switch in Settings, or set to "Follow System" for automatic detection.
