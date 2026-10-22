// Hear With Me — the room page.
//
// This file is the wiring: it builds the pieces, decides whether this client
// is the host or a listener, and routes every event from the room to whoever
// owns it. The pieces themselves live in ./js and know nothing about each
// other.
//
//   dom / format / prefs / platform   the page, its words, what the browser remembers, what the device can do
//   identity / api / room-events      who we are, what we can ask for, what we're told
//   audio-meter / elapsed-timer / connection-quality   what the room shows about itself
//   audio-quality / ice               what the audio costs and how it finds a path
//   host-session / guest-session      the two halves of a room
//   relay-encoder / relay-player      the screen-off path, from each side
//   roster / notices / invite         people, messages, and getting the link out
//   end-card / car-mode / metrics     what a guest keeps, a dashboard view, and what we count

import { REACTIONS } from './shared/reactions.js';
import { show, ui } from './js/dom.js';
import { faDigits } from './js/format.js';
import { prefs } from './js/prefs.js';
import { isTouchDevice } from './js/platform.js';
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
import { createEndCard } from './js/end-card.js';
import { createCarMode } from './js/car-mode.js';
import { report } from './js/metrics.js';

const REACTION_COOLDOWN_MS = 1000; // the server refuses anything faster anyway
const NAME_DEBOUNCE_MS = 600;      // typing is not an event worth a request per keystroke
const END_CARD_MIN_MS = 20000;     // under this, there is nothing to remember yet

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
  ui, api, quality, stats, rtcConfig, prefs, notices, report,
  meter: hostMeter,
  timer: hostTimer,
  onQualityChange: prefs.setQuality,
});

const guest = createGuestSession({
  ui, api, quality, events, wakeLock, stats, prefs, rtcConfig, notices,
  meter: guestMeter,
  timer: guestTimer,
});

setupInvite({ ui, roomId, notices });
const endCard = createEndCard({ ui, notices });
const carMode = createCarMode({ ui, guest });

let isHost = false;
let sharingNow = false;
let terminated = false;
let hostName = '';

// ---------------------------------------------------------------------------
// Which half of the room we are
// ---------------------------------------------------------------------------

// The header is the host's instrument panel and the guest's title card: a
// guest has no use for a copy button or a count of listeners, so those go.
function showRole(asHost) {
  isHost = asHost;
  show(ui.hostCard, asHost, 'grid');
  show(ui.guestCard, !asHost);
  ui.roomShell.classList.toggle('is-host', asHost);
  ui.roomShell.classList.toggle('is-guest', !asHost);
  show(ui.copyLinkBtn, asHost, 'grid');
  ui.codePlate.classList.toggle('is-bare', !asHost);
  show(ui.statusRow, asHost, 'flex');
  roster.setHostView(asHost);
}

// The guest page leads with who is playing; that name comes from the roster.
function updateHostName(members) {
  const hostMember = (members || []).find((m) => m.isHost);
  hostName = (hostMember && hostMember.name) || '';
  guest.setHostName(hostName);
  carMode.setTitle(hostName ? `${hostName} داره پخش می‌کنه` : 'در حال پخش');
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
  if (!button || button === ui.moreReactionsBtn || button.disabled) return;
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

ui.moreReactionsBtn.addEventListener('click', () => {
  const opening = ui.moreReactions.hidden;
  ui.moreReactions.hidden = !opening;
  ui.moreReactionsBtn.setAttribute('aria-expanded', String(opening));
  ui.moreReactionsBtn.textContent = opening ? 'کمتر' : 'بیشتر';
});

// ---------------------------------------------------------------------------
// Ending the room, from any of the ways it can end
// ---------------------------------------------------------------------------

// A room we are not in any more still had a header offering to invite people
// into it and a chip counting listeners in it. Every one of those readings is
// now either stale or, for a room that never existed, an invitation to a dead
// link — so the dead end keeps only the code that failed.
function showDeadEnd(title, sub) {
  show(ui.hostCard, false);
  show(ui.guestCard, false);
  ui.notFoundTitle.textContent = title;
  ui.notFoundSub.textContent = sub;
  show(ui.notFoundCard, true);

  ui.qrPanel.hidden = true;
  ui.qrBtn.setAttribute('aria-expanded', 'false');
  show(ui.copyLinkBtn, false);
  ui.codePlate.classList.add('is-bare');
  show(ui.listenerPill, false);
  show(ui.qualityPill, false);

  // A phone cannot host what it hears, so offering "create a room" there sent
  // people into something that failed a step later. What they can do is ask
  // for a fresh link.
  if (isTouchDevice) {
    ui.notFoundCta.textContent = 'ساخت اتاق با یه فایل از گوشیم';
  }
}

function endRoom(title, sub) {
  terminated = true;
  events.close();
  host.endRoom();
  guest.endRoom();

  showDeadEnd(title, sub);
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
  updateHostName(data.members);
  host.applySettings(data.settings);
  guest.applySettings(data.settings);

  if (isHost) {
    stats.stop(); // a fresh host isn't sending anything yet
    host.handleRelayDemand(data.relayDemand);
    host.announceName();
    return;
  }

  if (ui.nameInput.value) api.setName(ui.nameInput.value); // we already know what to call ourselves
  guest.renderNowPlaying(data.nowPlaying);
  guest.applyShare({ relayFormat: data.relayFormat });

  if (!data.isSharing) { guest.waitForHost(); return; }
  // Late joiners pick the timer up mid-session rather than from zero.
  if (data.sharingElapsedMs !== null) guestTimer.start(data.sharingElapsedMs);
  guest.startListening({ reconnect: !guest.isHealthy() });
});

events.on('sharing-started', (data) => {
  sharingNow = true;
  if (isHost) return;
  endCard.hide();
  guest.renderNowPlaying('');
  guest.applyShare({ relayFormat: data.relayFormat });
  guestTimer.start(0);
  guest.startListening();
});

events.on('sharing-stopped', () => {
  sharingNow = false;
  if (isHost) return;
  const listened = guest.handleSharingStopped();
  if (listened >= END_CARD_MIN_MS) endCard.show(listened, hostName);
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

events.on('relay-demand', ({ count }) => {
  if (isHost) host.handleRelayDemand(count);
});

events.on('listener-count', ({ count }) => roster.renderCount(count));
events.on('members', ({ members }) => { roster.update(members); updateHostName(members); });
events.on('room-settings', (settings) => {
  host.applySettings(settings);
  guest.applySettings(settings);
});

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
  host.announceName();
  guest.renderNowPlaying('');
  // Informational, not an error — so it clears itself once it's been read,
  // and can be dismissed on the spot.
  notices.showInfo(reason === 'transfer'
    ? 'میزبان قبلی اتاق رو به تو سپرد. برای پخش، «شروع پخش صدا» رو بزن.'
    : 'میزبان قبلی رفت؛ حالا تو میزبان این اتاقی. برای ادامه، «شروع پخش صدا» رو بزن.');
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
  endRoom('اتاق بسته شد', 'میزبان رفت و اتاق با رفتنش بسته شد.');
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
    endRoom('این اتاق پیدا نشد', 'یا کد اشتباهه، یا این اتاق دیگه وجود نداره. از کسی که لینک رو فرستاده یه لینک تازه بخواه.');
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

// Car mode mirrors the guest's stage, whatever changed it.
new MutationObserver(() => carMode.setState(ui.guestStage.dataset.state))
  .observe(ui.guestStage, { attributes: true, attributeFilter: ['data-state'] });

// ---------------------------------------------------------------------------
// The mark breathes with the sound
// ---------------------------------------------------------------------------

// The second strand of the header mark rides the level of what is playing —
// read from the same analyser as the meter, so it is as honest as the meter.
// Nothing moves when nothing plays, or for anyone who asked for less motion.
if (ui.markVoice && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const breathe = () => {
    const level = (isHost ? hostMeter : guestMeter).level();
    ui.markVoice.style.transform = `translateY(${(Math.min(1, level * 1.6) * 3.5).toFixed(2)}px)`;
    requestAnimationFrame(breathe);
  };
  requestAnimationFrame(breathe);
}

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
    const report_ = await pc.getStats();
    let pair = null;
    report_.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || !pair)) pair = r;
    });
    if (!pair) { out.push({ state: pc.connectionState, route: 'no succeeded candidate pair yet' }); continue; }

    let local = null;
    let remote = null;
    report_.forEach((r) => {
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

// Guests need nothing but a browser that can play a stream — which is all of
// them — but saying so plainly beats a page that simply never connects.
if (!window.RTCPeerConnection && !window.HTMLAudioElement) {
  showDeadEnd(
    'این مرورگر پخش زنده رو پشتیبانی نمی‌کنه',
    'با Chrome، Edge، Firefox یا Safari باز کن.',
  );
  ui.connectionText.textContent = 'پشتیبانی نمی‌شه';
}

// The page works as an installed app too; the worker only ever caches the
// shell, never a room's audio or its API.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
