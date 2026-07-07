**English** | [中文](SECURITY.zh-CN.md)

# Security Policy

## Supported Versions

We provide security updates only for the latest minor release line. Older versions will not receive backported fixes — please upgrade.

| Version | Supported |
| ------- | --------- |
| 0.25.x  | ✅        |
| < 0.25  | ❌        |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

There are two private channels:

- **Preferred — GitHub Private Vulnerability Reporting**: open a private report at <https://github.com/PM-Shawn/Abu-Cowork/security/advisories/new>. This keeps everything tracked in one place and lets us coordinate a fix and disclosure.
- **Alternative — Email**: <syishao666@gmail.com>

### What to include

- Affected version (e.g. `v0.25.5`) and platform (macOS / Windows)
- A clear description of the issue and the impact (data exposure, RCE, privilege escalation, etc.)
- Reproduction steps or a proof-of-concept — please avoid attaching real credentials or third-party data
- Any suggested fix, if you have one

### What to expect

- **Initial response**: within 7 days
- **Triage & severity assessment**: within 14 days
- **Fix timeline**: depends on severity — critical issues are prioritized; lower-severity issues are bundled into the next regular release
- We will credit you in the release notes if you wish (please tell us how you would like to be credited)

## Scope

This policy covers the Abu desktop application source code in this repository. It does NOT cover:

- Third-party LLM providers (Anthropic, OpenAI-compatible endpoints, etc.) — please report to the upstream vendor
- User-installed Skills, MCP servers, or third-party plugins — please report to the respective maintainers
- The user's own environment misconfiguration (e.g. weak file permissions on the local data directory)

## Disclosure Policy

We follow coordinated disclosure: we will work with you on a fix before any public disclosure, and will ask you to refrain from publishing details until a patched release is available.
