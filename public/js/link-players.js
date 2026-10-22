// The three services' own embedded players, behind one small interface, for
// listening by link (public/shared/links.js).
//
//   const player = await createLinkPlayer(track, container, { onState });
//   player.play(); player.pause(); player.seek(ms);
//   await player.position();   // ms
//   await player.index();      // which item of a playlist or set (0 otherwise)
//   player.skipTo(i);
//   await player.title();      // what is playing, where the service says
//   await player.isPlaying();  // asked of the player now, not remembered
//   player.playing;            // as the player last reported it
//   player.destroy();
//
// `onState({ playing, positionMs, index, ended })` fires when the player itself
// changes: someone pressed its play button, dragged its bar, or it finished.
// The host's page turns those into the room's track state; a guest's page
// uses them to notice its own listener pausing.
//
// Each service's script is loaded on first use, from the service itself: it
// is their player, their licence, their account (Spotify plays a 30-second
// preview to anyone not signed in to it in this browser).

import { spotifyUri, youtubeId, youtubeList } from '../shared/links.js';

const scripts = new Map();
function loadScript(src, ready) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onerror = () => { scripts.delete(src); reject(new Error('blocked')); };
      if (ready) ready(resolve); else el.onload = () => resolve();
      document.head.append(el);
    }));
  }
  return scripts.get(src);
}

// A script that never answers (a filtered domain often just hangs) has to
// fail too, or the page waits forever.
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}
const LOAD_TIMEOUT_MS = 15000;

// -- SoundCloud -----------------------------------------------------------------

async function soundcloud(track, container, onState) {
  await withTimeout(loadScript('https://w.soundcloud.com/player/api.js'), LOAD_TIMEOUT_MS);
  const iframe = document.createElement('iframe');
  iframe.allow = 'autoplay; encrypted-media';
  iframe.title = 'پخش‌کننده‌ی SoundCloud';
  iframe.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(track.url)}`
    + '&auto_play=false&hide_related=true&show_comments=false&show_reposts=false&show_teaser=false&visual=false&color=%233fe0be';
  container.append(iframe);
  const { Widget } = window.SC;
  const widget = Widget(iframe);
  const E = Widget.Events;
  let playing = false;
  const position = () => new Promise((resolve) => widget.getPosition((ms) => resolve(ms || 0)));
  const index = () => new Promise((resolve) => widget.getCurrentSoundIndex((i) => resolve(i || 0)));
  const report = async (extra = {}) => onState({ playing, positionMs: await position(), index: await index(), ...extra });

  await withTimeout(new Promise((resolve) => widget.bind(E.READY, resolve)), LOAD_TIMEOUT_MS);
  widget.bind(E.PLAY, () => { playing = true; report(); });
  widget.bind(E.PAUSE, () => { playing = false; report(); });
  widget.bind(E.SEEK, () => report());
  // The end of one item in a set is not the end: the next one starts and
  // reports itself. Only the last item's end stops anything.
  // Events arrive out of order on a slow connection (a FINISH after the next
  // item's PLAY), so an end is only believed once the player says so.
  const isPlaying = () => new Promise((resolve) => widget.isPaused((paused) => resolve(!paused)));
  widget.bind(E.FINISH, () => {
    setTimeout(async () => {
      playing = await isPlaying();
      if (!playing) report({ ended: true });
    }, 1500);
  });

  return {
    get playing() { return playing; },
    play: () => widget.play(),
    pause: () => widget.pause(),
    seek: (ms) => widget.seekTo(Math.max(0, ms)),
    position,
    index,
    isPlaying,
    skipTo: (i) => widget.skip(i),
    title: () => new Promise((resolve) => widget.getCurrentSound((sound) => resolve(sound
      ? [sound.user && sound.user.username, sound.title].filter(Boolean).join(' — ')
      : null))),
    destroy: () => { try { widget.unbind(E.PLAY); } catch (e) { /* gone */ } iframe.remove(); },
  };
}

// -- Spotify --------------------------------------------------------------------

let spotifyApi = null;
async function spotify(track, container, onState) {
  if (!spotifyApi) {
    spotifyApi = withTimeout(loadScript('https://open.spotify.com/embed/iframe-api/v1', (resolve) => {
      window.onSpotifyIframeApiReady = (api) => resolve(api);
    }), LOAD_TIMEOUT_MS).catch((e) => { spotifyApi = null; throw e; });
  }
  const api = await spotifyApi;
  const holder = document.createElement('div');
  container.append(holder);
  const controller = await withTimeout(new Promise((resolve) => {
    api.createController(holder, { uri: spotifyUri(track.url), width: '100%', height: 152 }, resolve);
  }), LOAD_TIMEOUT_MS);

  let playing = false;
  let started = false;
  let last = { position: 0, at: Date.now() };
  // Spotify reports every half second or so, with no separate "seek" event:
  // a change of play state, or a jump the clock cannot explain, is the news.
  controller.addListener('playback_update', (e) => {
    const d = (e && e.data) || {};
    const now = Date.now();
    const nowPlaying = !d.isPaused && !d.isBuffering ? true : (d.isBuffering ? playing : false);
    const expected = last.position + (playing ? now - last.at : 0);
    const jumped = Math.abs((d.position || 0) - expected) > 2500;
    const ended = d.duration > 0 && d.isPaused && d.position >= d.duration - 800;
    const changed = nowPlaying !== playing || jumped || ended;
    playing = nowPlaying;
    if (playing) started = true;
    last = { position: d.position || 0, at: now };
    if (changed) onState({ playing, positionMs: last.position, ended });
  });

  return {
    get playing() { return playing; },
    play: () => { if (started) controller.resume(); else controller.play(); started = true; },
    pause: () => controller.pause(),
    seek: (ms) => controller.seek(Math.max(0, ms) / 1000),
    position: async () => last.position + (playing ? Date.now() - last.at : 0),
    // The embed has no way to say or choose which item of a playlist plays.
    index: async () => 0,
    isPlaying: async () => playing,
    skipTo: () => {},
    title: async () => null,
    destroy: () => { try { controller.destroy(); } catch (e) { holder.remove(); } },
  };
}

// -- YouTube --------------------------------------------------------------------

let youtubeApi = null;
async function youtube(track, container, onState) {
  if (!youtubeApi) {
    youtubeApi = withTimeout(loadScript('https://www.youtube.com/iframe_api', (resolve) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    }), LOAD_TIMEOUT_MS).catch((e) => { youtubeApi = null; throw e; });
  }
  const YT = await youtubeApi;
  const holder = document.createElement('div');
  container.append(holder);
  let playing = false;
  let player;
  const list = youtubeList(track.url);
  await withTimeout(new Promise((resolve) => {
    player = new YT.Player(holder, {
      ...(list ? {} : { videoId: youtubeId(track.url) }),
      width: '100%',
      height: '200',
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1, ...(list ? { listType: 'playlist', list } : {}) },
      events: {
        onReady: resolve,
        onStateChange: (e) => {
          const positionMs = Math.round((player.getCurrentTime() || 0) * 1000);
          const index = Math.max(0, (player.getPlaylistIndex && player.getPlaylistIndex()) || 0);
          if (e.data === YT.PlayerState.PLAYING) { playing = true; onState({ playing, positionMs, index }); }
          else if (e.data === YT.PlayerState.PAUSED) { playing = false; onState({ playing, positionMs, index }); }
          else if (e.data === YT.PlayerState.ENDED) {
            playing = false;
            // In a playlist the next video follows; only a real end stops.
            setTimeout(() => { if (!playing) onState({ playing, positionMs: 0, index, ended: true }); }, 1500);
          }
        },
      },
    });
  }), LOAD_TIMEOUT_MS);

  return {
    get playing() { return playing; },
    play: () => player.playVideo(),
    pause: () => player.pauseVideo(),
    seek: (ms) => player.seekTo(Math.max(0, ms) / 1000, true),
    position: async () => Math.round((player.getCurrentTime() || 0) * 1000),
    index: async () => Math.max(0, (player.getPlaylistIndex && player.getPlaylistIndex()) || 0),
    isPlaying: async () => player.getPlayerState() === YT.PlayerState.PLAYING,
    skipTo: (i) => { if (list) player.playVideoAt(i); },
    title: async () => { try { return (player.getVideoData() || {}).title || null; } catch (e) { return null; } },
    destroy: () => { try { player.destroy(); } catch (e) { /* gone */ } holder.remove(); },
  };
}

const FACTORIES = { soundcloud, spotify, youtube };

export async function createLinkPlayer(track, container, { onState = () => {} } = {}) {
  const make = FACTORIES[track.provider];
  if (!make) throw new Error('unknown provider');
  container.textContent = '';
  return make(track, container, onState);
}
