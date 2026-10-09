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
  assert.match(zh, /hash === 'browser-bridge' \? 'web-browsing'/);
  assert.match(en, /hash === 'browser-bridge' \? 'web-browsing'/);
});

test('documentation viewer keeps cross-guide links in the viewer', () => {
  const zh = read('website/docs.zh-CN.html');
  const en = read('website/docs.html');

  for (const source of [zh, en]) {
    assert.match(source, /candidate\.file\.endsWith\('\/' \+ href\)/);
    assert.match(source, /link\.setAttribute\('href', '#' \+ target\[0\]\)/);
  }
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

  assert.ok(zh.includes('<h3>连接器</h3>'));
  assert.ok(zh.includes('<span class="more-cap">项目管理</span>'));
  assert.ok(zh.includes('点击本页顶部的下载按钮，选择对应平台的安装包'));
  assert.ok(!zh.includes('MCP 工具协议'));
  assert.ok(!zh.includes('Projects 管理'));
  assert.ok(!zh.includes('7×24 无人值守'));
  assert.ok(!zh.includes('从 GitHub Releases 下载对应平台的安装包'));

  assert.ok(en.includes('<h3>Connectors</h3>'));
  assert.ok(en.includes('<span class="more-cap">Project management</span>'));
  assert.ok(en.includes('Use the download button at the top of this page and choose your platform'));
  assert.ok(!en.includes('MCP Tool Protocol'));
  assert.ok(!en.includes('Projects management'));
  assert.ok(!en.includes('24/7 unattended operation'));
  assert.ok(!en.includes('Grab the installer for your platform from GitHub Releases'));
});

test('homepage shows the user feedback wall between use cases and architecture', () => {
  const pages = [
    {
      source: read('website/index.zh-CN.html'),
      heading: '<h2>用户反馈</h2>',
      quotes: [
        '阿布很好用，已经用阿布做了个日历定制打印网站',
        '轻量快速，使用起来很顺手',
        '可以自己动手 DIY 改代码',
        '阿布帮我们公司交付了好几个项目',
        '我经常向客户推广阿布',
        '软件开发的很不错！',
        '感谢，工具做的很棒',
        '一个人开发出阿布，太牛了',
      ],
    },
    {
      source: read('website/index.html'),
      heading: '<h2>What Users Say</h2>',
      quotes: [
        "Abu works really well. I've already used it to build a custom calendar printing website",
        'Lightweight and fast, and it feels smooth to use',
        'I can get hands-on and change the code myself',
        'Abu has helped our company deliver several projects',
        'I often recommend Abu to my clients',
        'The software is really well made!',
        'Thank you, the tool is great',
        'Building Abu single-handedly is amazing',
      ],
    },
  ];

  for (const { source, heading, quotes } of pages) {
    const useCases = source.indexOf('<section class="use-cases" id="use-cases">');
    const feedback = source.indexOf('<section class="feedback" id="feedback">');
    const tech = source.indexOf('<section class="tech" id="tech">');
    assert.ok(useCases < feedback && feedback < tech);

    const section = source.slice(feedback, tech);
    assert.ok(section.includes(heading));
    assert.equal(section.split('<figure class="feedback-item">').length - 1, quotes.length);
    for (const quote of quotes) {
      assert.ok(section.includes(`<blockquote class="feedback-bubble">${quote}</blockquote>`), quote);
    }
  }
});

test('homepage architecture copy reflects the Electron product', () => {
  const zh = read('website/index.zh-CN.html');
  const en = read('website/index.html');

  assert.doesNotMatch(zh, /Rust 后端|Seatbelt 沙箱/);
  assert.doesNotMatch(en, /Rust backend|Seatbelt sandbox/);
  assert.match(zh, /Electron 主进程 \+ 原生组件/);
  assert.match(en, /Electron main process \+ native components/);
});
