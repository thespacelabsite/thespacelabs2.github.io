// Share button: the native share sheet where available, otherwise copy the link. Stays hidden if neither exists.
(function () {
  const btn = document.querySelector('[data-share]');
  if (!btn || !(navigator.share || navigator.clipboard)) return;
  const label = btn.querySelector('span');
  const idleText = label.textContent;
  btn.hidden = false;
  btn.addEventListener('click', async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title, text: btn.dataset.share, url: location.href });
        return;
      }
      await navigator.clipboard.writeText(location.href);
      label.textContent = 'Link copied';
      setTimeout(() => { label.textContent = idleText; }, 2000);
    } catch (err) {
      if (err.name !== 'AbortError') console.warn('[card] share failed', err);
    }
  });
})();
