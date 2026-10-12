// Shared by every page: the navigation bar's states and the entrance of content.
(function () {
  const nav = document.getElementById('nav');
  const nights = [...document.querySelectorAll('[data-night]')];
  let queued = false;

  // The bar stays at the top of the window. Away from the top of the page it gets a background and a rule; over a dark block it turns dark.
  function update() {
    nav.classList.toggle('is-solid', nav.hasAttribute('data-solid') || scrollY > 24);
    const onNight = nights.some((el) => {
      const r = el.getBoundingClientRect();
      return r.top <= 36 && r.bottom >= 36;
    });
    nav.classList.toggle('on-night', onNight);
  }

  function request() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }
  addEventListener('scroll', request, { passive: true });
  addEventListener('resize', request);
  update();

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach((el, i) => {
    el.style.transitionDelay = `${(i % 4) * 70}ms`;
    observer.observe(el);
  });

  // Star count beside the repository's name, on the pages that have a place for it.
  // The count comes from GitHub's public API; when it cannot be read the place stays empty.
  const stars = document.getElementById('stars');
  if (stars) {
    fetch('https://api.github.com/repos/PM-Shawn/Abu-Cowork')
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((repo) => {
        if (!repo) return;
        stars.textContent = `★ ${repo.stargazers_count.toLocaleString('en-US')}`;
        stars.hidden = false;
      })
      .catch(() => {});
  }
})();
