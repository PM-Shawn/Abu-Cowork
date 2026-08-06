# Abu User Guide

**English** | [中文](User-Guide.zh-CN.md)

This guide follows the current Electron client. UI pages and controls are shown in **bold**. If an older screenshot or tutorial conflicts with this guide, follow the labels in the app.

## Key terms

| Term | What it means in Abu |
|---|---|
| **Task** | One complete piece of work, from request to result. Select **New Task** to begin. |
| **Conversation** | The messages and execution record for a task. Completed conversations remain under **Recents**. |
| **Workspace** | The folder Abu can work with for this task and the primary boundary for file access. |
| **Project** | A workspace plus its related conversations, default model, skills, and connectors for ongoing work. |
| **Model** | The model-provider configuration used for conversations. Open **Settings → Models**. |
| **Skill** | A reusable method for a particular kind of work. |
| **Agent** | A role that can take responsibility for a defined part of a task. |
| **Connector** | An extension that connects external tools or services using the MCP standard. |
| **Capability** | A system capability, such as web browsing or computer control, that may need setup or permission. |

## Start your first task in five minutes

### 1. Install Abu

Download the installer that matches your operating system and CPU architecture from the [Abu official website](https://myabu.cn/). See the [Installation Guide](Installation-Guide.md) for complete steps.

Run only installers obtained through the download entry on the Abu official website. Official macOS packages are signed and notarized. The current Windows package may trigger SmartScreen, so verify its source and filename before continuing.

### 2. Configure a model

1. Select your avatar in the lower-left corner and open **Settings**.
2. Open **Models**.
3. Select **Add**. On an empty page, you may see **Add AI Service**.
4. Choose the provider and billing mode, then enter the API key.
5. Fetch or manually add a model, validate the connection, and save.
6. Return to the task view and use the model picker near the composer to select the model for this task.

For local models, select Ollama or LM Studio. They do not require a cloud API key, but the local service must be running and its address and model ID must match your setup.

### 3. Choose where Abu should work

- For one-off work in a folder, select **New Task**, then choose a **Workspace** below the composer.
- For ongoing work, create a **Project**, bind its workspace, and start tasks inside that project.
- For a task that does not use files, you can leave the workspace unset. Abu will ask for a folder if file access becomes necessary.

The workspace is Abu's default file boundary. Do not select a broader directory merely to avoid a permission prompt.

### 4. Describe the result, not only the action

Include the goal, source material, constraints, and deliverable. For example:

> Read the meeting notes in this workspace and prepare a weekly update. List missing information first and do not invent facts. Save the result as `weekly-update.md`, then summarize the three main risks in the reply.

Abu can read files, call skills or connectors, run commands, and return results and pending decisions to the same task.

## Interface map

### Sidebar

- **New Task** starts an independent task.
- **Toolbox** manages **Skills, Agents, and Connectors**.
- **Automation** manages **Scheduled Tasks** and **Event Listeners**.
- **Recents** lets you search, rename, import, export, or delete past conversations.
- **Projects** groups ongoing work by workspace.

### Settings

Select your avatar in the lower-left corner, then **Settings**. The main pages in personal mode are:

| Page | Purpose |
|---|---|
| **Preferences** | Theme, language, close behavior, behavior awareness, and sleep prevention. |
| **Capabilities** | Readiness for the built-in browser, My Chrome, and Computer Use. |
| **Security** | Sandbox, network isolation, default permission mode, content scanning, and authorized paths. |
| **Experiments** | Opt in to features that are still being refined. |
| **Models** | Model providers, web search, and image-generation backends. |
| **Usage** | Request and token usage. |
| **Memory** | Personal preferences and workspace-specific knowledge remembered by Abu. |
| **Personality** | Abu's response style and proactivity for skill suggestions. |
| **IM Channels** | Feishu, DingTalk, WeCom, Slack, WeChat, and other message channels. |
| **Diagnostics** | Checks for models, permissions, connectors, skills, network, and app state. |
| **Feedback / Version** | Report issues, inspect the version, and check for updates. |

Experiments may add extra pages, such as **Desktop Pet**.

## Task execution and approvals

### Model used by the current task

The model picker near the composer controls the current task. The selection is bound to that conversation so a global setting change does not switch models midway through a task. New tasks inherit the project default or global default.

### Three permission modes

Set the global default under **Settings → Security → Default Permission Mode**. Use the permission control near the composer to override it for the current task.

| Mode | Best for | Behavior |
|---|---|---|
| **Standard** | Default use | Routine work inside the workspace can continue; out-of-bounds writes, dangerous commands, and sensitive computer actions ask you first. |
| **Smart Review** | Clear boundaries with fewer interruptions | AI reviews some out-of-bounds actions; browsers, communications, unknown apps, and consequential results may still ask you. |
| **Full Autonomy** | Low-risk batch work in a trusted workspace | Allows more routine actions; system red lines, consequential results, and explicit blocks still apply. |

A permission mode is not a global safety off-switch. Sandbox rules, protected paths, dangerous-command checks, content scanning, and operating-system permissions still apply independently.

### Execution plans

When a plan includes high-risk steps such as deletion, overwrite, sending, publishing, or installation, Abu presents an **Execution Plan** and waits for approval. Approving a plan allows work to continue under that plan; it does not permanently authorize every downstream result. Abu may still ask immediately before a consequential action.

You can reject the plan and explain what to change. Only read-only operations are allowed while approval is pending.

### Interactive questions and stopping a task

When information is missing, Abu can present a question card with single-choice, multi-choice, and custom-answer fields. Your answer returns directly to the original task.

Use the stop control to terminate the active run. Stopping a task does not delete files that were already created or remove the conversation history.

## Workspaces, projects, and memory

### Workspace versus project

- A **workspace is a folder boundary**: it determines which files the task primarily works with.
- A **project is an organizational layer**: it binds one workspace, groups conversations, and stores default models, skills, and connectors.

One project binds one workspace, and a project can contain many tasks. Archiving or deleting a project does not automatically delete workspace files; always read the confirmation text.

### Create a project

1. Use the create control in the Projects area of the sidebar.
2. Choose **Start from Scratch**, **Convert Existing Conversation**, or **Use Existing Folder**.
3. Set the name, icon, and workspace.
4. Optionally configure default models, skills, and connectors.

If a task already has a workspace but no project, Abu may also offer to promote that workspace to a project.

### Three kinds of persistent context

| Type | Maintained by | Scope |
|---|---|---|
| **Personal memory** | Accumulated by Abu and editable by you | Cross-project preferences such as communication style and common tools. |
| **Project memory** | Accumulated by workspace | Knowledge for one workspace, such as technology, decisions, and recurring issues. |
| **Project rules** | Written by the user | Explicit instructions that take priority over automatic memory. |

View personal and project memory under **Settings → Memory**. User rules live at `~/.abu/ABU.md`; project rules live at `{workspace}/.abu/ABU.md`, with optional modules under `{workspace}/.abu/rules/*.md`.

Project memory is stored under `~/.abu/projects/<workspace-key>/memory/` and is not written to your Git repository by default. For identity, account, financial, medical, or confidential business data, mark the memory private and keep its index description limited to the topic rather than the sensitive value.

## Web browsing

Abu offers two distinct browser paths:

| Capability | Use it when | Session state |
|---|---|---|
| **Abu Built-in Browser** | General search, reading, clicks, forms, screenshots, and extraction | Independent session; it does not read Chrome cookies. |
| **My Chrome** | You explicitly need existing tabs, cookies, extensions, or signed-in state | Uses your current Chrome session. |

### Abu Built-in Browser

The built-in browser is bundled with the Electron client and requires no extension. Describe an ordinary web task directly. The page opens in Abu's workspace panel so you can observe or take over.

### Connect My Chrome

1. Open **Settings → Capabilities**.
2. Under **My Chrome**, select **Connect Chrome**.
3. Follow the guide to open the extensions page and the extension folder.
4. In Chrome, enable Developer mode, choose **Load unpacked**, and select the entire `browser-extension` folder.
5. Return to Abu and wait for the status to become **Ready**.

The extension is bundled locally with Abu rather than installed from the Chrome Web Store. It needs permission to read and interact with webpages and manage downloads for tasks you explicitly assign. Enable it only on a trusted device. Disconnect it in Abu and disable or remove it in Chrome when it is no longer needed.

Abu selects My Chrome only when you explicitly request your current Chrome or existing signed-in state. If the connection is unavailable, the task pauses for setup instead of silently switching browser paths.

## Computer Use

Computer Use is off by default. Open **Settings → Capabilities → Computer Use** to enable it.

On macOS, two separate permissions are required:

1. **View Screen**: System Settings → Privacy & Security → Screen & System Audio Recording.
2. **Control Interface**: System Settings → Privacy & Security → Accessibility.

Use Abu's setup guide to open System Settings, then return to Abu for an automatic recheck. Development builds may appear as Electron in the permission list; installed releases appear as Abu.

Computer Use remains subject to sensitive-app blocking, dangerous-key interception, permission modes, and confirmation for consequential results. After you disable Computer Use, neither the model nor a background task can turn it back on.

## Toolbox: Skills, Agents, and Connectors

### Skills

Skills describe a professional method for a category of work. Under **Toolbox → Skills**, you can:

- create a skill with Abu or manually;
- import a skill folder containing `SKILL.md`;
- find and install skills from a registry;
- inspect, enable, disable, or manage skill drafts proposed by Abu.

You do not need to pick a skill for every task. When an enabled skill matches your request, Abu follows its instructions.

### Agents

Agents are roles with defined responsibilities and tool access. Use **Toolbox → Agents** to create, import, and manage them. For a complex task, the main agent can delegate a bounded part of the work to another agent.

### Connectors

The UI calls them **Connectors**; MCP (Model Context Protocol) is the underlying standard. Under **Toolbox → Connectors**, you can add:

- a **Local Process (Stdio)** with a command and arguments; or
- a **Remote Service (HTTP)** with a server URL, headers, and timeout.

Connector state appears as Connected, Connecting, Reconnecting, or Disconnected. If a connector fails, check its command, arguments, environment variables, URL, and network, then rerun **Settings → Diagnostics**.

## Automation and IM channels

### Scheduled Tasks

Open **Automation → Scheduled Tasks** to create, pause, resume, run now, or delete a task. Configure its prompt, frequency, time, workspace, optional skill, and optional IM output channel.

Scheduled tasks run only while Abu is running and the computer is awake. An unattended task cannot open an interactive approval dialog; dangerous actions that require approval are skipped and recorded. Do not schedule work that depends on human approval.

### Event Listeners

Open **Automation → Event Listeners** to trigger tasks from HTTP requests, file changes, IM messages, or intervals. Each listener can define filters, debounce behavior, quiet hours, workspace, and result delivery.

Like scheduled tasks, event listeners run in the local Abu client. Abu must remain running and the computer must stay awake; the task is not moved to a cloud runner while the app is closed or the computer sleeps.

HTTP endpoints listen locally by default. Do not expose them directly to the public internet. For cross-machine triggers, use a controlled gateway, private network, or authenticated forwarding service.

### IM Channels

Add a channel under **Settings → IM Channels**, then configure platform credentials, response behavior, capability tier, session timeout, and allowed users. Receive modes and capabilities vary by platform. After setup, inspect the connection state and test with a low-risk message.

Credentials are used for the platform connection you configure. Never paste an App Secret, bot token, or webhook into a conversation, project rule, or shareable skill.

## Model auxiliary capabilities

### Web search

Under **Settings → Models**, expand **Auxiliary Capabilities → Web Search**:

- If an enabled model provider includes search, Abu labels it as built in through that provider.
- Otherwise configure Brave, Tavily, Bing, or a self-hosted SearXNG service.

Availability depends on the active model service, API permissions, and network settings. When freshness matters, explicitly request web search and review the sources.

### Image generation

**Settings → Models → Auxiliary Capabilities → Image Generation** uses a separate list of image-generation backends. Select **Add**, configure the provider, API key, endpoint, and model ID, then choose a default backend.

Chat-model and image-generation configuration are independent. A working chat model does not mean image generation is configured.

## Diagnostics, feedback, and updates

When something fails, start with **Settings → Diagnostics**. Checks are grouped by models, data and permissions, connectors, skills, network, and app state, and each group can be rerun independently.

When reporting an issue:

1. Describe the reproduction steps, expected result, and actual result under **Feedback**.
2. Include only the conversations and screenshots you intend to share.
3. Review the diagnostic-bundle manifest before exporting or uploading.

Abu excludes API keys and known secrets, but conversations, logs, filenames, and screenshots can still contain confidential information. Review the package manually before submission.

Use **Settings → Version** to check for updates. Treat the Abu official website and in-app update prompts as authoritative.

## FAQ

### Where is the “AI Services” page?

The current page is named **Models**. Select your avatar, then **Settings → Models**. An empty Models page may still show an **Add AI Service** button; it creates a model-provider configuration.

### Where is the “MCP Tools” page?

The current UI calls them **Connectors**. Open **Toolbox → Connectors**. MCP is the protocol used by those connectors.

### Do ordinary web tasks require the Chrome extension?

No. Ordinary browsing uses the **Abu Built-in Browser**. Connect **My Chrome** only when you need existing tabs, cookies, extensions, or signed-in state.

### Where are API keys stored?

API keys use operating-system secure storage on this device and are not written as plaintext into normal application data. You may need to enter them again after hardware or operating-system migration. **Settings → Models** includes an action to clear all stored keys.

Model requests send the necessary conversation content and API key directly to the provider you configured. This does not make every task fully offline. Review the privacy policy of your provider.

### Does Abu automatically upload my files?

Abu does not upload an entire workspace to an Abu-owned server by default. Text, images, or tool results needed for a task may be sent to the model provider or external connector you configured. Diagnostic and feedback uploads require an explicit submission. Use trusted providers and restrict workspace and connector scope for sensitive work.

### Why did a scheduled task not run?

Confirm that Abu is running, the computer is awake, the task is enabled, and a model is available. Then inspect **Automation → Scheduled Tasks → Run History**. Dangerous steps that need approval are skipped in unattended runs.

### What should I check when a model or connector cannot connect?

Check the API key, billing mode, model ID, base URL, command arguments, and network, then run **Settings → Diagnostics**. For a custom endpoint, also confirm that its API format matches the configuration.

### How do I switch language and theme?

Open **Settings → Preferences**. Choose Simplified Chinese, English, or Follow System, and select Light, Dark, or Follow System theme.

---

If the issue remains, file a reproducible report in [GitHub Issues](https://github.com/PM-Shawn/Abu-Cowork/issues). Do not publish API keys, access tokens, internal addresses, or diagnostic material containing confidential information.
