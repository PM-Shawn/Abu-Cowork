# Electron E2E / Automated Test Report — 2026-07-24

- **Branch**: `feat/electron-shell-p2-1` (`7a1b976`)
- **Generated**: 2026-07-24T11:40:54.311Z
- **Generator**: `scripts/e2e-report.mjs`

## Summary

| Suite | Result | Passed/Failed | Duration |
|---|---|---|---|
| vitest (unit/integration) | PASS | 4493 passed / 0 failed / 0 skipped (of 4493) | 64.0s |
| Electron headless harnesses (safe subset) | PASS | 16 passed / 0 failed-or-timeout (of 16) | 66.5s |
| Skipped harnesses (GUI/TCC/heavy-boot) | SKIP | 0 run / 8 skipped | — |

## 1. Unit/integration suite (`npx vitest run`)

Result: **PASS** (exit code 0, 64.0s)

- Test Files: 308 passed (308)
- Tests: 4493 passed (4493)

<details><summary>vitest output tail</summary>

```
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92628) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92632) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92630) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92633) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92634) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92636) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92637) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92638) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92640) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92639) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92641) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92644) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92645) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92646) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92647) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92648) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92649) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92650) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92651) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92652) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92653) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92654) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92655) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92656) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92657) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:92658) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)

 Test Files  308 passed (308)
      Tests  4493 passed (4493)
   Start at  19:38:45
   Duration  61.83s (transform 19.68s, setup 84.03s, import 63.58s, tests 20.92s, environment 171.23s)


```

</details>

## 2. Headless Electron harnesses (best-effort, safe subset)

Each harness spawns its own Electron process running `electron/spike/<name>.cjs`,
asserts internally, and exits non-zero on failure. Run sequentially with a
90s per-harness hard kill timeout (this machine has no `timeout` binary).

| Harness | Result | Exit code | Duration |
|---|---|---|---|
| `f1aE2E.cjs` | PASS | 0 | 1.2s |
| `f1HeartbeatE2E.cjs` | PASS | 0 | 51.7s |
| `shellGlobalShortcutVerify.cjs` | PASS | 0 | 590ms |
| `deepLinkVerify.cjs` | PASS | 0 | 751ms |
| `f2Verify.cjs` | PASS | 0 | 657ms |
| `f3Verify.cjs` | PASS | 0 | 1.4s |
| `f4Verify.cjs` | PASS | 0 | 1.5s |
| `f6Verify.cjs` | PASS | 0 | 747ms |
| `f7Verify.cjs` | PASS | 0 | 775ms |
| `f9Verify.cjs` | PASS | 0 | 1.1s |
| `f13Verify.cjs` | PASS | 0 | 267ms |
| `f1bVerify.cjs` | PASS | 0 | 155ms |
| `f14Verify.cjs` | PASS | 0 | 4.0s |
| `httpVerify.cjs` | PASS | 0 | 502ms |
| `reviewFixVerify.cjs` | PASS | 0 | 860ms |
| `migrationVerify.cjs` | PASS | 0 | 301ms |

## 3. Skipped (not run — need GUI / TCC-Screen-Recording / heavy boot)

| Harness | Reason not run |
|---|---|
| `f8GuiVerify.cjs` | tray/pet/overlay visual assertions — needs a real GUI/display |
| `f10CuVerify.cjs` | computer-use control loop — needs Screen-Recording/TCC permission |
| `f10AxVerify.cjs` | Accessibility (AX) API probing — needs Accessibility/TCC permission |
| `f10IntVerify.cjs` | computer-use integration — needs Screen-Recording/TCC permission |
| `f10TccProbe.cjs` | directly probes TCC permission state — needs interactive grant |
| `f10HelperLoop.cjs` | native helper loop for computer-use — needs Screen-Recording/TCC permission |
| `devSmoke.cjs` | heavy full dev-mode boot smoke test — too slow/flaky unattended |
| `bootSpike.cjs` | heavy full boot spike — too slow/flaky unattended |

These do not count against the overall verdict — they are an honest coverage gap,
not a failure, and running them unattended would hang or false-fail (no display /
no interactive TCC grant in this environment).

## Overall verdict

**PASS** — vitest suite and all 16 run harnesses succeeded (8 harnesses intentionally skipped, see above).
