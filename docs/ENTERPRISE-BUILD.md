# Abu Enterprise Build

Abu-opensource 默认产出 OSS 构建（个人模式 + 企业模式协议层）。
官方 Abu Enterprise 二进制额外合入 `@abu/enterprise-modules` 闭源插件。

## Sibling 仓库布局

```
Abu/
├── Abu-opensource/                       # 公开 (Apache 2.0)
└── Abu-enterprise-modules/               # 私有（git clone 单独）
```

## Build

```bash
# OSS dev
cd Abu-opensource && npm run dev

# Enterprise dev
cd Abu-opensource && npm run dev:enterprise

# Tauri OSS dev
cd Abu-opensource && npm run tauri:dev

# Tauri Enterprise dev
cd Abu-opensource && npm run tauri:dev:enterprise

# Production Enterprise
cd Abu-opensource && npm run tauri:build:enterprise
```

## Enterprise Build Smoke 验证（手动步骤，Shawn 跑）

```bash
# 1. OSS path TS 编译检查（0 错误）
cd Abu-opensource
npx tsc -p tsconfig.json --noEmit

# 2. Enterprise path TS 编译检查（0 错误）
ABU_BUILD_TARGET=enterprise npx tsc -p tsconfig.json --noEmit

# 3. OSS 测试（全绿）
npm test

# 4. Enterprise dev server smoke（需要 Abu-enterprise-modules 为 sibling）
npm run dev:enterprise
# 浏览器开 → 切到企业模式 → KbBrowser / SkillTab / MCPTab /
# MeTransparencyView 应该都显示出来（需要连接到 Abu Console）
```

## What's in / out of OSS

| 功能 | OSS | Enterprise |
|---|---|---|
| 个人模式（个人 LLM key / Skill / MCP） | ✅ | ✅ |
| 企业模式 bind flow (device flow + SSO 跳转) | ✅ | ✅ |
| 企业 brand badge / 状态显示 | ✅ | ✅ |
| 企业 LLM gateway 路由 | ✅ | ✅ |
| 策略 confirm modal（默认 UI） | ✅ | ✅ |
| KB Browser (企业知识库 UI) | ✗ | ✅ |
| Skill 市场企业 tab | ✗ | ✅ |
| MCP 市场企业 tab | ✗ | ✅ |
| /me 透明性页 | ✗ | ✅ |
| Migration wizard (个人版→企业) | ✗ | ✅ |
| Agent kb_query tool | ✗ | ✅ |

## Architecture

```
Abu-opensource/
├── src/enterprise-modules-stub/   # OSS build stub (empty init)
│   └── index.ts
└── vite.config.ts                 # ABU_BUILD_TARGET → @enterprise-modules alias

Abu-enterprise-modules/
└── src/
    ├── index.ts                   # initEnterpriseModules() + side-effect imports
    ├── components/                # KbBrowser, SkillTab, McpTab, MeTransparency, MigrationWizard
    ├── core/                      # kb-sync, skill-installer, mcp-installer, migration
    ├── tools/                     # enterprise-kb-query (agent tool)
    └── stores/                    # enterpriseKbStore, enterpriseSkillStore, enterpriseMcpStore
```

## Notes for Enterprise CI

Enterprise build CI requires access to the private `Abu-enterprise-modules` repo.
Set up as a sibling directory via SSH key or submodule. The OSS CI pipeline
runs without it (default `ABU_BUILD_TARGET` is `oss`).
