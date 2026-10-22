// The host's half of listening by link (public/shared/links.js): paste a
// SoundCloud, Spotify or YouTube link, play it here in that service's own
// player, and every play, pause and seek becomes the room's track state.

import { show } from './dom.js';
import { createLinkPlayer } from './link-players.js';
import { parseTrackLink, PROVIDER_NAMES, trackPositionNow } from '../shared/links.js';

// While playing, the position goes out now and then even without a change, so
// a guest who drifted has something recent to measure against.
const HEARTBEAT_MS = 8000;

export const SPOTIFY_NOTE = 'Spotify فقط برای کسی کامل پخش می‌شه که تو همون مرورگر وارد حساب Spotify شده باشه؛ بقیه یه تیکه‌ی ۳۰ ثانیه‌ای می‌شنون. برای همه‌ی مهمان‌ها SoundCloud یا YouTube مطمئن‌تره.';

export function createLinkShare({ ui, api, notices }) {
  let player = null;
  let url = null;
  let heartbeat = null;
  let active = false;

  function setStatus(text) { ui.hostLinkStatus.textContent = text; }

  function teardownPlayer() {
    clearInterval(heartbeat);
    heartbeat = null;
    if (player) player.destroy();
    player = null;
    url = null;
    ui.hostLinkPlayer.textContent = '';
  }

  function render(track) {
    active = !!track;
    show(ui.hostLinkBox, active, 'grid');
    ui.linkBtn.textContent = active ? 'عوض کردن آهنگ' : 'پخش با هم';
    if (!track) return;
    ui.hostLinkProvider.textContent = PROVIDER_NAMES[track.provider];
    ui.hostLinkNote.textContent = track.provider === 'spotify'
      ? SPOTIFY_NOTE
      : 'هر کاری با همین پخش‌کننده بکنی (پخش، مکث، جلو و عقب) مهمان‌ها هم همراهت میان.';
  }

  async function onPlayerState({ playing, positionMs, ended }) {
    setStatus(ended ? 'تموم شد' : playing ? 'داره برای همه پخش می‌شه' : 'مکث');
    api.updateTrack({ playing: playing && !ended, positionMs: ended ? 0 : positionMs });
    clearInterval(heartbeat);
    heartbeat = null;
    if (playing && !ended) {
      heartbeat = setInterval(async () => {
        if (!player || !player.playing) return;
        api.updateTrack({ playing: true, positionMs: await player.position() });
      }, HEARTBEAT_MS);
    }
  }

  async function loadPlayer(track, startAt = 0) {
    teardownPlayer();
    url = track.url;
    setStatus('در حال باز کردن پخش‌کننده...');
    try {
      const made = await createLinkPlayer(track, ui.hostLinkPlayer, { onState: onPlayerState });
      if (url !== track.url) { made.destroy(); return; } // replaced while loading
      player = made;
      if (startAt > 0) player.seek(startAt);
      setStatus('دکمه‌ی پخش رو بزن');
    } catch (e) {
      setStatus('');
      ui.hostLinkPlayer.textContent = '';
      notices.showError(`پخش‌کننده‌ی ${PROVIDER_NAMES[track.provider]} باز نشد. اگه این سرویس تو اینترنتت فیلتره، با VPN امتحان کن.`);
    }
  }

  ui.linkForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const link = parseTrackLink(ui.linkInput.value);
    if (!link) {
      notices.showError('این لینک رو نمی‌شناسیم. لینک یه آهنگ از Spotify، SoundCloud یا YouTube رو بچسبون (تو اپ‌شون: Share ← Copy link).');
      return;
    }
    ui.linkBtn.disabled = true;
    const res = await api.setTrack(link.url);
    ui.linkBtn.disabled = false;
    if (!res || !res.ok) {
      notices.showError('ثبت این لینک ممکن نشد. دوباره امتحان کن.');
      return;
    }
    const { track } = await res.json();
    ui.linkInput.value = '';
    render(track);
    // Loaded from the submit tap, so its play button needs only one more.
    loadPlayer(track);
  });

  ui.linkStopBtn.addEventListener('click', () => {
    api.clearTrack();
    teardownPlayer();
    render(null);
  });

  return {
    get active() { return active; },

    // The room's track, as the server has it: on joining (a host who
    // reloaded picks their player back up, paused where it was), and after
    // every change.
    apply(track, serverNow) {
      if (!track) { teardownPlayer(); render(null); return; }
      render(track);
      if (track.url !== url) {
        loadPlayer(track, trackPositionNow(track, serverNow, Date.now()));
        // The old page's player is gone; until this one is pressed, the room
        // is paused, not playing on into nothing.
        if (track.playing) api.updateTrack({ playing: false, positionMs: trackPositionNow(track, serverNow, Date.now()) });
      }
    },

    reset() { teardownPlayer(); render(null); },
  };
}
