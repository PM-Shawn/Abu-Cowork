# Electron E2E / Automated Test Report — 2026-07-24

- **Branch**: `feat/electron-shell-p2-1` (`01b544f`)
- **Generated**: 2026-07-24T11:18:32.117Z
- **Generator**: `scripts/e2e-report.mjs`

## Summary

| Suite | Result | Passed/Failed | Duration |
|---|---|---|---|
| vitest (unit/integration) | PASS | 4491 passed / 0 failed / 0 skipped (of 4491) | 66.1s |
| Electron headless harnesses (safe subset) | PASS | 16 passed / 0 failed-or-timeout (of 16) | 66.6s |
| Skipped harnesses (GUI/TCC/heavy-boot) | SKIP | 0 run / 8 skipped | — |

## 1. Unit/integration suite (`npx vitest run`)

Result: **PASS** (exit code 0, 66.1s)

- Test Files: 308 passed (308)
- Tests: 4491 passed (4491)

<details><summary>vitest output tail</summary>

```
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86638) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86639) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86641) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86642) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86643) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86645) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86646) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86647) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86648) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86649) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86650) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86652) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86654) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86655) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86656) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86659) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86658) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86660) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86661) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86662) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86665) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86666) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86667) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86668) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86669) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:86670) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)

 Test Files  308 passed (308)
      Tests  4491 passed (4491)
   Start at  19:16:21
   Duration  63.74s (transform 23.77s, setup 87.63s, import 63.57s, tests 24.14s, environment 175.52s)


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
| `shellGlobalShortcutVerify.cjs` | PASS | 0 | 543ms |
| `deepLinkVerify.cjs` | PASS | 0 | 758ms |
| `f2Verify.cjs` | PASS | 0 | 648ms |
| `f3Verify.cjs` | PASS | 0 | 1.4s |
| `f4Verify.cjs` | PASS | 0 | 1.5s |
| `f6Verify.cjs` | PASS | 0 | 734ms |
| `f7Verify.cjs` | PASS | 0 | 762ms |
| `f9Verify.cjs` | PASS | 0 | 1.1s |
| `f13Verify.cjs` | PASS | 0 | 251ms |
| `f1bVerify.cjs` | PASS | 0 | 158ms |
| `f14Verify.cjs` | PASS | 0 | 4.2s |
| `httpVerify.cjs` | PASS | 0 | 496ms |
| `reviewFixVerify.cjs` | PASS | 0 | 874ms |
| `migrationVerify.cjs` | PASS | 0 | 299ms |

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
