---
name: Abu-Chrome-Bridge
description: 通过 Abu Chrome 扩展操作用户现有的 Chrome 标签页、登录态和浏览器资料。仅在用户明确要求使用 Chrome、已有标签页或现有登录状态时使用。
trigger: 用户明确要求操作 Chrome、现有 Chrome 标签页、Chrome 登录态、Chrome Cookie 或 Abu Chrome 扩展
do-not-trigger: 用户只要求打开普通网页、在阿布内预览网页或截图；这些场景使用 Abu-Browser
user-invocable: true
context: inline
tags:
  - browser
  - chrome
  - extension
---

# Abu-Chrome-Bridge

这个技能连接用户已经在使用的 Chrome，不代表 Abu 内置浏览器。

## 连接

1. 先调用 `manage_mcp_server(action: "ensure", name: "abu-browser-bridge")`，让阿布检查内置连接组件。不要向用户解释 MCP、启动命令或安装包。
2. 如果返回结果说明用户已关闭该能力或需要设置，立即调用 `manage_mcp_server(action: "open_setup", name: "abu-browser-bridge")`，暂停当前浏览器动作，并等待用户在引导页明确点击“连接 Chrome”。不要自行重新开启。
3. 连接组件就绪后，调用 `abu-browser-bridge__connection_status` 确认 Chrome 扩展是否就绪；如果扩展未连接，同样打开“我的 Chrome”安装引导并暂停。
4. 用户确认完成后再次检查连接；连接成功就从原任务中断处继续，不要让用户重新描述需求。

## 操作

1. `abu-browser-bridge__get_tabs` 获取用户现有标签页。
2. 优先选择 `focused`、`active` 或 `isCurrentTab` 对应的标签页。
3. 使用 `snapshot` 获取元素 ref 与 id，再执行点击、填写或选择。
4. 页面明显变化后重新快照；已持有的 ref 只要元素还在页面上就依然有效，不必因为重新快照而丢弃。

## 表单与下拉

- **填写**用 `fill`，定位优先用快照给出的 `ref`，需要跨页面刷新时用 `id`（快照会返回 `#form_item_xxx` 这类 id）。
- **下拉一律用 `select`，一次调用搞定**：定位到下拉控件本身、把选项文字作为 `value` 传进去即可。**不要先点开下拉**，也不要自己去点选项——`select` 会自己打开、找到（必要时滚动长列表）、点中、关闭。原生 `<select>` 和 antd / Element Plus / Arco 的自定义下拉都支持。
- 选项名写错时，`select` 的报错里会列出该下拉**实际可选的全部选项**——照着重试一次即可，不要改用脚本。
- 快照提示被截断时，按提示用 `selector` 收窄到当前表单，或调大 `maxChars`。

## 不要用 execute_js 绕路

`execute_js` 是最后手段，**每次执行都会打断用户单独授权**，而且拥有页面的全部权限。动手写脚本之前先确认标准工具真的做不到：读页面用 `snapshot` / `extract_text` / `extract_table`，等待用 `wait_for`（超时会说明页面当前的实际状态），选下拉用 `select`。工具报错时先读错误信息——它通常已经写明下一步该怎么做。

不要把 Chrome Bridge 用作普通网页任务的默认浏览器，也不要用它代替 Abu 内置浏览器。

## 确认操作结果，也不要用脚本

提交、保存这类操作之后要确认结果时：先 `wait_for`（等成功提示出现、或等 URL 变化），再 `extract_text` 读页面文字。**不要写脚本去挂 `fetch`、翻 `.ant-message`、查 DOM**——那样每查一次就打断用户一次。页面如果确实没有任何反馈，如实告诉用户"没有看到成功提示"，不要反复探测。
