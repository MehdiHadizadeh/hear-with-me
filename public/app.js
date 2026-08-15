// Hear With Me — the room page.
//
// This file is the wiring: it builds the pieces, decides whether this client
// is the host or a listener, and routes every event from the room to whoever
// owns it. The pieces themselves live in ./js and know nothing about each
// other.
//
//   dom / format / prefs        the page, its words, and what the browser remembers
//   identity / api / room-events  who we are, what we can ask for, what we're told
//   audio-meter / elapsed-timer / connection-quality   what the room shows about itself
//   audio-quality / ice         what the audio costs and how it finds a path
//   host-session / guest-session  the two halves of a room
//   roster / notices / invite   people, messages, and getting the link out

import { REACTIONS } from './shared/reactions.js';
import { show, ui } from './js/dom.js';
import { faDigits } from './js/format.js';
import { prefs } from './js/prefs.js';
import { loadIdentity } from './js/identity.js';
import { createRoomApi } from './js/api.js';
import { createRoomEvents } from './js/room-events.js';
import { createLevelMeter } from './js/audio-meter.js';
import { createElapsedTimer } from './js/elapsed-timer.js';
import { BITRATES, createQualityPolicy } from './js/audio-quality.js';
import { loadRtcConfig } from './js/ice.js';
import { createNotices } from './js/notices.js';
import { createConnectionQuality } from './js/connection-quality.js';
import { createWakeLock } from './js/wake-lock.js';
import { createRoster } from './js/roster.js';
import { createHostSession } from './js/host-session.js';
import { createGuestSession } from './js/guest-session.js';
import { setupInvite } from './js/invite.js';

const REACTION_COOLDOWN_MS = 1000; // the server refuses anything faster anyway
const NAME_DEBOUNCE_MS = 600;      // typing is not an event worth a request per keystroke

const roomId = decodeURIComponent(window.location.pathname.split('/').pop()).toUpperCase();
ui.roomCode.textContent = roomId;

const identity = loadIdentity(roomId);
const api = createRoomApi(roomId, identity);
const events = createRoomEvents(api);
const rtcConfig = loadRtcConfig();

const notices = createNotices(ui);
const roster = createRoster({ ui, api, notices });
const quality = createQualityPolicy(prefs.quality(Object.keys(BITRATES)));
const wakeLock = createWakeLock();

const hostMeter = createLevelMeter(ui.hostMeter);
const guestMeter = createLevelMeter(ui.guestMeter);
const hostTimer = createElapsedTimer(ui.hostElapsed);
const guestTimer = createElapsedTimer(ui.guestElapsed);

// Whichever side we are on, the quality pill reads from the connections that
// side actually holds.
const stats = createConnectionQuality({
  pill: ui.qualityPill,
  text: ui.qualityText,
  faDigits,
  connections: () => (isHost
    ? [...host.peers.values()]
    : [guest.connection].filter(Boolean)),
});

const host = createHostSession({
  ui, api, quality, stats, rtcConfig,
  meter: hostMeter,
  timer: hostTimer,
  onQualityChange: prefs.setQuality,
});

const guest = createGuestSession({
  ui, api, quality, events, wakeLock, stats, prefs, rtcConfig,
  meter: guestMeter,
  timer: guestTimer,
});

setupInvite({ ui, roomId, notices });

let isHost = false;
let sharingNow = false;
let terminated = false;

// ---------------------------------------------------------------------------
// Which half of the room we are
// ---------------------------------------------------------------------------

function showRole(asHost) {
  isHost = asHost;
  show(ui.hostCard, asHost);
  show(ui.guestCard, !asHost);
  roster.setHostView(asHost);
}

// ---------------------------------------------------------------------------
// The guest's name, and their back channel
// ---------------------------------------------------------------------------

let nameTimer = null;
ui.nameInput.value = prefs.name();

ui.nameInput.addEventListener('input', () => {
  prefs.setName(ui.nameInput.value);
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => api.setName(ui.nameInput.value), NAME_DEBOUNCE_MS);
});
ui.nameInput.addEventListener('blur', () => {
  clearTimeout(nameTimer);
  api.setName(ui.nameInput.value);
});

let lastReactionSent = 0;
ui.reactionRow.addEventListener('click', (e) => {
  const button = e.target.closest('.reaction');
  if (!button) return;
  // Swallowing a too-early tap silently made the button look broken, so say
  // it landed too soon instead.
  if (Date.now() - lastReactionSent < REACTION_COOLDOWN_MS) {
    button.classList.add('cooling');
    setTimeout(() => button.classList.remove('cooling'), 500);
    return;
  }
  lastReactionSent = Date.now();
  api.react(button.dataset.kind);
  button.classList.add('sent');
  setTimeout(() => button.classList.remove('sent'), 600);
});

// ---------------------------------------------------------------------------
// Ending the room, from any of the ways it can end
// ---------------------------------------------------------------------------

function endRoom(title, sub) {
  terminated = true;
  events.close();
  host.endRoom();
  guest.endRoom();

  show(ui.hostCard, false);
  show(ui.guestCard, false);
  ui.notFoundTitle.textContent = title;
  ui.notFoundSub.textContent = sub;
  show(ui.notFoundCard, true);
  show(ui.shareRow, false);
  ui.qrPanel.hidden = true;
  ui.connectionPill.classList.remove('live');
  ui.connectionText.textContent = 'اتاق تمام شد';
}

// ---------------------------------------------------------------------------
// Everything the room tells us
// ---------------------------------------------------------------------------

events.on('welcome', (data) => {
  ui.connectionText.textContent = 'متصل';
  ui.connectionPill.classList.add('live');

  sharingNow = data.isSharing;
  showRole(data.isHost);
  roster.seed(data.members);
  host.applySettings(data.settings);

  if (isHost) {
    stats.stop(); // a fresh host isn't sending anything yet
    return;
  }

  if (ui.nameInput.value) api.setName(ui.nameInput.value); // we already know what to call ourselves
  guest.renderNowPlaying(data.nowPlaying);

  if (!data.isSharing) { guest.waitForHost(); return; }
  // Late joiners pick the timer up mid-session rather than from zero.
  if (data.sharingElapsedMs !== null) guestTimer.start(data.sharingElapsedMs);
  if (!guest.isHealthy()) guest.connect();
});

events.on('sharing-started', () => {
  sharingNow = true;
  if (isHost) return;
  guest.renderNowPlaying('');
  guestTimer.start(0);
  guest.connect();
});

events.on('sharing-stopped', () => {
  sharingNow = false;
  if (!isHost) guest.handleSharingStopped();
});

events.on('now-playing', ({ text }) => {
  if (isHost) ui.nowPlayingInput.value = text;
  else guest.renderNowPlaying(text);
});

events.on('signal', ({ from, type, payload }) => {
  if (isHost) {
    if (type === 'offer') host.handleOffer(from, payload);
    else if (type === 'ice') host.handleIce(from, payload);
    else if (type === 'quality') host.handleQualityRequest(from, payload);
    return;
  }
  if (type === 'answer') guest.handleAnswer(payload);
  else if (type === 'ice') guest.handleIce(payload);
});

events.on('peer-left', ({ clientId: goneId, force }) => {
  if (isHost) host.handlePeerLeft(goneId, force);
});

events.on('listener-count', ({ count }) => roster.renderCount(count));
events.on('members', ({ members }) => roster.update(members));
events.on('room-settings', (settings) => host.applySettings(settings));

events.on('reaction', ({ from, kind }) => {
  const reaction = REACTIONS[kind];
  if (!reaction) return;
  const layer = isHost ? ui.hostBurst : ui.guestBurst;

  if (from === identity.clientId) {
    // Your own reaction only has to confirm it left.
    if (reaction.cheer) notices.showBurst(reaction.emoji, layer);
    else notices.showToast('فرستاده شد ✔');
    return;
  }
  if (reaction.cheer) { notices.showBurst(reaction.emoji, layer); return; }

  notices.showToast(reaction.text, {
    who: roster.labelFor(from),
    emoji: reaction.emoji,
    alert: reaction.alert,
    // The fix is only the host's to make; a guest seeing it would be told to
    // do something they cannot do.
    todo: isHost ? reaction.todo : undefined,
  });
});

events.on('you-are-host', ({ reason }) => {
  guest.stopListening();
  showRole(true);
  host.activate({ fresh: true });
  guest.renderNowPlaying('');
  // Informational, not an error — so it clears itself once it's been read,
  // and can be dismissed on the spot.
  notices.showInfo(reason === 'transfer'
    ? 'میزبان قبلی اتاق رو به تو سپرد. برای پخش، «شروع پخش صدا» رو بزن.'
    : 'میزبان قبلی خارج شد — الان تو میزبان جدید این اتاقی. برای ادامه، «شروع پخش صدا» رو بزن.');
});

// Someone else took the room: either we handed it over, or the server moved
// it. Either way we are a listener now.
events.on('host-changed', ({ hostId }) => {
  if (!isHost || hostId === identity.clientId) return;
  host.deactivate();
  showRole(false);
  guest.becomeListener();
  notices.showInfo('میزبانی اتاق به یک نفر دیگه منتقل شد.');
});

events.on('evicted', () => {
  endRoom('از اتاق حذف شدی', 'میزبان تو رو از این اتاق بیرون کرد. با همین لینک دیگه نمی‌تونی برگردی.');
});

events.on('room-closed', () => {
  endRoom('اتاق بسته شد', 'میزبان اتاق رو ترک کرد و اتاق با رفتنش بسته شد.');
});

events.onError(async () => {
  if (terminated) return; // we ended this on purpose; the message is already right
  ui.connectionPill.classList.remove('live');

  if (!events.gaveUp) {
    ui.connectionText.textContent = 'قطع شد — در حال اتصال مجدد...';
    return;
  }

  ui.connectionText.textContent = 'اتصال برقرار نشد';
  const info = await api.info();

  if (info && info.missing) {
    endRoom('این اتاق پیدا نشد', 'یا کد اشتباهه، یا اتاق منقضی شده — با ری‌استارت شدن سرور همه‌ی اتاق‌ها پاک می‌شن.');
    ui.connectionText.textContent = 'اتاق پیدا نشد';
  } else if (info && info.locked) {
    // The room exists and refused us: it is locked, or we were removed from
    // it. Both are decisions, not failures, so neither offers a retry.
    endRoom('در اتاق قفله', 'میزبان ورود آدم جدید رو بسته. ازش بخواه قفل رو باز کنه.');
    ui.connectionText.textContent = 'اتاق قفله';
  } else {
    notices.showError('اتصال به سرور برقرار نشد. صفحه رو دوباره باز کن.');
  }
});

document.addEventListener('visibilitychange', () => {
  if (isHost) return;
  if (document.visibilityState === 'hidden') { guest.handleHidden(); return; }
  if (sharingNow) guest.handleVisible();
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

// Answers the one question chrome://webrtc-internals is awkward to answer: did
// this connection go direct, or is it only working because of a relay? "host"
// means same network, "srflx" means STUN got through a NAT, "relay" means it
// needs a TURN server.
window.__hwmRoute = async () => {
  const pcs = isHost ? [...host.peers.values()] : [guest.connection].filter(Boolean);
  const out = [];
  for (const pc of pcs) {
    const report = await pc.getStats();
    let pair = null;
    report.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || !pair)) pair = r;
    });
    if (!pair) { out.push({ state: pc.connectionState, route: 'no succeeded candidate pair yet' }); continue; }

    let local = null;
    let remote = null;
    report.forEach((r) => {
      if (r.id === pair.localCandidateId) local = r;
      if (r.id === pair.remoteCandidateId) remote = r;
    });
    out.push({
      state: pc.connectionState,
      local: local && `${local.candidateType}/${local.protocol}`,
      remote: remote && `${remote.candidateType}/${remote.protocol}`,
      needsTurn: !!(local && remote && (local.candidateType === 'relay' || remote.candidateType === 'relay')),
      roundTripMs: pair.currentRoundTripTime === undefined ? null : Math.round(pair.currentRoundTripTime * 1000),
    });
  }
  console.table(out);
  return out;
};

// The rest are test hooks, behind `?debug=1` so a shared room link doesn't
// hand every guest a handle on the live peer connections.
if (new URLSearchParams(window.location.search).has('debug')) {
  window.__hwmPeerCount = () => host.peers.size;
  window.__hwmHostPcs = () => [...host.peers.values()];
  window.__hwmGuestPc = () => guest.connection;
  window.__hwmKillEventStream = () => events.close();
}

// Guests need nothing but a browser that can receive WebRTC — which is all of
// them — but saying so plainly beats a page that simply never connects.
if (!window.RTCPeerConnection) {
  show(ui.hostCard, false);
  show(ui.guestCard, false);
  ui.notFoundTitle.textContent = 'این مرورگر پخش زنده رو پشتیبانی نمی‌کنه';
  ui.notFoundSub.textContent = 'با Chrome، Edge، Firefox یا Safari باز کن — این صفحه به WebRTC نیاز داره.';
  show(ui.notFoundCard, true);
}
