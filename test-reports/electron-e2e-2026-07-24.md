# Electron E2E / Automated Test Report — 2026-07-24

- **Branch**: `feat/electron-shell-p2-1` (`cfddb3a`)
- **Generated**: 2026-07-24T12:43:06.706Z
- **Generator**: `scripts/e2e-report.mjs`

## Summary

| Suite | Result | Passed/Failed | Duration |
|---|---|---|---|
| vitest (unit/integration) | PASS | 4493 passed / 0 failed / 0 skipped (of 4493) | 55.2s |
| Electron headless harnesses (safe subset) | PASS | 17 passed / 0 failed-or-timeout (of 17) | 67.1s |
| Skipped harnesses (GUI/TCC/heavy-boot) | SKIP | 0 run / 8 skipped | — |

## 1. Unit/integration suite (`npx vitest run`)

Result: **PASS** (exit code 0, 55.2s)

- Test Files: 308 passed (308)
- Tests: 4493 passed (4493)

<details><summary>vitest output tail</summary>

```
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8193) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8192) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8194) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8195) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8196) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8197) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8200) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8202) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8203) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8208) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8212) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8215) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8216) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8217) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8219) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8221) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8222) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8223) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8224) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8225) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8226) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8228) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8229) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8231) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8233) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:8234) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)

 Test Files  308 passed (308)
      Tests  4493 passed (4493)
   Start at  20:41:04
   Duration  54.14s (transform 12.44s, setup 75.48s, import 48.81s, tests 16.11s, environment 153.64s)


```

</details>

## 2. Headless Electron harnesses (best-effort, safe subset)

Each harness spawns its own Electron process running `electron/spike/<name>.cjs`,
asserts internally, and exits non-zero on failure. Run sequentially with a
90s per-harness hard kill timeout (this machine has no `timeout` binary).

| Harness | Result | Exit code | Duration |
|---|---|---|---|
| `f1aE2E.cjs` | PASS | 0 | 835ms |
| `f1HeartbeatE2E.cjs` | PASS | 0 | 51.7s |
| `shellGlobalShortcutVerify.cjs` | PASS | 0 | 558ms |
| `deepLinkVerify.cjs` | PASS | 0 | 699ms |
| `f2Verify.cjs` | PASS | 0 | 630ms |
| `f3Verify.cjs` | PASS | 0 | 1.4s |
| `f4Verify.cjs` | PASS | 0 | 1.5s |
| `f6Verify.cjs` | PASS | 0 | 746ms |
| `f7Verify.cjs` | PASS | 0 | 774ms |
| `f9Verify.cjs` | PASS | 0 | 1.1s |
| `f13Verify.cjs` | PASS | 0 | 254ms |
| `f1bVerify.cjs` | PASS | 0 | 154ms |
| `f14Verify.cjs` | PASS | 0 | 4.3s |
| `httpVerify.cjs` | PASS | 0 | 536ms |
| `reviewFixVerify.cjs` | PASS | 0 | 870ms |
| `migrationVerify.cjs` | PASS | 0 | 320ms |
| `updaterVerify.cjs` | PASS | 0 | 816ms |

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

**PASS** — vitest suite and all 17 run harnesses succeeded (8 harnesses intentionally skipped, see above).
