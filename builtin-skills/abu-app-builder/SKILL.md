---
name: abu-app-builder
description: Create an Abu app in its app-creation conversation — a home page with scenes, each handed to an expert or an expert team. Write the draft in the conversation folder, validate it with app_prepare, and let the user confirm the preview card.
---

Work only inside the current conversation folder. The draft is `.abu-app/app.json`, plus `agents/<name>.md` for experts the app needs that do not exist yet and `teams/<id>.json` for new expert teams. Never write to ~/.abu, never create experts or teams with other tools, and never add the app yourself: nothing is created until the user confirms the preview card.

Before writing anything, call `app_prepare` with no arguments. It returns `yours`: the experts (by name) and expert teams (by id and name) the user already has.

Settle three things with the user, one question at a time and only where the answer is missing: who the app is for; which groups of scenes it offers (these become modes and scenes); who handles each scene. Offer a complete draft (modes, scenes, who handles each, the app prompt) and continue once the user agrees or tells you to decide.

Who handles a scene, in this order of preference:

1. An expert or team the user already has, from `yours`: `{ "expert": "mine:<name>" }`, `{ "team": "mine:<team id>" }`.
2. One of Abu's built-in experts or teams: `{ "expert": "builtin:<name>" }`, `{ "team": "builtin-team:<id>" }`, names and ids in `references/builtin-catalog.md`.
3. An expert, team or skill of a plugin the user has installed: `plugin:<plugin>/<id>`, with the plugin listed in `plugins`.
4. Only when none of these fits, a new expert or team in the draft. A new expert is `agents/<name>.md` with YAML `name` and `description` and a nonempty system prompt; its name must not be taken. A new team is `teams/<id>.json`; its members are the draft's new experts (by name) and built-in experts (`builtin:<name>`). Reference them as `mine:<name>` and `mine:<id>`.

Read `references/app-config.md` for every field of the app file and a complete example, `references/teams.md` for the team file, and `references/builtin-catalog.md` for the built-in names; open them with `read_skill_file` before writing. Give every scene 3–6 templates whose prompts a user can send as they are. The app `name` is lowercase and hyphenated; `minAbuVersion` is `0.51.0`. Set `interface.displayName` and `interface.shortDescription`; do not generate logo images unless the user provides them. When a navigation item uses `url:`, list every origin in `allowedOrigins`.

After writing, call `app_prepare` again. A validation error names the field, for example `home.modes.items[0].scenes[0].run.team`; correct that field and call again. When it returns `status: "ready"`, the preview card appears below your message: tell the user they can confirm it to add the app, or say what to change. After every change, call `app_prepare` again so the card shows the current draft.

Once the user confirms, the app appears in the app switcher and Abu opens its home page; new experts and teams appear under Experts → Mine. The app of this conversation cannot be changed here afterwards, and `app_prepare` says so; tell the user plainly. If `app_prepare` says this is not an app-creation conversation, ask the user to start one from the app switcher → Create app. Keep the final response short.
