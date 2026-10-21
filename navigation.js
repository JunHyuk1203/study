// Keep navigation in one document so the slide cannot be skipped on page load.
(() => {
  const tabPages = ['index.html', 'study.html', 'school.html', 'play.html', 'account.html'];
  let displayedUrl = new URL(window.location.href);
  let navigating = false;

  function tabIndex(url) {
    return tabPages.indexOf(url.pathname.endsWith('/') ? 'index.html' : url.pathname.split('/').pop());
  }

  async function navigate(url, pushHistory) {
    if (navigating) return;
    const from = tabIndex(displayedUrl);
    const to = tabIndex(url);
    if (from === to) return;
    navigating = true;

    let stage;
    try {
      const response = await fetch(url.href, { cache: 'no-store' });
      if (!response.ok) throw new Error('Page could not be loaded');
      const nextDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
      const nextApp = nextDocument.querySelector('.app');
      const currentApp = document.querySelector('.app');
      if (!nextApp || !currentApp) throw new Error('Page layout is missing');
      const currentNav = currentApp.querySelector('.bottom-nav');
      const nextNav = nextApp.querySelector('.bottom-nav');
      const nextHeader = nextApp.querySelector('.header');
      const nextMain = nextApp.querySelector('main');
      if (!currentNav || !nextNav || !nextHeader || !nextMain) throw new Error('Page structure is missing');

      stage = document.createElement('div');
      stage.className = 'tab-slide-stage';
      stage.style.bottom = `${window.innerHeight - currentNav.getBoundingClientRect().top}px`;
      stage.setAttribute('aria-hidden', 'true');
      stage.inert = true;
      const outgoing = document.createElement('div');
      const incoming = document.createElement('div');
      outgoing.className = incoming.className = 'tab-slide-page';
      const outgoingApp = currentApp.cloneNode(true);
      outgoingApp.querySelector('.bottom-nav').remove();
      nextNav.remove();
      outgoing.append(outgoingApp);
      incoming.append(nextApp);
      stage.append(outgoing, incoming);
      document.body.append(stage);
      outgoing.scrollTop = Math.max(0, window.scrollY);

      const direction = to > from ? 1 : -1;
      const timing = { duration: 440, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both' };
      const animations = [
        outgoing.animate([
          { transform: 'translateX(0)' },
          { transform: `translateX(${-direction * 100}%)` },
        ], timing),
        incoming.animate([
          { transform: `translateX(${direction * 100}%)` },
          { transform: 'translateX(0)' },
        ], timing),
      ];
      await Promise.all(animations.map(animation => animation.finished));

      // Preserve the actual navigation node outside both sliding panels.
      currentApp.querySelector('.header').replaceWith(nextHeader);
      currentApp.querySelector('main').replaceWith(nextMain);
      const selectedHref = nextNav.querySelector('[aria-current="page"]')?.getAttribute('href');
      for (const link of currentNav.querySelectorAll('a')) {
        if (link.getAttribute('href') === selectedHref) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      document.title = nextDocument.title;
      if (pushHistory) window.history.pushState(null, '', url.href);
      displayedUrl = url;
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      window.dispatchEvent(new Event('study:navigated'));
    } catch {
      window.location.assign(url.href);
    } finally {
      stage?.remove();
      navigating = false;
    }
  }

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== displayedUrl.origin || url.hash || tabIndex(url) < 0 || tabIndex(displayedUrl) < 0) return;

    event.preventDefault();
    if (!navigating) void navigate(url, true);
  });

  window.addEventListener('popstate', () => {
    const url = new URL(window.location.href);
    if (navigating || tabIndex(url) < 0 || tabIndex(displayedUrl) < 0) {
      window.location.reload();
      return;
    }
    void navigate(url, false);
  });
})();
