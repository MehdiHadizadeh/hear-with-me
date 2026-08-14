// Keeping a listening phone's screen on.
//
// The background-playback limit is not fixable — the OS classifies a
// real-time stream as a call, and a call is suspended when you leave the app.
// But a large share of the cases people actually hit is just the screen
// locking itself while the phone sits on the table, and that one *is*
// preventable.

export function createWakeLock() {
  let lock = null;

  return {
    get supported() { return 'wakeLock' in navigator; },

    async request() {
      if (!this.supported || lock || document.visibilityState !== 'visible') return;
      try {
        lock = await navigator.wakeLock.request('screen');
        // The browser drops the lock whenever the page is hidden; forgetting
        // the stale handle is what lets us take a fresh one on the way back.
        lock.addEventListener('release', () => { lock = null; });
      } catch (e) { /* refused, or not allowed in this context */ }
    },

    release() {
      if (!lock) return;
      const held = lock;
      lock = null;
      held.release().catch(() => {});
    },
  };
}
