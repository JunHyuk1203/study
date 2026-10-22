// Keep navigation in one document so the slide cannot be skipped on page load.
(() => {
  const tabPages = ['index.html', 'study.html', 'school.html', 'play.html'];
  let displayedUrl = new URL(window.location.href);
  let activeNavigation = null;
  let aiReturnUrl = new URL('index.html', displayedUrl);
  let accountReturnUrl = new URL('index.html', displayedUrl);

  function tabIndex(url) {
    return tabPages.indexOf(url.pathname.endsWith('/') ? 'index.html' : url.pathname.split('/').pop());
  }

  function isAI(url) {
    return url.pathname.split('/').pop() === 'ai.html';
  }

  function isPage(url) {
    return tabIndex(url) >= 0 || isSheet(url);
  }

  function isAccount(url) {
    return url.pathname.split('/').pop() === 'account.html';
  }

  function isSheet(url) {
    return isAI(url) || isAccount(url);
  }

  function cancelNavigation() {
    if (!activeNavigation) return;
    const previous = activeNavigation;
    // Finish the visible destination before choosing the next slide direction.
    // Interrupted destinations do not add entries to browser history.
    previous.commit?.(false);
    activeNavigation = null;
    previous.controller.abort();
    for (const animation of previous.animations) animation.cancel();
    previous.stage?.remove();
    document.documentElement.classList.remove('tab-navigation-active');
  }

  async function navigate(url, pushHistory) {
    if (activeNavigation?.url.href === url.href) return;
    cancelNavigation();
    const from = tabIndex(displayedUrl);
    const to = tabIndex(url);
    if (from === to && isAI(displayedUrl) === isAI(url) && isAccount(displayedUrl) === isAccount(url)) return;
    const openingAI = isAI(url);
    const closingAI = isAI(displayedUrl);
    const openingAccount = isAccount(url);
    const closingAccount = isAccount(displayedUrl);
    const openingSheet = isSheet(url);
    const closingSheet = isSheet(displayedUrl);
    const transition = { url, controller: new AbortController(), animations: [], stage: null };
    activeNavigation = transition;

    let stage;
    try {
      const response = await fetch(url.href, { cache: 'no-store', signal: transition.controller.signal });
      if (!response.ok) throw new Error('Page could not be loaded');
      const html = await response.text();
      if (activeNavigation !== transition) return;
      const nextDocument = new DOMParser().parseFromString(html, 'text/html');
      const nextApp = nextDocument.querySelector('.app');
      const currentApp = document.querySelector('.app');
      if (!nextApp || !currentApp) throw new Error('Page layout is missing');
      const currentNav = currentApp.querySelector('.bottom-nav');
      const currentHeader = currentApp.querySelector('.header');
      const nextNav = nextApp.querySelector('.bottom-nav');
      const nextHeader = nextApp.querySelector('.header');
      const nextMain = nextApp.querySelector('main');
      if (!currentNav || !currentHeader || !nextNav || !nextHeader || !nextMain) throw new Error('Page structure is missing');
      if (openingAI) {
        if (!closingAI) aiReturnUrl = displayedUrl;
        nextMain.querySelector('[data-ai-close]')?.setAttribute('href', aiReturnUrl.href);
      }
      if (openingAccount) {
        if (!closingAccount) accountReturnUrl = displayedUrl;
        nextMain.querySelector('[data-account-close]')?.setAttribute('href', accountReturnUrl.href);
      }
      // Move the persistent selection background alongside the page slide.
      const selectedHref = nextNav.querySelector('[aria-current="page"]')?.getAttribute('href');
      for (const link of currentNav.querySelectorAll('a')) {
        if (link.getAttribute('href') === selectedHref) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }

      document.documentElement.classList.add('tab-navigation-active');
      const contentTop = Math.max(0, currentHeader.getBoundingClientRect().bottom);

      stage = document.createElement('div');
      transition.stage = stage;
      stage.className = 'tab-slide-stage';
      if (openingSheet || closingSheet) stage.classList.add('sheet-slide-stage');
      stage.style.top = `${contentTop}px`;
      const sideNavigation = window.matchMedia('(min-width: 768px)').matches;
      stage.style.bottom = sideNavigation ? '0px' : `${window.innerHeight - currentNav.getBoundingClientRect().top}px`;
      if (sideNavigation) stage.style.left = `${currentNav.getBoundingClientRect().right}px`;
      stage.setAttribute('aria-hidden', 'true');
      stage.inert = true;
      const outgoing = document.createElement('div');
      const incoming = document.createElement('div');
      outgoing.className = incoming.className = 'tab-slide-page';
      const outgoingApp = currentApp.cloneNode(true);
      outgoingApp.querySelector('.bottom-nav').remove();
      outgoingApp.querySelector('.header').remove();
      nextNav.remove();
      nextHeader.remove();
      outgoing.append(outgoingApp);
      incoming.append(nextApp);
      stage.append(outgoing, incoming);
      document.body.append(stage);
      window.dispatchEvent(new Event('study:page-prepared'));
      outgoing.scrollTop = Math.max(0, contentTop - currentApp.querySelector('main').getBoundingClientRect().top);

      const direction = to > from ? 1 : -1;
      transition.commit = (recordHistory = true) => {
        if (transition.committed || activeNavigation !== transition) return;
        transition.committed = true;
        // Preserve the actual navigation node outside both sliding panels.
        currentApp.querySelector('main').replaceWith(nextMain);
        document.title = nextDocument.title;
        if (recordHistory && pushHistory && window.location.href !== url.href) window.history.pushState(null, '', url.href);
        displayedUrl = url;
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        window.dispatchEvent(new Event('study:navigated'));
        if (openingAI) nextMain.querySelector('[data-ai-close]')?.focus({ preventScroll: true });
        if (closingAI) currentApp.querySelector('a[href="ai.html"]')?.focus({ preventScroll: true });
        if (openingAccount) nextMain.querySelector('[data-account-close]')?.focus({ preventScroll: true });
        if (closingAccount) currentHeader.querySelector('.profile-dot')?.focus({ preventScroll: true });
      };
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const timing = { duration: reducedMotion ? 0 : 440, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both' };
      if (closingSheet && !openingSheet) outgoing.style.zIndex = '1';
      const animations = openingSheet || closingSheet ? [
        outgoing.animate(openingSheet ? [{ opacity: 1 }, { opacity: .65 }] : [{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }], timing),
        incoming.animate(openingSheet ? [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }] : [{ opacity: .65 }, { opacity: 1 }], timing),
      ] : [
        outgoing.animate([
          { transform: 'translateX(0)' },
          { transform: `translateX(${-direction * 100}%)` },
        ], timing),
        incoming.animate([
          { transform: `translateX(${direction * 100}%)` },
          { transform: 'translateX(0)' },
        ], timing),
      ];
      transition.animations = animations;
      await Promise.all(animations.map(animation => animation.finished));
      if (activeNavigation !== transition) return;

      transition.commit();
    } catch {
      if (activeNavigation === transition && !transition.controller.signal.aborted) window.location.assign(url.href);
    } finally {
      stage?.remove();
      if (activeNavigation === transition) {
        document.documentElement.classList.remove('tab-navigation-active');
        activeNavigation = null;
      }
    }
  }

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== displayedUrl.origin || url.hash || !isPage(url) || !isPage(displayedUrl)) return;

    event.preventDefault();
    void navigate(url, true);
  });

  window.addEventListener('popstate', () => {
    const url = new URL(window.location.href);
    if (!isPage(url) || !isPage(displayedUrl)) {
      window.location.reload();
      return;
    }
    void navigate(url, false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isAI(displayedUrl)) {
      document.querySelector('[data-ai-close]')?.click();
    }
    if (event.key === 'Escape' && isAccount(displayedUrl) && !document.querySelector('#account-settings[open]')) {
      document.querySelector('[data-account-close]')?.click();
    }
  });
})();
