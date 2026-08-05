# enterprise-modules-stub

OSS-build placeholder for the closed-source `@abu/enterprise-modules`.

The public client contains only the host contract and this personal-mode no-op
implementation. Authentication, binding, heartbeat, policy, organization
state, LiteLLM gateway behavior, enterprise catalogs, and enterprise UI all
ship from the private sibling repository.

OSS users do not receive enterprise mode. The official Enterprise build swaps
this stub for the private module at compile time.

## Build targets

- `npm run electron:dev` — OSS (this stub; renderer is rebuilt before launch)
- `npm run electron:dev:enterprise` — uses `../Abu-enterprise-modules/src` via Vite alias (private repo required as sibling)

## Vite alias

In `vite.config.ts`, the alias `@enterprise-modules` is resolved as:

| `ABU_BUILD_TARGET` | Resolves to |
|---|---|
| (unset / `oss`) | `src/enterprise-modules-stub` (this directory) |
| `enterprise` | `../Abu-enterprise-modules/src` (sibling private repo) |

## Export contract

The private module must mirror every export in `index.ts`. The primary lifecycle
entry point is:

```ts
export async function initEnterpriseModules(): Promise<void>
```

Shared host code imports the same contract in both build targets. In an OSS
build these exports are inert personal-mode defaults; in an Enterprise build
they resolve to the private implementation.
