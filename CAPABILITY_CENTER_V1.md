# Abu Skill / MCP 能力中心 V1

> 状态：2026-08-05 V1 已实现并通过本地门禁。本文只描述公开的产品契约与安全边界；企业闭源实现位于私有模块仓库。

## 1. 用户路径

### 个人版

1. 用户打开「工具箱」。
2. 在 Skill、Agent、MCP 三种能力之间切换。
3. Skill 支持创建、导入、安装与启停；MCP 支持添加本地或远程服务并管理连接。
4. 本地能力继续由用户拥有，不要求登录企业服务。

### 企业版

1. 用户绑定企业实例后，Skill 与 MCP 页面出现「我的 / 组织」来源切换。
2. 「我的」保留个人能力；「组织」只展示企业管理员发布且当前用户有权使用的能力。
3. 组织 Skill 一键安装、更新或移除。
4. 组织 MCP 一键连接或断开。凭据不进入剪贴板，也不写入普通 JSON；客户端通过企业身份领取凭据并存入操作系统密钥库。
5. 策略、ACL、凭据过期或目录下架会阻止后续连接；离线状态不静默回退到个人凭据。

## 2. 为什么不是五个顶级标签

Skill 与 MCP 是不同的运行时能力：Skill 是按需加载的流程与知识，MCP 是带认证和权限边界的实时工具/数据连接。「个人 / 组织」是来源与治理属性，不应被做成新的能力类型。因此顶层保持 Skill、Agent、MCP，企业入口下沉到 Skill/MCP 内部。

这也为后续 Plugin 留出清晰位置：Plugin/能力包是分发层，可以组合 Skill、MCP、Hook 等资源；安装后仍由各自运行时执行，而不是把所有能力强行合并成一种对象。

## 3. 竞品与主流方案结论

本轮只做了本机已安装应用和官方公开资料的行为/结构研究，没有复制第三方闭源代码。

| 产品/生态 | 观察 | Abu 采用 |
|---|---|---|
| WorkBuddy | 内置市场以插件为分发单元，可组合 Skill、Hook、MCP；用户显式安装和启用 | 后续用能力包承载组合分发；V1 不新造包格式 |
| TRAE SOLO | 内置 MCP、系统连接器、Computer Use 审批；录制结果可物化为可复用 Skill | 保留 Skill/MCP 运行边界，高风险动作继续走审批 |
| Codex / OpenAI Plugins | Plugin 可打包 Skills、MCP 等；Skills 用渐进加载，MCP 负责外部能力与认证；企业可用管理配置控制来源和启用 | 能力包作为分发层，企业策略与凭据独立治理 |
| Claude Code / Cursor | Marketplace + Plugin 已成为统一发现/安装入口，团队管理员可以分发或限制来源 | 企业组织目录与个人目录并存，管理员控制组织来源 |

共同模式是：**市场/Plugin 负责发现与分发，Skill 负责可复用工作流，MCP 负责实时数据和动作，企业策略负责可用性，身份系统负责授权**。这四层不能混成一个“已安装即永久有权”的开关。

## 4. V1 架构边界

```text
公开客户端壳
  ├─ 个人 Skill / MCP（公开实现）
  ├─ 来源切换与搜索契约（公开接口）
  └─ enterprise mount（公开空插槽）
             │
             ▼
私有 enterprise modules
  ├─ 组织 Skill 目录 + 安装器
  ├─ 组织 MCP 目录 + 连接器
  ├─ ACL / policy 本地门禁
  └─ OS secret store 凭据适配
             │
             ▼
Abu Console
  ├─ 组织目录与审核状态
  ├─ 用户/部门/角色 ACL
  └─ 用户短期凭据签发；不支持时使用管理员静态凭据兼容路径
```

公开仓库只拥有来源切换、搜索参数和挂载契约，不包含企业目录、凭据签发或闭源治理逻辑。

## 5. 安全与协议决定

- 企业 MCP 的目录可见性、连接权限和工具执行权限是三道独立门禁。
- 优先领取用户级、可过期凭据；静态管理员凭据只用于当前服务端明确返回“不支持签发”的兼容部署。
- 凭据只存操作系统密钥库。旧版本 JSON 中的明文值逐条迁移：只有密钥库写入成功后才删除对应旧值。
- 目录项必须展示来源、审核/弃用状态；过期凭据不得自动尝试连接，用户可显式重新连接。
- 当前客户端使用 `@modelcontextprotocol/sdk` 1.x 的有状态握手。MCP 2026-07-28 的无状态核心、`server/discover`、OAuth 2.1 与 Enterprise-Managed Authorization 属于下一阶段协议迁移，不在 V1 中混做，避免一次改动同时触碰产品、认证和传输层。

## 6. V1 验收

- OSS 构建：只显示 Skill、Agent、MCP，不暴露企业闭源实现。
- 企业构建：绑定后 Skill/MCP 显示「我的 / 组织」，搜索同时作用于组织目录。
- 组织 Skill：安装、更新、移除路径可用。
- 组织 MCP：连接、断开、过期后重新连接路径可用；界面不再复制凭据。
- 本地元数据文件不再写入 `credential`；旧明文凭据迁移有单元测试。
- lint、TypeScript、相关单测、OSS build、enterprise build 全部通过。

## 7. 后续阶段

1. 定义 Abu 能力包清单及签名格式，把多个 Skill/MCP/Hook 作为一个审核与发布单元。
2. Console 增加组织级 marketplace allowlist/denylist、强制安装、版本锁定和审计事件。
3. 将凭据签发升级为标准 OAuth 2.1/PKCE，并接入 Enterprise-Managed Authorization 与企业 IdP。
4. 迁移 MCP 2026-07-28 无状态协议；迁移前先做 SDK 兼容矩阵和旧服务器适配层。
5. 给个人 MCP 的 header/env 敏感配置补同等级的密钥库迁移，统一凭据健康检查与重授权体验。

## 8. 参考

- [OpenAI Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
- [OpenAI: Build skills](https://developers.openai.com/plugins/build/skills)
- [OpenAI: Add MCP servers](https://developers.openai.com/plugins/build/mcp-server)
- [Claude Code plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Cursor Marketplace](https://cursor.com/blog/marketplace)
- [MCP 2026-07-28 release candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [MCP Enterprise-Managed Authorization](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization)
- [MCP security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
