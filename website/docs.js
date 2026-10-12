// Documentation page: reads the Markdown guides and the release notes, switches between them, builds the contents list.
(function () {
  const zh = document.documentElement.lang.toLowerCase().indexOf('zh') === 0;
  // A guide is a Markdown file of the site. The release notes come from the release record, in this page's language.
  const DOCS = zh
    ? {
        'installation': { file: 'docs/Installation-Guide.zh-CN.md', title: '安装指南' },
        'user-guide': { file: 'docs/User-Guide.zh-CN.md', title: '使用指南' },
        'web-browsing': { file: 'docs/browser-bridge-vs-playwright.zh-CN.md', title: '浏览网页' },
        'app-spec': { file: 'docs/app-spec.md', title: '应用规范' },
        'plugin-spec': { file: 'docs/plugin-spec.md', title: '插件规范' },
        'changelog': { release: 'zh-CN', title: '更新日志' },
      }
    : {
        'installation': { file: 'docs/Installation-Guide.md', title: 'Installation Guide' },
        'user-guide': { file: 'docs/User-Guide.md', title: 'User Guide' },
        'web-browsing': { file: 'docs/browser-bridge-vs-playwright.md', title: 'Web Browsing' },
        // The two specs exist in Chinese only.
        'app-spec': { file: 'docs/app-spec.md', title: 'App Spec (Chinese)' },
        'plugin-spec': { file: 'docs/plugin-spec.md', title: 'Plugin Spec (Chinese)' },
        'changelog': { release: 'en-US', title: 'Release notes' },
      };
  const DEFAULT_DOC = 'installation';
  const RELEASE_METADATA = 'https://abu-agent.oss-cn-beijing.aliyuncs.com/electron/latest-release.json';
  const TEXT = zh
    ? {
        loading: '正在读取文档',
        failed: (title) => `「${title}」没有读取成功。`,
        retry: '重新读取',
        contents: '本页目录',
        pageTitle: (title) => `${title} - Abu (阿布)`,
      }
    : {
        loading: 'Loading the document',
        failed: (title) => `“${title}” could not be loaded.`,
        retry: 'Try again',
        contents: 'On this page',
        pageTitle: (title) => `${title} — Abu`,
      };

  const article = document.getElementById('article');
  const state = document.getElementById('docsState');
  const toc = document.getElementById('toc');
  const side = document.getElementById('docsSide');
  const menu = document.getElementById('docsMenu');
  let headingCounts = {};
  let spy = null;
  let loadCount = 0;

  function slugify(text) {
    return text.toLowerCase().replace(/[^\w一-鿿\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
  }

  const renderer = new window.marked.Renderer();
  renderer.heading = function ({ tokens, depth }) {
    const text = tokens.map((t) => t.raw || t.text || '').join('');
    let slug = slugify(text);
    headingCounts[slug] = (headingCounts[slug] || 0) + 1;
    if (headingCounts[slug] > 1) slug += '-' + headingCounts[slug];
    return `<h${depth} id="${slug}">${this.parser.parseInline(tokens)}</h${depth}>`;
  };
  renderer.table = function ({ header, rows }) {
    const cell = (tag, item) => {
      const align = item.align ? ` style="text-align:${item.align}"` : '';
      return `<${tag}${align}>${this.parser.parseInline(item.tokens)}</${tag}>`;
    };
    const head = header.map((item) => cell('th', item)).join('');
    const body = rows.map((row) => `<tr>${row.map((item) => cell('td', item)).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  };
  window.marked.use({ gfm: true, breaks: false, renderer });

  // The part of the address after # names either a guide or a heading inside the current guide.
  // Old public links to #browser-bridge open the guide under its current name.
  function docFromHash() {
    const hash = decodeURIComponent(location.hash.slice(1));
    const key = hash === 'browser-bridge' ? 'web-browsing' : hash;
    if (hash === 'browser-bridge') history.replaceState(null, '', '#web-browsing');
    return DOCS[key] ? key : null;
  }

  function showState(...nodes) {
    state.replaceChildren(...nodes);
    state.hidden = false;
  }

  // Resolves to { markdown, version } or, when the source cannot be read, to null.
  function readGuide(doc) {
    return fetch(doc.file)
      .then((resp) => (resp.ok ? resp.text() : null), () => null)
      .then((markdown) => (markdown === null ? null : { markdown, version: '' }));
  }

  function readReleaseNotes(doc) {
    return fetch(RELEASE_METADATA, { cache: 'no-cache' })
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((data) => {
        if (!data || data.schema_version !== 1 || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(data.version || '')) return null;
        const notes = ((data.notes_i18n || {})[doc.release] || '').trim();
        return notes ? { markdown: notes, version: data.version } : null;
      })
      .catch(() => null);
  }

  async function loadDoc(key, headingId) {
    const doc = DOCS[key];
    const load = ++loadCount;
    document.querySelectorAll('.doc-link').forEach((el) => {
      if (el.dataset.doc === key) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
    article.replaceChildren();
    toc.replaceChildren();
    spy = null;
    showState(TEXT.loading);

    // A document that cannot be read shows a message with a retry button in place of the text.
    const source = await (doc.release ? readReleaseNotes(doc) : readGuide(doc));
    if (load !== loadCount) return;
    if (source === null) {
      const message = document.createElement('p');
      message.textContent = TEXT.failed(doc.title);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-line btn-sm';
      retry.textContent = TEXT.retry;
      retry.addEventListener('click', () => loadDoc(key));
      showState(message, retry);
      return;
    }

    headingCounts = {};
    article.innerHTML = window.marked.parse(source.markdown);
    state.hidden = true;
    document.title = TEXT.pageTitle(doc.title);

    // The release notes carry no title of their own: the page adds one and the version under it.
    if (doc.release) {
      const title = document.createElement('h1');
      title.textContent = doc.title;
      const version = document.createElement('p');
      version.className = 'doc-version';
      version.id = 'docVersion';
      version.textContent = source.version;
      article.prepend(title, version);
    }

    // Each guide opens with a line linking to its other-language file; the page has its own language link.
    const opener = article.querySelector('h1 + p');
    if (opener && /^(English|中文)\s*\|\s*(English|中文)$/.test(opener.textContent.trim())) opener.remove();

    // Keep links between Markdown guides inside the single-page docs viewer; outside links open in a new tab.
    article.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href').replace(/^\.\//, '');
      // A link may name a heading of the other guide, or the guide's file in the other language.
      const file = href.split('#')[0].replace('.zh-CN.md', '.md');
      const target = file && Object.entries(DOCS).find(([, candidate]) => candidate.file && candidate.file.replace('.zh-CN.md', '.md').endsWith('/' + file));
      if (target) link.setAttribute('href', '#' + target[0]);
      else if (/^https?:/.test(href)) { link.target = '_blank'; link.rel = 'noopener'; }
    });

    buildToc();
    const heading = headingId && document.getElementById(headingId);
    if (heading) heading.scrollIntoView();
    else scrollTo(0, 0);
  }

  function buildToc() {
    const headings = [...article.querySelectorAll('h2, h3')];
    if (!headings.length) return;
    const label = document.createElement('span');
    label.className = 'eyebrow';
    label.textContent = TEXT.contents;
    toc.append(label);
    for (const h of headings) {
      const a = document.createElement('a');
      a.className = 'toc-link' + (h.tagName === 'H3' ? ' is-h3' : '');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      a.dataset.heading = h.id;
      toc.append(a);
    }
    spy = headings;
    markCurrentHeading();
  }

  // The contents list marks the heading being read: the last one that has scrolled up to the navigation bar.
  function markCurrentHeading() {
    if (!spy) return;
    let current = spy[0];
    for (const h of spy) {
      if (h.getBoundingClientRect().top <= 120) current = h;
    }
    toc.querySelectorAll('.toc-link').forEach((el) => el.classList.toggle('is-active', el.dataset.heading === current.id));
  }
  addEventListener('scroll', markCurrentHeading, { passive: true });

  addEventListener('hashchange', () => {
    const key = docFromHash();
    if (key) loadDoc(key);
    side.classList.remove('is-open');
    menu.setAttribute('aria-expanded', 'false');
  });
  menu.addEventListener('click', () => {
    const open = side.classList.toggle('is-open');
    menu.setAttribute('aria-expanded', String(open));
  });

  const firstDoc = docFromHash();
  loadDoc(firstDoc || DEFAULT_DOC, firstDoc ? null : decodeURIComponent(location.hash.slice(1)));
})();
