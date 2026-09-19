# Abu 内置浏览器基础操作

Use `abu-browser__` tools. Obtain numeric tab IDs from `list_tabs` or `create_tab`; IDs in examples are placeholders.

## 打开和查看

```text
abu-browser__list_tabs({})
abu-browser__create_tab({ url: "https://example.com" })
abu-browser__snapshot({ tabId: 123 })
```

Use the tabId returned by create_tab for the snapshot. For a second article, call create_tab again and keep both tabs. Use navigate only when replacing the chosen tab is intentional.

## 关闭未使用的后台页

Use `abu-browser__close_tab({ tabId: 123 })` only for an unused background page created by this run. Retain results the user should inspect. `requires_user_action` means leave the page open for the user; `closing` means wait without retrying or forcing it.

## 截图

```text
abu-browser__screenshot({ tabId: 123 })
abu-browser__screenshot_full_page({ tabId: 123 })
```

普通截图返回当前可视区域；整页截图会滚动并拼接长页面。

## 交互

```text
abu-browser__click({ tabId: 123, locator: "{\"ref\":\"e3\"}" })
abu-browser__fill({ tabId: 123, locator: "{\"ref\":\"e5\"}", value: "hello@example.com" })
abu-browser__select({ tabId: 123, locator: "{\"ref\":\"e7\"}", value: "option_value" })
abu-browser__keyboard({ tabId: 123, key: "Enter" })
abu-browser__scroll({ tabId: 123, direction: "down", amount: 500 })
```

优先使用 `snapshot` 返回的 ref。页面变化后重新获取 ref。

## 等待和提取

```text
abu-browser__wait_for({ tabId: 123, condition: "{\"type\":\"textContains\",\"locator\":{\"css\":\"body\"},\"text\":\"加载完成\"}" })
abu-browser__extract_text({ tabId: 123 })
abu-browser__extract_table({ tabId: 123, format: "markdown" })
```

## 安全边界

- 不使用 shell 命令打开系统浏览器。
- 不使用 `computer` 代替网页操作。
- 支付、删除、提交或发送前先截图并让用户确认。

When a click opens a new tab, list tabs again and keep the source available. A blocked popup (including `popupBlocked` in a listing) needs user attention or a separately approved destination; never replay a form submission as a GET.

Before a child task finishes, use `abu-browser__retain_tab({ tabId })` for each result or handoff page the user should keep. The host moves retained pages to the conversation; unused background pages may close safely. Never retry browser work after the child task has ended.

## 嵌入表单、接管与取消

A snapshot covers one document. Its `frames` list contains browser-confirmed embedded regions. Observe a region with `snapshot({ tabId, frameId })`, then pass that same **explicit frameId** with every locator or wait in it, including frame-qualified refs. Use only IDs returned for the current document. Each cross-origin region needs its own approval; do not infer a grant from the outer page or an iframe URL attribute. Opaque regions are unavailable.

After navigation, frame replacement, or handback, take a fresh snapshot and discard old refs/frame IDs. If the user takes control, stop tool calls and leave the page intact. The user returns control through the browser toolbar; observe again before writing. Do not close/recreate a page to bypass takeover.

`wait_for` is bounded and cancellation stops its observer. An interrupted click, submission, upload or script may already have taken effect: inspect the current page and never replay it automatically. A failed batch does not roll back earlier steps; continue only after checking their results.

Native file pickers are cancelled while automation controls the page. Upload through `upload_file` using approved task files, or ask the user to take control for manual file selection. Never switch to scripts to bypass a file approval.
