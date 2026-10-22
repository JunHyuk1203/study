// The header stays in the app shell while main handles page scrolling.
document.querySelector('.header')?.classList.remove('is-hidden');
window.addEventListener('study:navigated', () => {
  document.querySelector('.header')?.classList.remove('is-hidden');
});
