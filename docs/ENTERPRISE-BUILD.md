# Abu Enterprise Build

Abu-opensource produces an OSS build by default (personal mode + enterprise mode protocol layer).
The official Abu Enterprise binary additionally incorporates the `@abu/enterprise-modules` closed-source plugin.

## Sibling Repository Layout

```
Abu/
├── Abu-opensource/                       # public (Apache 2.0)
└── Abu-enterprise-modules/               # private (clone separately)
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

## Enterprise Build Smoke Verification (manual steps, run by Shawn)

```bash
# 1. OSS path TypeScript compile check (0 errors)
cd Abu-opensource
npx tsc -p tsconfig.json --noEmit

# 2. Enterprise path TypeScript compile check (0 errors)
ABU_BUILD_TARGET=enterprise npx tsc -p tsconfig.json --noEmit

# 3. OSS tests (all passing)
npm test

# 4. Enterprise dev server smoke (requires Abu-enterprise-modules as a sibling directory)
npm run dev:enterprise
# Open in browser → switch to enterprise mode → KbBrowser / SkillTab / MCPTab /
# MeTransparencyView should all appear (requires connection to Abu Console)
```

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
