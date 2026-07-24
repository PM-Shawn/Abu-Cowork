# Electron E2E / Automated Test Report — 2026-07-24

- **Branch**: `feat/electron-shell-p2-1` (`0c5987e`)
- **Generated**: 2026-07-24T02:00:23.136Z
- **Generator**: `scripts/e2e-report.mjs`

## Summary

| Suite | Result | Passed/Failed | Duration |
|---|---|---|---|
| vitest (unit/integration) | PASS | 4465 passed / 0 failed / 0 skipped (of 4465) | 49.3s |
| Electron headless harnesses (safe subset) | PASS | 13 passed / 0 failed-or-timeout (of 13) | 64.4s |
| Skipped harnesses (GUI/TCC/heavy-boot) | SKIP | 0 run / 8 skipped | — |

## 1. Unit/integration suite (`npx vitest run`)

Result: **PASS** (exit code 0, 49.3s)

- Test Files: 306 passed (306)
- Tests: 4465 passed (4465)

<details><summary>vitest output tail</summary>

```
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61552) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61553) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61556) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61559) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61560) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61562) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61563) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61564) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61565) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61566) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61567) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61568) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61569) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61570) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61574) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61573) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61576) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61577) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61578) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61579) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61580) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61581) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61582) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61583) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61584) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:61586) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)

 Test Files  306 passed (306)
      Tests  4465 passed (4465)
   Start at  09:58:29
   Duration  48.46s (transform 11.70s, setup 65.41s, import 44.70s, tests 15.26s, environment 135.19s)


```

</details>

## 2. Headless Electron harnesses (best-effort, safe subset)

Each harness spawns its own Electron process running `electron/spike/<name>.cjs`,
asserts internally, and exits non-zero on failure. Run sequentially with a
90s per-harness hard kill timeout (this machine has no `timeout` binary).

| Harness | Result | Exit code | Duration |
|---|---|---|---|
| `f1aE2E.cjs` | PASS | 0 | 699ms |
| `f1HeartbeatE2E.cjs` | PASS | 0 | 51.6s |
| `f2Verify.cjs` | PASS | 0 | 634ms |
| `f3Verify.cjs` | PASS | 0 | 1.4s |
| `f4Verify.cjs` | PASS | 0 | 1.5s |
| `f6Verify.cjs` | PASS | 0 | 777ms |
| `f7Verify.cjs` | PASS | 0 | 752ms |
| `f9Verify.cjs` | PASS | 0 | 1.1s |
| `f13Verify.cjs` | PASS | 0 | 234ms |
| `f1bVerify.cjs` | PASS | 0 | 158ms |
| `f14Verify.cjs` | PASS | 0 | 4.2s |
| `httpVerify.cjs` | PASS | 0 | 476ms |
| `reviewFixVerify.cjs` | PASS | 0 | 856ms |

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

**PASS** — vitest suite and all 13 run harnesses succeeded (8 harnesses intentionally skipped, see above).
