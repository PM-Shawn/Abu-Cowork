/**
 * F1b "catalog + notice SQLite" headless verification — a PLAIN node script
 * (no Electron/BrowserWindow needed; catalogDb.cjs/noticeDb.cjs only ever
 * touch `app.getPath('appData')` via appEnv.cjs's `abuAppDataDir`, so a fake
 * `app` stub pointing at a fresh temp dir is enough to exercise the real
 * node:sqlite code path end-to-end).
 *
 * Exercises:
 *  - catalog: upsert -> get -> bump_count -> search (3-char CJK MATCH hit +
 *    non-matching query returns none) -> reindex -> reconcile, all without
 *    throwing on a small on-disk JSONL/index.json fixture.
 *  - notice: audit_insert -> audit_query -> audit_aggregate; inbox_insert ->
 *    inbox_pending -> mark_delivered -> pending excludes it; cleanup runs.
 *
 * Run: node electron/spike/f1bVerify.cjs
 * Prints `[f1b-verify] PASSED = true/false` plus one line per check.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { catalogDispatch, CATALOG_MISS } = require('../catalogDb.cjs');
const { noticeDispatch, NOTICE_MISS } = require('../noticeDb.cjs');

const results = [];
let allPassed = true;

function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) allPassed = false;
  results.push(`[f1b-verify] ${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
}

function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-f1b-verify-'));
  const appDataRoot = path.join(tmpRoot, 'appdata');
  fs.mkdirSync(appDataRoot, { recursive: true });

  /** Fake Electron `app` — only `getPath('appData')` is used by abuAppDataDir. */
  const fakeApp = {
    getPath(name) {
      if (name === 'appData') return appDataRoot;
      throw new Error(`fakeApp.getPath: unexpected key "${name}"`);
    },
  };

  const conversationsRoot = path.join(tmpRoot, 'conversations');
  fs.mkdirSync(conversationsRoot, { recursive: true });

  // ── Catalog: upsert -> get -> bump_count ──────────────────────────────
  try {
    const convId = 'conv-verify-1';
    const now = Date.now();

    const upsertResult = catalogDispatch(fakeApp, 'catalog_upsert_conversation', {
      row: {
        conv_id: convId,
        title: '你好世界的会话',
        created_at: now,
        updated_at: now,
        message_count: 1,
        last_message_id: null,
        model: JSON.stringify({ providerId: 'anthropic', modelId: 'claude' }),
        source_bytes: 0,
        source_mtime: null,
        missing: false,
      },
    });
    check('catalog_upsert_conversation does not throw / MISS', upsertResult !== CATALOG_MISS);

    const got = catalogDispatch(fakeApp, 'catalog_get_conversation', { convId });
    check(
      'catalog_get_conversation returns the upserted row (fields match)',
      got && got.conv_id === convId && got.title === '你好世界的会话' && got.message_count === 1 && got.missing === false,
      JSON.stringify(got),
    );

    // bump_count: conversationsRoot has no messages.jsonl for this conv yet,
    // so source_bytes/source_mtime stay null (mirrors Rust's Err(_) => (None, None)).
    const bumpResult = catalogDispatch(fakeApp, 'catalog_bump_count', {
      convId,
      delta: 2,
      updatedAt: now + 1000,
      lastMessageId: 'm2',
      conversationsRoot,
    });
    check('catalog_bump_count does not throw', bumpResult !== CATALOG_MISS);

    const afterBump = catalogDispatch(fakeApp, 'catalog_get_conversation', { convId });
    check(
      'catalog_bump_count reflects: message_count 1+2=3, last_message_id updated',
      afterBump.message_count === 3 && afterBump.last_message_id === 'm2',
      JSON.stringify(afterBump),
    );
  } catch (err) {
    check('catalog upsert/get/bump_count block threw unexpectedly', false, err.stack || String(err));
  }

  // ── Catalog: search (3-char CJK MATCH + reindex/reconcile against a real
  // on-disk fixture) ──────────────────────────────────────────────────────
  try {
    const convId = 'conv-verify-fixture';
    const convDir = path.join(conversationsRoot, convId);
    fs.mkdirSync(convDir, { recursive: true });
    const jsonlPath = path.join(convDir, 'messages.jsonl');
    const now = Date.now();
    const lines = [
      JSON.stringify({ id: 'm1', role: 'user', content: '你好世界这是搜索测试', timestamp: now }),
      JSON.stringify({ id: 'm2', role: 'assistant', content: 'sure, here is a reply', timestamp: now + 100 }),
    ];
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');

    // Upsert via reindex path (exercises reindex_scan_core + reindex_apply_core
    // against the real fixture, including the FTS body derivation).
    catalogDispatch(fakeApp, 'catalog_reindex_conversation', { convId, conversationsRoot });

    const afterReindex = catalogDispatch(fakeApp, 'catalog_get_conversation', { convId });
    check(
      'catalog_reindex_conversation derives message_count from JSONL',
      afterReindex && afterReindex.message_count === 2,
      JSON.stringify(afterReindex),
    );

    const hitsMatch = catalogDispatch(fakeApp, 'catalog_search', { query: '你好世界', limit: 10 });
    check(
      '3-char+ CJK query MATCHes the upserted conversation',
      Array.isArray(hitsMatch) && hitsMatch.some((h) => h.conv_id === convId),
      JSON.stringify(hitsMatch),
    );

    const hitsNoMatch = catalogDispatch(fakeApp, 'catalog_search', { query: '完全不存在的短语XYZ', limit: 10 });
    check(
      'non-matching query returns no hits for this conv',
      Array.isArray(hitsNoMatch) && !hitsNoMatch.some((h) => h.conv_id === convId),
      JSON.stringify(hitsNoMatch),
    );

    // reconcile against the real fixture dir — must not throw, and must pick
    // up the on-disk conversation.
    const stats = catalogDispatch(fakeApp, 'catalog_reconcile', { conversationsRoot });
    check(
      'catalog_reconcile runs without throwing and reports stats',
      stats && typeof stats.scanned_dirs === 'number',
      JSON.stringify(stats),
    );

    const afterReconcile = catalogDispatch(fakeApp, 'catalog_get_conversation', { convId });
    check(
      'catalog_reconcile leaves the fixture conversation intact (not marked missing)',
      afterReconcile && afterReconcile.missing === false && afterReconcile.message_count === 2,
      JSON.stringify(afterReconcile),
    );
  } catch (err) {
    check('catalog search/reindex/reconcile block threw unexpectedly', false, err.stack || String(err));
  }

  // ── Catalog: zero-frontend-ref commands (list/sync-state/etc.) — parity check ─
  try {
    const list = catalogDispatch(fakeApp, 'catalog_list_conversations', { limit: 10, offset: 0 });
    check('catalog_list_conversations does not throw and returns an array', Array.isArray(list), `len=${list && list.length}`);

    const syncState = catalogDispatch(fakeApp, 'catalog_get_sync_state', {});
    check(
      'catalog_get_sync_state reflects reconcile having run (initial_build_complete=true)',
      syncState && syncState.initial_build_complete === true && syncState.observation_sequence >= 1,
      JSON.stringify(syncState),
    );

    const seq = catalogDispatch(fakeApp, 'catalog_bump_observation_sequence', {});
    check('catalog_bump_observation_sequence returns an incremented number', typeof seq === 'number' && seq >= 1, String(seq));

    const setComplete = catalogDispatch(fakeApp, 'catalog_set_initial_build_complete', { complete: false });
    check('catalog_set_initial_build_complete does not throw', setComplete !== CATALOG_MISS);
    const syncState2 = catalogDispatch(fakeApp, 'catalog_get_sync_state', {});
    check('catalog_set_initial_build_complete(false) took effect', syncState2.initial_build_complete === false);
  } catch (err) {
    check('catalog zero-ref commands block threw unexpectedly', false, err.stack || String(err));
  }

  // ── Notice: audit ──────────────────────────────────────────────────────
  try {
    const now = Date.now();
    const insertResult = noticeDispatch(fakeApp, 'notice_audit_insert', {
      entry: {
        notice_id: 'notice-1',
        type: 'reminder',
        tier: 'l1',
        source: 'scheduler',
        decision: 'deliver',
        reason: null,
        delivered_to: ['sidebar', 'menubar'],
        timestamp: now,
      },
    });
    check('notice_audit_insert does not throw / MISS', insertResult !== NOTICE_MISS);

    const queried = noticeDispatch(fakeApp, 'notice_audit_query', {
      since: now - 1000,
      until: now + 1000,
      noticeType: null,
      limit: 50,
    });
    check(
      'notice_audit_query returns the inserted entry with delivered_to round-tripped',
      Array.isArray(queried) &&
        queried.length === 1 &&
        queried[0].notice_id === 'notice-1' &&
        queried[0].type === 'reminder' &&
        Array.isArray(queried[0].delivered_to) &&
        queried[0].delivered_to.length === 2,
      JSON.stringify(queried),
    );

    const aggregated = noticeDispatch(fakeApp, 'notice_audit_aggregate', { since: now - 1000, until: now + 1000 });
    check(
      'notice_audit_aggregate is sane: [["deliver", 1]]',
      Array.isArray(aggregated) && aggregated.length === 1 && aggregated[0][0] === 'deliver' && aggregated[0][1] === 1,
      JSON.stringify(aggregated),
    );
  } catch (err) {
    check('notice audit block threw unexpectedly', false, err.stack || String(err));
  }

  // ── Notice: inbox ───────────────────────────────────────────────────────
  try {
    const now = Date.now();
    noticeDispatch(fakeApp, 'notice_inbox_insert', {
      entry: {
        notice_id: 'inbox-1',
        notice_json: JSON.stringify({ id: 'inbox-1', tier: 'l2' }),
        tier: 'l2',
        queued_at: now,
        expires_at: now + 60_000,
      },
    });

    const pending1 = noticeDispatch(fakeApp, 'notice_inbox_pending', { now });
    check(
      'notice_inbox_pending returns the queued entry',
      Array.isArray(pending1) && pending1.some((e) => e.notice_id === 'inbox-1' && e.delivered === false),
      JSON.stringify(pending1),
    );

    noticeDispatch(fakeApp, 'notice_inbox_mark_delivered', { noticeId: 'inbox-1' });
    const pending2 = noticeDispatch(fakeApp, 'notice_inbox_pending', { now });
    check(
      'after mark_delivered, pending no longer returns it',
      Array.isArray(pending2) && !pending2.some((e) => e.notice_id === 'inbox-1'),
      JSON.stringify(pending2),
    );

    // A second, already-expired entry so cleanup has something to remove.
    noticeDispatch(fakeApp, 'notice_inbox_insert', {
      entry: {
        notice_id: 'inbox-expired',
        notice_json: '{}',
        tier: 'l2',
        queued_at: now - 120_000,
        expires_at: now - 60_000,
      },
    });
    const cleaned = noticeDispatch(fakeApp, 'notice_inbox_cleanup', { now });
    check('notice_inbox_cleanup runs and removes expired+delivered rows', typeof cleaned === 'number' && cleaned >= 1, String(cleaned));
  } catch (err) {
    check('notice inbox block threw unexpectedly', false, err.stack || String(err));
  }

  // eslint-disable-next-line no-console
  results.forEach((line) => console.log(line));
  console.log(`[f1b-verify] PASSED = ${allPassed}`);

  // Force a clean process exit. catalogDb.cjs/noticeDb.cjs cache their
  // node:sqlite DatabaseSync handles in module-level singletons for the
  // process lifetime (by design — see catalogDb.cjs's module doc header) and
  // expose no close()/dispose() export, so there is nothing to explicitly
  // tear down here. Those open handles (plus WAL-mode journal files) keep
  // the event loop alive indefinitely; `process.exitCode` alone only sets
  // the code for a *natural* exit, which never arrives. `process.exit()`
  // forces immediate termination regardless of open handles — the same
  // fallback this project's own module doc already calls out as acceptable
  // (see networkProxy.cjs's f14Verify.cjs sibling, and app.exit() in
  // f9Verify.cjs for the BrowserWindow-based harnesses).
  process.exit(allPassed ? 0 : 1);
}

main();
