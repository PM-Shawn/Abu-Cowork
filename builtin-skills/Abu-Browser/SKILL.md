---
name: Abu-Browser
description: 操作用户真实的 Chrome 浏览器：点击、填写、截图、提取数据。当用户要求查看网页内容、抓取页面数据、填写表单、网页截图或浏览器自动化时使用此技能。
trigger: 用户要求操作浏览器、查看或抓取网页内容、网页截图、填写网页表单、点击网页按钮、浏览器自动化、从浏览器中提取数据
do-not-trigger: 用户要求用 Playwright 做自动化测试、讨论浏览器技术原理、只是提到"浏览器"一词但无实际操作需求
user-invocable: true
context: inline
tags:
  - browser
  - automation
  - chrome
---

# Abu-Browser — 浏览器操作技能

## 环境自检（每次激活必做，按顺序执行）

### 当前桥接状态

!`curl -s --max-time 2 http://127.0.0.1:9875/status 2>/dev/null || echo '{"bridge":"offline"}'`

根据上面的返回结果判断当前状态，按以下逻辑执行：

### Step 1：确保浏览器桥接服务运行

- 如果返回中包含 `"bridge":"offline"` 或返回为空 → 调用 `manage_mcp_server(action: "ensure", name: "abu-browser-bridge")`
  - 返回 `connected` 或 `reconnected`：继续 Step 2
  - 返回 `needs_config`：告诉用户缺少配置（一般不会出现）
  - 返回 `install_failed`：告诉用户安装失败，可能需要检查网络或 Node.js 环境
- 如果返回中有 `wsPort` 字段 → 桥接服务已在运行，继续 Step 2

### Step 2：检查 Chrome 扩展连接

- 如果 Step 1 的返回或 `!`command`` 输出中 `extensionConnected: true` → 环境就绪，跳到「执行用户任务」
- 如果 `extensionConnected: false` → 执行扩展安装引导：

#### 扩展安装引导

Abu 安装目录中内置了 Chrome 扩展文件。严格按以下步骤执行：

1. 用 run_command 打开内置扩展目录（路径从 manage_mcp_server 返回值中的 `extensionPath` 行获取）
2. 告诉用户（**必须使用以下话术，不要自由发挥**）：

---
我帮你打开了插件文件夹，三步搞定：

1. Chrome 地址栏输入 `chrome://extensions` 回车
2. 打开右上角「开发者模式」开关
3. 把刚才打开的文件夹**拖到**这个页面上，松手即可
---

3. 等用户确认安装完成后，再次检查连接状态

**禁止事项**：
- ❌ 不要提「加载已解压的扩展程序」按钮——拖拽更简单
- ❌ 不要说"MCP"、"WebSocket"、"bridge"等技术术语
- ✅ 如果用户之前安装过但扩展掉线了，提示可能是 Chrome 重启导致的，建议刷新扩展页面

### Step 3：确认就绪

前两步都通过后，简短告诉用户"已连接到你的浏览器"，然后立即执行用户的原始请求。不要等用户再说一遍。

---

## 操作指南

根据任务复杂度，决定是否需要加载参考文档：

**简单任务**（截图、读取文字、单次点击）→ 用下方快速参考直接执行，不加载文件
**中等任务**（表单填写、多步交互）→ `read_skill_file("guide-form-filling.md")`
**复杂任务**（批量抓取、跨页操作）→ `read_skill_file("guide-scraping.md")`
**自动化任务**（录制回放、定时执行）→ `read_skill_file("guide-rpa.md")`

**Available reference files** (use `read_skill_file` tool to load when needed):
- guide-basics.md — 截图、读取页面、简单交互的详细指南
- guide-form-filling.md — 表单填写、登录、多步流程
- guide-scraping.md — 数据抓取、分页翻页、批量导出
- guide-rpa.md — 录制回放、长流程自动化、错误恢复
- guide-cross-tab.md — 跨标签页数据搬运

---

## 快速参考

### 基本流程
1. 调用 `abu-browser-bridge__get_tabs` 获取所有标签页
2. 关注 `focused: true` 的标签页——那是用户正在看的
3. 用 `snapshot` 获取页面结构和元素 ref 编号
4. 用 ref/css/text 定位元素进行后续操作

### 参数注意
- `tabId` 必须传数字（如 `1203797111`），**不能加引号**
- 每次操作前重新调用 `get_tabs` 获取最新状态，不要复用旧数据

### 常用操作模式
- **读取内容**：`get_tabs` → `extract_text` / `extract_table` / `snapshot`
- **交互操作**：`get_tabs` → `snapshot`（拿到 ref）→ `click` / `fill` / `select`
- **截图**：`get_tabs` → `screenshot`（可视区域）/ `screenshot_full_page`（整页）
- **等待加载**：操作后用 `wait_for` 等待页面变化再继续下一步

### 安全原则
- 涉及支付、删除、提交等不可逆操作前，先 `screenshot` 让用户确认
- 不要在用户未授权的页面上输入敏感信息（密码、银行卡等）
- 发消息、发邮件前先截图让用户确认内容

### 失败恢复
- 元素找不到 → 重新 `snapshot`，页面可能已变化
- 点击没反应 → 尝试用 `keyboard` 快捷键替代
- 输入框问题 → 先 `click` 确认焦点再 `fill`
- 页面未加载 → `wait_for` 设置更长超时

### 工具选择
- 优先使用 `abu-browser-bridge__` 开头的工具操作用户真实浏览器
- **不要**使用 `playwright__` 工具——那会启动一个全新的空白浏览器，不是用户正在用的
