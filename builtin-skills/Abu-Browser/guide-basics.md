# Abu 内置浏览器基础操作

所有操作使用 `abu-browser__` 工具，并先通过 `get_tabs` 取得数字类型的 `tabId`。

## 打开和查看

```text
abu-browser__get_tabs({})
abu-browser__navigate({ tabId: 123, url: "https://example.com" })
abu-browser__snapshot({ tabId: 123 })
```

`get_tabs` 在没有标签页时会创建一个 Abu 内可见的浏览器标签。导航后重新调用 `snapshot` 获取最新元素 ref。

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
abu-browser__wait_for({ tabId: 123, condition: "{\"type\":\"text\",\"text\":\"加载完成\"}" })
abu-browser__extract_text({ tabId: 123 })
abu-browser__extract_table({ tabId: 123, format: "markdown" })
```

## 安全边界

- 不使用 shell 命令打开系统浏览器。
- 不使用 `computer` 代替网页操作。
- 支付、删除、提交或发送前先截图并让用户确认。
