# 浏览器基础操作指南

当快速参考不够用时，加载此文档获取更详细的操作说明。

## 截图

### 可视区域截图
```
abu-browser-bridge__screenshot({ tabId: <number> })
```
- 返回当前可视区域的截图（base64 PNG）
- 适合快速查看页面状态、让用户确认操作

### 整页截图
```
abu-browser-bridge__screenshot_full_page({ tabId: <number> })
```
- 自动滚动拼接，适合长页面
- 耗时较长（每屏约 600ms），大页面可能需要数秒
- 截图过程中会临时隐藏 fixed/sticky 元素避免重复

## 读取页面内容

### 提取文本
```
abu-browser-bridge__extract_text({ tabId: <number> })
abu-browser-bridge__extract_text({ tabId: <number>, locator: { css: ".article-body" } })
```
- 不指定 locator：提取整页文本
- 指定 locator：只提取匹配元素的文本
- 适合文章、段落等纯文本内容

### 提取表格
```
abu-browser-bridge__extract_table({ tabId: <number> })
abu-browser-bridge__extract_table({ tabId: <number>, locator: { css: "table.data" }, format: "markdown" })
```
- 自动识别页面中的 HTML `<table>` 元素
- `format` 支持 `"array"`（默认，嵌套数组）和 `"markdown"`
- 如果页面有多个表格，用 locator 指定目标表格

### 页面快照（交互元素树）
```
abu-browser-bridge__snapshot({ tabId: <number> })
```
- 返回页面所有可交互元素的树状结构
- 每个元素有唯一 ref 编号（如 `e1`, `e2`, `e3`）
- ref 编号在后续 click/fill/select 中使用
- 包含元素类型、文本、属性等信息

## 交互操作

### 点击
```
abu-browser-bridge__click({ tabId: <number>, locator: { ref: "e3" } })
abu-browser-bridge__click({ tabId: <number>, locator: { text: "提交" } })
abu-browser-bridge__click({ tabId: <number>, locator: { css: "#submit-btn" } })
```
定位策略优先级：
1. `ref` — 从 snapshot 获取，最精确
2. `text` — 按可见文本匹配
3. `css` — CSS 选择器
4. `role` + `name` — ARIA 角色
5. `testId` — data-testid 属性
6. `xpath` — 兜底方案

### 填写输入框
```
abu-browser-bridge__fill({ tabId: <number>, locator: { ref: "e5" }, value: "hello@example.com" })
```
- 自动清空原有内容再填写
- 自动触发 input/change 事件
- 如果填写不生效，先 click 确认焦点

### 选择下拉菜单
```
abu-browser-bridge__select({ tabId: <number>, locator: { ref: "e7" }, value: "option_value" })
```
- `value` 是 `<option>` 的 value 属性值

### 键盘操作
```
abu-browser-bridge__keyboard({ tabId: <number>, key: "Enter" })
abu-browser-bridge__keyboard({ tabId: <number>, key: "a", modifiers: ["Control"] })
```
- 支持修饰键组合：Control, Shift, Alt, Meta
- 常用：Enter（确认）、Tab（切换焦点）、Escape（关闭弹窗）

### 滚动
```
abu-browser-bridge__scroll({ tabId: <number>, direction: "down" })
abu-browser-bridge__scroll({ tabId: <number>, direction: "down", amount: 500 })
abu-browser-bridge__scroll({ tabId: <number>, locator: { css: ".scroll-container" }, direction: "down" })
```
- direction: `up`, `down`, `left`, `right`
- 不指定 locator 时滚动整个页面

## 等待页面变化
```
abu-browser-bridge__wait_for({ tabId: <number>, condition: { type: "element", locator: { css: ".result" } } })
abu-browser-bridge__wait_for({ tabId: <number>, condition: { type: "text", text: "加载完成" } })
abu-browser-bridge__wait_for({ tabId: <number>, condition: { type: "url", pattern: "/success" } })
```
- `type: "element"` — 等待元素出现
- `type: "element_gone"` — 等待元素消失（如 loading spinner）
- `type: "text"` — 等待页面出现指定文本
- `type: "url"` — 等待 URL 变化匹配 pattern
- 默认超时 30 秒

## 导航
```
abu-browser-bridge__navigate({ tabId: <number>, url: "https://example.com" })
abu-browser-bridge__navigate({ tabId: <number>, action: "back" })
abu-browser-bridge__navigate({ tabId: <number>, action: "forward" })
abu-browser-bridge__navigate({ tabId: <number>, action: "reload" })
```

## 执行 JavaScript
```
abu-browser-bridge__execute_js({ tabId: <number>, code: "document.title" })
```
- 在页面上下文中执行任意 JS
- 返回执行结果
- 谨慎使用，优先用其他专用工具

## 常见操作组合

### 读取页面数据并导出
1. `get_tabs` → 找到目标标签页
2. `extract_table` → 提取表格数据
3. 将数据写入文件（CSV/Excel）

### 填写并提交表单
1. `get_tabs` → 找到目标标签页
2. `snapshot` → 获取表单元素 ref
3. `fill` 逐个填写字段
4. `screenshot` → 让用户确认
5. `click` 提交按钮
6. `wait_for` → 等待提交结果

### 登录流程
1. `navigate` → 跳转登录页
2. `snapshot` → 获取用户名/密码输入框 ref
3. `fill` 用户名 → `fill` 密码
4. `click` 登录按钮
5. `wait_for` URL 变化或元素出现确认登录成功
