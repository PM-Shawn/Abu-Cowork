---
name: abu-plugin-builder
description: Create or edit a local Abu plugin or app in its dedicated creation conversation. Generate the package, then validate with plugin_prepare for user-reviewed installation.
---

First clarify the workflow and the smallest useful set of skills, connectors or agents. Creating a plugin does not require a marketplace. When the user wants an app (a home page with scenes, its own navigation, a fixed team behind it), follow the "Apps" section below as well.

Work only inside the current creation workspace. Never write to ~/.abu/plugin-packages, plugin-authors, plugin-operations or activation settings. Source edits do not change the installed version. Never install, enable or publish the plugin yourself.

Create `.abu-plugin/plugin.json` with a stable lowercase hyphenated `name`, `version` and a short `description`. Keep the name unchanged on edits. Skills go in `skills/<name>/SKILL.md`, with YAML name and description and Markdown instructions. Agents go in `agents/<name>.md` with YAML name/description and a nonempty system prompt; use unique names that do not shadow existing agents. Hooks and commands are not supported.

For a connector, declare `mcpServers` in the manifest or `.mcp.json`. Use stdio `command`, `args`, and `env`, or a supported HTTP URL. Never request credentials in chat, write them in source, invent secrets or copy credentials from another connector. For required credentials in env or headers, use `${config.API_TOKEN}` placeholders (variable names: letters, digits, underscore). Abu renders these as secure fields in the installation preview. Do not use configuration placeholders in commands, arguments or URLs. Explain required user configuration. Do not run connector commands while generating or validating.

Before the first `plugin_prepare` call, state the exact package `name` you are about to use and tell the user it cannot be changed afterwards (it becomes the install key, package path and marketplace identity). Wait for the user's confirmation, then proceed. On later edits never propose a rename.

After writing files and obtaining that confirmation, call `plugin_prepare` with no arguments. Fix validation errors and repeat. Report the supported components and any unsupported parts. Tell the user to open Extensions → Plugins → Mine to preview and confirm installation/update. If the tool says this is not a plugin-creation conversation, ask the user to use Add → Create plugin; do not change author records or pass arbitrary paths.

## Apps

An app is a plugin whose manifest carries an `app` field. Before writing one, settle four things with the user, one question at a time and only where the answer is missing: who the app is for; which groups of scenes it offers (these become modes and scenes); who handles each scene — a team, one expert or one skill; which connectors and web pages it needs. Offer a complete draft (modes, scenes, who runs each, the app prompt) and continue once the user agrees or tells you to decide.

Then write the package: `app` in `.abu-plugin/plugin.json`, `teams/<id>.json` for teams the package ships, `skills/` and `agents/` for anything a scene references, and `minAbuVersion` (required whenever `app` or `teams/` is present). Read `references/app-config.md` for every `app` field and two complete examples, `references/teams.md` for the team file, and `references/builtin-catalog.md` for the exact names of Abu's built-in experts and the ids of its built-in teams; open them with `read_skill_file` before writing. Prefer a built-in team from that catalog when its roster fits; write a package team only when the app needs its own experts. Give every scene 3–6 templates whose prompts a user can send as they are. When a navigation item uses `url:`, list every origin in `allowedOrigins`. Set `interface.displayName` and `interface.shortDescription`; do not generate logo images unless the user provides them.

`plugin_prepare` returns the validated `teams` and `app` (modes, scenes, who runs each, navigation, pages, required connectors) so you can read back what the user will see. A validation error names the field, for example `app.home.modes.items[0].scenes[0].run`; correct that field and call again. Once installed, the app appears in the app switcher and the user enters it from there.

When editing, always call `plugin_prepare` again after the final file change. Explain its status plainly: `update-available` means source changes are ready, but the running plugin is still the old version; direct the user to Extensions → Plugins → Mine → this plugin → Preview update → Update. `unchanged` means no update is needed. Never describe saved source as an installed update. Keep the final response short and tell the user the next UI action.
