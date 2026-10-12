import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const mirroredDocs = [
  'User-Guide.md',
  'User-Guide.zh-CN.md',
  'Installation-Guide.md',
  'Installation-Guide.zh-CN.md',
  'app-spec.md',
  'plugin-spec.md',
];

const publicDocs = [
  ...mirroredDocs.map((name) => `website/docs/${name}`),
  'website/docs/browser-bridge-vs-playwright.md',
  'website/docs/browser-bridge-vs-playwright.zh-CN.md',
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

for (const name of mirroredDocs) {
  test(`${name} matches the deployed website copy`, () => {
    assert.equal(
      read(`docs/${name}`),
      read(`website/docs/${name}`),
      `${name} drifted from website/docs/${name}`,
    );
  });
}

test('documentation viewer uses current product terminology', () => {
  const zh = read('website/docs.zh-CN.html');
  const en = read('website/docs.html');

  assert.match(zh, /data-doc="web-browsing"[\s\S]*浏览网页/);
  assert.match(en, /data-doc="web-browsing"[\s\S]*Web Browsing/);
  assert.doesNotMatch(zh, />\s*浏览器桥接\s*</);
  assert.doesNotMatch(en, />\s*Browser Bridge\s*</);
  // Both pages run the same viewer script.
  const viewer = read('website/docs.js');
  assert.match(viewer, /hash === 'browser-bridge' \? 'web-browsing'/);
  assert.match(viewer, /title: '浏览网页'/);
  assert.match(viewer, /title: 'Web Browsing'/);
  for (const source of [zh, en]) {
    assert.ok(source.includes('<script src="docs.js"></script>'));
    for (const key of ['user-guide', 'installation', 'web-browsing', 'app-spec', 'plugin-spec']) {
      assert.ok(source.includes(`href="#${key}" data-doc="${key}"`), `missing the ${key} entry`);
    }
  }
});

test('documentation viewer reads each language from its own files', () => {
  const viewer = read('website/docs.js');

  for (const file of [
    'docs/User-Guide.zh-CN.md',
    'docs/Installation-Guide.zh-CN.md',
    'docs/browser-bridge-vs-playwright.zh-CN.md',
    'docs/User-Guide.md',
    'docs/Installation-Guide.md',
    'docs/browser-bridge-vs-playwright.md',
    'docs/app-spec.md',
    'docs/plugin-spec.md',
  ]) {
    assert.ok(viewer.includes(`file: '${file}'`), `viewer does not read ${file}`);
    assert.ok(fs.existsSync(path.join(root, 'website', file)), `website/${file} is missing`);
  }
});

test('documentation viewer keeps cross-guide links in the viewer', () => {
  const viewer = read('website/docs.js');

  assert.match(viewer, /const file = href\.split\('#'\)\[0\]\.replace\('\.zh-CN\.md', '\.md'\)/);
  assert.match(viewer, /candidate\.file\.replace\('\.zh-CN\.md', '\.md'\)\.endsWith\('\/' \+ file\)/);
  assert.match(viewer, /link\.setAttribute\('href', '#' \+ target\[0\]\)/);
});

test('public guides do not restore retired navigation paths', () => {
  const retiredPaths = [
    '设置 → AI 服务',
    'Settings → AI Services',
    '工具箱 → MCP 工具',
    'Toolbox → MCP Tools',
    'Abu_x.x.x_aarch64.dmg',
    'Abu_x.x.x_x64-setup.exe',
  ];

  for (const file of publicDocs) {
    const source = read(file);
    for (const retired of retiredPaths) {
      assert.ok(!source.includes(retired), `${file} contains retired path or asset name: ${retired}`);
    }
  }
});

test('user guides teach the current primary paths', () => {
  const zh = read('website/docs/User-Guide.zh-CN.md');
  const en = read('website/docs/User-Guide.md');

  for (const phrase of ['设置 → 模型', '工具箱 → 连接器', '设置 → 能力', '自动化 → 定时任务']) {
    assert.ok(zh.includes(phrase), `Chinese guide is missing ${phrase}`);
  }
  for (const phrase of ['Settings → Models', 'Toolbox → Connectors', 'Settings → Capabilities', 'Automation → Scheduled Tasks']) {
    assert.ok(en.includes(phrase), `English guide is missing ${phrase}`);
  }
});

test('installation paths start from the official website', () => {
  const files = [
    'website/docs/User-Guide.zh-CN.md',
    'website/docs/User-Guide.md',
    'website/docs/Installation-Guide.zh-CN.md',
    'website/docs/Installation-Guide.md',
  ];

  for (const file of files) {
    const source = read(file);
    assert.ok(source.includes('https://myabu.cn/'), `${file} does not link to the official website`);
    assert.ok(
      !source.includes('https://github.com/PM-Shawn/Abu-Cowork/releases'),
      `${file} still routes installation through GitHub Releases`,
    );
  }
});

test('public user guides omit experimental todo and inbox surfaces', () => {
  const zh = read('website/docs/User-Guide.zh-CN.md');
  const en = read('website/docs/User-Guide.md');

  assert.ok(!zh.includes('待办 / 收件箱'));
  assert.ok(!en.includes('Todos / Inbox'));
});

test('relative Markdown links in public docs resolve', () => {
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;

  for (const file of publicDocs) {
    const source = read(file);
    const directory = path.dirname(path.join(root, file));
    for (const match of source.matchAll(linkPattern)) {
      const target = match[1].split('#', 1)[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      assert.ok(fs.existsSync(path.resolve(directory, target)), `${file} links to missing file ${target}`);
    }
  }
});

test('homepage uses the same current terminology', () => {
  const zh = read('website/index.zh-CN.html');
  const en = read('website/index.html');

  assert.ok(zh.includes('<span class="cell-name">连接器</span>'));
  assert.ok(zh.includes('<span class="pill">项目管理</span>'));
  assert.ok(zh.includes('安装之后配置一个模型，选一个文件夹，告诉阿布你要什么'));
  assert.ok(!zh.includes('MCP 工具协议'));
  assert.ok(!zh.includes('Projects 管理'));
  assert.ok(!zh.includes('7×24 无人值守'));
  assert.ok(!zh.includes('从 GitHub Releases 下载对应平台的安装包'));

  assert.ok(en.includes('<span class="cell-name">Connectors</span>'));
  assert.ok(en.includes('<span class="pill">Project management</span>'));
  assert.ok(en.includes('After installing, set up a model, pick a folder and tell Abu what you need'));
  assert.ok(!en.includes('MCP Tool Protocol'));
  assert.ok(!en.includes('Projects management'));
  assert.ok(!en.includes('24/7 unattended operation'));
  assert.ok(!en.includes('Grab the installer for your platform from GitHub Releases'));
});

test('homepage architecture copy reflects the Electron product', () => {
  const zh = read('website/index.zh-CN.html');
  const en = read('website/index.html');

  assert.doesNotMatch(zh, /Rust 后端|Seatbelt 沙箱/);
  assert.doesNotMatch(en, /Rust backend|Seatbelt sandbox/);
  assert.match(zh, /Electron 主进程 \+ 原生组件/);
  assert.match(en, /Electron main process \+ native components/);
});
