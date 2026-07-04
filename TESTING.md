# Testing System — Abu Client (TESTING.md)

> Canonical reference for the Abu-opensource client repository.
> This document is the "constitution" for the test suite — all contributors and AI agents must follow it.

## 1. Pyramid & Scope

```
      /\   Tauri native smoke  (pre-release, manual trigger)   — ~5 % surface
     /──\  Web E2E Playwright  (outer gate)                    — key user flows
    /────\ Integration tests   (outer gate)                    — module seams
   /──────\ Unit tests         (inner gate, main workhorse)    — fast, deterministic
  Contract / boundary tests    (lock frontend ↔ native + cross-repo SDK shapes)
```

Coverage is collected via **v8** (built-in to Vitest) across all non-component source files.
Component coverage (`src/components/**`) is excluded — UI behaviour is validated via E2E instead.

---

## 2. File Layout & Naming Convention

| Layer | Pattern | Location |
|---|---|---|
| Unit | `*.test.ts` / `*.test.tsx` | Co-located next to source file |
| Integration | `*.integration.test.ts` | Co-located or `src/__tests__/` |
| E2E | `*.spec.ts` | `e2e/` directory (Playwright) |
| Contract / boundary | `*.contract.test.ts` | Co-located or `src/__tests__/` |

**Examples:**
```
src/core/llm/claude.ts           → src/core/llm/claude.test.ts
src/core/agent/agentLoop.ts      → src/core/agent/agentLoop.integration.test.ts
e2e/chat-flow.spec.ts
src/core/tools/definitions.contract.test.ts
```

Vitest is configured to pick up all three patterns (unit + integration co-located; scripts tests
under `scripts/`). E2E (`e2e/*.spec.ts`) is handled by Playwright and runs as a separate step.

---

## 3. Determinism Constraints (anti-flaky hard rules)

These rules are **mandatory** for every new test:

| Prohibited | Use instead |
|---|---|
| `Date.now()` / `new Date()` in assertions | `vi.useFakeTimers()` + `vi.setSystemTime(fixedDate)` |
| `Math.random()` | Inject a seeded RNG or stub with `vi.spyOn(Math, 'random')` |
| Real network calls (fetch, HTTP, WebSocket) | `vi.mock()` or intercept with `msw` |
| Real timers (`setTimeout`, `setInterval`, `sleep`) | `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` |
| Real file system / Tauri FS plugin | Global Tauri mocks in `src/test/setup.ts` (already wired) |
| `crypto.randomUUID()` / entropy-sourced IDs as assertions | Stub via `vi.spyOn` or accept any string with `expect.any(String)` |

Global Tauri API mocks live in `src/test/setup.ts` and are applied automatically to every test file.
Add new Tauri plugin mocks there rather than per-test.

**Flaky test quarantine:** If a test is found to be flaky (non-deterministic failure), open a
GitHub issue tagged `flaky-test` and move the test into `src/__tests__/quarantine/` with a
`// QUARANTINED: <issue-url>` comment. Quarantined tests are excluded from CI gates but included
in a daily reminder run. SLA to fix or delete: **2 sprints (4 weeks)**.

---

## 4. Gate Contracts — Three Scripts

All gates are wired as npm scripts and must be called using these exact names so that `/goal`
automation templates work identically across both Abu repos:

```
npm run verify:quick   # inner loop — lint + typecheck + changed-file tests
npm run verify:full    # outer gate — lint + typecheck + all tests + coverage threshold
npm run verify         # alias for verify:full (single entry point for CI / goal templates)
```

### verify:quick

```sh
npm run lint && npm run typecheck && vitest run --changed
```

- Runs ESLint, TypeScript compiler check, then Vitest on files with uncommitted changes in the working tree.
- Target: **< 30 s** on a development machine.
- Use during the inner loop of AI-driven development (every small change).
- Does NOT enforce coverage thresholds.

### verify:full

```sh
npm run lint && npm run typecheck && npm run gen:models:check && npm run test:coverage
```

- Full quality gate: lint + type errors + model-data freshness check + all 2400+ tests + coverage threshold enforcement.
- Use before marking a task complete and before opening a PR. Locally equivalent to what CI runs as independent steps.
- Coverage below the committed thresholds causes non-zero exit and fails the gate.

### verify (= verify:full)

Single canonical entry point for local use and `/goal` completion criteria.
CI does **not** call `verify:full` directly — it runs the same quality checks as individual steps
(Lint / Type check / Test with coverage) so each stage reports independently. `verify:full` is the
local shorthand that sequences those same steps in one command.

---

## 5. Coverage Thresholds

Coverage thresholds are stored in `vitest.config.ts` under `coverage.thresholds` and are the
**single source of truth** — do not duplicate exact numbers here.

**Design:**

- Global thresholds are rounded-down integer lower bounds with a 2-point buffer for natural
  drift. They do **not** use `autoUpdate: true` — that would rewrite the tracked config on every
  passing run, dirtying the working tree and causing false-red CI on sub-1% fluctuations.
- Per-module floors are committed alongside the global thresholds and must not be lowered.
- If coverage drops below any committed threshold, the run exits non-zero and CI fails.

**To raise thresholds:** edit `vitest.config.ts` manually in a dedicated commit. Never let
automation update them. To add `lines`/`branches`/`functions` dimensions to a per-module floor,
add the keys directly in `vitest.config.ts`.

See `vitest.config.ts → test.coverage.thresholds` for current values.

---

## 6. Writing Tests — Conventions

### Store tests

```ts
import { useChatStore } from '@/stores/chatStore'

beforeEach(() => {
  useChatStore.setState({ conversations: [], activeId: null })
})

it('adds a message', () => {
  useChatStore.getState().addMessage(...)
  expect(useChatStore.getState().conversations[0].messages).toHaveLength(1)
})
```

No React rendering needed. Access state via `getState()`.

### Timer tests

```ts
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

it('fires after delay', async () => {
  const spy = vi.fn()
  scheduleWork(spy, 1000)
  await vi.advanceTimersByTimeAsync(1000)
  expect(spy).toHaveBeenCalledOnce()
})
```

### Describe structure

```ts
describe('module name', () => {
  describe('action or method', () => {
    it('does X when Y', () => { /* ... */ })
    it('throws Z when W', () => { /* ... */ })
  })
})
```

---

## 7. CI Integration

The CI workflow (`.github/workflows/ci.yml`) splits the quality gate into **independent steps**
(Lint / Type check / Test with coverage), each with `if: always()` so a single failure does not
swallow the others — you see exactly which stages are red in one run. `verify:full` is the local
equivalent that sequences the same checks; use it before opening a PR.

Model-data freshness (`gen:models:check`) runs automatically before tests via the `pretest` npm hook
and again inside `npm run build` — no separate CI step is needed.

Steps that are NOT part of verify (and must be kept):
- Enterprise leak guard (`scripts/enterprise-leak-guard.sh`) — runs **before** npm install.
- Build frontend (`npm run build`) — separate from tests, validates production bundle.
- Chrome extension bundle sync check — validates committed extension artifact is up to date.

---

## 8. Enterprise / Open-Core Boundary

Enterprise feature tests must **not** appear in this public repository:

- Closed-source test logic belongs in the private `Abu-enterprise-modules` repo alongside the implementation.
- This repo only tests the public slot/interface/protocol layer (`src/core/enterprise/`).
- AI-driven autonomous builds involving enterprise logic **must use worktree isolation** and never touch the `Abu-opensource` working tree directly.

---

## 9. E2E Tests (Playwright)

### Positioning

E2E is the **outer gate** — heavier than unit tests, independent from `verify:full`. It is **not** included in `verify:quick` or `verify:full`; run it separately as needed and in CI via `.github/workflows/e2e.yml`.

```
npm run test:e2e       # run all Playwright specs (headless Chromium)
```

### Strategy: Web Mode + LLM mock

The app runs under `npm run dev` (Vite dev server on `:5173`). Tauri IPC is absent in this mode, so:

1. **`tauriFetch` guard** — `getTauriFetch()` checks `window.__TAURI_INTERNALS__` at runtime. If absent (browser / E2E), it short-circuits to `globalThis.fetch` without importing `@tauri-apps/plugin-http`. This makes all LLM HTTP requests go through the browser's native fetch.

2. **LLM mock via `page.route()`** — Since LLM calls now use `globalThis.fetch`, Playwright can intercept them:
   ```ts
   await page.route('https://api.anthropic.com/**', async (route) => {
     await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: sseBody });
   });
   ```
   The mock body must follow the Anthropic SSE format: `event: <type>\ndata: <json>\n\n` per event (message_start → content_block_start → content_block_delta(s) → content_block_stop → message_delta → message_stop).

3. **localStorage pre-seeding** — `page.addInitScript()` writes `abu-settings` to localStorage before React hydrates, injecting a fake API key so the `providerRequiresApiKey` guard in ChatView passes.

### Covered flows (5 specs)

| File | Flow |
|---|---|
| `smoke.spec.ts` | App mounts, sidebar + chat input visible |
| `conversation.spec.ts` | New conversation button, text input typing |
| `settings.spec.ts` | localStorage persistence, settings panel open |
| `tabs.spec.ts` | Toolbox + Automation tab navigation |
| `chat.spec.ts` | Full send → mock SSE → assistant reply rendered |

### Limitations in web mode

- Tauri-specific features (file system, shell commands, Tauri events) do not function — tests avoid them.
- LLM requests in web mode use `globalThis.fetch` → `page.route()` intercepts work, but real API calls would hit CORS in a raw browser (no Tauri proxy). The mock sidesteps this entirely.

---

## 10. Contract Tests (Tauri IPC boundary)

### Purpose

Contract tests lock the **call shape** — command name + parameter key set — for frontend ↔ Rust IPC boundaries. They catch parameter renames that TypeScript would not flag (TypeScript sees the `invoke` call but not the Rust deserialization schema).

### Location & naming

| Pattern | Location |
|---|---|
| `*.contract.test.ts` | Co-located next to source, or in `src/__tests__/contract/` |

The canonical contract test lives in:

```
src/__tests__/contract/tauri-commands.contract.test.ts
```

### What is locked

| Command | Wrapper | Param keys locked |
|---|---|---|
| `run_shell_command` | `runCommandTool.execute()` | `command, cwd, background, timeout, sandboxEnabled, networkIsolation, extraWritablePaths` |
| `secret_set` | `setSecret(key, value)` | `key, value` |
| `secret_get` | `getSecret(key)` | `key` |
| `secret_clear_all` | `clearAllSecrets(knownKeys)` | **`knownKeys`** (camelCase — Tauri auto-converts to `known_keys` on the Rust side; if renamed to `known_keys` here, Tauri receives it literally and Rust deserialization fails) |
| `atomic_write_with_backup` | `atomicWriteWithBackup(path, content)` | `path, content` |
| `start_network_proxy` | `initNetworkProxy()` | `whitelist, `**`allowPrivateNetworks`** (camelCase — Tauri auto-converts to `allow_private_networks` on the Rust side; same rename-guard rationale as `knownKeys`) |

### Dangling-command guard

A separate test asserts that every command in `EXPECTED_CONTRACTS` is present in the set of commands registered in `src-tauri/src/lib.rs`. The set is **parsed live** from the `tauri::generate_handler![...]` macro at test time — there is no hand-maintained copy to keep in sync. If a Rust command is renamed or removed, the guard turns red automatically.

**When you add a new contracted command:** add a row to `EXPECTED_CONTRACTS` in `tauri-commands.contract.test.ts`. No other change is needed — the parser picks up the new Rust registration automatically.

**When you rename or remove a Rust command:** update the wrapper function and `EXPECTED_CONTRACTS`. The guard will fail at test time to prompt you.

### Running

Contract tests are in-process (no Rust/native dependencies) and run as part of the default gate:

```bash
npm run verify:full   # includes contract tests
npm test              # includes contract tests
```

---

## 11. Flaky Test Quarantine

### How it works

1. Open a GitHub issue tagged `flaky-test` with a reproduction recipe.
2. Move the flaky test file (or describe block, if only part is flaky) to `src/__tests__/quarantine/`.
3. Add `// QUARANTINED: <issue-url> (YYYY-MM-DD)` as the **first line** of the file.
4. Run `npm run verify:full` and confirm it still passes (quarantine dir is excluded from the main gate).

### SLA: 4 weeks

A meta-test (`src/__tests__/quarantine-sla.test.ts`) runs inside the **main gate** and asserts that every quarantined file's date is within 4 weeks of the fixed `BASE_DATE` constant. If a file exceeds the SLA, the meta-test fails and CI is red until the file is fixed or deleted.

> `BASE_DATE` is a hardcoded constant (not `Date.now()`) to prevent time-based test flakiness. Update it in a dedicated "extend quarantine SLA" commit when the window is intentionally extended.

### Commands

```bash
npm run test:quarantine   # run quarantined tests in isolation (separate coverage thresholds)
npm run verify:full       # excludes quarantine/ but runs the SLA meta-test
```

### Coverage note

Quarantined tests are **not** counted toward coverage thresholds. Moving a test to quarantine may lower coverage. If it would push coverage below a committed threshold, stop and fix the coverage gap separately — never lower a threshold to accommodate a quarantined test.

### First-batch quarantine

`src/__tests__/quarantine/skillManageTool-cold-import.test.ts` documents the historical `skillManageTool` cold-import timing issue (see the comment in the quarantine file). The flakiness was fixed in-place in `skillManageTool.test.ts` via `vi.mock()` stubs; this quarantine file verifies the stubs remain load-bearing.

---

## 12. Tauri Native Smoke Tests (V2, gated)

### Status: V1 Skeleton — NOT in CI gate

Full documentation is in `docs/TAURI-SMOKE.md`. Summary:

| Item | Detail |
|---|---|
| Test files | `e2e/tauri-smoke/*.e2e.ts` (WebdriverIO, NOT Vitest) |
| Config | `wdio.conf.ts` at repo root |
| CI workflow | `.github/workflows/tauri-smoke.yml` — `workflow_dispatch` only, `continue-on-error: true` |
| Gate inclusion | **Not included** in `verify:full`, `npm test`, or any automatic PR gate |
| Docs | `docs/TAURI-SMOKE.md` — ⚠️ `docs/` is in `.gitignore`, so this file needs `git add -f docs/TAURI-SMOKE.md` to be committed |

### Why it can't run in CI yet (V1 blockers)

- `tauri-driver` does not support macOS (Linux/Windows only in Tauri 2.x).
- Requires a signed Tauri build bundle (only produced by `release.yml`).
- Core commands (`capture_screen`, `secret_get`) require OS permission grants unavailable in headless CI.
- No display environment on macOS CI runners.

### Vitest isolation guarantee

`*.e2e.ts` files are **not** picked up by Vitest because Vitest's `include` only matches `*.test.ts` / `*.test.tsx`. They also live in `e2e/tauri-smoke/`, outside `src/`, so they cannot accidentally enter the Vitest gate.

### V2 activation

See `docs/TAURI-SMOKE.md § V2 Activation Checklist` for the complete list of pre-conditions before setting `continue-on-error: false`.
