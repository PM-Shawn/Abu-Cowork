---
name: abu-plugin-builder
description: Create or edit a local Abu plugin in its dedicated creation conversation. Generate the package, then validate with plugin_prepare for user-reviewed installation.
---

First clarify the workflow and the smallest useful set of skills, connectors or agents. Creating a plugin does not require a marketplace.

Work only inside the current creation workspace. Never write to ~/.abu/plugin-packages, plugin-authors, plugin-operations or activation settings. Source edits do not change the installed version. Never install, enable or publish the plugin yourself.

Create `.abu-plugin/plugin.json` with a stable lowercase hyphenated `name`, `version` and a short `description`. Keep the name unchanged on edits. Skills go in `skills/<name>/SKILL.md`, with YAML name and description and Markdown instructions. Agents go in `agents/<name>.md` with YAML name/description and a nonempty system prompt; use unique names that do not shadow existing agents. Hooks and commands are not supported.

For a connector, declare `mcpServers` in the manifest or `.mcp.json`. Use stdio `command`, `args`, and `env`, or a supported HTTP URL. Never request credentials in chat, write them in source, invent secrets or copy credentials from another connector. For required credentials in env or headers, use `${config.API_TOKEN}` placeholders (variable names: letters, digits, underscore). Abu renders these as secure fields in the installation preview. Do not use configuration placeholders in commands, arguments or URLs. Explain required user configuration. Do not run connector commands while generating or validating.

Before the first `plugin_prepare` call, state the exact package `name` you are about to use and tell the user it cannot be changed afterwards (it becomes the install key, package path and marketplace identity). Wait for the user's confirmation, then proceed. On later edits never propose a rename.

After writing files and obtaining that confirmation, call `plugin_prepare` with no arguments. Fix validation errors and repeat. Report the supported components and any unsupported parts. Tell the user to open Extensions → Plugins → Mine to preview and confirm installation/update. If the tool says this is not a plugin-creation conversation, ask the user to use Add → Create plugin; do not change author records or pass arbitrary paths.

When editing, always call `plugin_prepare` again after the final file change. Explain its status plainly: `update-available` means source changes are ready, but the running plugin is still the old version; direct the user to Extensions → Plugins → Mine → this plugin → Preview update → Update. `unchanged` means no update is needed. Never describe saved source as an installed update. Keep the final response short and tell the user the next UI action.
