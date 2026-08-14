// Where the browser is allowed to look for a path to the other side.
//
// Fetched from the server so that adding a TURN relay to a deployment is an
// environment variable and a restart, not an edit to (and cache-bust of) the
// browser code.

// The same free STUN server this used to hardcode: enough for most home NATs,
// and nothing at all for the strictest ones.
const FALLBACK = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

export function loadRtcConfig() {
  return fetch('/api/ice')
    .then((r) => r.json())
    .then((d) => (d && Array.isArray(d.iceServers) && d.iceServers.length
      ? { iceServers: d.iceServers }
      : FALLBACK))
    .catch(() => FALLBACK);
}
