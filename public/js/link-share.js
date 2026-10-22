// The host's half of listening by link (public/shared/links.js): paste a
// SoundCloud, Spotify or YouTube link, play it here in that service's own
// player, and every play, pause, seek and skip becomes the room's track state.
//
// In the Android app the link goes further: the app's own capture picks up
// this player like any other sound and sends it through our server, so guests
// hear it without reaching the service themselves — no VPN on their side
// (`via: 'relay'`). If that capture hears nothing, guests fall back to their
// own players (`via: 'embed'`).

import { show } from './dom.js';
import { createLinkPlayer } from './link-players.js';
import { parseTrackLink, PROVIDER_NAMES, trackPositionNow } from '../shared/links.js';
import { canCaptureNativeAudio } from './platform.js';

// While playing, the position goes out now and then even without a change, so
// a guest who drifted has something recent to measure against.
const HEARTBEAT_MS = 8000;
// How long the app's capture gets to hear the player before guests are
// switched to their own players.
const RELAY_PROOF_MS = 9000;

export const SPOTIFY_NOTE = 'Spotify فقط برای کسی کامل پخش می‌شه که تو همون مرورگر وارد حساب Spotify شده باشه؛ بقیه یه تیکه‌ی ۳۰ ثانیه‌ای می‌شنون. برای همه‌ی مهمان‌ها SoundCloud یا YouTube مطمئن‌تره.';

export function createLinkShare({ ui, api, notices, host }) {
  let player = null;
  let url = null;
  let track = null;     // the room's track, as we last set or heard it
  let heartbeat = null;
  let proofTimer = null;
  let lastTitle = '';

  function setStatus(text) { ui.hostLinkStatus.textContent = text; }

  function teardownPlayer() {
    clearInterval(heartbeat);
    clearTimeout(proofTimer);
    heartbeat = null;
    if (player) player.destroy();
    player = null;
    url = null;
    lastTitle = '';
    ui.hostLinkPlayer.textContent = '';
  }

  function render() {
    show(ui.hostLinkBox, !!track, 'grid');
    ui.linkBtn.textContent = track ? 'عوض کردن آهنگ' : 'پخش با هم';
    if (!track) return;
    const name = PROVIDER_NAMES[track.provider];
    ui.hostLinkProvider.textContent = name;
    if (track.via === 'relay') {
      ui.hostLinkNote.textContent = `صدای همین پخش‌کننده از راه سرور ما به مهمان‌ها می‌رسه؛ لازم نیست ${name} براشون باز بشه یا VPN بزنن. هر کاری با پخش‌کننده بکنی، همه همراهت میان.`;
    } else if (track.provider === 'spotify') {
      ui.hostLinkNote.textContent = SPOTIFY_NOTE;
    } else {
      ui.hostLinkNote.textContent = `هر مهمان خودش از ${name} پخش می‌کنه، هم‌زمان با تو؛ اگه ${name} براش فیلتره، باید VPN بزنه.${canCaptureNativeAudio ? '' : ' با اپ اندروید Hear With Me، صدا از راه سرور ما می‌رسه و مهمان‌ها VPN لازم ندارن.'}`;
    }
  }

  function send(state) {
    if (!track) return;
    track = { ...track, ...state };
    api.updateTrack({ playing: track.playing, positionMs: track.positionMs, index: track.index || 0, ...(state.via ? { via: state.via } : {}) });
  }

  // The app's capture could not hear this player (or sharing stopped): every
  // guest plays it themselves instead.
  function fallBackToEmbed(why) {
    if (!track || track.via !== 'relay') return;
    send({ via: 'embed' });
    render();
    if (why) notices.showInfo(why);
  }

  async function onPlayerState({ playing, positionMs, index = 0, ended }) {
    setStatus(ended ? 'تموم شد' : playing ? 'داره برای همه پخش می‌شه' : 'مکث');
    send({ playing: playing && !ended, positionMs: ended ? 0 : positionMs, index });
    clearInterval(heartbeat);
    heartbeat = null;
    if (!playing || ended) return;
    heartbeat = setInterval(async () => {
      if (!player || !player.playing) return;
      send({ playing: true, positionMs: await player.position(), index: await player.index() });
    }, HEARTBEAT_MS);

    // Guests see what is playing, as the service names it.
    const title = await player.title().catch(() => null);
    if (title && title !== lastTitle) { lastTitle = title; api.setNowPlaying(title); }

    if (track && track.via === 'relay' && !proofTimer) {
      proofTimer = setTimeout(() => {
        if (!host.heardSound) fallBackToEmbed('صدای پخش‌کننده تو اپ گرفته نشد؛ حالا هر مهمان خودش پخش می‌کنه (اگه فیلتره، با VPN).');
      }, RELAY_PROOF_MS);
    }
  }

  async function loadPlayer(next, startAt = 0) {
    teardownPlayer();
    url = next.url;
    setStatus('در حال باز کردن پخش‌کننده...');
    try {
      const made = await createLinkPlayer(next, ui.hostLinkPlayer, { onState: onPlayerState });
      if (url !== next.url) { made.destroy(); return; } // replaced while loading
      player = made;
      if (next.index > 0) player.skipTo(next.index);
      if (startAt > 0) player.seek(startAt);
      setStatus('دکمه‌ی پخش رو بزن');
    } catch (e) {
      setStatus('');
      ui.hostLinkPlayer.textContent = '';
      notices.showError(`پخش‌کننده‌ی ${PROVIDER_NAMES[next.provider]} باز نشد. اگه این سرویس تو اینترنتت فیلتره، با VPN امتحان کن.`);
    }
  }

  ui.linkForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const link = parseTrackLink(ui.linkInput.value);
    if (!link) {
      notices.showError('این لینک رو نمی‌شناسیم. لینک یه آهنگ یا پلی‌لیست از Spotify، SoundCloud یا YouTube رو بچسبون (تو اپ‌شون: Share ← Copy link).');
      return;
    }
    ui.linkBtn.disabled = true;
    // In the Android app, the phone's own capture carries it (asked for
    // inside this tap, which Android needs for its permission prompt).
    let via = 'embed';
    if (canCaptureNativeAudio) {
      if (!host.isSharing()) await host.startSharing();
      if (host.isSharing()) via = 'relay';
    }
    const res = await api.setTrack(link.url, via);
    ui.linkBtn.disabled = false;
    if (!res || !res.ok) {
      notices.showError('ثبت این لینک ممکن نشد. دوباره امتحان کن.');
      return;
    }
    ({ track } = await res.json());
    ui.linkInput.value = '';
    render();
    loadPlayer(track);
  });

  // Said before the link is pasted: who will need what to hear it.
  ui.linkHint.textContent = canCaptureNativeAudio
    ? 'آهنگ، پلی‌لیست یا آلبوم. همین‌جا پخش می‌شه و صداش از راه سرور ما به مهمان‌ها می‌رسه؛ اونا VPN لازم ندارن.'
    : 'آهنگ، پلی‌لیست یا آلبوم. هر مهمان خودش از همون سرویس پخش می‌کنه، هم‌زمان با تو؛ اگه براش فیلتره، VPN لازم داره. با اپ اندروید Hear With Me، صدا از راه سرور ما می‌رسه و VPN لازم نیست.';

  ui.linkStopBtn.addEventListener('click', () => {
    api.clearTrack();
    teardownPlayer();
    track = null;
    render();
  });

  return {
    get active() { return !!track; },

    // The room's track, as the server has it: on joining (a host who
    // reloaded picks their player back up, paused where it was), and after
    // every change.
    apply(next, serverNow) {
      if (!next) { teardownPlayer(); track = null; render(); return; }
      const reload = next.url !== url;
      track = next;
      render();
      if (reload) {
        const at = trackPositionNow(next, serverNow, Date.now());
        loadPlayer(next, at);
        // The old page's player is gone; until this one is pressed, the room
        // is paused, not playing on into nothing. And the old page's capture
        // went with it.
        if (next.playing || next.via === 'relay') send({ playing: false, positionMs: at, ...(next.via === 'relay' && !host.isSharing() ? { via: 'embed' } : {}) });
      }
    },

    // The phone stopped sending sound: whoever still hears the song hears it
    // from their own player.
    sharingStopped() {
      fallBackToEmbed(track && track.via === 'relay' ? 'پخش صدای گوشی قطع شد؛ حالا هر مهمان خودش آهنگ رو پخش می‌کنه.' : '');
    },

    reset() { teardownPlayer(); track = null; render(); },
  };
}
