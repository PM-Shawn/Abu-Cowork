# Abu Enterprise Build

Abu-opensource produces an OSS build by default (personal mode + enterprise mode protocol layer).
The official Abu Enterprise binary additionally incorporates the `@abu/enterprise-modules` closed-source plugin.

## Sibling Repository Layout

```
Abu/
├── Abu-opensource/                       # public (Apache 2.0)
└── Abu-enterprise-modules/               # private (clone separately)
```

## Electron-only Development and Build

Electron is the only shell for new feature development, debugging, and
acceptance. `src-tauri/` remains only for compatibility with already shipped
versions, migration, and rollback evidence. Do not use it to develop or accept
new functionality.

```bash
# First use in an OSS worktree
cd Abu-opensource && npm run setup:electron-dev

# First use in an Enterprise worktree
cd Abu-opensource && npm run setup:electron-dev:enterprise

# OSS Electron desktop development
cd Abu-opensource && npm run electron:dev

# Enterprise Electron desktop development
cd Abu-opensource && npm run electron:dev:enterprise

# Production Electron package
cd Abu-opensource && npm run dist:electron
```

Both Electron development commands rebuild the renderer for the intended
target before launching. This prevents a previous Enterprise build from being
mistaken for OSS, or an OSS renderer from being mistaken for Enterprise.

## Enterprise Build Smoke Verification (manual steps, run by Shawn)

```bash
# 1. OSS path TypeScript compile check (0 errors)
cd Abu-opensource
npx tsc -p tsconfig.json --noEmit

# 2. Enterprise path TypeScript compile check (0 errors)
ABU_BUILD_TARGET=enterprise npx tsc -p tsconfig.json --noEmit

# 3. OSS tests (all passing)
npm test

# 4. Electron dependency/runtime preflight
npm run electron:dev:check

# 5. Real Enterprise Electron smoke (requires Abu-enterprise-modules as a sibling directory)
npm run electron:dev:enterprise
# In the Electron window → switch to enterprise mode → KbBrowser / SkillTab / MCPTab /
# MeTransparencyView should all appear (requires connection to Abu Console)
```

A browser-only dev server, unit tests, or a renderer build does not count as
desktop acceptance. A feature is complete only after the real Electron shell
starts and the affected user journey is exercised.

## Runtime entitlement boundary

The desktop revalidates its enterprise session before loading private modules.
Enterprise Skill, MCP, and KB capabilities are usable only while the server
reports a signed, unexpired License for the bound organization and the matching
module. Offline, expired, mismatched, or missing-module states fail closed:
installed enterprise Skills are filtered from runtime lookup, enterprise MCP
invocations are rejected and connections are withdrawn, and the KB tool is
unregistered. Local installation metadata is retained so a valid renewal can
restore the capability without reinstalling it. Personal Skill/MCP behavior is
not affected.

## What's in / out of OSS

| Feature | OSS | Enterprise |
|---|---|---|
| Personal mode (personal LLM key / Skill / MCP) | ✅ | ✅ |
| Enterprise mode bind flow (device flow + SSO redirect) | ✅ | ✅ |
| Enterprise brand badge / status display | ✅ | ✅ |
| Enterprise LLM gateway routing | ✅ | ✅ |
| Policy confirm modal (default UI) | ✅ | ✅ |
| KB Browser (enterprise knowledge base UI) | ✗ | ✅ |
| Skill Marketplace enterprise tab | ✗ | ✅ |
| MCP Marketplace enterprise tab | ✗ | ✅ |
| /me transparency page | ✗ | ✅ |
| Migration wizard (personal → enterprise) | ✗ | ✅ |
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
