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

## 执行原则

1. 直接调用 `abu-browser__get_tabs`。没有标签页时，该调用会在 Abu 内创建一个可见空白标签。
2. 使用返回的当前 `tabId` 调用 `abu-browser__navigate` 打开目标网址。
3. 需要交互时先调用 `abu-browser__snapshot`，再根据元素 ref 点击或填写。
4. 用户要求截图时，完成导航并等待页面稳定后调用 `abu-browser__screenshot` 或 `abu-browser__screenshot_full_page`。
5. 不要运行 macOS `open`、Windows `start`，也不要用 `computer` 或外部系统浏览器代替。

## 常用流程

- 打开网页：`get_tabs` -> `navigate`
- 截图：`get_tabs` -> `navigate` -> `wait_for` -> `screenshot`
- 页面交互：`get_tabs` -> `snapshot` -> `click` / `fill` / `select`
- 提取内容：`get_tabs` -> `extract_text` / `extract_table`

每次页面发生明显变化后重新获取 `snapshot`，不要长期复用旧元素 ref。

## 安全

- 支付、删除、提交、发送等不可逆操作前先截图并获得用户确认。
- 不在用户未授权的页面输入密码、银行卡等敏感信息。
- 如果 `abu-browser__` 工具不可用，明确说明内置浏览器当前没有准备好；不要静默切换到 Chrome、Computer Use 或系统浏览器。
