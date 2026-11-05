/* Optional, one-shot visual explanations. All information is present in HTML. */
(() => {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const active = new Map();
  const seen = new WeakSet();
  const buttons = [...document.querySelectorAll('[data-play]')];
  function stop(element) {
    clearTimeout(active.get(element));
    active.delete(element);
    element.classList.remove('is-playing', 'is-paused');
  }
  function play(element) {
    if (motion.matches || document.hidden) return;
    stop(element);
    // A new class application starts the short sequence from its first step.
    void element.offsetWidth;
    element.classList.add('is-playing');
    active.set(element, setTimeout(() => stop(element), 3400));
  }
  function updatePreference() {
    buttons.forEach(button => { button.hidden = motion.matches; });
    if (motion.matches) [...active.keys()].forEach(stop);
  }
  buttons.forEach(button => button.addEventListener('click', () => {
    const element = document.getElementById(button.dataset.play);
    if (element) play(element);
  }));
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) { stop(entry.target); return; }
    if (!seen.has(entry.target)) { seen.add(entry.target); play(entry.target); }
  }), { threshold: .25 });
  document.querySelectorAll('.process-sequence, .courtyard-scene, .cloud-hero').forEach(element => observer.observe(element));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) [...active.keys()].forEach(stop);
  });
  motion.addEventListener('change', updatePreference);
  updatePreference();
})();
