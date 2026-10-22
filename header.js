// The header stays in the app shell while main handles page scrolling.
// Dialog autofocus can match :focus-visible on iOS even when opened by touch.
// Keep button focus rings for keyboard navigation only, without blurring focus.
document.addEventListener('pointerdown', () => {
  document.documentElement.removeAttribute('data-keyboard-navigation');
}, true);
document.addEventListener('keydown', (event) => {
  if (['Tab', 'Enter', ' ', 'Home', 'End'].includes(event.key) || event.key.startsWith('Arrow')) {
    document.documentElement.setAttribute('data-keyboard-navigation', '');
  }
}, true);

document.querySelector('.header')?.classList.remove('is-hidden');
window.addEventListener('study:navigated', () => {
  document.querySelector('.header')?.classList.remove('is-hidden');
});
