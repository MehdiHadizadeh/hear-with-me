// The guest's half of listening by link (public/shared/links.js): the host's
// track, in that service's own player, kept within a couple of seconds of
// where the host is.
//
// The guest's own player is theirs to touch. Pausing it is respected until
// they press play again (in it, or on our button); then it catches up.

import { show } from './dom.js';
import { createLinkPlayer } from './link-players.js';
import { PROVIDER_NAMES, trackPositionNow } from '../shared/links.js';
import { SPOTIFY_NOTE } from './link-share.js';

const DRIFT_MS = 2500;       // closer than this is "together" for a song
const SYNC_EVERY_MS = 4000;
const OWN_ACTION_MS = 1500;  // a player event this soon after we acted is ours

export function createLinkListen({ ui, notices, onChange = () => {} }) {
  let state = null;     // { track, serverNow, receivedAt }
  let player = null;
  let url = null;
  let joined = false;   // tapped to listen; phones need that before any sound
  let userPaused = false;
  let ownActionAt = 0;
  let syncTimer = null;

  const providerName = () => (state ? PROVIDER_NAMES[state.track.provider] : '');
  const target = () => trackPositionNow(state.track, state.serverNow, state.receivedAt);

  function render() {
    const track = state && state.track;
    show(ui.linkCard, !!track, 'grid');
    if (!track) return;
    ui.guestLinkProvider.textContent = providerName();
    ui.guestLinkNote.textContent = track.provider === 'spotify'
      ? SPOTIFY_NOTE
      : 'اگه گوشی قفل بشه ممکنه پخش‌کننده مکث کنه؛ برگردی، خودش با میزبان هم‌زمان می‌شه.';
    const waitingToJoin = !joined || userPaused;
    show(ui.linkJoinBtn, waitingToJoin && !!player);
    ui.linkJoinBtn.textContent = userPaused ? 'ادامه، هم‌زمان با میزبان' : 'پخش، هم‌زمان با میزبان';
    let status;
    if (!player) status = url ? 'در حال باز کردن پخش‌کننده...' : '';
    else if (!track.playing) status = 'میزبان مکث کرده';
    else if (userPaused) status = 'تو مکث کردی';
    else if (!joined) status = 'میزبان داره پخش می‌کنه';
    else status = 'هم‌زمان با میزبان';
    ui.linkStatus.textContent = status;
  }

  function act(fn) { ownActionAt = Date.now(); fn(); }

  async function sync() {
    if (!player || !state || !joined) return;
    if (!state.track.playing) {
      if (player.playing) act(() => player.pause());
      const pos = await player.position();
      if (Math.abs(pos - state.track.positionMs) > DRIFT_MS) act(() => player.seek(state.track.positionMs));
      render();
      return;
    }
    if (userPaused) { render(); return; }
    const goal = target();
    const pos = await player.position();
    if (Math.abs(pos - goal) > DRIFT_MS) act(() => player.seek(goal));
    if (!player.playing) act(() => player.play());
    render();
  }

  // What the guest did with the player itself.
  function onPlayerState({ playing }) {
    if (Date.now() - ownActionAt < OWN_ACTION_MS) return;
    if (!playing && state && state.track.playing) { userPaused = true; render(); return; }
    if (playing) {
      // Pressing the player's own play button counts as joining, and as
      // asking to catch up.
      joined = true;
      userPaused = false;
      sync();
    }
  }

  function teardown() {
    clearInterval(syncTimer);
    syncTimer = null;
    if (player) player.destroy();
    player = null;
    url = null;
    ui.guestLinkPlayer.textContent = '';
  }

  async function loadPlayer(track) {
    teardown();
    url = track.url;
    render();
    try {
      const made = await createLinkPlayer(track, ui.guestLinkPlayer, { onState: onPlayerState });
      if (url !== track.url) { made.destroy(); return; }
      player = made;
      syncTimer = setInterval(sync, SYNC_EVERY_MS);
      render();
      sync();
    } catch (e) {
      url = null;
      render();
      ui.linkStatus.textContent = '';
      notices.showError(`پخش‌کننده‌ی ${PROVIDER_NAMES[track.provider]} باز نشد. اگه این سرویس تو اینترنتت فیلتره، با VPN امتحان کن.`);
    }
  }

  // Inside the tap, so the player is allowed to start with sound.
  ui.linkJoinBtn.addEventListener('click', () => {
    joined = true;
    userPaused = false;
    if (player && state && state.track.playing) {
      act(() => player.play());
      setTimeout(sync, 400);
    }
    render();
  });

  // A locked phone pauses most embedded players. Back in sight, catch up.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
  });

  return {
    get active() { return !!(state && state.track); },

    apply(track, serverNow) {
      if (!track) {
        state = null;
        teardown();
        render();
        onChange(false);
        return;
      }
      const isNew = !state || state.track.url !== track.url;
      const wasPlaying = !!state && state.track.playing;
      state = { track, serverNow, receivedAt: Date.now() };
      if (isNew) {
        userPaused = false;
        loadPlayer(track);
      } else {
        // The host pressed play again: whatever the guest paused is over.
        // (A heartbeat while playing is not that.)
        if (track.playing && !wasPlaying) userPaused = false;
        sync();
      }
      render();
      onChange(true);
    },

    reset() { state = null; joined = false; teardown(); render(); },
  };
}
