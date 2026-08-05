# Abu Client: Codex Working Guide

This repository is the public Abu client. Treat the checked-out code and Git
state as the source of truth. Historical reports and old agent instructions
are useful evidence, not current status.

## Scope and Git Safety

- `dev` is the only active integration line. Start every feature/fix branch
  from the latest `origin/dev` and merge verified work back into `dev`.
- `main` is a stable release pointer, not a second development line. It may
  only fast-forward to the exact commit already verified on `dev`.
- `refactor-dev` and the older Electron feature worktrees are historical. Do
  not start new work from them. Some historical worktrees still contain
  user-owned reports, generated files, or uncommitted material; preserve them
  until the user explicitly approves an archival or deletion policy.
- Check `git status --short` and the current branch before making changes. This
  worktree currently contains user-owned uncommitted material; preserve it.
- Do not commit or push unless the user explicitly asks. Do not force-push,
  reset, discard, delete, or move files without explicit approval.
- Do not work directly on `main`. Release promotion remains a deliberate,
  user-authorized fast-forward from `dev`, not an ordinary development action.

## Model Allocation

Use the smallest model tier that can safely complete the current stage. The
point is to spend advanced reasoning where judgment matters, not to make every
small edit expensive.

- **Planner/reviewer:** `gpt-5.6-sol` with `xhigh` reasoning. Use it for
  architecture, Electron/Tauri migration decisions, security or permission
  boundaries, data migration, release/update design, difficult regressions, and
  final review of high-risk changes. Reserve `max` for measured exceptions.
- **Complex builder:** `gpt-5.5` with `high` reasoning. Use it for cross-boundary
  renderer/main/sidecar work, native process handling, concurrency, packaging,
  and implementation of an already-approved security design.
- **Routine builder:** `gpt-5.6-terra` with `medium` reasoning, raised to `high`
  for broader debugging. Use it for bounded implementation, tests, config, and
  documentation after acceptance checks are clear.
- **Scout:** `gpt-5.6-luna` with `low` reasoning, or `gpt-5.4-mini` with `low`
  when Luna is unavailable. It may only do read-only inventory, locating code,
  summarizing logs, and simple classification. It must not make architecture,
  security, deletion, release, or public/private boundary decisions.
- Before handing implementation to a standard model, the advanced model should
  leave a short task brief: desired user outcome, non-goals, files/boundaries
  likely involved, safety constraints, and concrete acceptance checks.
- The builder must report changed files, test results, and unresolved uncertainty.
  For risky work, the advanced model then reviews the result against the brief
  and actual code; it does not trust a self-report alone.
- Escalate from builder to advanced model after two unsuccessful fix attempts,
  when a change crosses renderer/main/sidecar boundaries, when permissions or
  user data are involved, or when the next action could be irreversible.
- Do not let multiple models edit the same files in the same worktree at once.
  Parallel scouts may inspect code read-only; implementation stays with one
  owner until its verification is complete.
- For a small, well-understood fix, one standard model may both plan and build.
  Do not add a planning pass just for ceremony.
- Explicitly record the model and reasoning effort when delegating. Never use
  stale Claude aliases such as `opus`, `sonnet`, or `haiku` in Codex tasks.

## Public/Open-Core Boundary

- `Abu-opensource` is a public Apache-2.0 repository. Never commit credentials,
  private URLs, internal business data, or content from `.env.local` files.
- All enterprise client implementation belongs only in the sibling private
  repository `Abu-enterprise-modules`, including authentication, heartbeat,
  policy, gateway routing, organization state, and enterprise UI. This public
  repository may contain neutral interfaces, extension points, compile-time
  bridges, and no-op stubs, but not executable enterprise workflows.
- Before changing enterprise behavior, read `docs/ENTERPRISE-BUILD.md` and keep
  the public/private split intact. Passing tests do not prove that no private
  code has leaked.
- Do not build a distributable application from a machine environment that has
  `VITE_*` secrets configured. Those values can be embedded in renderer assets.

## Electron-Only Development Architecture

- Electron is the only desktop shell for new feature development, debugging,
  and acceptance. `src-tauri/` remains only for compatibility with already
  shipped versions, migration, and rollback evidence. Never use a Tauri launch
  or build as evidence that a new feature is complete. The important boundaries are:
  - `src/`: React renderer and product logic.
  - `electron/main.cjs`: Electron main-process lifecycle and native services.
  - `electron/preload.cjs`: the narrow, safe renderer bridge.
  - `electron/tauriHost.cjs`: compatibility implementation for existing
    Tauri-shaped renderer calls.
  - `sidecar/`: Node sidecar that hosts agent/runtime work.
  - `electron/native-helper/`: narrowly scoped native macOS helper.
- Do not grant the renderer direct Node.js, filesystem, shell, or process
  access. Add capabilities through preload/main/sidecar boundaries and keep
  inputs validated at the privileged boundary.
- Node built-ins are appropriate in `electron/` and `sidecar/` when needed.
  They are not a reason to add direct privileged imports to `src/`.
- Tauri/Rust is a frozen compatibility and migration path. Preserve it where
  transition behavior still depends on it, but do not add new product behavior
  there and do not run it for normal development or acceptance.
- `src-tauri/gen/` contains generated output. Change its source configuration
  first and regenerate when required; do not casually hand-edit or discard a
  generated diff.

## Product and Code Conventions

- Keep user-facing UI strings in the i18n system. Update both supported locales
  and the typed translation shape when adding text.
- Use strict TypeScript. Prefer precise types and discriminated unions over
  `any`, runtime `enum`, or `namespace`.
- Use the existing `@/` aliases, feature-local tests, Zustand store conventions,
  and components in `src/components/ui/`. Do not hand-roll one-off form controls
  when the shared component can be extended.
- Preserve persistence compatibility: a persisted Zustand schema change needs a
  version bump, migration, and the relevant store-version test update.
- Keep macOS and Windows behavior in mind for paths, keyboard shortcuts,
  shell behavior, permissions, and destructive file operations.
- Treat review findings as hypotheses. Verify them against the actual code and
  a reproducible behavior before changing product code.

## Validation

Run the smallest relevant checks while developing. Before handing off a
meaningful Electron change, run the applicable commands below:

```bash
npm run parity:check
npm run typecheck
npm run lint
npm test
npm run build
```

For Electron-shell, packaging, or release changes, additionally use the
relevant command:

```bash
npm run setup:electron-dev # once per worktree, or after package-lock changes
npm run setup:electron-dev:enterprise # enterprise worktrees
npm run electron:test
npm run test:e2e:electron
npm run pack:electron
npm run smoke:electron:packaged
```

`npm run setup:electron-dev` and `npm run setup:electron-dev:enterprise`
prepare worktree-local dependencies, bundled runtimes, generated bridges,
native helpers, and the correctly targeted renderer. `npm run electron:dev`
and `npm run electron:dev:enterprise` run preflight and rebuild their own
renderer target before launch, so a stale OSS/Enterprise renderer cannot be
mistaken for the other edition. Preflight never downloads a temporary Electron
through `npx`. Keep each active worktree's `node_modules` local when installing:
the setup command deliberately refuses
to run through a symlink because `npm ci` could otherwise mutate another
worktree's dependencies.

Packaging, signing, updater, permissions, and cross-platform behavior require
real application verification; a green unit-test suite alone is insufficient.
Do not publish update feeds or release artifacts without explicit user approval.

Before claiming a desktop feature complete, record evidence from the real
Electron shell and affected user journey. Browser previews, unit tests, and
renderer builds are supporting gates, not desktop acceptance.

## Current Migration Priorities

- Keep functional parity between the renderer's existing API surface and the
  Electron host. `npm run parity:check` is the static guard, not a substitute
  for real workflow tests.
- Treat updater end-to-end behavior, Windows validation, packaged preview
  inspection, and macOS computer-use/TCC permission behavior as post-release
  evidence that still needs real-machine verification.
- The untracked `*-REPORT.md` files and `RUNTIME-LANDING-RUNBOOK.md` in this
  worktree are historical development records. Leave them in place unless the
  user explicitly chooses an archival policy. Do not blindly add them to the
  public repository, and do not rely on their old branch/status statements.

## Communication

- State the user-visible outcome and verification status clearly.
- Surface uncertainty, safety implications, and choices that would change
  product behavior or release scope before taking irreversible action.
- Make focused changes. Avoid unrelated refactors while completing a task.
