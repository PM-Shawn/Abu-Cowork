# Electron E2E / Automated Test Report — 2026-07-24

- **Branch**: `feat/electron-shell-p2-1` (`f4e3c20`)
- **Generated**: 2026-07-23T19:15:38.953Z
- **Generator**: `scripts/e2e-report.mjs`

## Summary

| Suite | Result | Passed/Failed | Duration |
|---|---|---|---|
| vitest (unit/integration) | PASS | 4460 passed / 0 failed / 0 skipped (of 4460) | 53.6s |
| Electron headless harnesses (safe subset) | FAIL | 10 passed / 2 failed-or-timeout (of 12) | 129.9s |
| Skipped harnesses (GUI/TCC/heavy-boot) | SKIP | 0 run / 8 skipped | — |

## 1. Unit/integration suite (`npx vitest run`)

Result: **PASS** (exit code 0, 53.6s)

- Test Files: 306 passed (306)
- Tests: 4460 passed (4460)

<details><summary>vitest output tail</summary>

```
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53434) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53435) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53436) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53437) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53438) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53439) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53440) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53441) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53442) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53443) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53445) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53444) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53448) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53449) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53450) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53451) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53452) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53453) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53454) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53457) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53460) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53463) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53464) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53465) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53466) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
(node:53467) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)

 Test Files  306 passed (306)
      Tests  4460 passed (4460)
   Start at  03:12:35
   Duration  52.62s (transform 12.03s, setup 73.36s, import 47.14s, tests 15.53s, environment 148.67s)


```

</details>

## 2. Headless Electron harnesses (best-effort, safe subset)

Each harness spawns its own Electron process running `electron/spike/<name>.cjs`,
asserts internally, and exits non-zero on failure. Run sequentially with a
60s per-harness hard kill timeout (this machine has no `timeout` binary).

| Harness | Result | Exit code | Duration |
|---|---|---|---|
| `f1aE2E.cjs` | PASS | 0 | 1.2s |
| `f2Verify.cjs` | PASS | 0 | 593ms |
| `f3Verify.cjs` | PASS | 0 | 1.4s |
| `f4Verify.cjs` | PASS | 0 | 1.5s |
| `f6Verify.cjs` | PASS | 0 | 774ms |
| `f7Verify.cjs` | PASS | 0 | 764ms |
| `f9Verify.cjs` | PASS | 0 | 1.1s |
| `f13Verify.cjs` | PASS | 0 | 243ms |
| `f1bVerify.cjs` | TIMEOUT | 1 | 60.0s |
| `f14Verify.cjs` | TIMEOUT | 1 | 60.0s |
| `httpVerify.cjs` | PASS | 0 | 996ms |
| `reviewFixVerify.cjs` | PASS | 0 | 1.2s |

<details><summary>Failed/timed-out harness output tails</summary>

**f1bVerify.cjs** (TIMEOUT, exit=1):
```
[f1b-verify] PASS — catalog_upsert_conversation does not throw / MISS
[f1b-verify] PASS — catalog_get_conversation returns the upserted row (fields match) ({"conv_id":"conv-verify-1","title":"你好世界的会话","created_at":1784834016471,"updated_at":1784834016471,"message_count":1,"last_message_id":null,"model":"{\"providerId\":\"anthropic\",\"modelId\":\"claude\"}","source_bytes":0,"source_mtime":null,"missing":false})
[f1b-verify] PASS — catalog_bump_count does not throw
[f1b-verify] PASS — catalog_bump_count reflects: message_count 1+2=3, last_message_id updated ({"conv_id":"conv-verify-1","title":"你好世界的会话","created_at":1784834016471,"updated_at":1784834017471,"message_count":3,"last_message_id":"m2","model":"{\"providerId\":\"anthropic\",\"modelId\":\"claude\"}","source_bytes":0,"source_mtime":null,"missing":false})
[f1b-verify] PASS — catalog_reindex_conversation derives message_count from JSONL ({"conv_id":"conv-verify-fixture","title":"你好世界这是搜索测试","created_at":1784834016478,"updated_at":1784834016578,"message_count":2,"last_message_id":"m2","model":null,"source_bytes":186,"source_mtime":1784834016478,"missing":false})
[f1b-verify] PASS — 3-char+ CJK query MATCHes the upserted conversation ([{"conv_id":"conv-verify-fixture","title":"你好世界这是搜索测试","snippet":"user: \u0002你好世界\u0003这是搜索测试\nassistant: sure, …","rank":-0.0000018333333333333335}])
[f1b-verify] PASS — non-matching query returns no hits for this conv ([])
[f1b-verify] PASS — catalog_reconcile runs without throwing and reports stats ({"scanned_dirs":1,"upserted":0,"marked_missing":1,"corrupt_lines_skipped":0})
[f1b-verify] PASS — catalog_reconcile leaves the fixture conversation intact (not marked missing) ({"conv_id":"conv-verify-fixture","title":"你好世界这是搜索测试","created_at":1784834016478,"updated_at":1784834016578,"message_count":2,"last_message_id":"m2","model":null,"source_bytes":186,"source_mtime":1784834016478,"missing":false})
[f1b-verify] PASS — catalog_list_conversations does not throw and returns an array (len=1)
[f1b-verify] PASS — catalog_get_sync_state reflects reconcile having run (initial_build_complete=true) ({"initial_build_complete":true,"observation_sequence":1,"schema_version":1})
[f1b-verify] PASS — catalog_bump_observation_sequence returns an incremented number (2)
[f1b-verify] PASS — catalog_set_initial_build_complete does not throw
[f1b-verify] PASS — catalog_set_initial_build_complete(false) took effect
[f1b-verify] PASS — notice_audit_insert does not throw / MISS
[f1b-verify] PASS — notice_audit_query returns the inserted entry with delivered_to round-tripped ([{"id":1,"notice_id":"notice-1","type":"reminder","tier":"l1","source":"scheduler","decision":"deliver","reason":null,"delivered_to":["sidebar","menubar"],"timestamp":1784834016480}])
[f1b-verify] PASS — notice_audit_aggregate is sane: [["deliver", 1]] ([["deliver",1]])
[f1b-verify] PASS — notice_inbox_pending returns the queued entry ([{"id":1,"notice_id":"inbox-1","notice_json":"{\"id\":\"inbox-1\",\"tier\":\"l2\"}","tier":"l2","queued_at":1784834016483,"expires_at":1784834076483,"delivered":false}])
[f1b-verify] PASS — after mark_delivered, pending no longer returns it ([])
[f1b-verify] PASS — notice_inbox_cleanup runs and removes expired+delivered rows (2)
[f1b-verify] PASSED = true

```

**f14Verify.cjs** (TIMEOUT, exit=1):
```
[network-proxy] listening on 127.0.0.1:55349
[network-proxy] BLOCKED: not-whitelisted.example.invalid
[network-proxy] BLOCKED: not-whitelisted.example.invalid
[network-proxy] BLOCKED: still-not-whitelisted.example.invalid

```

</details>

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

**FAIL** — 2 harness(es) failed or timed out. See sections above for detail.
