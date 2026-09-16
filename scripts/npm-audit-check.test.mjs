import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateAudit, formatReport, ghsaIdFromUrl, runCli } from './npm-audit-check.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AS_OF = '2026-09-07';

// Shape copied from a real `npm audit --omit=dev --json` run (npm 11).
function report() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      'image-size': {
        name: 'image-size',
        severity: 'high',
        isDirect: false,
        via: [
          { source: 1, name: 'image-size', severity: 'high', title: 'image-size: ICNS parser DoS', url: 'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr', range: '<=2.0.2' },
          { source: 2, name: 'image-size', severity: 'high', title: 'image-size: JXL/HEIF parser DoS', url: 'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq', range: '<=2.0.2' },
        ],
        range: '*',
        fixAvailable: { name: 'pptxgenjs', version: '1.1.5', isSemVerMajor: true },
      },
      pptxgenjs: {
        name: 'pptxgenjs',
        severity: 'high',
        isDirect: true,
        via: ['image-size'],
        range: '1.1.5-1 || >=1.1.6',
        fixAvailable: { name: 'pptxgenjs', version: '1.1.5', isSemVerMajor: true },
      },
      qs: {
        name: 'qs',
        severity: 'moderate',
        isDirect: false,
        via: [{ source: 3, name: 'qs', severity: 'moderate', title: 'qs array-limit bypass', url: 'https://github.com/advisories/GHSA-0000-0000-0000', range: '<6.16.0' }],
        range: '<6.16.0',
        fixAvailable: true,
      },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 2, critical: 0, total: 3 } },
  };
}

function allowlist(overrides = {}) {
  return {
    entries: [
      { ghsa: 'GHSA-w3rx-r6r6-pgpr', package: 'image-size', reason: 'no upstream fix', expires: '2026-12-31', ...overrides },
      { ghsa: 'GHSA-5p2g-fcmc-qvqq', package: 'image-size', reason: 'no upstream fix', expires: '2026-12-31' },
    ],
  };
}

test('ghsaIdFromUrl extracts and normalises the advisory id', () => {
  assert.equal(ghsaIdFromUrl('https://github.com/advisories/GHSA-w3rx-r6r6-pgpr'), 'GHSA-W3RX-R6R6-PGPR');
  assert.equal(ghsaIdFromUrl('ghsa-w3rx-r6r6-pgpr'), 'GHSA-W3RX-R6R6-PGPR');
  assert.equal(ghsaIdFromUrl('https://example.com/not-an-advisory'), null);
  assert.equal(ghsaIdFromUrl(undefined), null);
});

test('fully allowlisted findings pass, including packages vulnerable only via an allowlisted one', () => {
  const result = evaluateAudit(report(), allowlist(), AS_OF);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.expired, []);
  assert.deepEqual(result.unused, []);
  assert.deepEqual(result.allowlisted.map((item) => item.name).sort(), ['image-size', 'pptxgenjs']);
  assert.match(formatReport(result), /✅ no unaccepted high\/critical findings/);
});

test('moderate findings are ignored (matches --audit-level=high)', () => {
  const result = evaluateAudit(report(), allowlist(), AS_OF);
  assert.ok(!result.blocking.concat(result.allowlisted).some((item) => item.name === 'qs'));
});

test('a high finding without an allowlist entry blocks, and the dependent package blocks with it', () => {
  const partial = { entries: allowlist().entries.slice(0, 1) };
  const result = evaluateAudit(report(), partial, AS_OF);
  assert.deepEqual(result.blocking.map((item) => item.name).sort(), ['image-size', 'pptxgenjs']);
  assert.match(formatReport(result), /❌ 2 blocking finding/);
  assert.match(formatReport(result), /GHSA-5P2G-FCMC-QVQQ/);
});

test('an allowlist entry only covers the package it names', () => {
  const wrongPackage = allowlist({ package: 'pptxgenjs' });
  const result = evaluateAudit(report(), wrongPackage, AS_OF);
  assert.ok(result.blocking.some((item) => item.name === 'image-size'));
});

test('an expired entry fails the check even when the finding is otherwise covered', () => {
  const result = evaluateAudit(report(), allowlist({ expires: '2026-09-06' }), AS_OF);
  assert.equal(result.expired.length, 1);
  assert.equal(result.expired[0].ghsa, 'GHSA-W3RX-R6R6-PGPR');
  assert.ok(result.blocking.some((item) => item.name === 'image-size'));
  assert.match(formatReport(result), /expired \(as of 2026-09-07\)/);
  // The day of expiry itself still counts as valid.
  assert.equal(evaluateAudit(report(), allowlist({ expires: AS_OF }), AS_OF).expired.length, 0);
});

test('entries npm audit no longer reports are surfaced as unused, not as failures', () => {
  const extra = { entries: [...allowlist().entries, { ghsa: 'GHSA-aaaa-bbbb-cccc', package: 'left-pad', reason: 'gone', expires: '2026-12-31' }] };
  const result = evaluateAudit(report(), extra, AS_OF);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.unused.map((entry) => entry.ghsa), ['GHSA-AAAA-BBBB-CCCC']);
  assert.match(formatReport(result), /safe to delete/);
});

test('malformed inputs throw instead of silently passing', () => {
  assert.throws(() => evaluateAudit({ error: { code: 'ENOAUDIT' } }, allowlist(), AS_OF), /no "vulnerabilities" object.*ENOAUDIT/);
  assert.throws(() => evaluateAudit(report(), { entries: [{ ghsa: 'GHSA-w3rx-r6r6-pgpr', package: 'image-size', expires: '2026-12-31' }] }, AS_OF), /missing "reason"/);
  assert.throws(() => evaluateAudit(report(), allowlist({ expires: '31/12/2026' }), AS_OF), /must be YYYY-MM-DD/);
  assert.throws(() => evaluateAudit(report(), allowlist({ ghsa: 'CVE-2026-1' }), AS_OF), /malformed GHSA/);
  assert.throws(() => evaluateAudit(report(), { allow: [] }, AS_OF), /"entries" array/);
  assert.throws(() => evaluateAudit(report(), allowlist(), 'today'), /asOf must be YYYY-MM-DD/);
});

test('committed allowlist is well-formed and matches the shape the checker requires', () => {
  const committed = JSON.parse(readFileSync(path.join(repoRoot, '.github/npm-audit-allowlist.json'), 'utf8'));
  assert.ok(Array.isArray(committed.entries) && committed.entries.length > 0);
  for (const entry of committed.entries) {
    assert.match(entry.ghsa, /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    assert.match(entry.expires, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.reason.length > 20, `reason for ${entry.ghsa} must explain why it is accepted`);
  }
  // Evaluating the fixture against the committed file must not throw.
  evaluateAudit(report(), committed, AS_OF);
});

test('CLI: exit 0 when covered, 1 when blocking or expired, 2 on malformed input', () => {
  const dir = path.join(os.tmpdir(), `abu-audit-check-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const script = path.join(repoRoot, 'scripts', 'npm-audit-check.mjs');
    writeFileSync(path.join(dir, 'audit.json'), JSON.stringify(report()));
    writeFileSync(path.join(dir, 'allow.json'), JSON.stringify(allowlist()));
    writeFileSync(path.join(dir, 'expired.json'), JSON.stringify(allowlist({ expires: '2026-01-01' })));
    writeFileSync(path.join(dir, 'broken.json'), JSON.stringify({ error: 'ENOAUDIT' }));
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NPM_AUDIT_ASOF: AS_OF } });

    const pass = run('audit.json', '--allowlist=allow.json');
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /accepted by allowlist/);

    const expired = run('audit.json', '--allowlist=expired.json');
    assert.equal(expired.status, 1);
    assert.match(expired.stdout, /expired/);

    const explicitAsOf = run('audit.json', '--allowlist=expired.json', '--asof=2025-12-31');
    assert.equal(explicitAsOf.status, 0, 'explicit --asof must override NPM_AUDIT_ASOF');

    const broken = run('broken.json', '--allowlist=allow.json');
    assert.equal(broken.status, 2);
    assert.match(broken.stderr, /no "vulnerabilities" object/);

    const usage = run();
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage:/);

    // Library entry point honours the injected date without touching the clock.
    const viaLib = runCli(['audit.json', '--allowlist=allow.json'], { cwd: dir, env: {}, today: AS_OF });
    assert.equal(viaLib.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
