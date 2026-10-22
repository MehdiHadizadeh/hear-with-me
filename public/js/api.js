// Every call this page makes to the room server, in one place.
//
// Before this, the room id and the credentials were pasted into eight template
// strings across the app; renaming an endpoint meant finding all eight.

export function createRoomApi(roomId, identity) {
  const base = `/api/rooms/${encodeURIComponent(roomId)}`;
  const { clientId, secret } = identity;

  const credentials = () => `clientId=${encodeURIComponent(clientId)}`
    + `&secret=${encodeURIComponent(secret)}`;

  // A failed send is a normal network event here, not a programming error: the
  // watchdogs in the session code are what recover from it. Callers that do
  // care (creating a room, reading room info) use `fetch` results directly.
  const post = (path, body) => fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, secret, ...body }),
  }).catch(() => null);

  return {
    roomId,
    clientId,
    // Only for the app's own native code, which posts to the relay itself.
    nativeCredentials: () => ({ clientId, secret }),

    // The same endpoint, reached two ways. Which one is used is the server's
    // call, not ours — see js/room-events.js.
    eventStreamUrl: () => `${base}/events?${credentials()}`,

    socketUrl: () => {
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      return `${scheme}://${window.location.host}${base}/events?${credentials()}`;
    },

    // Tells "this room doesn't exist" apart from "the network is flaky":
    // EventSource reports both as a bare error event.
    async info() {
      try {
        const res = await fetch(base);
        if (res.status === 404) return { missing: true };
        return res.ok ? await res.json() : null;
      } catch (e) {
        return null; // offline
      }
    },

    // `details` says what the guests will be offered: which relay format the
    // host can encode (or none), and what kind of source this is.
    setSharing: (on, details = {}) => post('/sharing', { action: on ? 'start' : 'stop', ...details }),
    setNowPlaying: (text) => post('/now-playing', { text }),
    setName: (name) => post('/name', { name }),
    react: (kind) => post('/reaction', { kind }),
    updateSettings: (settings) => post('/settings', settings),
    kick: (targetId) => post('/kick', { targetId }),
    setTrack: (url, via) => post('/track', { url, via }),
    updateTrack: (state) => post('/track', state),
    clearTrack: () => post('/track', { clear: true }),
    // Sent as a beacon too when there is one: the page may be gone a moment
    // after the tap, and the room should still hear it.
    leave() {
      const body = JSON.stringify({ clientId, secret });
      try {
        if (navigator.sendBeacon && navigator.sendBeacon(`${base}/leave`, new Blob([body], { type: 'application/json' }))) return Promise.resolve();
      } catch (e) { /* fall through to fetch */ }
      return post('/leave', {});
    },
    makeHost: (targetId) => post('/host', { targetId }),
    signal: (to, type, payload) => post('/signal', { to, type, payload }),

    // -- the screen-off relay ------------------------------------------------

    // The stream URL ends up in an <audio src>, so it carries a short-lived
    // token rather than our secret. Resolves to { token, format } or to an
    // { error } saying why not.
    async relayToken() {
      const res = await post('/relay-token', {});
      if (!res) return { error: 'offline' };
      const body = await res.json().catch(() => ({}));
      return res.ok ? body : { error: body.error || 'refused' };
    },
    relayUrl: (token) => `${base}/relay?t=${encodeURIComponent(token)}`,

    // The body is audio, so the credentials go in headers.
    uploadRelayChunk: (generation, seq, bytes) => fetch(`${base}/relay?gen=${generation}&seq=${seq}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-HWM-Client': clientId,
        'X-HWM-Secret': secret,
      },
      body: bytes,
    }).catch(() => null),
  };
}
