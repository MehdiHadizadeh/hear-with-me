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
import { setStage, show, ui } from './js/dom.js';
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
import { createLinkShare } from './js/link-share.js';
import { createLinkListen } from './js/link-listen.js';
import { PROVIDER_NAMES } from './shared/links.js';

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

const linkShare = createLinkShare({ ui, api, notices, host });
const linkListen = createLinkListen({ ui, notices, onChange: () => updateLinkLayout() });

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
  show(ui.leaveBtn, true, 'inline-flex');
  ui.codePlate.classList.toggle('is-bare', !asHost);
  show(ui.statusRow, asHost, 'flex');
  roster.setHostView(asHost);
}

// The guest page leads with who is playing; that name comes from the roster.
// Listening by link sits beside the audio stream, not inside it: a host can
// talk over the mic while everyone plays the same SoundCloud track. With only
// the link on, the guest's stream controls have nothing to do and step aside.
let currentTrack = null;
function updateLinkLayout() {
  const linkOn = !!currentTrack;
  ui.guestCard.classList.toggle('is-link-only', !isHost && linkOn && !sharingNow);
  // The tab-picking rehearsal is about the other way of sharing.
  ui.hostCard.classList.toggle('has-link', isHost && linkOn);
  if (!isHost) { guest.setLinkLive(linkOn); return; }
  if (host.isSharing()) return;
  if (linkOn) {
    setStage(ui.hostStage, 'live');
    ui.hostTitle.textContent = 'با هم گوش می‌دید';
    ui.hostStatus.textContent = `آهنگ از ${PROVIDER_NAMES[currentTrack.provider]} برای همه پخش می‌شه. میکروفون رو هم می‌تونی روشن کنی.`;
  } else {
    setStage(ui.hostStage, 'idle');
    ui.hostTitle.textContent = 'تو میزبان این اتاقی';
    ui.hostStatus.textContent = 'هنوز چیزی پخش نمی‌شه.';
  }
}

function applyTrack(track, serverNow) {
  currentTrack = track || null;
  if (isHost) { linkListen.reset(); linkShare.apply(currentTrack, serverNow); }
  else { linkShare.reset(); linkListen.apply(currentTrack, serverNow); }
  updateLinkLayout();
}

let guestCount = 0;
function updateHostName(members) {
  guestCount = (members || []).filter((m) => !m.isHost).length;
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
  // A tap you can feel, on the phones that allow it.
  try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* not allowed */ }
  button.classList.remove('sent');
  void button.offsetWidth; // restart the pop when tapped again
  button.classList.add('sent');
  setTimeout(() => button.classList.remove('sent'), 600);
  // A problem is reported once; the panel has done its job.
  if (button.classList.contains('problem')) setProblemsOpen(false);
});

function setProblemsOpen(open) {
  ui.moreReactions.hidden = !open;
  ui.moreReactionsBtn.setAttribute('aria-expanded', String(open));
}
ui.moreReactionsBtn.addEventListener('click', () => setProblemsOpen(ui.moreReactions.hidden));

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
  show(ui.leaveBtn, false);
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
  linkShare.reset();
  linkListen.reset();

  showDeadEnd(title, sub);
  ui.connectionPill.classList.remove('live');
  ui.connectionText.textContent = 'اتاق تمام شد';
}

// Leaving from the header. A guest just goes, and can come back by the same
// link. The host is asked first: for them it ends the room for everyone, or
// hands it on if they chose that in the settings.
function leaveRoom() {
  const wasHost = isHost;
  terminated = true;
  api.leave();
  events.close();
  host.endRoom();
  guest.endRoom();
  linkShare.reset();
  linkListen.reset();
  wakeLock.release();
  if (wasHost) { window.location.href = '/'; return; }
  showDeadEnd('از اتاق اومدی بیرون', 'هر وقت خواستی، با همین لینک برگرد.');
  ui.notFoundCta.textContent = 'برگشت به اتاق';
  ui.notFoundCta.href = window.location.pathname;
  ui.connectionText.textContent = 'بیرون اومدی';
}

ui.leaveBtn.addEventListener('click', () => {
  if (!isHost || !ui.leaveDialog.showModal) { leaveRoom(); return; }
  const handOver = ui.handOverToggle.checked && guestCount > 0;
  ui.leaveDialogTitle.textContent = handOver ? 'میزبانی رو می‌سپری و می‌ری؟' : 'اتاق بسته بشه؟';
  ui.leaveDialogSub.textContent = handOver
    ? 'پخش قطع می‌شه و میزبانی به نفر بعدی می‌رسه.'
    : guestCount > 0
      ? `پخش برای ${faDigits(guestCount)} نفر قطع می‌شه و اتاق بسته می‌شه. لینکش دیگه کار نمی‌کنه.`
      : 'اتاق بسته می‌شه و لینکش دیگه کار نمی‌کنه.';
  ui.leaveConfirmBtn.textContent = handOver ? 'سپردن و خروج' : 'بستن اتاق و خروج';
  ui.leaveDialog.returnValue = '';
  ui.leaveDialog.showModal();
});
ui.leaveDialog.addEventListener('close', () => {
  if (ui.leaveDialog.returnValue === 'leave') leaveRoom();
});

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
  applyTrack(data.track, data.serverNow);

  if (isHost) {
    stats.stop(); // a fresh host isn't sending anything yet
    host.handleRelayDemand(data.relayDemand);
    host.announceName();
    return;
  }

  if (ui.nameInput.value) api.setName(ui.nameInput.value); // we already know what to call ourselves
  guest.renderNowPlaying(data.nowPlaying);
  guest.applyShare({ relayFormat: data.relayFormat, directAvailable: data.directAvailable });

  if (!data.isSharing) { guest.waitForHost(); return; }
  // Late joiners pick the timer up mid-session rather than from zero.
  if (data.sharingElapsedMs !== null) guestTimer.start(data.sharingElapsedMs);
  guest.startListening({ reconnect: !guest.isHealthy() });
});

events.on('track', ({ track, serverNow }) => applyTrack(track, serverNow));

events.on('sharing-started', (data) => {
  sharingNow = true;
  updateLinkLayout();
  if (isHost) return;
  endCard.hide();
  guest.renderNowPlaying('');
  guest.applyShare({ relayFormat: data.relayFormat, directAvailable: data.directAvailable });
  guestTimer.start(0);
  guest.startListening();
});

events.on('sharing-stopped', () => {
  sharingNow = false;
  if (isHost) { linkShare.sharingStopped(); updateLinkLayout(); return; }
  const listened = guest.handleSharingStopped();
  updateLinkLayout();
  // The host only switched the mic off; the song plays on.
  if (listened >= END_CARD_MIN_MS && !currentTrack) endCard.show(listened, hostName);
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
    else notices.showToast('به میزبان گفتیم ✔');
    return;
  }
  if (reaction.cheer) { notices.showBurst(reaction.emoji, layer, isHost ? roster.labelFor(from) : ''); return; }

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
  linkListen.reset();
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
  linkShare.reset();
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
    const level = (isHost ? hostMeter : guestMeter).level(true);
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
