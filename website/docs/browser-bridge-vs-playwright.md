# abu-browser-bridge vs Playwright: Architecture Comparison

## Playwright

- Communicates with the browser process directly via **CDP (Chrome DevTools Protocol)**
- **Launches and controls an independent browser instance** (headless or headed)
- Requires no browser extension installation
- Communication chain: `Playwright → CDP WebSocket → Browser Process`
- Has full control over the browser (network interception, multi-tab/context isolation, browser lifecycle management, etc.)

## abu-browser-bridge

- Communicates with the **user's already-open browser** via a **Chrome Extension + custom WebSocket** protocol
- Communication chain: `MCP Server → WebSocket(:9876) → Extension Service Worker → Content Script → DOM`
- **Does not control the browser process itself** — instead acts as an "add-on" injected into the browser the user is actively using
- Relies on Chrome Extension APIs (`chrome.scripting.executeScript`, `chrome.tabs.sendMessage`, etc.) to manipulate the DOM

## Key Differences Summary

| Dimension | Playwright | abu-browser-bridge |
|------|-----------|-------------------|
| Protocol | CDP (DevTools Protocol) | Custom WebSocket + Chrome Extension API |
| Browser | Launches a new instance, fully controlled | Connects to the user's existing browser via extension collaboration |
| Installation | No extension needed | Requires installing a Chrome Extension |
| Login state | Must be handled manually | **Natively reuses the user's login state and cookies** |
| Control depth | Very deep (network layer, protocol layer) | Primarily DOM layer |
| Typical use | Automated testing, web scraping | AI assistant controlling the user's real browser |

## Why Doesn't abu-browser-bridge Use CDP?

The design goal of abu-browser-bridge is to **let AI operate the browser the user is actively using** — reusing the user's login state, cookies, and already-open pages. The Playwright/CDP approach launches a "clean" browser instance that cannot directly access the user's real browsing environment.

Using a Chrome Extension as the middleware layer provides less control depth than CDP, but in return gives **seamless access to the user's real browser session** — which is far more practical for AI assistant scenarios.

## abu-browser-bridge Architecture in Detail

### Three Core Components

1. **abu-browser-bridge** (Node.js MCP Server) — the bridge process
2. **abu-chrome-extension** (Chrome Extension) — the browser-side agent
3. **abu-browser-shared** (shared types) — communication protocol definitions

### Communication Protocol

#### WebSocket Connection (Port 9876)

- Transport: raw TCP WebSocket `ws://127.0.0.1:9876`
- Authentication: token-based, passed via the `Sec-WebSocket-Protocol` header
  - Bridge generates a random 48-byte hex token on startup
  - Chrome Extension discovers the token via an HTTP endpoint (port 9875)
  - Token is verified during the connection handshake
- Heartbeat: 15-second ping/pong to detect dead connections
- Single connection: only one extension connection is allowed at a time

#### HTTP Discovery Endpoint (Port 9875)

- Lightweight HTTP service on fixed port 9875
- CORS restricted to `chrome-extension://` origins
- Returns JSON: `{ wsPort, pid, extensionConnected, uptime, version, token }`

#### Message Format

```typescript
// Bridge → Extension
interface BridgeRequest {
  id: string;              // unique ID for each request
  action: string;          // action name (e.g. "click", "snapshot")
  payload: Record<string, unknown>;
}

// Extension → Bridge
interface BridgeResponse {
  id: string;              // matches the request ID
  success: boolean;
  data?: unknown;
  error?: string;
}
```

### Browser Communication Layers

| Layer | Communication Method |
|------|---------|
| Service Worker ↔ MCP Server | WebSocket |
| Service Worker ↔ Content Script | `chrome.tabs.sendMessage()` |
| Content Script → DOM | Direct DOM manipulation |

### 17 Supported Tools

**Tab Management**: `get_tabs`, `screenshot`, `navigate`, `get_downloads`

**DOM Query & Observation**: `snapshot`, `extract_text`, `extract_table`, `wait_for`

**DOM Interaction**: `click`, `fill`, `select`, `scroll`, `keyboard`

**Advanced Operations**: `execute_js`, `start_recording`, `stop_recording`, `connection_status`

### Element Locator Strategies

Multiple locator types are supported:

```typescript
{ "css": "#button-id" }                        // CSS selector
{ "text": "Click Me" }                         // visible text
{ "role": "button", "name": "Submit" }         // ARIA role + label
{ "testId": "submit-btn" }                     // data-testid attribute
{ "ref": "e3" }                                // reference ID returned by snapshot
{ "xpath": "//div[@class='x']" }               // XPath (fallback)
```

### Security Features

1. **Auth Token** — randomly generated on each startup to prevent unauthorized connections
2. **CORS Restriction** — discovery endpoint only accepts `chrome-extension://` origins
3. **URL Validation** — `navigate` only accepts `http:` / `https:` protocols
4. **CSP Bypass** — executed via `chrome.scripting.executeScript({ world: 'MAIN' })`
5. **Selector Injection Protection** — CSS selectors are escaped using `CSS.escape()`

### Data Flow Example

```
User requests "click the submit button"
  ↓
MCP tool: click({ tabId: 5, locator: { "text": "Submit" } })
  ↓
Bridge sends BridgeRequest over WS
  ↓
Service Worker receives it, calls sendToContentScript()
  ↓
Content Script locates the element, fires mousedown/mouseup/click events
  ↓
Content Script returns the result
  ↓
Service Worker returns BridgeResponse over WS
  ↓
Bridge returns the result to AI
```
