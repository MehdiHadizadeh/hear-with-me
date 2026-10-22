// The guest's half of a room: hearing the host, by one of two paths, and
// everything around keeping that alive on a phone.
//
//   direct — WebRTC, browser to browser. Under a tenth of a second late, but
//            a phone suspends it like a call once the screen locks, and it
//            needs a UDP path between the two that some networks never give.
//   relay  — the "screen-off" path (js/relay-player.js): the same sound as an
//            HTTP stream through our server. A second or two late, keeps
//            playing on a locked phone, and goes wherever the page itself got.
//
// Phones default to relay, desktops to direct; the guest can switch either
// way, and a direct connection that never comes up falls back to relay on its
// own.

import { setStage, show } from './dom.js';
import { faDigits } from './format.js';
import { resumeAudio } from './audio-meter.js';
import { RECEIVE_CAPS } from './audio-quality.js';
import { canPlayRelay, isTouchDevice, prefersScreenOff } from './platform.js';
import { createRelayPlayer, SILENCE } from './relay-player.js';
import { report, withPlatform } from './metrics.js';
import { minutesBucket } from '../shared/metrics.js';

const ALIVE_STATES = ['new', 'connecting', 'connected'];
const DEAD_STATES = ['disconnected', 'failed', 'closed'];

// A phone that lost its network can be gone for minutes. Retrying every two
// seconds for all of it drains the battery and achieves nothing, so the gap
// grows — but never past fifteen seconds, because coming back should feel
// immediate. The jitter keeps two guests from retrying in lockstep.
const RETRY_BASE_MS = 1500;
const RETRY_MAX_MS = 15000;
const RETRY_JITTER_MS = 400;
const WAIT_FOR_STREAM_MS = 1000;

// If the answer never arrives the connection just sits in 'new' — it never
// becomes 'failed', so the state handler never fires and we would wait
// forever. That is exactly what happened after a phone came back from sleep,
// where only a manual reload recovered it.
const NEGOTIATION_TIMEOUT_MS = 8000;

// How long a direct connection gets before we stop waiting for it and go
// through the server instead. Long enough for a slow ICE check on mobile
// data, short enough that nobody has given up and reloaded yet.
const DIRECT_FALLBACK_MS = 6000;

export function createGuestSession({
  ui, api, quality, meter, timer, events, wakeLock, stats, prefs, rtcConfig, notices,
}) {
  let pc = null;
  let stream = null; // kept so the meter can be re-attached once audio unlocks
  let attempts = 0;
  let retryTimer = null;
  let negotiationTimer = null;
  let fallbackTimer = null;
  let receiveCap = prefs.receiveCap(Object.keys(RECEIVE_CAPS));

  // How this guest listens, and why: "default" (nobody chose), "chosen", or
  // "fallback" (direct never came up).
  const forced = new URLSearchParams(window.location.search).get('mode');
  let mode = forced === 'relay' || forced === 'direct'
    ? forced
    : prefs.listenMode() || (prefersScreenOff ? 'relay' : 'direct');
  let why = forced || prefs.listenMode() ? 'chosen' : 'default';

  let relayFormat = null;     // what the host is encoding, if anything
  let relayAllowed = true;    // the host's "direct only" switch, inverted
  // A phone has to tap once before audio may start on its own; a desktop page
  // can usually just begin. Until then nothing connects.
  let armed = !isTouchDevice;
  let wantListening = false;  // sharing is on and we should be hearing it
  let listeningSince = null;
  let hostName = '';

  const relayUsable = () => relayAllowed && canPlayRelay(relayFormat);
  const pathNow = () => (mode === 'relay' && relayUsable() ? 'relay' : 'direct');

  const relay = createRelayPlayer({
    api,
    audio: ui.remoteAudio,
    onLive: () => onConnected('relay'),
    onDropped: () => { onDropped(); retry(); },
    onRefused: (reason) => {
      // The host switched the relay off, or it is not available for this
      // share: the direct path is all there is.
      if (reason === 'relay-disabled' || reason === 'no-relay') {
        relayAllowed = reason !== 'relay-disabled' && relayAllowed;
        mode = 'direct';
        renderModeChoice();
        connect();
        return;
      }
      onDropped();
      retry();
    },
  });

  // The WebRTC connection does not run over the event stream, so it survives
  // an event-stream blip untouched. After such a blip we get a fresh
  // `welcome`, and rebuilding a healthy connection then would cause an audio
  // dropout for no reason.
  const isHealthy = () => (pathNow() === 'relay'
    ? relay.active && !ui.remoteAudio.error
    : !!pc && ALIVE_STATES.includes(pc.connectionState));

  const backoff = () => Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS)
    + Math.random() * RETRY_JITTER_MS;

  function retry(delayMs) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delayMs === undefined ? backoff() : delayMs);
  }

  // Sent on every connect too, so a reconnect (or a host who reloaded) does
  // not silently go back to full rate.
  function sendReceiveCap() {
    api.signal('host', 'quality', RECEIVE_CAPS[receiveCap]);
  }

  // -- what the page says about the path -------------------------------------

  function renderPath() {
    const relayNow = pathNow() === 'relay';
    ui.pathChip.textContent = relayNow ? 'از راه سرور · صفحه‌خاموش' : 'مستقیم · هم‌زمان';
    ui.pathChip.dataset.path = relayNow ? 'relay' : 'direct';
    // The one sentence about privacy that is true for the path in use.
    ui.footerNote.textContent = relayNow
      ? 'همین صدا، همین لحظه. صدا از سرور ما رد می‌شه و هیچ‌جا ذخیره نمی‌شه.'
      : 'همین صدا، همین لحظه. صدا مستقیم بین دو مرورگر رد و بدل می‌شه.';
    if (isTouchDevice && !relayNow) {
      ui.backgroundHint.textContent = relayUsable()
        ? 'تو حالت هم‌زمان، با قفل شدن گوشی صدا قطع می‌شه. برای گوش دادن با صفحه‌ی خاموش، «صفحه‌خاموش» رو انتخاب کن.'
        : 'اگه گوشی رو قفل کنی یا از مرورگر بیرون بری، صدا قطع می‌شه. برگردی، خودکار وصل می‌شه.';
      show(ui.backgroundHint, wantListening);
    } else {
      show(ui.backgroundHint, false);
    }
    show(ui.wakeLockRow, isTouchDevice && !relayNow && wakeLock.supported, 'flex');
  }

  function renderModeChoice() {
    const relayOk = relayUsable() || (relayAllowed && !relayFormat); // format not known yet
    ui.modeRelay.disabled = !relayOk;
    ui.modeRelay.setAttribute('aria-checked', String(mode === 'relay' && relayOk));
    ui.modeDirect.setAttribute('aria-checked', String(mode !== 'relay' || !relayOk));
  }

  // -- shared life cycle ------------------------------------------------------

  function onConnected(path) {
    clearTimeout(negotiationTimer);
    clearTimeout(fallbackTimer);
    attempts = 0;
    setStage(ui.guestStage, 'live');
    ui.guestStatusTitle.textContent = 'زنده — در حال شنیدن';
    ui.guestStatusSub.textContent = path === 'relay'
      ? 'می‌تونی گوشی رو قفل کنی؛ پخش ادامه پیدا می‌کنه.'
      : 'همون چیزی که میزبان الان می‌شنوه.';
    show(ui.guestLiveBox, true);
    renderPath();
    setReactionsEnabled(true);

    if (listeningSince === null) {
      listeningSince = Date.now();
      report('listen-started', withPlatform({ path, why }));
    }

    if (path === 'relay') {
      // The meter taps a copy of what the element plays. Where a browser
      // cannot copy it (iPhone), the meter is hidden rather than left flat:
      // a flat meter here would claim there is no sound.
      const copy = ui.remoteAudio.captureStream ? (() => { try { return ui.remoteAudio.captureStream(); } catch (e) { return null; } })() : null;
      ui.guestStage.dataset.meter = copy ? 'on' : 'off';
      if (copy && document.visibilityState === 'visible') meter.attach(copy);
      wakeLock.release(); // not needed: this path survives a dark screen
      return;
    }

    ui.guestStage.dataset.meter = 'on';
    sendReceiveCap(); // this connection is new; the host knows nothing of our ceiling
    stats.start();
    reportDirectRoute();
    if (isTouchDevice && ui.wakeLockToggle.checked) wakeLock.request();
  }

  function onDropped() {
    setStage(ui.guestStage, 'dropped');
    ui.guestStatusTitle.textContent = 'اتصال قطع شد';
    ui.guestStatusSub.textContent = 'در حال تلاش دوباره...';
    meter.stop();
    stats.stop();
  }

  function setReactionsEnabled(on) {
    for (const b of ui.reactionRow.querySelectorAll('.reaction')) {
      if (b !== ui.moreReactionsBtn) b.disabled = !on;
    }
  }

  async function connect() {
    clearTimeout(retryTimer);
    clearTimeout(negotiationTimer);
    if (!wantListening) return;
    if (!armed) { showGate(); return; }
    if (pathNow() === 'relay') { connectRelay(); return; }
    connectDirect();
  }

  // -- relay ------------------------------------------------------------------

  async function connectRelay() {
    if (pc) { pc.close(); pc = null; }
    stats.stop();
    attempts++;
    setStage(ui.guestStage, 'connecting');
    ui.guestStatusTitle.textContent = 'در حال وصل شدن...';
    ui.guestStatusSub.textContent = attempts > 1 ? `تلاش دوباره (${faDigits(attempts)})...` : '';
    stream = null;
    const problem = await relay.start();
    if (problem === 'autoplay-blocked') ui.enableAudioOverlay.classList.remove('hidden');
  }

  // -- direct -----------------------------------------------------------------

  async function connectDirect() {
    relay.stop();
    // The host's answer comes back over the event stream. Offering while that
    // is down means the answer is delivered to nobody, and nothing will resend
    // it — so wait for the stream instead of burning an offer.
    if (!events.isOpen) {
      setStage(ui.guestStage, 'connecting');
      ui.guestStatusTitle.textContent = 'در حال اتصال دوباره به اتاق...';
      ui.guestStatusSub.textContent = '';
      retry(WAIT_FOR_STREAM_MS);
      return;
    }

    if (pc) pc.close();
    attempts++;
    const config = await rtcConfig;

    setStage(ui.guestStage, 'connecting');
    ui.guestStatusTitle.textContent = 'در حال اتصال به میزبان...';
    // Say so when we're retrying: a silent retry loop is indistinguishable
    // from a frozen page, which is how this looked to the user.
    ui.guestStatusSub.textContent = attempts > 1 ? `تلاش دوباره (${faDigits(attempts)})...` : '';

    const connection = new RTCPeerConnection(config);
    pc = connection;
    connection.addTransceiver('audio', { direction: 'recvonly' });

    connection.ontrack = (e) => {
      [stream] = e.streams;
      ui.remoteAudio.removeAttribute('src');
      ui.remoteAudio.srcObject = stream;
      meter.attach(stream);
      ui.remoteAudio.play().catch(() => ui.enableAudioOverlay.classList.remove('hidden'));
    };
    connection.onicecandidate = (e) => { if (e.candidate) api.signal('host', 'ice', e.candidate); };
    connection.onconnectionstatechange = () => {
      if (connection !== pc) return;
      if (connection.connectionState === 'connected') onConnected('direct');
      else if (DEAD_STATES.includes(connection.connectionState)) { onDropped(); retry(); }
    };

    const offer = await connection.createOffer();
    offer.sdp = quality.tuneOpus(offer.sdp);
    await connection.setLocalDescription(offer);
    api.signal('host', 'offer', offer.sdp);

    negotiationTimer = setTimeout(() => {
      if (connection !== pc || connection.connectionState === 'connected') return;
      connect();
    }, NEGOTIATION_TIMEOUT_MS);

    // Most "it never connects" on Iranian networks is UDP that never gets
    // through: no amount of retrying the direct path fixes it, the relay
    // does. Only once per listen, and never against the host's wishes.
    clearTimeout(fallbackTimer);
    if (listeningSince === null && relayUsable()) {
      fallbackTimer = setTimeout(() => {
        if (connection !== pc || connection.connectionState === 'connected') return;
        reportDirectFailure(connection);
        mode = 'relay';
        why = 'fallback';
        renderModeChoice();
        notices.showInfo('اتصال مستقیم برقرار نشد، پس صدا از راه سرور ما می‌رسه. اگه هر دو تو ایرانید و VPN روشنه، خاموش کردنش معمولاً اتصال مستقیم رو درست می‌کنه.');
        connect();
      }, DIRECT_FALLBACK_MS);
    }
  }

  // What ICE had found when it gave up. "none" means not even the STUN
  // server answered, which on Iranian networks usually means UDP is blocked.
  async function reportDirectFailure(connection) {
    let best = 'none';
    try {
      const rank = { none: 0, host: 1, srflx: 2, relay: 3 };
      (await connection.getStats()).forEach((r) => {
        if (r.type === 'local-candidate' && rank[r.candidateType] > rank[best]) best = r.candidateType;
      });
    } catch (e) { /* closed */ }
    report('direct-failed', withPlatform({ candidates: best }));
  }

  async function reportDirectRoute() {
    const connection = pc;
    // The kinds of the two ends of the pair that carried the audio: "host"
    // is the same network, "srflx"/"prflx" got through a NAT, "relay" means
    // a TURN server did the work.
    const types = [];
    try {
      const stats_ = await connection.getStats();
      let pair = null;
      stats_.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || !pair)) pair = r; });
      if (pair) {
        stats_.forEach((r) => {
          if (r.id === pair.localCandidateId || r.id === pair.remoteCandidateId) types.push(r.candidateType);
        });
      }
    } catch (e) { /* closed */ }
    const order = ['relay', 'prflx', 'srflx', 'host'];
    report('direct-route', { route: order.find((t) => types.includes(t)) || 'unknown' });
  }

  // -- tearing down -----------------------------------------------------------

  function finishListening() {
    if (listeningSince !== null) {
      report('listen-ended', { minutes: minutesBucket(Date.now() - listeningSince) });
    }
    const listened = listeningSince === null ? 0 : Date.now() - listeningSince;
    listeningSince = null;
    return listened;
  }

  function teardown() {
    clearTimeout(retryTimer);
    clearTimeout(negotiationTimer);
    clearTimeout(fallbackTimer);
    if (pc) { pc.close(); pc = null; }
    relay.stop();
    ui.remoteAudio.srcObject = null;
    stream = null;
    meter.stop();
    timer.stop();
    stats.stop();
    wakeLock.release();
    setReactionsEnabled(false);
  }

  // -- the first tap (phones) ------------------------------------------------

  function showGate() {
    renderModeChoice();
    show(ui.listenGate, true);
  }

  function choose(next) {
    mode = next;
    why = 'chosen';
    prefs.setListenMode(next);
    renderModeChoice();
  }

  ui.modeRelay.addEventListener('click', () => choose('relay'));
  ui.modeDirect.addEventListener('click', () => choose('direct'));

  ui.listenBtn.addEventListener('click', () => {
    armed = true;
    show(ui.listenGate, false);
    // Inside the tap: let this element play later without another one.
    if (!ui.remoteAudio.src && !ui.remoteAudio.srcObject) {
      ui.remoteAudio.src = SILENCE;
      ui.remoteAudio.play().then(() => ui.remoteAudio.pause(), () => {});
    }
    unlockAudio();
    if (wantListening) connect();
    else {
      ui.guestStatusTitle.textContent = 'آماده‌ای';
      ui.guestStatusSub.textContent = 'وقتی پخش شروع بشه، خودکار می‌شنوی.';
    }
  });

  // Switching paths mid-listen: the chip is also the switch.
  ui.pathChip.addEventListener('click', () => {
    const next = pathNow() === 'relay' ? 'direct' : 'relay';
    if (next === 'relay' && !relayUsable()) {
      notices.showInfo(relayAllowed
        ? 'این مرورگر جریان صفحه‌خاموش این اتاق رو پخش نمی‌کنه.'
        : 'میزبان این اتاق رو روی «فقط مستقیم» گذاشته.');
      return;
    }
    choose(next);
    if (pc) { pc.close(); pc = null; }
    relay.stop();
    meter.stop();
    stats.stop();
    attempts = 0;
    connect();
  });

  // -- what the guest hears about ---------------------------------------------

  function renderNowPlaying(text) {
    ui.guestNowPlaying.textContent = '';
    if (text) {
      const label = document.createElement('span');
      label.className = 'np-label';
      label.textContent = 'الان';
      ui.guestNowPlaying.append(label, document.createTextNode(text));
    }
    show(ui.guestNowPlaying, !!text);
    publishMediaSession(text);
  }

  function renderWho(sharing) {
    const name = hostName || 'یکی';
    ui.guestWho.textContent = sharing ? `${name} داره برات پخش می‌کنه` : `${name} هنوز پخش رو شروع نکرده`;
  }

  // The lock screen and the notification shade show this. On the relay path
  // it is also what makes the OS treat the page as a player.
  function publishMediaSession(text) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: text || (hostName ? `${hostName} · زنده` : 'پخش زنده'),
        artist: 'Hear With Me',
        artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
      navigator.mediaSession.setActionHandler('play', () => {
        ui.remoteAudio.play().catch(() => {});
        setMuted(false);
      });
      navigator.mediaSession.setActionHandler('pause', () => setMuted(true));
    } catch (e) { /* not supported here */ }
  }

  // -- volume -----------------------------------------------------------------

  // iOS ignores writes to HTMLMediaElement.volume entirely — the slider moves
  // and nothing happens. `muted` is honoured everywhere, so muting is a real
  // button rather than the slider's zero position, and dragging to zero mutes
  // explicitly instead of relying on a volume that may never have applied.
  const volumeIsSettable = (() => {
    const original = ui.remoteAudio.volume;
    ui.remoteAudio.volume = 0.5;
    const applied = Math.abs(ui.remoteAudio.volume - 0.5) < 0.01;
    ui.remoteAudio.volume = original;
    return applied;
  })();

  if (!volumeIsSettable) {
    show(ui.volumeBar, false);
    show(ui.volumeHint, true);
  }

  // The icon is swapped in CSS off aria-pressed, so the button's state and its
  // appearance can never drift apart.
  function setMuted(muted) {
    ui.remoteAudio.muted = muted;
    for (const btn of [ui.muteBtn, ui.carPlayBtn]) {
      btn.setAttribute('aria-pressed', String(muted));
      btn.setAttribute('aria-label', muted ? 'وصل کردن صدا' : 'بی‌صدا کردن');
    }
  }

  ui.muteBtn.addEventListener('click', () => {
    setMuted(!ui.remoteAudio.muted);
    if (!ui.remoteAudio.muted && Number(ui.volumeBar.value) === 0) {
      ui.volumeBar.value = '1';
      ui.remoteAudio.volume = 1;
    }
  });

  ui.volumeBar.addEventListener('input', () => {
    const level = Number(ui.volumeBar.value);
    ui.remoteAudio.volume = level;
    setMuted(level === 0);
  });

  function unlockAudio() {
    resumeAudio();
    if (stream && !meter.isRunning()) meter.attach(stream);
  }

  ui.enableAudioBtn.addEventListener('click', () => {
    ui.enableAudioOverlay.classList.add('hidden');
    armed = true;
    show(ui.listenGate, false);
    ui.remoteAudio.play().catch(() => {});
    unlockAudio(); // this tap is the gesture the AudioContext was waiting for
    if (wantListening && !isHealthy()) connect();
  });

  for (const evt of ['pointerdown', 'touchend', 'keydown']) {
    document.addEventListener(evt, unlockAudio, { passive: true });
  }

  // -- preferences the guest owns ---------------------------------------------

  ui.receiveQuality.value = receiveCap;
  ui.receiveQuality.addEventListener('change', () => {
    receiveCap = ui.receiveQuality.value in RECEIVE_CAPS ? ui.receiveQuality.value : 'auto';
    prefs.setReceiveCap(receiveCap);
    sendReceiveCap();
  });

  ui.wakeLockToggle.checked = prefs.wakeLockWanted();
  ui.wakeLockToggle.addEventListener('change', () => {
    prefs.setWakeLockWanted(ui.wakeLockToggle.checked);
    if (ui.wakeLockToggle.checked) wakeLock.request(); else wakeLock.release();
  });

  setReactionsEnabled(false);
  renderModeChoice();

  return {
    get connection() { return pc; },
    get listening() { return listeningSince !== null; },
    get muted() { return ui.remoteAudio.muted; },
    setMuted,
    isHealthy,
    connect,
    renderNowPlaying,

    // What the host offers this share: the relay format (or none) and
    // whether the host lets anyone use it.
    applyShare({ relayFormat: format }) {
      relayFormat = format || null;
      renderModeChoice();
    },
    applySettings(settings) {
      if (!settings || typeof settings.relayAllowed !== 'boolean') return;
      const was = relayAllowed;
      relayAllowed = settings.relayAllowed;
      renderModeChoice();
      // Switched off under us: back to the direct path.
      if (was && !relayAllowed && relay.active) { relay.stop(); connect(); }
    },
    setHostName(name) {
      hostName = name || '';
      renderWho(wantListening);
      publishMediaSession(ui.guestNowPlaying.textContent.replace(/^الان/, ''));
    },

    handleAnswer(sdp) {
      if (pc) pc.setRemoteDescription({ type: 'answer', sdp }).catch(() => {});
    },

    handleIce(candidate) {
      if (pc && candidate) pc.addIceCandidate(candidate).catch(() => {});
    },

    waitForHost() {
      wantListening = false;
      renderWho(false);
      setStage(ui.guestStage, 'waiting');
      ui.guestStatusTitle.textContent = 'در انتظار میزبان';
      ui.guestStatusSub.textContent = 'وقتی پخش شروع بشه، همین‌جا می‌شنوی.';
      if (!armed) showGate();
    },

    // Sharing is on: listen, by whichever path this guest uses. A fresh
    // `welcome` after an event-stream blip says so too, but a connection
    // that is still healthy must not be rebuilt for it.
    startListening({ reconnect = true } = {}) {
      wantListening = true;
      renderWho(true);
      show(ui.endCard, false);
      if (reconnect) connect();
    },

    // Returns how long this guest listened, for the end card.
    handleSharingStopped() {
      wantListening = false;
      const listened = finishListening();
      teardown();
      renderWho(false);
      setStage(ui.guestStage, 'stopped');
      ui.guestStatusTitle.textContent = 'پخش تموم شد';
      ui.guestStatusSub.textContent = 'اگه میزبان دوباره شروع کنه، خودکار وصل می‌شی.';
      show(ui.guestLiveBox, false);
      show(ui.backgroundHint, false);
      renderNowPlaying('');
      return listened;
    },

    // Coming back from a locked screen: the phone suspended everything, so
    // check rather than wait for a timeout the user is already staring
    // through.
    handleVisible() {
      if (pathNow() === 'direct' && ui.wakeLockToggle.checked && isTouchDevice) wakeLock.request();
      if (!wantListening) return;
      if (!isHealthy()) connect();
      else if (pathNow() === 'relay' && ui.guestStage.dataset.meter === 'on' && !meter.isRunning()) {
        try { meter.attach(ui.remoteAudio.captureStream()); } catch (e) { /* no meter */ }
      } else if (stream && !meter.isRunning()) meter.attach(stream);
    },

    handleHidden() {
      // Nobody can see the meter now, and tapping the stream with Web Audio
      // can move audio rendering into the AudioContext — which the browser
      // suspends on a backgrounded page, taking the audio with it. Let the
      // <audio> element be the only consumer while we're out of sight.
      meter.stop();
    },

    // We were the host a moment ago and are not any more.
    becomeListener() {
      setStage(ui.guestStage, 'waiting');
      ui.guestStatusTitle.textContent = 'حالا شنونده‌ای';
      ui.guestStatusSub.textContent = 'وقتی میزبان جدید پخش رو شروع کنه، همین‌جا می‌شنوی.';
    },

    // We are the host now; drop every trace of listening.
    stopListening() {
      wantListening = false;
      finishListening();
      teardown();
      show(ui.guestLiveBox, false);
    },

    endRoom() { finishListening(); teardown(); },
  };
}
