# Security Policy / 安全策略

## Supported Versions / 支持的版本

We provide security updates only for the latest minor release line. Older versions will not receive backported fixes — please upgrade.

我们只为最新的次版本号系列提供安全更新。旧版本不会回溯修复，请升级。

| Version | Supported |
| ------- | --------- |
| 0.13.x  | ✅        |
| < 0.13  | ❌        |

## Reporting a Vulnerability / 报告漏洞

**Please do NOT open a public GitHub issue for security vulnerabilities.**

**请勿在公开的 GitHub issue 中报告安全漏洞。**

There are two private channels:

- **Preferred — GitHub Private Vulnerability Reporting**: open a private report at <https://github.com/PM-Shawn/Abu-Cowork/security/advisories/new>. This keeps everything tracked in one place and lets us coordinate a fix and disclosure.
- **Alternative — Email**: <syishao666@gmail.com>

推荐走 GitHub 私有漏洞报告（上面那个链接），方便我们追踪修复进度和协调公开披露时间。也可以发邮件。

### What to include / 报告时请包含

- Affected version (e.g. `v0.13.12`) and platform (macOS / Windows)
- A clear description of the issue and the impact (data exposure, RCE, privilege escalation, etc.)
- Reproduction steps or a proof-of-concept — please avoid attaching real credentials or third-party data
- Any suggested fix, if you have one

—

- 受影响版本（例如 `v0.13.12`）与平台（macOS / Windows）
- 问题与影响的清晰描述（数据泄漏、远程代码执行、权限提升等）
- 复现步骤或 PoC——请勿附带真实凭证或第三方数据
- 如果有修复建议，欢迎一并提供

### What to expect / 你能期待的响应

- **Initial response**: within 7 days
- **Triage & severity assessment**: within 14 days
- **Fix timeline**: depends on severity — critical issues are prioritized; lower-severity issues are bundled into the next regular release
- We will credit you in the release notes if you wish (please tell us how you would like to be credited)

—

- **首次回复**：7 天内
- **分诊与严重性评估**：14 天内
- **修复时间**：取决于严重性——严重漏洞优先处理，低危问题随下一次常规发版一起修
- 如果你希望署名，会在发版日志中致谢（请告知希望使用的署名方式）

## Scope / 适用范围

This policy covers the Abu desktop application source code in this repository. It does NOT cover:

- Third-party LLM providers (Anthropic, OpenAI-compatible endpoints, etc.) — please report to the upstream vendor
- User-installed Skills, MCP servers, or third-party plugins — please report to the respective maintainers
- The user's own environment misconfiguration (e.g. weak file permissions on the local data directory)

—

本策略仅覆盖本仓库内 Abu 桌面应用的源代码。**不**覆盖：

- 第三方 LLM 服务商（Anthropic、OpenAI 兼容端点等）——请向上游报告
- 用户自行安装的 Skills、MCP 服务器或第三方插件——请向各自维护者报告
- 用户本机环境配置问题（如本地数据目录的权限设置过于宽松）

## Disclosure Policy / 披露策略

We follow coordinated disclosure: we will work with you on a fix before any public disclosure, and will ask you to refrain from publishing details until a patched release is available.

我们遵循协调披露原则：会与你一起完成修复后再公开披露，请在补丁版本发布前不要公开漏洞细节。
