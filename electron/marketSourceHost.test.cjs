'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');
const { classifyAddress, createMarketSourceHost, marketSourceDispatch, REFRESH_AFTER_MS } = require('./marketSourceHost.cjs');

function marketZip(root, name, extra = {}) {
  return Buffer.from(zipSync({
    [`${root}/.abu-plugin/marketplace.json`]: strToU8(JSON.stringify({ name, plugins: [], apps: [{ name: 'contract-review', source: './apps/contract-review' }] })),
    [`${root}/apps/contract-review/.abu-app/app.json`]: strToU8('{}'),
    ...extra,
  }));
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'abu-market-source-'));
}

test('classifies an address by how it is fetched', () => {
  assert.deepEqual(classifyAddress('https://github.com/lawyer/market'), { kind: 'github', url: 'https://codeload.github.com/lawyer/market/zip/HEAD' });
  assert.deepEqual(classifyAddress('https://github.com/lawyer/market.git'), { kind: 'github', url: 'https://codeload.github.com/lawyer/market/zip/HEAD' });
  assert.deepEqual(classifyAddress('https://files.example.com/market.zip'), { kind: 'zip', url: 'https://files.example.com/market.zip' });
  assert.deepEqual(classifyAddress('https://gitee.com/lawyer/market.git'), { kind: 'git', url: 'https://gitee.com/lawyer/market.git' });
  for (const bad of ['http://files.example.com/market.zip', 'file:///etc', 'lawyer/market', ' https://x.example.com']) {
    assert.throws(() => classifyAddress(bad), (error) => error.code === 'not_a_market');
  }
});

test('stores a downloaded market under its own name, without git on the computer', async () => {
  const root = scratch();
  try {
    const requested = [];
    const host = createMarketSourceHost({
      marketsRoot: root,
      download: async (url, opts) => { requested.push({ url, allowsOtherHosts: opts.isAllowed('https://files.example.com/x') }); return marketZip('market-main', 'lawyer-market'); },
      runGit: async () => { throw new Error('git must not run for a GitHub address'); },
      now: () => 1000,
    });
    const result = await host.add('https://github.com/lawyer/market');
    assert.deepEqual(result, { name: 'lawyer-market', dir: path.join(root, 'lawyer-market') });
    assert.deepEqual(requested, [{ url: 'https://codeload.github.com/lawyer/market/zip/HEAD', allowsOtherHosts: true }]);
    assert.ok(fs.existsSync(path.join(root, 'lawyer-market', 'apps', 'contract-review', '.abu-app', 'app.json')));
    assert.deepEqual(host.readSource('lawyer-market'), { address: 'https://github.com/lawyer/market', fetchedAt: 1000 });
    assert.deepEqual(fs.readdirSync(root), ['lawyer-market'], 'no staging folder is left behind');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('clones any other https repository and drops its .git folder', async () => {
  const root = scratch();
  try {
    const host = createMarketSourceHost({
      marketsRoot: root,
      download: async () => { throw new Error('no download for a git address'); },
      runGit: async (args) => {
        assert.deepEqual(args.slice(0, 4), ['clone', '--depth', '1', '--']);
        const dest = args[5];
        fs.mkdirSync(path.join(dest, '.abu-plugin'), { recursive: true });
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        fs.writeFileSync(path.join(dest, '.abu-plugin', 'marketplace.json'), JSON.stringify({ name: 'gitee-market', plugins: [] }));
        return '';
      },
    });
    const result = await host.add('https://gitee.com/lawyer/market.git');
    assert.equal(result.name, 'gitee-market');
    assert.equal(fs.existsSync(path.join(result.dir, '.git')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('names what went wrong the way the add dialog explains it', async () => {
  const root = scratch();
  try {
    const failing = (download, runGit = async () => '') => createMarketSourceHost({ marketsRoot: root, download, runGit });
    const needsLogin = Object.assign(new Error('archive HTTP 403'), { status: 403 });
    await assert.rejects(failing(async () => { throw needsLogin; }).add('https://files.example.com/market.zip'), (error) => error.code === 'auth_required');
    await assert.rejects(failing(async () => '', async () => { throw new Error("git exited 128: fatal: could not read Username for 'https://gitee.com': terminal prompts disabled"); }).add('https://gitee.com/private/market.git'), (error) => error.code === 'auth_required');
    await assert.rejects(failing(async () => { throw Object.assign(new Error('archive HTTP 404'), { status: 404 }); }).add('https://files.example.com/market.zip'), (error) => error.code === 'not_a_market');
    const noMarket = Buffer.from(zipSync({ 'root/readme.md': strToU8('hi') }));
    await assert.rejects(failing(async () => noMarket).add('https://files.example.com/market.zip'), (error) => error.code === 'not_a_market');
    const twoRoots = Buffer.from(zipSync({ 'a/x.txt': strToU8('1'), 'b/y.txt': strToU8('2') }));
    await assert.rejects(failing(async () => twoRoots).add('https://files.example.com/market.zip'), (error) => error.code === 'not_a_market');
    const escaping = Buffer.from(zipSync({ 'root/.abu-plugin/marketplace.json': strToU8('{"name":"m","plugins":[]}'), 'root/../../evil.txt': strToU8('x') }));
    await assert.rejects(failing(async () => escaping).add('https://files.example.com/market.zip'), (error) => error.code === 'not_a_market');
    assert.equal(fs.existsSync(path.join(root, '..', 'evil.txt')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('refuses a second address that provides a market of a name already taken, and replaces its own', async () => {
  const root = scratch();
  try {
    let clock = 0;
    const host = createMarketSourceHost({ marketsRoot: root, download: async () => marketZip('m', 'lawyer-market'), now: () => clock });
    await host.add('https://files.example.com/a.zip');
    await assert.rejects(host.add('https://files.example.com/b.zip'), (error) => error.code === 'name_taken');
    clock = 5;
    await host.add('https://files.example.com/a.zip');
    assert.equal(host.readSource('lawyer-market').fetchedAt, 5);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fetches a market again only once its copy is an hour old', async () => {
  const root = scratch();
  try {
    let clock = 0;
    let downloads = 0;
    const host = createMarketSourceHost({ marketsRoot: root, download: async () => { downloads += 1; return marketZip('m', 'lawyer-market'); }, now: () => clock });
    await host.add('https://files.example.com/a.zip');
    clock = REFRESH_AFTER_MS - 1;
    assert.deepEqual(await host.refresh('lawyer-market'), { refreshed: false });
    clock = REFRESH_AFTER_MS;
    assert.deepEqual(await host.refresh('lawyer-market'), { refreshed: true });
    assert.equal(downloads, 2);
    host.remove('lawyer-market');
    assert.equal(fs.existsSync(path.join(root, 'lawyer-market')), false);
    assert.throws(() => host.remove('../outside'), (error) => error.code === 'not_a_market');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the dispatch carries the code on the message the renderer receives', async () => {
  const root = scratch();
  try {
    const host = createMarketSourceHost({ marketsRoot: root, download: async () => { throw Object.assign(new Error('archive HTTP 401'), { status: 401 }); } });
    await assert.rejects(marketSourceDispatch('market_source_add', { args: { address: 'https://files.example.com/a.zip' } }, host), /^Error: \[auth_required\]/);
    assert.equal(typeof marketSourceDispatch('something_else', {}, host), 'symbol');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
