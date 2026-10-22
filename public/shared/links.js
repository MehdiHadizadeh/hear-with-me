// "Listen by link": a track on SoundCloud, Spotify or YouTube that every
// guest plays in that service's own player, kept in step with the host's.
//
// Why this exists: phones cannot share what Spotify or SoundCloud play. A
// phone browser hands out no other app's sound at all, and on Android those
// apps opt out of playback capture — a choice the system honours and so do
// we. What every phone can do is play the same track in the service's own
// embedded player. Then no audio passes through us at all; only "playing, at
// 1:23" does.
//
// Two ways it reaches a guest (`via`):
//   embed — the guest's own embedded player plays it. Needs that service to
//           open on the guest's network: in Iran, usually a VPN.
//   relay — the host's Android app captures its own player and sends the
//           sound like any other share. Guests need nothing but this site.
//
// Shared by both servers (to refuse anything else) and the page (to load the
// right player), so it touches nothing but strings.

const MAX_URL = 400;

// Hosts each service answers on, and how to read a track out of a URL.
const PROVIDERS = {
  soundcloud: {
    hosts: ['soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com'],
    // Anything under soundcloud.com is a track, a set or a profile; the
    // widget plays all three. on.soundcloud.com is the app's share link.
    parse(url) {
      const path = url.pathname.replace(/\/+$/, '');
      if (url.hostname === 'on.soundcloud.com') return /^\/[A-Za-z0-9]+$/.test(path) ? `https://on.soundcloud.com${path}` : null;
      if (!/^\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+){0,2}$/.test(path)) return null;
      return `https://soundcloud.com${path}`;
    },
  },
  spotify: {
    hosts: ['open.spotify.com', 'spotify.link'],
    parse(url) {
      if (url.hostname === 'spotify.link') return null; // a redirect we cannot follow from here
      const m = url.pathname.match(/^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(track|album|playlist|episode)\/([A-Za-z0-9]{22})/);
      return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : null;
    },
  },
  youtube: {
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'],
    parse(url) {
      // A playlist plays as one: its list, from its first video.
      const list = url.searchParams.get('list');
      if (list && /^[A-Za-z0-9_-]{10,64}$/.test(list) && (url.pathname === '/playlist' || url.pathname === '/watch')) {
        return `https://www.youtube.com/playlist?list=${list}`;
      }
      let id = null;
      if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
      else if (url.pathname === '/watch') id = url.searchParams.get('v');
      else {
        const m = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/);
        if (m) id = m[1];
      }
      return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
    },
  },
};

export const LINK_PROVIDERS = Object.keys(PROVIDERS);

// The text someone pasted — often a whole share message, "Listen to X on
// Spotify: https://..." — to { provider, url } in one canonical form, or null.
export function parseTrackLink(text) {
  if (typeof text !== 'string') return null;
  const found = text.match(/https?:\/\/[^\s<>"']+/i);
  const raw = found ? found[0] : text.trim();
  if (!raw || raw.length > MAX_URL) return null;
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch (e) { return null; }
  const host = url.hostname.toLowerCase();
  for (const [provider, spec] of Object.entries(PROVIDERS)) {
    if (!spec.hosts.includes(host)) continue;
    const canonical = spec.parse(url);
    return canonical ? { provider, url: canonical } : null;
  }
  return null;
}

// Spotify's player takes a URI, not a URL.
export function spotifyUri(url) {
  const m = /open\.spotify\.com\/(track|album|playlist|episode)\/([A-Za-z0-9]{22})/.exec(url);
  return m ? `spotify:${m[1]}:${m[2]}` : null;
}

export function youtubeId(url) {
  const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(url);
  return m ? m[1] : null;
}

export function youtubeList(url) {
  const m = /[?&]list=([A-Za-z0-9_-]{10,64})/.exec(url);
  return m ? m[1] : null;
}

export const LINK_VIA = ['embed', 'relay'];

export const PROVIDER_NAMES = { soundcloud: 'SoundCloud', spotify: 'Spotify', youtube: 'YouTube' };

// The host's report of where the track is, cleaned. `positionMs` is where it
// was at `updatedAt` (server clock); while playing, it has moved on since.
// `index` is which item of a playlist or set. `via` only when it changes.
export function cleanTrackState(body) {
  if (!body || typeof body !== 'object') return null;
  const playing = body.playing === true;
  const position = Number(body.positionMs);
  const index = Number(body.index);
  const state = {
    playing,
    positionMs: Number.isFinite(position) && position >= 0 ? Math.min(Math.round(position), 24 * 3600 * 1000) : 0,
    index: Number.isInteger(index) && index >= 0 && index < 10000 ? index : 0,
  };
  if (LINK_VIA.includes(body.via)) state.via = body.via;
  return state;
}

// A new track: paused at the start, reaching guests the way the host asked.
export function newTrack(link, via) {
  return { ...link, via: LINK_VIA.includes(via) ? via : 'embed', playing: false, positionMs: 0, index: 0, updatedAt: Date.now() };
}

// Where the track is now, given a state from the server and how long ago
// (on our own clock) we received it.
export function trackPositionNow(track, serverNow, receivedAt, now = Date.now()) {
  if (!track) return 0;
  if (!track.playing) return track.positionMs;
  const sinceUpdate = Math.max(0, serverNow - track.updatedAt) + Math.max(0, now - receivedAt);
  return track.positionMs + sinceUpdate;
}
