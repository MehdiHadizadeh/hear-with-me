// Every call this page makes to the room server, in one place.
//
// Before this, the room id and the credentials were pasted into eight template
// strings across the app; renaming an endpoint meant finding all eight.

export function createRoomApi(roomId, identity) {
  const base = `/api/rooms/${encodeURIComponent(roomId)}`;
  const { clientId, secret } = identity;

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

    eventStreamUrl: () => `${base}/events`
      + `?clientId=${encodeURIComponent(clientId)}&secret=${encodeURIComponent(secret)}`,

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

    setSharing: (on) => post('/sharing', { action: on ? 'start' : 'stop' }),
    setNowPlaying: (text) => post('/now-playing', { text }),
    setName: (name) => post('/name', { name }),
    react: (kind) => post('/reaction', { kind }),
    updateSettings: (settings) => post('/settings', settings),
    kick: (targetId) => post('/kick', { targetId }),
    makeHost: (targetId) => post('/host', { targetId }),
    signal: (to, type, payload) => post('/signal', { to, type, payload }),
  };
}
