# Abu Client: Codex Working Guide

This worktree is the Electron-first integration line for the public Abu client.
Treat the checked-out code and Git state as the source of truth. Historical
reports and old agent instructions are useful evidence, not current status.

## Scope and Git Safety

- The current integration branch is `refactor-dev`. Do Electron work here or
  from a focused branch based on it. The older `feat/electron-shell-p2-1`
  worktree has already been merged and is historical.
- Check `git status --short` and the current branch before making changes. This
  worktree currently contains user-owned uncommitted material; preserve it.
- Do not commit or push unless the user explicitly asks. Do not force-push,
  reset, discard, delete, or move files without explicit approval.
- Do not work directly on `main`. Release promotion remains a deliberate merge
  decision, not an agent action.

## Model Allocation

Use the smallest model tier that can safely complete the current stage. The
point is to spend advanced reasoning where judgment matters, not to make every
small edit expensive.

- **Advanced model (planner/reviewer):** use for architecture, Electron/Tauri
  migration decisions, security or permission boundaries, data migration,
  release/update design, ambiguous product requests, difficult regressions, and
  final review of high-risk changes.
- **Standard coding model (builder):** use for bounded implementation after the
  goal, constraints, affected areas, and acceptance checks are clear. It owns
  focused code changes, tests, and the relevant local verification.
- **Lightweight model (scout):** use only for read-only inventory, locating code,
  summarizing logs, formatting, or straightforward documentation extraction. It
  must not make architecture, security, deletion, release, or public/private
  boundary decisions.
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

## Public/Open-Core Boundary

- `Abu-opensource` is a public Apache-2.0 repository. Never commit credentials,
  private URLs, internal business data, or content from `.env.local` files.
- Closed-source enterprise implementation belongs only in the sibling private
  repository `Abu-enterprise-modules`. This repository may contain public
  interfaces, extension points, protocol types, and no-op stubs, but not the
  private implementation.
- Before changing enterprise behavior, read `docs/ENTERPRISE-BUILD.md` and keep
  the public/private split intact. Passing tests do not prove that no private
  code has leaked.
- Do not build a distributable application from a machine environment that has
  `VITE_*` secrets configured. Those values can be embedded in renderer assets.

## Electron-First Architecture

- Electron is the target desktop shell. The important boundaries are:
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
- Tauri/Rust is still a compatibility and migration path. Preserve behavior
  until Electron parity is proven; do not remove Tauri code simply because an
  Electron equivalent exists.
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
npm run electron:test
npm run test:e2e:electron
npm run pack:electron
npm run smoke:electron:packaged
```

Packaging, signing, updater, permissions, and cross-platform behavior require
real application verification; a green unit-test suite alone is insufficient.
Do not publish update feeds or release artifacts without explicit user approval.

## Current Migration Priorities

- Keep functional parity between the renderer's existing API surface and the
  Electron host. `npm run parity:check` is the static guard, not a substitute
  for real workflow tests.
- Treat updater end-to-end behavior, Windows validation, packaged preview
  inspection, and macOS computer-use/TCC permission behavior as release-readiness
  work that still needs real-machine verification.
- The untracked `*-REPORT.md` files and `RUNTIME-LANDING-RUNBOOK.md` in this
  worktree are historical development records. Leave them in place unless the
  user explicitly chooses an archival policy. Do not blindly add them to the
  public repository, and do not rely on their old branch/status statements.

## Communication

- State the user-visible outcome and verification status clearly.
- Surface uncertainty, safety implications, and choices that would change
  product behavior or release scope before taking irreversible action.
- Make focused changes. Avoid unrelated refactors while completing a task.
