# Web Browsing

**English** | [中文](browser-bridge-vs-playwright.zh-CN.md)

You do not need to understand browser protocols or configure launch commands. Choose a browser path according to whether the task needs your existing signed-in session.

## Two browser paths

| Capability | Best for | Uses your Chrome session | Extension required |
|---|---|---|---|
| **Abu Built-in Browser** | Search, reading, clicks, forms, screenshots, and extraction | No; it uses an independent session | No |
| **My Chrome** | Existing tabs, cookies, extensions, or signed-in state | Yes | Yes; load the extension bundled with Abu |

Start with the **Abu Built-in Browser**. Use **My Chrome** only when you explicitly request it or when the task must reuse an existing signed-in session.

## Abu Built-in Browser

The built-in browser ships with the Electron client and requires no additional installation. Describe the task directly, for example:

> Find the latest Abu Release, compare the macOS and Windows installers, and include the source links.

The page opens in Abu's workspace panel so you can observe tabs or take over. The built-in browser uses an independent session and does not read your daily Chrome cookies, history, or signed-in accounts.

You can sign in separately inside the built-in browser. Connect **My Chrome** only when the task must reuse a session that already exists in Chrome.

## Connect My Chrome

1. Open **Settings → Capabilities**.
2. Under **My Chrome**, select **Connect Chrome**.
3. Select **Open Installation Window**. Abu opens Chrome's extensions page and the bundled extension folder.
4. Enable **Developer mode** on the Chrome extensions page.
5. Select **Load unpacked** and choose the entire `browser-extension` folder. Do not enter the folder and select an individual file.
6. Return to Abu and wait for the state to become **Ready**.

Chrome requires you to complete Developer mode, Load unpacked, and folder selection yourself. Abu does not bypass these browser security steps.

## Permissions and privacy

To complete browser tasks you explicitly assign, the extension needs permission to read and interact with webpages and manage downloads. This is a broad capability, so:

- install it only on a trusted device;
- do not install an unverified extension with a similar name;
- use it only for tasks that need your current Chrome session; and
- select **Disconnect My Chrome** in Abu when finished, then disable or remove it in Chrome if desired.

The connection uses components on your device. You do not need to enter local bridge ports, tokens, or launch commands in Toolbox. Do not follow older instructions that tell you to add a browser MCP service manually.

## How Abu chooses a browser

- Ordinary web task: use the Abu Built-in Browser.
- You explicitly request your current Chrome: use My Chrome.
- My Chrome is not connected: pause the browser step and open setup.
- The connection drops: ask you to reconnect instead of silently continuing a signed-in task in the built-in browser.

This prevents a task that depends on authenticated state from acting in the wrong browser session.

## FAQ

### Where is the “Browser Bridge” setting?

It is no longer a standalone settings page. Open **Settings → Capabilities** and review **Abu Built-in Browser** and **My Chrome**.

### What if “Open Installation Window” does not open both locations?

Open `chrome://extensions` manually, then return to Abu's setup guide to locate the `browser-extension` folder. Select the folder itself, not `manifest.json` or another individual file.

### The extension is installed, but Abu says it is disconnected

1. Confirm that the extension is enabled.
2. Select **Check Connection** or **Retry** under **Settings → Capabilities**.
3. Close other running Abu instances and retry.
4. If it still fails, open **Settings → Diagnostics** and check capabilities and network state.

### Can I install it from the Chrome Web Store?

The current release uses the local extension bundled with Abu and is not distributed through the Chrome Web Store. Follow future official release notes if the distribution method changes.

### Is the built-in browser the same as Playwright?

Users do not need to choose an underlying framework. The product exposes two supported paths: the independent **Abu Built-in Browser** and **My Chrome**, which reuses your existing Chrome session. The implementation may evolve while this user-facing distinction remains stable.
