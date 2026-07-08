# abu-browser-bridge vs Playwright 原理对比

## Playwright

- 直接通过 **CDP（Chrome DevTools Protocol）** 与浏览器进程通信
- **启动并控制一个独立的浏览器实例**（headless 或 headed）
- 不需要安装任何浏览器扩展
- 通信链路：`Playwright → CDP WebSocket → Browser Process`
- 拥有浏览器的完全控制权（网络拦截、多 tab/context 隔离、浏览器生命周期管理等）

## abu-browser-bridge

- 通过 **Chrome Extension + 自定义 WebSocket** 协议与**用户已打开的浏览器**通信
- 通信链路：`MCP Server → WebSocket(:9876) → Extension Service Worker → Content Script → DOM`
- **不控制浏览器进程本身**，而是作为"外挂"注入到用户正在使用的浏览器中
- 依赖 Chrome Extension API（`chrome.scripting.executeScript`、`chrome.tabs.sendMessage` 等）操作 DOM

## 关键差异总结

| 维度 | Playwright | abu-browser-bridge |
|------|-----------|-------------------|
| 协议 | CDP (DevTools Protocol) | 自定义 WebSocket + Chrome Extension API |
| 浏览器 | 启动新实例，完全受控 | 连接用户已有浏览器，通过扩展协作 |
| 安装 | 无需扩展 | 需要安装 Chrome Extension |
| 登录态 | 需要自行处理 | **天然复用用户的登录态和 Cookie** |
| 控制深度 | 极深（网络层、协议层） | DOM 层为主 |
| 典型用途 | 自动化测试、爬虫 | AI 助手操控用户真实浏览器 |

## 为什么 abu-browser-bridge 不用 CDP？

abu-browser-bridge 的设计目标是**让 AI 操作用户正在使用的浏览器**——复用用户的登录态、Cookie、已打开的页面。而 Playwright/CDP 模式会启动一个"干净"的浏览器实例，无法直接访问用户的真实浏览环境。

用 Chrome Extension 作为中间层，虽然控制能力不如 CDP 深，但换来了**对用户真实浏览器会话的无缝接入**，这对 AI 助手场景更实用。

## abu-browser-bridge 架构详解

### 三大组件

1. **abu-browser-bridge**（Node.js MCP Server）— 桥接进程
2. **abu-chrome-extension**（Chrome Extension）— 浏览器端代理
3. **abu-browser-shared**（共享类型）— 通信协议定义

### 通信协议

#### WebSocket 连接（端口 9876）

- 传输：原始 TCP WebSocket `ws://127.0.0.1:9876`
- 认证：基于 Token，通过 `Sec-WebSocket-Protocol` header 传递
  - Bridge 启动时生成随机 48 字节 hex token
  - Chrome Extension 通过 HTTP 端点（端口 9875）发现 token
  - 连接握手时验证 token
- 心跳：15 秒 ping/pong 检测死连接
- 单连接：同一时间只允许一个扩展连接

#### HTTP 发现端点（端口 9875）

- 固定端口 9875 上的轻量 HTTP 服务
- CORS 限制为 `chrome-extension://` 来源
- 返回 JSON：`{ wsPort, pid, extensionConnected, uptime, version, token }`

#### 消息格式

```typescript
// Bridge → Extension
interface BridgeRequest {
  id: string;              // 每个请求的唯一 ID
  action: string;          // 动作名称（如 "click", "snapshot"）
  payload: Record<string, unknown>;
}

// Extension → Bridge
interface BridgeResponse {
  id: string;              // 与请求 ID 对应
  success: boolean;
  data?: unknown;
  error?: string;
}
```

### 浏览器通信分层

| 层级 | 通信方式 |
|------|---------|
| Service Worker ↔ MCP Server | WebSocket |
| Service Worker ↔ Content Script | `chrome.tabs.sendMessage()` |
| Content Script → DOM | 直接 DOM 操作 |

### 支持的 17 个工具

**Tab 管理**：`get_tabs`、`screenshot`、`navigate`、`get_downloads`

**DOM 查询与观察**：`snapshot`、`extract_text`、`extract_table`、`wait_for`

**DOM 交互**：`click`、`fill`、`select`、`scroll`、`keyboard`

**高级操作**：`execute_js`、`start_recording`、`stop_recording`、`connection_status`

### 元素定位策略

支持多种定位方式：

```typescript
{ "css": "#button-id" }                        // CSS 选择器
{ "text": "Click Me" }                         // 可见文本
{ "role": "button", "name": "Submit" }         // ARIA role + label
{ "testId": "submit-btn" }                     // data-testid 属性
{ "ref": "e3" }                                // snapshot 返回的引用 ID
{ "xpath": "//div[@class='x']" }               // XPath（备选）
```

### 安全特性

1. **Auth Token** — 每次启动随机生成，防止未授权连接
2. **CORS 限制** — 发现端点仅接受 `chrome-extension://` 来源
3. **URL 校验** — `navigate` 仅接受 `http:` / `https:` 协议
4. **CSP 绕过** — 通过 `chrome.scripting.executeScript({ world: 'MAIN' })` 执行
5. **选择器注入防护** — CSS 选择器使用 `CSS.escape()` 转义

### 数据流示例

```
用户请求 "点击提交按钮"
  ↓
MCP tool: click({ tabId: 5, locator: { "text": "提交" } })
  ↓
Bridge 通过 WS 发送 BridgeRequest
  ↓
Service Worker 接收，调用 sendToContentScript()
  ↓
Content Script 定位元素，触发 mousedown/mouseup/click 事件
  ↓
Content Script 返回结果
  ↓
Service Worker 通过 WS 返回 BridgeResponse
  ↓
Bridge 将结果返回给 AI
```
