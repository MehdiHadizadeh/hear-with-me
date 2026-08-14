// The guest's half of a room: one connection to the host, and everything
// around keeping it alive on a phone.

import { isTouchDevice, setStage, show } from './dom.js';
import { faDigits } from './format.js';
import { resumeAudio } from './audio-meter.js';
import { RECEIVE_CAPS } from './audio-quality.js';

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

export function createGuestSession({
  ui, api, quality, meter, timer, events, wakeLock, stats, prefs, rtcConfig,
}) {
  let pc = null;
  let stream = null; // kept so the meter can be re-attached once audio unlocks
  let attempts = 0;
  let retryTimer = null;
  let negotiationTimer = null;
  let receiveCap = prefs.receiveCap(Object.keys(RECEIVE_CAPS));

  // The WebRTC connection does not run over the event stream, so it survives
  // an event-stream blip untouched. After such a blip we get a fresh
  // `welcome`, and rebuilding a healthy connection then would cause an audio
  // dropout for no reason.
  const isHealthy = () => !!pc && ALIVE_STATES.includes(pc.connectionState);

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

  function onConnected() {
    clearTimeout(negotiationTimer);
    attempts = 0;
    sendReceiveCap(); // this connection is new; the host knows nothing of our ceiling
    setStage(ui.guestStage, 'live');
    ui.guestStatusTitle.textContent = 'زنده — در حال شنیدن';
    ui.guestStatusSub.textContent = 'همون چیزی که میزبان الان می‌شنوه.';
    show(ui.guestLiveBox, true);
    stats.start();

    // Only phones and tablets suspend a backgrounded page's audio, and only
    // there do these two earn their space.
    if (!isTouchDevice) return;
    show(ui.backgroundHint, true);
    if (wakeLock.supported) show(ui.wakeLockRow, true, 'flex');
    if (ui.wakeLockToggle.checked) wakeLock.request();
  }

  function onDropped() {
    setStage(ui.guestStage, 'dropped');
    ui.guestStatusTitle.textContent = 'اتصال قطع شد';
    ui.guestStatusSub.textContent = 'در حال تلاش دوباره...';
    meter.stop();
    stats.stop();
  }

  async function connect() {
    clearTimeout(retryTimer);
    clearTimeout(negotiationTimer);

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
      ui.remoteAudio.srcObject = stream;
      meter.attach(stream);
      ui.remoteAudio.play().catch(() => ui.enableAudioOverlay.classList.remove('hidden'));
    };
    connection.onicecandidate = (e) => { if (e.candidate) api.signal('host', 'ice', e.candidate); };
    connection.onconnectionstatechange = () => {
      if (connection !== pc) return;
      if (connection.connectionState === 'connected') onConnected();
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
  }

  function teardown() {
    clearTimeout(retryTimer);
    clearTimeout(negotiationTimer);
    if (pc) { pc.close(); pc = null; }
    ui.remoteAudio.srcObject = null;
    stream = null;
    meter.stop();
    timer.stop();
    stats.stop();
    wakeLock.release();
  }

  // -- what the guest hears about -------------------------------------------

  function renderNowPlaying(text) {
    ui.guestNowPlaying.textContent = '';
    if (text) {
      const label = document.createElement('span');
      label.className = 'np-label';
      label.textContent = 'در حال پخش';
      ui.guestNowPlaying.append(label, document.createTextNode(text));
    }
    show(ui.guestNowPlaying, !!text);
    publishMediaSession(text);
  }

  // Declaring a media session gets the stream into the OS media controls and
  // marks it as something the user is deliberately listening to, which is a
  // browser's main signal for whether audio may keep playing once the page is
  // backgrounded. Phones still suspend a locked browser; this improves the
  // odds rather than guaranteeing anything.
  function publishMediaSession(text) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: text || 'پخش زنده',
        artist: `Hear With Me — ${api.roomId}`,
      });
      navigator.mediaSession.setActionHandler('play', () => {
        ui.remoteAudio.play().catch(() => {});
        setMuted(false);
      });
      navigator.mediaSession.setActionHandler('pause', () => setMuted(true));
    } catch (e) { /* not supported here */ }
  }

  // -- volume ---------------------------------------------------------------

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
    ui.muteBtn.setAttribute('aria-pressed', String(muted));
    ui.muteBtn.setAttribute('aria-label', muted ? 'وصل کردن صدا' : 'بی‌صدا کردن');
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
    ui.remoteAudio.play().catch(() => {});
    unlockAudio(); // this tap is the gesture the AudioContext was waiting for
  });

  for (const evt of ['pointerdown', 'touchend', 'keydown']) {
    document.addEventListener(evt, unlockAudio, { passive: true });
  }

  // -- preferences the guest owns -------------------------------------------

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

  return {
    get connection() { return pc; },
    isHealthy,
    connect,
    renderNowPlaying,

    handleAnswer(sdp) {
      if (pc) pc.setRemoteDescription({ type: 'answer', sdp }).catch(() => {});
    },

    handleIce(candidate) {
      if (pc && candidate) pc.addIceCandidate(candidate).catch(() => {});
    },

    waitForHost() {
      setStage(ui.guestStage, 'waiting');
      ui.guestStatusTitle.textContent = 'در انتظار میزبان';
      ui.guestStatusSub.textContent = 'وقتی میزبان پخش رو شروع کنه، همین‌جا خودکار می‌شنوی.';
    },

    handleSharingStopped() {
      teardown();
      setStage(ui.guestStage, 'stopped');
      ui.guestStatusTitle.textContent = 'میزبان پخش رو متوقف کرد';
      ui.guestStatusSub.textContent = 'وقتی دوباره شروع کنه، خودکار وصل می‌شی.';
      show(ui.guestLiveBox, false);
      renderNowPlaying('');
    },

    // Coming back from a locked screen: the phone suspended everything, so
    // check rather than wait for a timeout the user is already staring
    // through.
    handleVisible() {
      if (ui.wakeLockToggle.checked) wakeLock.request();
      if (!isHealthy()) connect();
      else if (stream && !meter.isRunning()) meter.attach(stream);
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
      teardown();
      show(ui.guestLiveBox, false);
    },

    endRoom() { teardown(); },
  };
}
