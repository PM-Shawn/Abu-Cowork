---
name: Abu-Browser
description: 操作阿布应用内置的可见浏览器：打开网页、点击、填写、截图和提取数据。用户要求在阿布内预览或操作网页时使用；无需安装浏览器扩展。
trigger: 用户要求使用阿布内置浏览器、在阿布内打开网页、查看网页内容、网页截图、填写网页表单、点击网页按钮或提取网页数据
do-not-trigger: 用户明确要求操作已有 Chrome 标签页、复用 Chrome 登录态或使用 Abu Chrome 扩展；这些场景使用 Abu-Chrome-Bridge
user-invocable: true
context: inline
tags:
  - browser
  - automation
  - electron
---

# Abu-Browser

这是 Abu 随 Electron 客户端提供的内置浏览器。它会在 Abu 工作区中创建可见标签页，用户可以观察、接管或关闭。

## Choosing and opening tabs

- A top-level approved click or key press may open one same-origin native tab. Call `abu-browser__list_tabs` after a popup-producing action and use the returned tab IDs; retain the source page. Cross-origin/high-risk or delayed popups are blocked and need separate approval. Never recreate a rejected form POST with `navigate`, scripts, or a GET request.
- Use `abu-browser__close_tab` only for unused background tabs created by this run. Keep comparison pages and deliverables open. If it returns `requires_user_action`, leave the page for the user; if `closing`, do not retry or force-close. Never bypass a refusal with scripts or other tools.
- Start with `abu-browser__list_tabs` to discover existing task tabs without creating a page. Select targets by their returned URL, title and tabId; never guess IDs.
- Use `abu-browser__create_tab({ url })` for a new HTTP(S) page the user should keep separately. For a comparison of two pages, create one tab for each and retain both for the user to inspect. Do not navigate the first article to the second article's URL.
- Use `abu-browser__navigate({ tabId, url })` when intentionally continuing navigation in an existing tab, such as refining a search. Reuse an already-open matching page instead of creating duplicates.
- `get_tabs` remains a compatibility entry that creates a blank tab if none exists. Prefer the explicit list/create tools for new work.
- Observe with `snapshot` before interacting; re-observe after navigation or a significant page change. Wait for relevant content with `wait_for` before extracting or taking a screenshot.
- Never substitute OS launch commands, Computer Use, Chrome or another browser for an unavailable built-in browser.

For locator, screenshot and extraction examples, read [guide-basics.md](guide-basics.md).

## 表单与下拉

- **下拉一律用 `select`，一次调用搞定**：定位到下拉控件本身、把选项文字作为 `value` 传进去。**不要先点开下拉**，也不要自己去点选项——`select` 会自己打开、找到、点中、关闭。原生 `<select>` 和 antd / Element Plus / Arco 的自定义下拉都支持；选项名写错时报错会列出实际可选项，照着重试即可。
- `execute_js` 是最后手段，拥有页面的全部权限。读页面用 `snapshot` / `extract_text` / `extract_table`，等待用 `wait_for`，选下拉用 `select`；工具报错时先读错误信息，它通常已写明下一步。

## 安全

- 支付、删除、提交、发送等不可逆操作前先截图并获得用户确认。
- 不在用户未授权的页面输入密码、银行卡等敏感信息。
- 如果 `abu-browser__` 工具不可用，明确说明内置浏览器当前没有准备好；不要静默切换到 Chrome、Computer Use 或系统浏览器。

## 确认操作结果，也不要用脚本

提交、保存这类操作之后要确认结果时：先 `wait_for`（等成功提示出现、或等 URL 变化），再 `extract_text` 读页面文字。**不要写脚本去挂 `fetch`、翻 `.ant-message`、查 DOM**——那样每查一次就打断用户一次。页面如果确实没有任何反馈，如实告诉用户"没有看到成功提示"，不要反复探测。

Before a child task finishes, use `abu-browser__retain_tab({ tabId })` for each result or handoff page the user should keep. The host moves retained pages to the conversation; unused background pages may close safely. Never retry browser work after the child task has ended.

## Embedded forms and control handback

Use snapshot's native `frames` list. Pass explicit `frameId` for region observations, locators (including qualified refs), and waits. Cross-origin regions need their own approval. After navigation, frame replacement or handback, observe again and discard old IDs.

While the user has control, stop tools and preserve their page. After cancellation or batch failure, inspect results; never replay writes automatically. Use approved `upload_file` inputs, not native pickers under automation. See guide-basics.md for details.
