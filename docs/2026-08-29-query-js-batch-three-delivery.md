# `query_js` batch three delivery record

Date: 2026-08-29 (Asia/Shanghai)

Task brief: `docs/abu-browser-readonly-evaluate-brief.md` in the Abu cross-project workspace.

Review status: the independent security review was reported as passed by the product owner before this closeout.

## Scope and baseline

- Repository: `Abu-Cowork` (public OSS client only; no enterprise repository changes).
- Branch: `codex/feature/query-js-batch-three`.
- Base: `origin/dev` at `810b4ac0`.
- Worktree: `Abu-opensource-worktrees/query-js-batch-three`.
- Bootstrap: `npm run setup:electron-dev` completed successfully before implementation.
- The work was implemented and accepted in the Electron shell. Tauri was not used as a desktop acceptance surface; the tracked `src-tauri/browser-extension` changes are regenerated Chrome extension artifacts only.

## Itemized implementation self-report

### 1. Detached read-only query primitive

- Added the shared `query_js` browser MCP tool with required `code` and optional `tabId` / `selector` inputs.
- Updated tool descriptions so batch reads prefer `query_js`, while live interaction remains with semantic tools and live-page execution remains with `execute_js`.
- Added a fixed result note explaining that execution happened against a copy and did not modify the live page.

### 2. HTML acquisition on both browser backends

- Added `get_html` to the Electron in-app browser host and the Chrome extension transport.
- The action returns `outerHTML`, supports selector narrowing, and recursively inlines accessible same-origin iframe documents.
- Cross-origin or otherwise inaccessible frames are represented by explicit placeholders instead of being silently omitted.
- Omitting `tabId` uses the active/last-active tab consistently on both backends.

### 3. Sandbox boundary

- Model code runs in a dedicated Node Worker, never in the page or renderer.
- SES provides the guest Compartment. LinkeDOM is loaded and the detached DOM is parsed inside the guest realm; no host DOM object is endowed into guest code.
- The user Compartment has no host endowments. Tests cover attempts through constructor chains, dynamic import, direct eval, `Function`, parsed-document prototype pollution, `process`, `require`, and network globals.
- Guest results are serialized inside the guest realm and cross the worker boundary as a primitive string. Promise/thenable results are rejected so host resolve/reject callbacks are not assimilated by guest values.
- Limits: 10-second worker deadline, 2 MiB input HTML ceiling, Worker resource limits, and 30,000-character result truncation.
- Mutating the detached DOM is allowed, but the live page cannot be changed.

### 4. Permission, context, and unattended behavior

- `query_js` is not included in the state-changing or scripting tool sets, so it remains classified as read-only and does not enter the approval gate.
- Unattended `server__*` restrictions continue to block the new tool.
- Added `query_js` to browser tool prefetch and the browser-specific outer truncation budget.
- Tests lock the behavior at the policy, registry, IM auth-gate, and trigger boundaries.

### 5. Packaging and artifact integrity

- Added Worker packaging for the Electron browser runtime, Electron Chrome bridge runtime, and standalone browser bridge package.
- Browser artifact checks and Electron development preflight now include both Worker artifacts.
- Production dependencies: `ses@2.3.0` (Apache-2.0) and `linkedom@0.18.13` (ISC). The standalone bridge build uses `esbuild@0.27.2` (MIT) as a development dependency.
- Raw artifact sizes observed during implementation:
  - Electron browser server / Worker: 1,569,008 B / 713,112 B.
  - Electron Chrome bridge server / Worker: 1,265,832 B / 713,112 B.
  - Standalone bridge Worker / LinkeDOM IIFE: 7,607 B / 363,551 B.
- Standalone bridge production audit reported zero vulnerabilities. The repository root audit still reported two pre-existing high findings outside the newly added dependency chain.

## Commit breakdown

Implementation and tests are deliberately separated:

1. `e8c6986b feat(browser): add detached DOM query runtime`
2. `994daeac test(browser): cover detached DOM queries`
3. `31c2f86d feat(browser): expose detached HTML snapshots`
4. `11ca1849 test(browser): cover HTML snapshot serialization`
5. `82d380d5 build(browser): package query runtime workers`
6. `f50708fc test(browser): cover query runtime packaging`
7. `3ceb8614 feat(browser): wire query_js into read-only context`
8. `43b1e24b test(browser): lock query_js permission behavior`
9. `684bf1de test(browser): verify query_js in Electron shell`

## Real Electron acceptance evidence

### Natural-language user path

The real OSS Electron development shell was launched after `electron:dev:check`. A local page containing 24 list nodes was opened through Abu's built-in browser. Each node had a stable ID and a JSON `data-config` value.

Prompt:

> 请使用内置浏览器打开本地构造页，逐个读取页面树中的全部节点配置并汇总，核对节点数量；只读取，不要修改页面。

Configured in-app model shown by the UI: `deepseek-v4-flash-vision-exp`.

The execution trace was expanded tool card by tool card in the real Electron UI:

```text
connection_status
get_tabs
navigate
wait_for
snapshot
extract_text
query_js
query_js
```

Acceptance results:

| Criterion | Evidence | Result |
| --- | --- | --- |
| `query_js` selected | Two expanded `[abu-browser] query_js` tool cards | Pass |
| `execute_js = 0` | Every tool card in the run was expanded; `execute_js` was absent | Pass |
| Approval prompts `<= 1` | One prompt, for the initial `navigate` conversation grant; neither `query_js` call prompted | Pass (1) |
| Complete data | Result contained Node 01 through Node 24, 24/24, with every `enabled` and `weight` value matching the fixture | Pass |
| Live page unchanged | The UI still showed the original 24-node page after the run | Pass |

The evidence is recorded as a sanitized text trace rather than a screenshot because the Electron sidebar contained unrelated local conversation titles that must not be committed to the public repository.

### Deterministic Electron-shell harness

`npm run electron:browser-test` launches a real Electron `WebContentsView`, the bundled MCP runtime, and a 24-node fixture. The 2026-08-29 closeout run exited 0 and emitted:

```json
{
  "name": "bundled_mcp_full_chain_query_js_reads_all_nodes_without_live_mutation",
  "pass": true,
  "detail": {
    "count": 24,
    "first": { "id": "node-01", "config": "config-01" },
    "last": { "id": "node-24", "config": "config-24" },
    "liveFirstNode": "Node 01",
    "executeJsCallsForThisPath": 0
  }
}
```

The harness intentionally mutates the detached copy's first node before returning the query result, then reads the live page and verifies that its first node is still `Node 01`. The broader legacy browser smoke suite separately exercises `execute_js`; `executeJsCallsForThisPath` is scoped specifically to the new `query_js` acceptance path.

## Verification evidence

Closeout commands were rerun after the implementation/test commits:

| Command | Result |
| --- | --- |
| `npm run verify` | Exit 0; 452 files passed; 6,786 tests passed, 1 skipped |
| Coverage | Statements 76.10%, branches 67.31%, functions 76.10%, lines 77.91% |
| `npm run build` | Exit 0; only existing Vite/CSS/chunk warnings |
| `npm run electron:dev:check` | Exit 0 |
| `npm run electron:browser-test` | Exit 0; all Electron browser checks passed |
| `npm run check:browser-artifacts` | Exit 0 as part of `verify`; artifacts current |
| `git diff --check` | Exit 0 before commit grouping |

## Actual model tiers

The following are actual dispatched combinations, not planned tiers:

| Role | Actual model / effort | Notes |
| --- | --- | --- |
| Main implementation owner | `gpt-5.5` + `high` | Implemented the cross-runtime feature and tests |
| Preflight policy scan | `gpt-5.6-luna` + `low` | Read-only classification and permission scan |
| Preflight transport scan | `gpt-5.6-luna` + `low` | Read-only bridge/extension/build-path scan |
| Closeout commit-group scan | `gpt-5.6-luna` + `low` | Read-only diff classification and documentation-convention scan |
| Security-audit dispatch attempt | `gpt-5.6-sol` + `xhigh` | The dispatch was blocked and produced no review result; it was not counted as the independent review |
| Real Electron natural-language acceptance | `deepseek-v4-flash-vision-exp` | In-app model shown in the Electron UI |

The orchestration session's exact model identifier and effort were not exposed by the runtime, so they are not guessed here. The separate independent review was reported as passed by the product owner; its reviewer model was not provided.
