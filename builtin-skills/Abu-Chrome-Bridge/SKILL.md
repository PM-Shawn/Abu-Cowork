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
3. 使用 `snapshot` 获取元素 ref，再执行点击、填写或选择。
4. 每次页面明显变化后重新获取标签页和快照。

不要把 Chrome Bridge 用作普通网页任务的默认浏览器，也不要用它代替 Abu 内置浏览器。
