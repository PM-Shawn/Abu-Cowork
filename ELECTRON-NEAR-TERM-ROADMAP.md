# Electron Near-Term Roadmap

Date: 2026-07-27

Status: approved for staged development. Branch 1 implementation and local
macOS verification are complete, but remain uncommitted pending user review.
Windows package verification is still required. This is not release approval.

Base branch: `refactor-dev`

## Outcome

A clean macOS or Windows computer with no system Node.js or Python can install
Abu and immediately run chat tasks, office-file tools, browser automation, and
sandboxed commands. Stopping a task terminates its whole process tree. Core
features do not depend on `npx ...@latest` or an unverified host runtime.

The older Tauri implementation remains available as a compatibility reference
until Electron user-journey parity is proven. Do not delete or rewrite it as
part of this roadmap.

## Delivery Order

| Order | Branch | User outcome | Scope | Primary model |
|---|---|---|---|---|
| 1 | `feat/electron-security-boundaries` | Untrusted pages and paths cannot reach privileged APIs or escape authorized roots | navigation/popup guards, trusted IPC sender validation, canonical filesystem boundaries, negative tests | plan/review: `gpt-5.6-sol` `xhigh`; build: `gpt-5.5` `high` |
| 2 | `feat/electron-sandbox-launcher` | Stopped or timed-out tasks leave no child processes and commands run inside an OS boundary | signed launcher, macOS Seatbelt, Windows restricted process/Job Object, process-tree termination | plan/review: `gpt-5.6-sol` `xhigh`; build: `gpt-5.5` `high` |
| 3 | `feat/electron-bundled-runtime` | Users do not install Node.js or Python | pinned Node/npm/npx, Python office/PDF packages, runtime resolver, updater dependency closure, licenses and signing manifest | build: `gpt-5.5` `high`; bounded tests/docs: `gpt-5.6-terra` `medium` |
| 4 | `feat/electron-browser-runtime` | Browser automation works after installation | built-in browser as default, isolated persistent session, pinned local browser bridge, optional Chrome extension mode | plan/review: `gpt-5.6-sol` `xhigh`; build: `gpt-5.5` `high` |
| 5 | `feat/electron-packaged-runtime-e2e` | The real installer proves the above on a clean environment | no-host-runtime tests, office/PDF/browser flows, stop/timeout tree tests, updater load, macOS and Windows package checks | tests: `gpt-5.6-terra` `high`; review: `gpt-5.6-sol` `xhigh` |

Each branch starts from the then-current `refactor-dev`, stays in an isolated
worktree, and is committed or merged only after explicit user approval.

## Current Progress

`feat/electron-security-boundaries` now has:

- exact local-page registration, main-frame IPC sender checks, and
  navigation/popup/webview denial;
- per-window command and event allowlists for main, pet, overlay, and stop;
- canonical filesystem scope enforcement plus exclusive temporary writes and
  symlink-safe cross-device restore;
- resource ownership and renderer-reload cleanup for events, file watches, and
  global shortcuts;
- command-aware IPC size/type validation compatible with the real Tauri fs and
  HTTP request shapes;
- 32 focused security tests, real Electron boot/HTTP/shortcut/E2E checks, the
  full 4518-test suite, and a packaged macOS smoke run.

The branch is not committed or merged. A real Windows boot/package smoke remains
an attended acceptance check; unit coverage for drive-letter and UNC paths is
present but is not a substitute for that machine check.

## Package Baseline

The Electron package should include:

- Electron's existing Chromium runtime; do not add a second Chromium yet.
- pinned Node.js LTS with npm and npx;
- pinned Python with `python-docx`, `python-pptx`, `openpyxl`, Pillow,
  `pdfplumber`, and the other dependencies actually used by registered tools;
- a pinned local Abu browser bridge and built Chrome extension assets;
- the signed sandbox launcher and native helper;
- `electron-updater` with its complete runtime dependency closure;
- built-in skills, agents, required small utilities, licenses, checksums, and
  signing metadata.

Chrome-extension control is optional for existing user tabs. The zero-setup
default is Abu's isolated built-in browser. A second Playwright Chromium is
deferred until a concrete unattended-browser requirement proves that Electron's
bundled Chromium is insufficient.

## Acceptance Gates

Every branch must run the smallest relevant unit tests plus:

```bash
npm run parity:check
npm run typecheck
npm run lint
npm test
npm run electron:test
```

Packaging or runtime branches also run:

```bash
npm run pack:electron
npm run smoke:electron:packaged
```

Automated tests do not prove TCC prompts, real computer input, Windows behavior,
signed updates, or visual composition. Those remain explicit attended checks.

## Deferred

- `feat/creation-workbench`
- `feat/browser-inspect`
- product Memory expansion
- Linux distribution
- a second bundled Chromium
- public release and update-feed publication

## Model Routing Evidence

OpenAI documents `gpt-5.6-sol` as the flagship for complex reasoning and coding,
`gpt-5.6-terra` as the balanced everyday tier, and `gpt-5.6-luna` as the fast
high-volume tier. It recommends raising effort to `high` or `xhigh` only when a
representative workload shows a quality gain. GitHub Copilot similarly routes
Auto by task complexity and service availability, then uses a separate review
and security-validation step for generated code.

References:

- https://developers.openai.com/api/docs/models
- https://developers.openai.com/api/docs/guides/latest-model
- https://openai.com/index/gpt-5-6/
- https://docs.github.com/en/copilot/concepts/models/auto-model-selection
- https://docs.github.com/en/copilot/concepts/agents/code-review
