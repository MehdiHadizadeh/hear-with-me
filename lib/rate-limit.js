// A fixed-window counter per (bucket, key). Enough to make flooding or code
// guessing pointless; not a defence against anyone with many addresses.

export function createRateLimiter({ windowMs = 60 * 1000 } = {}) {
  const windows = new Map(); // `${bucket}:${key}` -> { start, count }

  return {
    // True when this hit is within the limit.
    hit(bucket, key, limit) {
      const id = `${bucket}:${key}`;
      const now = Date.now();
      let w = windows.get(id);
      if (!w || now - w.start >= windowMs) {
        w = { start: now, count: 0 };
        windows.set(id, w);
      }
      w.count++;
      return w.count <= limit;
    },

    sweep() {
      const now = Date.now();
      for (const [id, w] of windows) if (now - w.start >= windowMs) windows.delete(id);
    },

    get size() { return windows.size; },
  };
}
