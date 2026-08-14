// How long this has been running.
//
// Anchored to performance.now() against an elapsed value from the server,
// never to a wall-clock timestamp — a guest's clock can be minutes off ours,
// and "started at 21:04" would then be a lie while "running for 3:12" is not.

import { formatClock } from './format.js';

export function createElapsedTimer(el) {
  let anchor = null;
  let base = 0;
  let tick = null;

  const render = () => { el.textContent = formatClock(base + (performance.now() - anchor)); };

  return {
    start(elapsedMs) {
      this.stop();
      base = Number(elapsedMs) || 0;
      anchor = performance.now();
      render();
      tick = setInterval(render, 1000);
    },
    stop() {
      if (tick) { clearInterval(tick); tick = null; }
      el.textContent = formatClock(0);
    },
  };
}
