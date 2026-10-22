// The guest's half of the screen-off path: the host's sound as an endless
// HTTP stream in the page's own <audio> element.
//
// That element is the whole point. A phone treats a WebRTC stream as a call
// and suspends it the moment the screen locks; a media element fed over plain
// HTTP is music, which it lets play on — with lock-screen controls — because
// the browser's own network stack keeps fetching it, not the page's scripts.

const STALL_MS = 8000;     // no progress for this long: the stream is dead
const MAX_LAG_S = 4;       // further behind live than this: skip ahead
const CATCH_UP_TO_S = 0.8; // ...to this far behind the newest audio
// Every stall in playback is time the stream fell behind, and the buffer
// check above cannot see it: the late audio arrives late, so nothing piles
// up here. The wall clock can — the media should advance a second per
// second. Once it is this far behind, starting the stream again is the way
// back to live (the server starts every listener close to now).
const MAX_DRIFT_S = 5;

export function createRelayPlayer({ api, audio, onLive, onDropped, onRefused }) {
  let active = false;
  let watchdog = null;
  let progress = { time: 0, at: 0 };
  let liveAnnounced = false;
  let anchor = null;       // { wall, media } once playing: where "on time" is

  function clearSource() {
    clearInterval(watchdog);
    if (audio.getAttribute('src')) {
      audio.removeAttribute('src');
      audio.load(); // actually drops the HTTP stream
    }
  }

  function drop() {
    if (!active) return;
    active = false;
    clearSource();
    onDropped();
  }

  // A stream that silently stops delivering never fires `error`, so watch the
  // clock. And one that fell behind (a stall, a slow phone) stays behind for
  // good unless something moves it forward.
  function watch() {
    clearInterval(watchdog);
    progress = { time: audio.currentTime, at: Date.now() };
    watchdog = setInterval(() => {
      // Paused (a lock-screen pause, say) is not falling behind.
      if (audio.paused) { progress.at = Date.now(); anchor = null; return; }
      if (audio.currentTime !== progress.time) {
        progress = { time: audio.currentTime, at: Date.now() };
      } else if (Date.now() - progress.at > STALL_MS) {
        drop();
        return;
      }
      const { buffered } = audio;
      if (buffered.length) {
        const edge = buffered.end(buffered.length - 1);
        if (edge - audio.currentTime > MAX_LAG_S) audio.currentTime = edge - CATCH_UP_TO_S;
      }
      if (!anchor) { anchor = { wall: Date.now(), media: audio.currentTime }; return; }
      const drift = (Date.now() - anchor.wall) / 1000 - (audio.currentTime - anchor.media);
      if (drift > MAX_DRIFT_S) player.start(); // quietly: the stage stays live
    }, 1000);
  }

  audio.addEventListener('playing', () => {
    if (!active || liveAnnounced) return;
    liveAnnounced = true;
    onLive();
  });
  for (const evt of ['error', 'ended']) {
    audio.addEventListener(evt, () => { if (active) drop(); });
  }

  const player = {
    get active() { return active; },

    // Resolves to null once the stream is requested, or to the reason it was
    // refused (relay switched off by the host, nothing shared, offline).
    async start() {
      this.stop();
      const grant = await api.relayToken();
      if (grant.error) { onRefused(grant.error); return grant.error; }
      active = true;
      liveAnnounced = false;
      anchor = null;
      audio.srcObject = null;
      // Declares this page a music player rather than a call (Safari 17+), so
      // locking the phone is not a reason to suspend it.
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* older Safari */ }
      audio.src = api.relayUrl(grant.token);
      watch();
      return audio.play().then(() => null, () => 'autoplay-blocked');
    },

    stop() {
      active = false;
      liveAnnounced = false;
      clearSource();
    },
  };
  return player;
}

// A few milliseconds of silence. Playing it inside a tap is what lets the
// same <audio> element start on its own later — iPhones only allow that for
// an element that has already played once from a user gesture.
export const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
