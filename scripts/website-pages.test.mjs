import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const websiteDir = path.join(root, 'website');

function read(name) {
  return fs.readFileSync(path.join(websiteDir, name), 'utf8');
}

function count(source, needle) {
  return source.split(needle).length - 1;
}

function attributeValues(source, attribute) {
  return [...source.matchAll(new RegExp(` ${attribute}="([^"]*)"`, 'g'))].map((match) => match[1]);
}

function navLabels(source) {
  const start = source.indexOf('<nav class="nav-links"');
  const nav = source.slice(start, source.indexOf('</nav>', start));
  return [...nav.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((match) => match[1]);
}

function navTargets(source) {
  const start = source.indexOf('<nav class="nav-links"');
  const nav = source.slice(start, source.indexOf('</nav>', start));
  return attributeValues(nav, 'href');
}

const pairs = [
  { zh: 'index.zh-CN.html', en: 'index.html' },
  { zh: 'enterprise.zh-CN.html', en: 'enterprise.html' },
  { zh: 'docs.zh-CN.html', en: 'docs.html' },
  { zh: 'platform.zh-CN.html', en: 'platform.html' },
  { zh: 'community.zh-CN.html', en: 'community.html' },
];
const pages = pairs.flatMap((pair) => [pair.zh, pair.en]);
const homeZh = read('index.zh-CN.html');
const homeEn = read('index.html');
const homeScript = read('home.js');

test('hero second line names the claim and the six models', () => {
  assert.ok(homeZh.includes('<mark class="hl">开源免费</mark><span>，用你自己的</span>'));
  assert.ok(homeZh.includes('<span data-more=" 等">DeepSeek</span><span>智谱</span><span>Kimi</span><span>通义</span><span>豆包</span><span>Ollama</span>'));
  assert.ok(homeZh.includes('<div class="sr">开源免费，用你自己的模型：DeepSeek、智谱、Kimi、通义、豆包、Ollama</div>'));

  assert.ok(homeEn.includes('<mark class="hl">Free and open source</mark><span>, with your own</span>'));
  assert.ok(homeEn.includes('<span data-more=" and more">DeepSeek</span><span>Zhipu</span><span>Kimi</span><span>Qwen</span><span>Doubao</span><span>Ollama</span>'));

  for (const source of [homeZh, homeEn]) {
    assert.equal(count(source, '<span class="row">'), 1, 'the hero title is one line');
  }
  assert.ok(homeZh.includes('<span class="row"><span>交给阿布就行啦<span class="punct">！</span></span></span>'));
  assert.ok(homeEn.includes('<span class="row"><span>Just leave it to Abu!</span></span>'));
});

test('hero shows one whole client window under the copy', () => {
  for (const [source, shots] of [[homeZh, 'assets/shots/'], [homeEn, 'assets/shots/en/']]) {
    const hero = source.slice(source.indexOf('<div class="hero" id="hero">'), source.indexOf('<div class="manifesto"'));
    assert.ok(hero.indexOf('class="hero-actions') < hero.indexOf('<div class="hero-window" id="heroWindow">'), 'the window comes after the buttons');
    assert.equal(count(hero, '<img '), 1, 'the hero holds one picture');
    assert.ok(hero.includes('<div class="lights" aria-hidden="true">'), 'the window has its frame');
    assert.ok(hero.includes(`<source media="(prefers-color-scheme: dark)" srcset="${shots}hero-window-dark-1440.webp 1440w, ${shots}hero-window-dark.webp 2880w"`));
    assert.ok(hero.includes(`<img src="${shots}hero-window-light.webp"`));
    assert.ok(!source.includes('class="frag"') && !source.includes('hero-pin'), 'no scattered component pictures');
  }
  assert.ok(homeScript.includes('const WINDOW_START_SCALE = 0.94;'), 'the window grows from 0.94 to full size while the page scrolls');
  assert.ok(!homeScript.includes('.frag'));
});

test('the four steps each show a 3:2 region of a client window', () => {
  for (const source of [homeZh, homeEn]) {
    const steps = source.split('<article class="stack-card">').slice(1).map((part) => part.slice(0, part.indexOf('</article>')));
    assert.equal(steps.length, 4);
    assert.deepEqual(
      steps.map((step) => step.match(/<img src="assets\/shots\/(?:en\/)?([^"]+)" width="(\d+)" height="(\d+)"/).slice(1, 4).join(' ')),
      ['step-1-ask.webp 800 500', 'step-2-plan.webp 840 525', 'step-3-question.webp 904 610', 'step-4-file.webp 1440 900'],
    );
  }
  const css = read('home.css');
  assert.ok(css.includes('.stack-card .art img { width: 100%; height: auto; border-radius: 14px;'));
  assert.ok(!/\.stack-card[^{]*img[^{]*\{[^}]*rotate/.test(css), 'the step pictures are not tilted');
});

test('nine ability cards, all of them text only', () => {
  const names = {
    zh: ['自主任务执行', '技能系统', '电脑操控', '连接器', '自动化', '自进化', '专家团', '计划模式', '交互式提问'],
    en: ['Autonomous task execution', 'Skill system', 'Computer control', 'Connectors', 'Automation', 'Self-evolving', 'Expert teams', 'Plan mode', 'Interactive questions'],
  };
  for (const [locale, source] of [['zh', homeZh], ['en', homeEn]]) {
    const cards = source.split('<article class="cell ').slice(1).map((part) => part.slice(0, part.indexOf('</article>')));
    assert.equal(cards.length, 9);
    assert.deepEqual(cards.map((card) => card.match(/<span class="cell-name">([^<]+)<\/span>/)[1]), names[locale]);
    for (const card of cards) {
      assert.ok(!card.includes('<img'), 'an ability card holds no picture');
      assert.ok(card.includes('<h3 class="h3">') && card.includes('<p class="small">'), 'an ability card has a title and one line');
    }
    assert.equal(count(source, '<span class="pill">'), 11, 'eleven more capabilities');
  }
  assert.ok(read('home.css').includes('.bento { display: grid; grid-template-columns: repeat(3, 1fr); grid-auto-rows: 1fr;'), 'three cards to a row, equal height');
});

test('eight user quotes in two rows, one in brand green', () => {
  const quotes = [
    '阿布很好用，已经用阿布做了个日历定制打印网站',
    '轻量快速，使用起来很顺手',
    '阿布帮我们公司交付了好几个项目',
    '可以自己动手 DIY 改代码',
    '我经常向客户推广阿布',
    '软件开发的很不错！',
    '一个人开发出阿布，太牛了',
    '感谢，工具做的很棒',
  ];
  for (const quote of quotes) assert.ok(homeZh.includes(`>${quote}</blockquote>`), `missing quote: ${quote}`);
  for (const source of [homeZh, homeEn]) {
    assert.equal(count(source, '<blockquote class="quote'), 8);
    assert.equal(count(source, '<blockquote class="quote is-brand">'), 1);
    assert.ok(source.includes('<div class="marquee" id="rowA">') && source.includes('<div class="marquee rev" id="rowB">'));
  }
  assert.ok(homeEn.includes("Translated from users' messages in Chinese"), 'the English page says the quotes are translations');
});

test('community section carries the WeChat QR code and five channels', () => {
  for (const source of [homeZh, homeEn]) {
    assert.ok(source.includes('<img src="assets/wechat-qr.png" width="448" height="448"'));
    assert.equal(count(source, '<span class="channel-name">'), 5);
    assert.ok(source.includes('href="https://xhslink.com/m/8ruHynC0jPB"'));
    assert.ok(source.includes('href="https://x.com/pmshawn_x"'));
    assert.ok(source.includes('href="https://discord.gg/eY3zH3XGqE"'));
    // Each channel shows its account name; the names stay in their original form in both languages.
    assert.deepEqual(
      [...source.matchAll(/<span class="channel-account">([^<]+)<\/span>/g)].map((match) => match[1]),
      ['Shawn的AI产品小记', 'Shawn的产品笔记', '@pmshawn_x', 'PM-Shawn/Abu-Cowork', 'Abu'],
    );
    assert.equal(count(source, '<span class="channel-desc">'), 5);
  }
  assert.deepEqual(
    [...homeZh.matchAll(/<span class="channel-desc">([^<]+)<\/span>/g)].map((match) => match[1]),
    ['使用技巧和产品动态', '在微信里搜索这个名字', '新版本和开发进展', 'Star、提 Issue、贡献代码', '英文社区'],
  );
  assert.ok(homeZh.includes('微信扫一扫 · 备注 Abu'));
  // The English home page leads the card with the Discord server; the Chinese one with the WeChat group.
  assert.ok(homeEn.includes('<a class="btn btn-fill" href="https://discord.gg/eY3zH3XGqE" target="_blank" rel="noopener">Join the Discord</a>'));
  assert.ok(!homeZh.includes('class="join-actions"'));
  assert.ok(fs.statSync(path.join(websiteDir, 'assets/wechat-qr.png')).size > 0);
});

test('community pages offer the group, GitHub and the channels to follow', () => {
  const discord = 'https://discord.gg/eY3zH3XGqE';
  const repo = 'https://github.com/PM-Shawn/Abu-Cowork';
  for (const [file, cells, accounts] of [
    ['community.zh-CN.html', ['Star', '提 Issue', '提交代码', '报告安全问题'], ['Shawn的AI产品小记', 'Shawn的产品笔记', '@pmshawn_x', 'Abu']],
    ['community.html', ['Star', 'Issues', 'Pull requests', 'Security'], ['Shawn的AI产品小记', 'Shawn的产品笔记', '@pmshawn_x', 'Abu']],
  ]) {
    const source = read(file);
    for (const id of ['main-content', 'group', 'github', 'follow', 'stars']) {
      assert.ok(source.includes(` id="${id}"`), `${file} is missing #${id}`);
    }
    const group = source.slice(source.indexOf(' id="group"'), source.indexOf(' id="github"'));
    assert.ok(group.includes('<img src="assets/wechat-qr.png" width="448" height="448"'), `${file}: the first block carries the WeChat QR code`);
    const github = source.slice(source.indexOf(' id="github"'), source.indexOf(' id="follow"'));
    assert.deepEqual([...github.matchAll(/<span class="cell-name">([^<]+)<\/span>/g)].map((match) => match[1]), cells, file);
    assert.deepEqual(
      [...github.matchAll(/<a class="cell reveal" href="([^"]+)" target="_blank" rel="noopener">/g)].map((match) => match[1]),
      [repo, `${repo}/issues/new/choose`, `${repo}/pulls`, `${repo}/security/policy`],
      file,
    );
    assert.ok(github.includes('<span class="stars" id="stars" hidden></span>'), `${file}: the star count has its place beside the repository name`);
    const follow = source.slice(source.indexOf(' id="follow"'));
    assert.deepEqual([...follow.matchAll(/<span class="channel-account">([^<]+)<\/span>/g)].map((match) => match[1]), accounts, file);
    assert.ok(follow.includes(`href="${discord}"`), `${file}: the Discord server is listed`);
    assert.ok(source.includes('<script src="site.js"></script>'), `${file} loads the shared script, which reads the star count`);
    assert.doesNotMatch(source, /不是[^。]*而是/);
  }
  const zh = read('community.zh-CN.html');
  const en = read('community.html');
  assert.ok(zh.includes('<figcaption class="eyebrow">微信扫一扫 · 备注 Abu</figcaption>'));
  assert.ok(!zh.includes('class="join-actions"'), 'the Chinese page leads with the WeChat group');
  assert.ok(en.includes(`<a class="btn btn-fill" href="${discord}" target="_blank" rel="noopener">Join the Discord</a>`), 'the English page leads with the Discord server');
  // Both home pages send a reader who needs help to the community page.
  assert.ok(homeZh.includes('<a class="small finale-link" href="community.zh-CN.html">'));
  assert.ok(homeEn.includes('<a class="small finale-link" href="community.html">'));
});

test('release notes live on the documentation page, the home page keeps version and downloads', () => {
  for (const source of [homeZh, homeEn]) {
    assert.ok(!source.includes('id="news"') && !source.includes('#news'), 'the home page has no update section');
    assert.ok(!source.includes('marked.umd.js'), 'the home page does not load the Markdown renderer');
  }
  assert.ok(!homeScript.includes('notes_i18n') && !homeScript.includes('marked'), 'the home script does not read the release notes');
  assert.ok(homeScript.includes("whatsnew: `${docsPage}#changelog`, news: `${docsPage}#changelog`"), 'old update addresses open the release notes');

  const viewer = read('docs.js');
  assert.ok(viewer.includes("'changelog': { release: 'zh-CN', title: '更新日志' }"));
  assert.ok(viewer.includes("'changelog': { release: 'en-US', title: 'Release notes' }"));
  assert.ok(viewer.includes("const RELEASE_METADATA = 'https://abu-agent.oss-cn-beijing.aliyuncs.com/electron/latest-release.json';"));
  assert.ok(viewer.includes("(data.notes_i18n || {})[doc.release]"), 'the notes are taken in the page language only');
  assert.ok(viewer.includes("version.textContent = source.version;"), 'the version shows at the top');
  assert.ok(viewer.includes("const DEFAULT_DOC = 'installation';"));
  for (const [file, labels] of [
    ['docs.zh-CN.html', ['安装指南', '使用指南', '浏览网页', '应用规范', '插件规范', '更新日志']],
    ['docs.html', ['Installation Guide', 'User Guide', 'Web Browsing', 'App Spec (Chinese)', 'Plugin Spec (Chinese)', 'Release notes']],
  ]) {
    const source = read(file);
    assert.deepEqual([...source.matchAll(/<a class="doc-link" href="#[a-z-]+" data-doc="[a-z-]+">([^<]+)<\/a>/g)].map((match) => match[1]), labels, file);
    assert.deepEqual(attributeValues(source, 'data-doc'), ['installation', 'user-guide', 'web-browsing', 'app-spec', 'plugin-spec', 'changelog'], file);
    assert.ok(source.indexOf('assets/vendor/marked.umd.js') < source.indexOf('<script src="docs.js">'), 'the Markdown renderer loads before the viewer');
  }
  assert.ok(fs.existsSync(path.join(websiteDir, 'assets/vendor/marked.umd.js')));
});

test('navigation stays in place and lists the same eight entries on every page', () => {
  const labels = {
    zh: ['预览', '能力', '场景', '架构', '企业版', '开放平台', '文档', '社区'],
    en: ['Preview', 'Features', 'Use cases', 'Architecture', 'Enterprise', 'Open Platform', 'Docs', 'Community'],
  };
  assert.ok(read('site.css').includes('.nav { position: fixed; inset: 0 0 auto 0;'));
  assert.ok(!read('site.css').includes('is-hidden') && !read('site.js').includes('is-hidden'), 'the bar is never hidden while scrolling');
  for (const pair of pairs) {
    assert.deepEqual(navLabels(read(pair.zh)), labels.zh, pair.zh);
    assert.deepEqual(navLabels(read(pair.en)), labels.en, pair.en);
  }
  assert.deepEqual(navTargets(homeZh), ['#preview', '#abilities', '#scenes', '#tech', 'enterprise.zh-CN.html', 'platform.zh-CN.html', 'docs.zh-CN.html', 'community.zh-CN.html']);
  assert.deepEqual(navTargets(homeEn), ['#preview', '#abilities', '#scenes', '#tech', 'enterprise.html', 'platform.html', 'docs.html', 'community.html']);
  for (const id of ['preview', 'how', 'abilities', 'scenes', 'voices', 'safe', 'tech', 'community', 'start']) {
    assert.ok(homeZh.includes(` id="${id}"`) && homeEn.includes(` id="${id}"`), `home pages are missing #${id}`);
  }
  assert.equal(count(homeZh, 'class="eyebrow sec-no"'), 8, 'eight numbered sections');
});

test('Chinese and English pages share one structure', () => {
  for (const pair of pairs) {
    const zh = read(pair.zh);
    // English pages lead their community card with a button to the Discord server, which the Chinese pages do not have.
    const en = read(pair.en).replace(/<div class="join-actions">[\s\S]*?<\/div>/, '');
    // The English home page adds one line under the quotes saying they are translations.
    const enClasses = attributeValues(en, 'class').filter((value) => value !== 'wrap eyebrow voices-note');
    // Chinese titles wrap their line-end punctuation in a span that the English titles do not need.
    const zhClasses = attributeValues(zh, 'class').filter((value) => value !== 'punct');
    assert.deepEqual(enClasses, zhClasses, `${pair.en} and ${pair.zh} differ in structure`);
    assert.deepEqual(attributeValues(en, 'id'), attributeValues(zh, 'id'), `${pair.en} and ${pair.zh} differ in ids`);
    // English pages take the same pictures from assets/shots/en, where the client is in English.
    const enSources = attributeValues(en, 'src').map((src) => src.replace('assets/shots/en/', 'assets/shots/'));
    assert.deepEqual(enSources, attributeValues(zh, 'src'), `${pair.en} and ${pair.zh} differ in pictures or scripts`);
    assert.ok(!zh.includes('assets/shots/en/'), `${pair.zh} must use the Chinese screenshots`);
    assert.ok(!/assets\/shots\/(?!en\/)/.test(en), `${pair.en} must use the English screenshots`);
  }
});

test('language entry points redirect, documentation pages keep their language', () => {
  for (const [file, other, redirectsOn] of [
    ['index.zh-CN.html', 'index.html', 'en'],
    ['index.html', 'index.zh-CN.html', 'zh'],
    ['enterprise.zh-CN.html', 'enterprise.html', 'en'],
    ['enterprise.html', 'enterprise.zh-CN.html', 'zh'],
    ['platform.zh-CN.html', 'platform.html', 'en'],
    ['platform.html', 'platform.zh-CN.html', 'zh'],
    ['community.zh-CN.html', 'community.html', 'en'],
    ['community.html', 'community.zh-CN.html', 'zh'],
  ]) {
    const source = read(file);
    assert.ok(source.includes("localStorage.getItem('abu-lang')"), `${file} must read the remembered language`);
    assert.ok(source.includes(`if (target === '${redirectsOn}') location.replace('${other}');`), `${file} must redirect to ${other}`);
  }
  for (const file of ['docs.zh-CN.html', 'docs.html']) {
    assert.ok(!read(file).includes('location.replace'), `${file} is an explicit-language address`);
  }
  for (const pair of pairs) {
    // The navigation bar of every page links to the same page in the other language.
    assert.ok(read(pair.zh).includes(`<a class="nav-lang" href="${pair.en}" lang="en" onclick="try{localStorage.setItem('abu-lang','en')}catch(e){}">EN</a>`), pair.zh);
    assert.ok(read(pair.en).includes(`<a class="nav-lang" href="${pair.zh}" lang="zh-CN" onclick="try{localStorage.setItem('abu-lang','zh')}catch(e){}">中文</a>`), pair.en);
    assert.ok(read(pair.zh).includes(`<a href="${pair.en}" lang="en" onclick="try{localStorage.setItem('abu-lang','en')}catch(e){}">English</a>`), pair.zh);
    assert.ok(read(pair.en).includes(`<a href="${pair.zh}" lang="zh-CN" onclick="try{localStorage.setItem('abu-lang','zh')}catch(e){}">中文</a>`), pair.en);
  }
});

test('enterprise pages keep their anchors and button targets', () => {
  for (const [file, suffix] of [['enterprise.zh-CN.html', '.zh-CN.html'], ['enterprise.html', '.html']]) {
    const source = read(file);
    for (const id of ['main-content', 'capabilities', 'comparison', 'contact']) {
      assert.ok(source.includes(` id="${id}"`), `${file} is missing #${id}`);
    }
    assert.equal(count(source, 'href="#contact"'), 2, `${file}: navigation and hero both lead to the demo block`);
    assert.ok(source.includes('<a class="btn btn-line" href="#comparison">'));
    const contact = source.slice(source.indexOf(' id="contact"'));
    assert.ok(contact.includes('<img src="assets/wechat-qr.png" width="448" height="448"'), `${file}: the demo block carries the WeChat QR code`);
    assert.ok(!contact.includes('#community'), `${file}: booking a demo stays on this page`);
    assert.ok(source.includes(`<a class="btn btn-line" href="docs${suffix}">`));
    assert.equal(count(source, '<article class="cap reveal">'), 6);
    assert.equal(count(source, '<div class="compare-row" role="row">'), 13);
    assert.doesNotMatch(source, /不是[^。]*而是/);
  }
});

test('open platform pages show the parts of an app, the delivery steps and where to go next', () => {
  for (const [file, suffix, parts, note] of [
    ['platform.zh-CN.html', '.zh-CN.html', ['首页', '场景', '专家团', '专家', '技能', '导航', '应用网页'], '微信扫一扫 · 备注 开放平台'],
    ['platform.html', '.html', ['Home page', 'Scenes', 'Expert teams', 'Experts', 'Skills', 'Navigation', 'App web pages'], 'Scan in WeChat · note Open Platform'],
  ]) {
    const source = read(file);
    for (const id of ['main-content', 'anatomy', 'apps', 'steps', 'connect', 'official', 'contact']) {
      assert.ok(source.includes(` id="${id}"`), `${file} is missing #${id}`);
    }
    const anatomy = source.slice(source.indexOf(' id="anatomy"'), source.indexOf(' id="apps"'));
    assert.deepEqual([...anatomy.matchAll(/<li class="part reveal"><span class="part-no">[^<]*<\/span><h3 class="h3">([^<]+)<\/h3>/g)].map((match) => match[1]), parts, file);
    assert.equal(count(anatomy, '<span class="mark" data-mark='), 5, `${file}: five places are marked on the screenshot`);
    assert.equal(count(source, '<article class="app-shot reveal">'), 3, `${file}: the three apps that ship with Abu`);
    const steps = source.slice(source.indexOf(' id="steps"'), source.indexOf(' id="connect"'));
    assert.equal(count(steps, '<article class="stack-card">'), 4, `${file}: four delivery steps`);
    assert.ok(steps.includes('"defaultRun": { "team": "builtin-team:recruiting" }'), `${file}: the first step quotes the Recruiting app file`);
    assert.equal(count(source, '<article class="cell reveal"><span class="cell-name">'), 2, `${file}: connectors and app web pages`);
    // Reading the spec and downloading are offered in the hero and again at the end.
    assert.equal(count(source, `<a class="btn btn-fill" href="docs${suffix}#app-spec">`), 2, file);
    assert.equal(count(source, `<a class="btn btn-line" href="index${suffix}#start">`), 2, file);
    const contact = source.slice(source.indexOf(' id="contact"'));
    assert.ok(contact.includes('<img src="assets/wechat-qr.png" width="448" height="448"'), `${file}: the closing block carries the WeChat QR code`);
    assert.ok(contact.includes(`<figcaption class="eyebrow">${note}</figcaption>`), file);
    assert.ok(contact.includes('href="https://github.com/PM-Shawn/Abu-Cowork"'), `${file}: the closing block links the repository`);
    assert.doesNotMatch(source, /不是[^。]*而是/);
  }
  // The quoted lines of the app file are the ones the Recruiting app ships with.
  const app = JSON.parse(fs.readFileSync(path.join(root, 'builtin-plugin-market/apps/recruiting/.abu-app/app.json'), 'utf8'));
  assert.equal(app.name, 'recruiting');
  assert.deepEqual(app.defaultRun, { team: 'builtin-team:recruiting' });
  assert.equal(app.interface.displayName, '招聘');
  assert.equal(app.interface.shortDescription, '写 JD、筛简历、备面试、查行情');
  assert.equal(app.home.modes.items[0].scenes[0].templates[0].title['zh-CN'], '高级前端 JD');
});

test('open platform pages name the app controls as the user guide does', () => {
  for (const [page, guide, controls] of [
    ['platform.zh-CN.html', 'docs/User-Guide.zh-CN.md', ['创建应用', '从文件夹添加', '添加市场', '使用', '更新', '去连接', '应用市场']],
    ['platform.html', 'docs/User-Guide.md', ['Create app', 'Add from folder', 'Add market', 'Use', 'Update', 'Connect', 'app market']],
  ]) {
    const source = read(page);
    const manual = read(guide);
    for (const control of controls) {
      assert.ok(source.includes(control), `${page} does not mention ${control}`);
      assert.ok(manual.toLowerCase().includes(`**${control.toLowerCase()}**`), `${guide} has no control named ${control}`);
    }
  }
});

test('every local file a page references exists', () => {
  for (const file of pages) {
    const source = read(file);
    const references = [
      ...attributeValues(source, 'src'),
      ...attributeValues(source, 'href').filter((href) => /\.(?:css|png|html)(?:#.*)?$/.test(href) && !/^https?:/.test(href)),
      ...attributeValues(source, 'srcset').flatMap((set) => set.split(',').map((entry) => entry.trim().split(' ')[0])),
    ];
    assert.ok(references.length > 0);
    for (const reference of references) {
      const target = reference.split('#', 1)[0];
      assert.ok(fs.existsSync(path.join(websiteDir, target)), `${file} references missing ${target}`);
    }
    assert.ok(!source.includes('style.css'), `${file} still links the retired stylesheet`);
    assert.ok(source.includes('<link rel="stylesheet" href="site.css">'), `${file} must load the shared stylesheet`);
  }
});

test('screenshots are WebP, every one is used, and the preview tabs resolve', () => {
  const shotsDir = path.join(websiteDir, 'assets/shots');
  const shots = fs.readdirSync(shotsDir);
  const sources = pages.map(read).join('\n');
  const tabShots = attributeValues(homeZh, 'data-shot');
  const darkShots = [...homeScript.matchAll(/'(b-done-[a-z]+-light)'/g)].map((match) => match[1].replace('-light', '-dark'));
  assert.equal(count(homeZh, '<button class="tab"'), 12);
  assert.ok(darkShots.length >= 2, 'the preview script names the screenshots that have a dark variant');
  for (const name of [...tabShots, ...darkShots]) {
    assert.ok(shots.includes(`${name}.webp`) && shots.includes(`${name}-1440.webp`), `missing screenshot ${name}`);
  }
  // assets/shots holds the Chinese pictures and one folder, en, with the same pictures of the English client.
  const zhShots = shots.filter((shot) => shot !== 'en');
  const enShots = fs.readdirSync(path.join(shotsDir, 'en'));
  assert.ok(homeScript.includes("const base = zh ? 'assets/shots/' : 'assets/shots/en/';"), 'the preview tabs follow the page language');
  for (const [folder, list] of [['', zhShots], ['en/', enShots]]) {
    for (const name of [...tabShots, ...darkShots]) {
      assert.ok(list.includes(`${name}.webp`) && list.includes(`${name}-1440.webp`), `missing screenshot ${folder}${name}`);
    }
    for (const shot of list) {
      assert.ok(shot.endsWith('.webp'), `${folder}${shot} is not WebP`);
      const name = shot.replace(/(?:-1440)?\.webp$/, '');
      assert.ok(sources.includes(`assets/shots/${folder}${shot}`) || tabShots.includes(name) || darkShots.includes(name), `assets/shots/${folder}${shot} is not used by any page`);
    }
  }
});

test('serif fonts are served from the site', () => {
  for (const file of pages) {
    const source = read(file);
    assert.ok(!source.includes('fonts.googleapis.com') && !source.includes('fonts.gstatic.com'), `${file} loads fonts from Google`);
    for (const sheet of ['assets/fonts/instrument-serif/400.css', 'assets/fonts/instrument-serif/400-italic.css', 'assets/fonts/noto-serif-sc/500.css']) {
      assert.ok(source.includes(`<link rel="stylesheet" href="${sheet}">`), `${file} is missing ${sheet}`);
    }
  }
  for (const [directory, sheets] of [['noto-serif-sc', ['500.css']], ['instrument-serif', ['400.css', '400-italic.css']]]) {
    for (const sheet of sheets) {
      const css = fs.readFileSync(path.join(websiteDir, 'assets/fonts', directory, sheet), 'utf8');
      const files = [...css.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)].map((match) => match[1]);
      assert.ok(files.length > 0);
      for (const name of files) {
        assert.ok(fs.existsSync(path.join(websiteDir, 'assets/fonts', directory, 'files', name)), `missing font file ${name}`);
      }
    }
  }
});

test('pages follow the system appearance', () => {
  const css = read('site.css');
  assert.ok(css.includes('color-scheme: light dark;'));
  assert.ok(css.includes('@media (prefers-color-scheme: dark)'));
  // Dark values of the desktop client's tokens.
  for (const value of ['--paper: #1c1c1e;', '--ink: #f5f5f7;', '--ink-2: #a1a1a6;', '--desk: #141416;']) {
    assert.ok(css.includes(value), `site.css is missing the dark value ${value}`);
  }
  for (const file of ['index.zh-CN.html', 'index.html', 'enterprise.zh-CN.html', 'enterprise.html']) {
    assert.match(read(file), /<source media="\(prefers-color-scheme: dark\)" srcset="assets\/shots\/(?:en\/)?[a-z-]+-dark-1440\.webp 1440w/, `${file} has no dark screenshot`);
  }
  for (const file of pages) {
    assert.ok(read(file).includes('<meta name="theme-color" content="#1c1c1e" media="(prefers-color-scheme: dark)">'), file);
  }
});
