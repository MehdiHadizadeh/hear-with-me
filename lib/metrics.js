// Anonymous usage counters, held in memory. See public/shared/metrics.js for
// what is counted and why nothing personal can get in.
//
// In memory on purpose: this server keeps nothing on disk, and a restart that
// clears every room may as well clear the counters with them. The Cloudflare
// deployment keeps the same counters in a Durable Object.

import { cleanMetric, metricKeys, today } from '../public/shared/metrics.js';

const KEEP_DAYS = 31;

export function createMetrics() {
  const counts = new Map(); // key -> number

  return {
    // False when the event is not one we count.
    record(event, props) {
      const clean = cleanMetric(event, props);
      if (!clean) return false;
      for (const key of metricKeys(today(), clean.event, clean.props)) {
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      return true;
    },

    // { "2026-10-22": { "listen-started": 4, "listen-started|path=relay": 3 } }
    snapshot() {
      const out = {};
      for (const [key, n] of counts) {
        const [day, ...rest] = key.split('|');
        (out[day] = out[day] || {})[rest.join('|')] = n;
      }
      return out;
    },

    sweep(now = Date.now()) {
      const oldest = today(now - KEEP_DAYS * 24 * 60 * 60 * 1000);
      for (const key of counts.keys()) if (key.slice(0, 10) < oldest) counts.delete(key);
    },
  };
}
