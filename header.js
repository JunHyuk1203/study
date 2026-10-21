let previousY = Math.max(0, window.scrollY);
let pending = false;

window.addEventListener('study:navigated', () => {
  previousY = Math.max(0, window.scrollY);
  document.querySelector('.header')?.classList.remove('is-hidden');
});

window.addEventListener('scroll', () => {
  if (pending) return;
  pending = true;

  window.requestAnimationFrame(() => {
    const header = document.querySelector('.header');
    const currentY = Math.max(0, window.scrollY);
    const difference = currentY - previousY;

    if (currentY <= 8) {
      header?.classList.remove('is-hidden');
      previousY = currentY;
    } else if (Math.abs(difference) >= 6) {
      header?.classList.toggle('is-hidden', difference > 0);
      previousY = currentY;
    }

    pending = false;
  });
}, { passive: true });
