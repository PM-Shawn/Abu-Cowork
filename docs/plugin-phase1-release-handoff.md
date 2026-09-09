# Plugin phase 1 — release handoff

This feature is intended to ship with the next combined Abu release. It does not require a separate version bump, release tag, or update feed.

## Included scope

- Create a local plugin through the built-in authoring skill without creating a marketplace first.
- Manage authored drafts and installed plugins in My plugins: validate, preview, install, enable, try, edit, check for changes, update, and uninstall while retaining editable source.
- Keep installation confirmation bound to an immutable snapshot. Serialize installation registry changes and recover interrupted operations before activating plugins.
- Store user-provided MCP configuration in the system credential store, separately from editable source and shared packages.
- Preserve plugin ownership and parent enablement across skills, agents, MCP connections, updates, and restarts.
- Finish the existing marketplace flow and use the shared extension card, detail, switch, and primary-action patterns.

Manual folder/ZIP import, uploads, archive export, sharing, and public distribution are deferred. Do not add those capabilities to release claims.

## Acceptance before the combined release

The feature has been exercised in development Electron on macOS. The combined release candidate must additionally pass the following checks on its final integration commit:

- [ ] Required PR and integration checks, including full Electron E2E, pass.
- [ ] The packaged app includes `abu-plugin-builder`, the plugin host workers/shared parser, and the `yaml` runtime dependency.
- [ ] In the packaged app, create a plugin, preview and install it, edit it, confirm an update, restart, and uninstall it; editable source remains available.
- [ ] Exercise a configured MCP plugin in the packaged app, including disabled-state preservation and credential persistence after restart.
- [ ] Repeat the plugin installation/update/recovery paths on Windows, including paths containing spaces and non-ASCII characters.
- [ ] Run the repository's normal release-candidate, signing, installation, and updater checks for the combined release.

Developer tests use fixture-generated plugin source; they verify UI and runtime behavior, not the quality of arbitrary model-generated plugins. The authoring prompt and revision loop also need human acceptance with the release's supported models.

## Release-note copy

### 中文

- 新增本地插件创建与管理：无需先建立插件市场，即可通过对话创建插件，校验安装后启停和试用；修改后可检查并确认更新，卸载保留创作源码。
- 完善插件安装与更新恢复、MCP 配置存储和能力归属；统一插件、技能与连接器的列表及详情交互。

### English

- Create and manage local plugins through a conversation without setting up a marketplace. Validate and install a plugin, enable and try it, and review updates after editing. Uninstalling retains editable source.
- Improve plugin installation and update recovery, MCP configuration storage, and capability ownership. Align plugin, skill, and connector list and detail interactions.

See [the plugin user guide](../PLUGINS.zh-CN.md) for supported formats, authoring steps, and recovery behavior.
