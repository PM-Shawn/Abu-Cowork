# enterprise-modules-stub

OSS-build placeholder for the closed-source `@abu/enterprise-modules`.

The Abu-opensource client supports an "enterprise mode" runtime switch
(connect to a self-hosted Abu Console). The **protocol** + **container**
layer is in this repo (public). The **business UI** (KB browser, Skill
marketplace tab, MCP tab, policy enforcer modal beyond default, etc.)
ships separately as a closed-source overlay.

OSS users can still use enterprise mode — they'll see the bind flow,
brand badge, and basic transparency page (all in this repo), but the
business UI panels will be empty. To get the full enterprise UI, use the
official Abu Enterprise build.

## Build targets

- `npm run tauri:dev` — OSS (this stub)
- `npm run tauri:dev:enterprise` — uses `../Abu-enterprise-modules/src` via Vite alias (private repo required as sibling)

## Vite alias

In `vite.config.ts`, the alias `@enterprise-modules` is resolved as:

| `ABU_BUILD_TARGET` | Resolves to |
|---|---|
| (unset / `oss`) | `src/enterprise-modules-stub` (this directory) |
| `enterprise` | `../Abu-enterprise-modules/src` (sibling private repo) |

## Export contract

Any module under `@enterprise-modules` must export:

```ts
export async function initEnterpriseModules(): Promise<void>
```

This is the only surface called from `App.tsx`. The enterprise build
additionally registers components into the mount registry via side-effect
imports inside `initEnterpriseModules`.
