# Abu Enterprise Build

Abu-opensource produces a personal-mode OSS build by default. The official Abu
Enterprise binary incorporates the complete `@abu/enterprise-modules`
closed-source client implementation at compile time.

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
# In the Electron window → switch to enterprise mode → verify Skill / Agent / MCP
# personal and organization sources plus the affected execution path.
```

A browser-only dev server, unit tests, or a renderer build does not count as
desktop acceptance. A feature is complete only after the real Electron shell
starts and the affected user journey is exercised.

## Runtime entitlement boundary

The desktop revalidates its enterprise session before loading private modules.
Enterprise Skill, Agent, MCP, and KB capabilities are usable only while the server
reports a signed, unexpired License for the bound organization and the matching
module. Offline, expired, mismatched, or missing-module states fail closed:
installed enterprise Skills are filtered from runtime lookup, enterprise MCP
invocations are rejected and connections are withdrawn, managed Agents are
removed from runtime lookup, and the KB tool is
unregistered. Local installation metadata is retained so a valid renewal can
restore the capability without reinstalling it. Personal Skill/MCP behavior is
not affected.

## What's in / out of OSS

| Feature | OSS | Enterprise |
|---|---|---|
| Personal mode (personal LLM key / Skill / MCP) | ✅ | ✅ |
| Enterprise mode bind flow (device flow + SSO redirect) | ✗ | ✅ |
| Enterprise brand badge / status display | ✗ | ✅ |
| Enterprise LLM gateway routing | ✗ | ✅ |
| Policy confirm modal | ✗ | ✅ |
| KB Browser (enterprise knowledge base UI) | ✗ | ✅ |
| Skill Marketplace enterprise tab | ✗ | ✅ |
| MCP Marketplace enterprise tab | ✗ | ✅ |
| Managed Agent templates (assigned, read-only, no local install) | ✗ | ✅ |
| /me transparency page | ✗ | ✅ |
| Migration wizard (personal → enterprise) | ✗ | ✅ |
| Agent kb_query tool | ✗ | ✅ |

## Architecture

```
Abu-opensource/
├── src/core/enterprise/           # host contracts + compile-time bridges only
├── src/enterprise-modules-stub/   # personal-mode no-op implementation
│   └── index.ts                   # mirrors the private package export contract
└── vite.config.ts                 # ABU_BUILD_TARGET → @enterprise-modules alias

Abu-enterprise-modules/
└── src/
    ├── index.ts                   # complete private runtime export surface
    ├── components/                # login, brand, policy, KB, Skill, Agent, MCP and employee UI
    ├── core/enterprise/           # auth, binding, heartbeat, gateway and policy
    ├── core/                      # KB/Skill/Agent/MCP sync, installers and migration
    ├── tools/                     # enterprise-kb-query (agent tool)
    └── stores/                    # organization mode and enterprise catalog state
```

## Edition and Enterprise Deployment Config

**Edition parameter.** `ABU_BUILD_TARGET=enterprise|oss` selects the edition
at PACKAGING time (Vite alias → private overlay vs stub; the dev scripts set
it too). At STARTUP the Electron shell resolves its edition as
`ABU_EDITION > ABU_BUILD_TARGET > presence of abu-enterprise.json > 'oss'`
(`electron/enterpriseConfig.cjs`) and exposes it to the renderer as
`__ABU_SHELL__.edition`.

**Enterprise deployment config file** — one build, many customers. The shell
looks for `abu-enterprise.json` at startup, first hit wins:

1. `ABU_ENTERPRISE_CONFIG=<path>` — explicit override (dev / ops)
2. `<resources>/abu-enterprise.json` — dropped in via electron-builder
   `extraResources` at per-customer packaging time (dev: repo root, gitignored)
3. OS managed location (MDM/admin deploys, survives app updates):
   macOS `/Library/Application Support/Abu/`, Windows `%ProgramData%\Abu\`,
   Linux `/etc/abu/`

Shape (see `abu-enterprise.example.json`; unknown keys are passed through
for future use):

```json
{
  "serverUrl": "https://abu.acme.com",
  "lockServerUrl": false
}
```

With `serverUrl` present, an UNBOUND app auto-opens the bind flow on
startup with the URL pre-filled — employees only complete the login step.
`lockServerUrl: true` renders the URL read-only (org-managed devices). An
`abu://enroll?server=...` deep link still takes precedence, and manual
binds from Settings pre-fill the same default. A malformed file logs a
warning and is ignored (the shell never fails over deployment config).

Fallback channel: the build-time env `VITE_ABU_ENTERPRISE_DEFAULT_SERVER`
(per-customer CI bake / `.env.local` for local dev) provides the same
default when no config file is deployed; the file wins when both exist.
These values are plain URLs, not secrets.

## Notes for Enterprise CI

Enterprise build CI requires access to the private `Abu-enterprise-modules` repo.
Set up as a sibling directory via SSH key or submodule. The OSS CI pipeline
runs without it (default `ABU_BUILD_TARGET` is `oss`).
