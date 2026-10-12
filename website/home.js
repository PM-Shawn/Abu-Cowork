// Home page: the hero window, the dark scene, the model-name roll, the preview gallery, the feedback rows,
// and the release record behind the version and the download buttons.
(function () {
  const zh = document.documentElement.lang.toLowerCase().indexOf('zh') === 0;
  const TEXT = zh
    ? { unavailable: '暂时无法下载', shotAlt: (name) => `阿布客户端画面：${name}` }
    : { unavailable: 'Download unavailable', shotAlt: (name) => `Abu desktop app: ${name}` };

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wide = matchMedia('(min-width: 901px)');
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const span = (p, a, b) => clamp((p - a) / (b - a));

  // Addresses of the previous site's sections keep working. The release notes now live on the documentation page.
  const docsPage = zh ? 'docs.zh-CN.html' : 'docs.html';
  const LEGACY_SECTIONS = { features: '#abilities', screenshots: '#preview', 'use-cases': '#scenes', social: '#community', whatsnew: `${docsPage}#changelog`, news: `${docsPage}#changelog` };
  const legacyTarget = LEGACY_SECTIONS[location.hash.slice(1)];
  if (legacyTarget) location.replace(legacyTarget);

  // ── Hero window and dark scene ──
  const heroWindow = document.getElementById('heroWindow');
  const manifesto = document.getElementById('manifesto');
  const aurora = document.getElementById('aurora');
  // The window starts slightly small and low, and reaches full size once it has scrolled up to the navigation bar.
  const WINDOW_START_SCALE = 0.94;
  const WINDOW_START_DROP = 24;

  // The dark scene's sentence: one span per character, lit while the page scrolls.
  const textEl = document.getElementById('manifestoText');
  const chars = [];
  textEl.dataset.text.split('|').forEach((line, i, all) => {
    for (const ch of line) {
      const s = document.createElement('span');
      s.textContent = ch;
      textEl.appendChild(s);
      chars.push(s);
    }
    if (i < all.length - 1) textEl.appendChild(document.createElement('br'));
  });

  let mouseX = 0;
  let mouseY = 0;
  let queued = false;
  addEventListener('pointermove', (e) => {
    mouseX = e.clientX / innerWidth - 0.5;
    mouseY = e.clientY / innerHeight - 0.5;
    request();
  }, { passive: true });
  addEventListener('scroll', request, { passive: true });
  addEventListener('resize', request);

  function request() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; frame(); });
  }

  function frame() {
    const vh = innerHeight;

    if (wide.matches && !reduced) {
      const p = clamp(scrollY / Math.max(1, heroWindow.offsetTop - 96));
      const scale = WINDOW_START_SCALE + (1 - WINDOW_START_SCALE) * p;
      heroWindow.style.transform = `translateY(${(1 - p) * WINDOW_START_DROP}px) scale(${scale})`;
    } else {
      heroWindow.style.transform = '';
    }

    if (reduced) {
      chars.forEach((s) => s.classList.add('is-on'));
      return;
    }
    const m = manifesto.getBoundingClientRect();
    const mp = clamp(-m.top / (m.height - vh));
    const lit = Math.round(span(mp, 0.05, 0.85) * chars.length);
    chars.forEach((s, i) => s.classList.toggle('is-on', i < lit));
    aurora.style.transform = `translate(${mouseX * -40}px, ${mp * -120 + mouseY * -30}px) rotate(${mp * 14}deg)`;
  }

  // ── Model name in the hero's second line ──
  // Every 1.8 s the list moves up one name. A copy of the first name sits at the end; after reaching it the list jumps back to the start, so the roll looks continuous.
  // The slot is as wide as the longest name (the list is a one-column grid), so the words before it stay where they are.
  const rotorList = document.getElementById('rotorList');
  if (!reduced) {
    const names = [...rotorList.children];
    rotorList.appendChild(names[0].cloneNode(true));
    let index = 0;
    setInterval(() => {
      index += 1;
      rotorList.style.transition = '';
      rotorList.style.transform = `translateY(${-index * 1.4}em)`;
      if (index === names.length) {
        setTimeout(() => {
          index = 0;
          rotorList.style.transition = 'none';
          rotorList.style.transform = 'translateY(0)';
        }, 700);
      }
    }, 1800);
  }

  // ── Product preview ──
  // A tab loads its whole-window screenshot on first use and fades it in. The screenshots that exist in the dark appearance follow the system setting.
  const gallery = document.getElementById('gallery');
  const tabNote = document.getElementById('tabNote');
  const tabs = [...document.querySelectorAll('.tab')];
  const HAS_DARK_SHOT = ['b-done-steps-light', 'b-done-preview-light'];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const name = tab.dataset.shot;
      tabs.forEach((t) => t.setAttribute('aria-pressed', String(t === tab)));
      tabNote.textContent = tab.dataset.note;
      let img = gallery.querySelector(`img[data-shot="${name}"]`);
      if (!img) {
        const file = dark.matches && HAS_DARK_SHOT.includes(name) ? name.replace('-light', '-dark') : name;
        img = document.createElement('img');
        img.dataset.shot = name;
        img.width = 1440;
        img.height = 900;
        img.alt = TEXT.shotAlt(tab.textContent);
        img.sizes = '(max-width: 900px) calc(100vw - 48px), 1240px';
        // English pages show the client in English, from assets/shots/en.
        const base = zh ? 'assets/shots/' : 'assets/shots/en/';
        img.srcset = `${base}${file}-1440.webp 1440w, ${base}${file}.webp 2880w`;
        img.src = `${base}${file}.webp`;
        // A screenshot that fails to load leaves the previous one in the window and is requested again on the next click.
        img.addEventListener('error', () => img.remove(), { once: true });
        gallery.appendChild(img);
      }
      const show = () => gallery.querySelectorAll('img').forEach((el) => el.classList.toggle('is-on', el === img));
      if (img.complete && img.naturalWidth > 0) show();
      else img.addEventListener('load', show, { once: true });
    });
  }

  // ── User feedback ──
  // Each row holds its quotes twice so the loop joins end to start.
  for (const id of ['rowA', 'rowB']) {
    const row = document.getElementById(id);
    for (const q of [...row.children]) {
      const copy = q.cloneNode(true);
      copy.setAttribute('aria-hidden', 'true');
      row.appendChild(copy);
    }
  }

  // ── Release record: installers and version ──
  // Installer downloads always use the official OSS host.
  const OSS_BASE = 'https://abu-agent.oss-cn-beijing.aliyuncs.com';
  const RELEASE_METADATA = `${OSS_BASE}/electron/latest-release.json`;
  const downloadLinks = ['dlMacSilicon', 'dlMacIntel', 'dlWindows'].map((id) => document.getElementById(id));

  downloadLinks.forEach((link) => link.addEventListener('click', (event) => {
    if (link.dataset.ready !== 'true') event.preventDefault();
  }));

  function applyLinks(urls) {
    document.getElementById('dlMacSilicon').href = urls.macSilicon;
    document.getElementById('dlMacIntel').href = urls.macIntel;
    document.getElementById('dlWindows').href = urls.windows;
    downloadLinks.forEach((link) => {
      link.dataset.ready = 'true';
      link.removeAttribute('aria-disabled');
    });
  }

  function trustedDownloadUrl(value, extension, version) {
    const url = new URL(value);
    const releasePath = `/releases/${version}/`;
    if (url.origin !== OSS_BASE || !url.pathname.startsWith(releasePath) || !url.pathname.toLowerCase().endsWith(extension)) {
      throw new Error('Untrusted installer URL');
    }
    return url.href;
  }

  // When the record cannot be read or fails a check, the links stay closed and the button says so.
  function markDownloadUnavailable() {
    document.getElementById('dlPrimaryLabel').textContent = TEXT.unavailable;
  }

  function showVersion(version) {
    for (const el of document.querySelectorAll('[data-release-version]')) {
      el.textContent = version;
      el.closest('[data-release-line]').hidden = false;
    }
  }

  function applyMetadata(data) {
    if (data.schema_version !== 1 || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(data.version || '')) {
      throw new Error('Invalid release metadata');
    }
    const downloads = data.downloads || {};
    applyLinks({
      macSilicon: trustedDownloadUrl(downloads['mac-arm64']?.url, '.dmg', data.version),
      macIntel: trustedDownloadUrl(downloads['mac-x64']?.url, '.dmg', data.version),
      windows: trustedDownloadUrl(downloads['windows-x64']?.url, '.exe', data.version),
    });
    showVersion(data.version);
  }

  fetch(RELEASE_METADATA, { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(`Release metadata responded ${r.status}`); return r.json(); })
    .then(applyMetadata)
    .catch(markDownloadUnavailable);

  // The macOS button opens the list of installers; a click elsewhere closes it.
  const trigger = document.getElementById('dlChevron');
  const menu = document.getElementById('dlMenu');
  function setMenu(open) {
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  }
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    setMenu(menu.hidden);
  });
  document.addEventListener('click', () => setMenu(false));
  menu.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      setMenu(false);
      trigger.focus();
    }
  });

  frame();
})();
