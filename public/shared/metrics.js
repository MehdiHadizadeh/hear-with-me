// What the app counts about itself, defined once for both servers and the page.
//
// The product's biggest unknown is how often a guest actually ends up hearing
// anything — on which path, through which kind of network — and the answer
// cannot come from anywhere but here. So the page reports a handful of named
// events, and the server keeps one number per (day, event, dimension value).
//
// Nothing personal goes in: no ids, no names, no room codes, no addresses.
// Every event and every value is from the lists below; anything else is
// dropped on arrival, so a page cannot be made to write free text into it.

export const METRIC_EVENTS = {
  // A room was created (counted by the server itself).
  'room-created': {},
  // The host started sharing, and from what.
  'share-started': { source: ['tab', 'screen', 'file', 'app', 'mic', 'unknown'] },
  // The host's capture produced no sound in its first seconds.
  'share-silent': {},
  // A guest started hearing audio, by which path, and why that path.
  'listen-started': {
    path: ['direct', 'relay'],
    why: ['chosen', 'default', 'fallback', 'relay-only'],
    platform: ['ios', 'android', 'desktop', 'other'],
    shell: ['web', 'app'],
  },
  // A direct connection gave up, and what ICE had found by then.
  'direct-failed': {
    candidates: ['none', 'host', 'srflx', 'relay'],
    platform: ['ios', 'android', 'desktop', 'other'],
  },
  // A direct connection came up: which kind of route it took.
  'direct-route': { route: ['host', 'srflx', 'prflx', 'relay', 'unknown'] },
  // A guest listened for this long before leaving or the share ended.
  'listen-ended': { minutes: ['<1', '1-5', '5-15', '15-60', '60+'] },
  // The growth loop: a guest asked to take the link to their own computer,
  // or a room was made from a link someone else shared.
  'send-to-self': {},
  'story-card': {},
  'room-from-ref': {},
};

export function minutesBucket(ms) {
  const m = ms / 60000;
  if (m < 1) return '<1';
  if (m < 5) return '1-5';
  if (m < 15) return '5-15';
  if (m < 60) return '15-60';
  return '60+';
}

// Null if the event is not one we count; otherwise the event with only the
// dimensions and values we allow.
export function cleanMetric(event, props) {
  const spec = Object.prototype.hasOwnProperty.call(METRIC_EVENTS, event) ? METRIC_EVENTS[event] : null;
  if (!spec) return null;
  const clean = {};
  for (const [dim, allowed] of Object.entries(spec)) {
    const value = props && props[dim];
    if (allowed.includes(value)) clean[dim] = value;
  }
  return { event, props: clean };
}

// The keys a counter is stored under: one for the event itself and one per
// dimension value, so "how many listens" and "how many were relay" are both a
// single read.
export function metricKeys(day, event, props) {
  const keys = [`${day}|${event}`];
  for (const [dim, value] of Object.entries(props)) keys.push(`${day}|${event}|${dim}=${value}`);
  return keys;
}

export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
