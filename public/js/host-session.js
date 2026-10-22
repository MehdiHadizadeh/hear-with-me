// The host's half of a room: getting a sound, proving it is a sound, and
// answering every guest.
//
// One RTCPeerConnection per guest, because each guest negotiates its own path
// and may ask for its own bitrate. The sound itself is one stream that all of
// those senders share — and that the screen-off encoder reads from too.
//
// Where the sound comes from:
//   tab/screen — getDisplayMedia, desktop Chrome and Edge. Anything playing.
//   file       — a file on this device, played through Web Audio. The one way
//                a phone can host: no phone browser hands out another app's
//                sound.
// Either can have the host's own microphone mixed in.

import { setStage, show } from './dom.js';
import { canCaptureSystemAudio, canShareFile } from './platform.js';
import { createRelayEncoder, pickRelayFormat } from './relay-encoder.js';

// Capture defaults are tuned for speech: automatic gain control rides the
// level up and down through a track's own dynamics, and echo cancellation and
// noise suppression chew into music. We want the tab's audio untouched.
const MUSIC_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
  sampleRate: 48000,
};

const DEAD_STATES = ['failed', 'closed'];
const ALIVE_STATES = ['new', 'connecting', 'connected'];

// "Live" is only said once the meter has heard something. A share with the
// audio switch left off looks exactly like a working one until a guest
// complains — this is where it gets caught instead.
const SIGNAL_THRESHOLD = 0.02;  // about -34 dBFS
const SIGNAL_CHECK_MS = 6000;
const SIGNAL_POLL_MS = 200;

const NAME_DEBOUNCE_MS = 600;

const AudioCtx = window.AudioContext || window.webkitAudioContext;

export function createHostSession({
  ui, api, quality, meter, timer, rtcConfig, stats, prefs, notices, report, onQualityChange = () => {},
}) {
  const peers = new Map(); // guestClientId -> RTCPeerConnection
  let base = null;      // { stream, kind, stop(), element? } — what is being shared
  let outgoing = null;  // the stream guests get: base, or base mixed with the mic
  let mic = null;       // { stream, ctx } while the microphone is mixed in
  let signalTimer = null;
  let heardSound = false;

  // The encoder exists once we know what this browser can encode; demand
  // that arrives before then is kept and handed over.
  const relayFormatReady = pickRelayFormat();
  let relay = null;
  let relayDemand = 0;
  relayFormatReady.then((format) => {
    relay = createRelayEncoder({ api, format });
    relay.setStream(outgoing);
    relay.setDemand(relayDemand);
  });
  const relayStream = (stream) => { if (relay) relay.setStream(stream); };

  const isSharing = () => outgoing !== null;

  // -- getting a sound -------------------------------------------------------

  // Hands back { stream, kind, stop }, or null having already explained on the
  // stage what went wrong.
  async function captureScreenAudio() {
    let stream;
    // Keep this page in front once the picker closes, so the host watches the
    // signal check instead of being thrown into the music tab mid-way.
    const controller = typeof CaptureController !== 'undefined' ? new CaptureController() : undefined;
    const ask = (audio) => navigator.mediaDevices.getDisplayMedia({
      video: true, audio, ...(controller ? { controller } : {}),
    });
    try {
      stream = await ask(MUSIC_AUDIO);
    } catch (e) {
      if (e && e.name === 'NotAllowedError') return refuse();
      try {
        // Some browsers reject the constrained form outright; plain audio is
        // still far better than no sharing at all.
        stream = await ask(true);
      } catch (e2) {
        return refuse();
      }
    }
    try { if (controller && controller.setFocusBehavior) controller.setFocusBehavior('no-focus-change'); } catch (e) { /* too late or unsupported */ }

    // We only want audio — the browser forces a video track through this API
    // even for tab/audio-only sharing, so we drop it immediately.
    const video = stream.getVideoTracks()[0];
    const surface = video && video.getSettings ? video.getSettings().displaySurface : '';
    stream.getVideoTracks().forEach((t) => t.stop());
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      if (!isSharing()) setStage(ui.hostStage, 'error');
      ui.hostTitle.textContent = isSharing() ? 'هنوز داری همون قبلی رو پخش می‌کنی' : 'این منبع صدا نداشت';
      ui.hostStatus.textContent = 'کلید صدا تو پنجره‌ی انتخاب روشن نبود. دوباره امتحان کن و این بار «Share tab audio» یا «Share system audio» رو روشن کن.';
      return null;
    }
    const tracks = new MediaStream(audioTracks);
    return {
      stream: tracks,
      kind: surface === 'browser' ? 'tab' : 'screen',
      stop: () => tracks.getTracks().forEach((t) => t.stop()),
    };

    function refuse() {
      if (!isSharing()) setStage(ui.hostStage, 'error');
      if (!isSharing()) {
        ui.hostTitle.textContent = 'دسترسی به صدا داده نشد';
        ui.hostStatus.textContent = 'یا پنجره‌ی انتخاب رو بستی، یا این مرورگر این کار رو بلد نیست. پخش صدای تب فقط از Chrome یا Edge روی کامپیوتر ممکنه.';
      }
      return null;
    }
  }

  // A file from this device, played through Web Audio so it becomes a stream.
  // The host hears it too: they are its player.
  async function captureFile(file) {
    if (!file || !canShareFile) return null;
    const ctx = new AudioCtx();
    const element = new Audio();
    element.src = URL.createObjectURL(file);
    element.preload = 'auto';
    const source = ctx.createMediaElementSource(element);
    const dest = ctx.createMediaStreamDestination();
    source.connect(dest);
    source.connect(ctx.destination);
    try {
      await ctx.resume();
      await element.play();
    } catch (e) {
      ctx.close();
      setStage(ui.hostStage, 'error');
      ui.hostTitle.textContent = 'این فایل پخش نشد';
      ui.hostStatus.textContent = 'شاید قالبش رو این مرورگر نمی‌شناسه. یه فایل mp3 یا m4a امتحان کن.';
      return null;
    }
    const name = file.name.replace(/\.[a-z0-9]{2,5}$/i, '');
    element.addEventListener('ended', () => {
      ui.hostStatus.textContent = 'فایل تموم شد. یه فایل دیگه انتخاب کن یا دوباره پخشش کن.';
      ui.filePlayBtn.textContent = 'پخش دوباره';
    });
    return {
      stream: dest.stream,
      kind: 'file',
      name,
      element,
      stop: () => {
        element.pause();
        URL.revokeObjectURL(element.src);
        ctx.close();
      },
    };
  }

  // -- what guests receive ---------------------------------------------------

  // Re-points every guest at a new stream without tearing anything down:
  // from the guest's side the sound simply changes.
  async function setOutgoing(stream) {
    outgoing = stream;
    const track = stream.getAudioTracks()[0];
    await Promise.all([...peers.values()].map(async (pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (sender && sender.replaceTrack) await sender.replaceTrack(track).catch(() => {});
    }));
    relayStream(stream);
    meter.attach(stream);
  }

  async function mixMicrophone(on) {
    if (!on) {
      if (mic) { mic.stream.getTracks().forEach((t) => t.stop()); mic.ctx.close(); mic = null; }
      if (base) await setOutgoing(base.stream);
      return;
    }
    if (!base || mic) return;
    let micStream;
    try {
      // Speech settings are right here: this is a voice, not the music.
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      ui.micToggle.checked = false;
      notices.showError('دسترسی به میکروفون داده نشد.');
      return;
    }
    const ctx = new AudioCtx();
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(base.stream).connect(dest);
    ctx.createMediaStreamSource(micStream).connect(dest);
    await ctx.resume().catch(() => {});
    mic = { stream: micStream, ctx };
    await setOutgoing(dest.stream);
  }

  // -- the signal check ------------------------------------------------------

  function startSignalCheck() {
    clearInterval(signalTimer);
    heardSound = false;
    const started = Date.now();
    let warned = false;
    setStage(ui.hostStage, 'connecting');
    ui.hostTitle.textContent = 'داریم گوش می‌دیم...';
    ui.hostStatus.textContent = 'چند ثانیه صبر کن تا مطمئن شیم صدا میاد.';
    signalTimer = setInterval(() => {
      if (!isSharing()) { clearInterval(signalTimer); return; }
      if (meter.level() > SIGNAL_THRESHOLD) {
        heardSound = true;
        clearInterval(signalTimer);
        goLive();
        return;
      }
      if (!warned && Date.now() - started > SIGNAL_CHECK_MS) {
        warned = true;
        report('share-silent');
        setStage(ui.hostStage, 'error');
        ui.hostTitle.textContent = 'صدایی نمیاد';
        ui.hostStatus.textContent = base && base.kind === 'file'
          ? 'فایل پخش نمی‌شه یا خیلی آرومه.'
          : 'یا کلید صدا تو پنجره‌ی انتخاب روشن نبود، یا تو اون تب الان چیزی پخش نمی‌شه. یه آهنگ پخش کن؛ اگه باز هم نیومد، «تعویض منبع صدا» رو بزن.';
        // Keep listening: the moment something plays, this turns live.
      }
    }, SIGNAL_POLL_MS);
  }

  function goLive() {
    prefs.setSharedBefore();
    setStage(ui.hostStage, 'live');
    ui.hostTitle.textContent = 'زنده — داری پخش می‌کنی';
    ui.hostStatus.textContent = 'هرکی لینک رو باز کنه، همین الان می‌شنوه.';
  }

  // -- starting and stopping ---------------------------------------------------

  function showSharingControls(sharing) {
    show(ui.startShareBtn, !sharing && canCaptureSystemAudio);
    show(ui.fileShareLabel, !sharing && canShareFile, 'flex');
    show(ui.switchSourceBtn, sharing);
    show(ui.stopShareBtn, sharing);
    show(ui.hostLiveBox, sharing);
    show(ui.micRow, sharing && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), 'flex');
    show(ui.hostRehearsal, !sharing && canCaptureSystemAudio);
    show(ui.fileControls, sharing && !!base && base.kind === 'file', 'flex');
  }

  async function begin(source) {
    base = source;
    // The user can also stop it from the browser's own sharing bar.
    source.stream.getAudioTracks()[0].addEventListener('ended', () => stopSharing());

    showSharingControls(true);
    await setOutgoing(source.stream);
    timer.start(0);
    stats.start();
    ui.nowPlayingInput.value = source.name || '';
    ui.filePlayBtn.textContent = 'مکث';
    ui.fileName.textContent = source.name || '';
    startSignalCheck();

    const relayFormat = await relayFormatReady;
    await api.setSharing(true, { relayFormat, source: source.kind });
    // A file names itself; a tab does not.
    if (source.name) api.setNowPlaying(source.name);
  }

  async function startSharing() {
    ui.hostStatus.textContent = 'منتظر انتخاب تب...';
    const source = await captureScreenAudio();
    if (source) await begin(source);
  }

  // Moving from one tab to another used to mean stopping and starting, which
  // tore down every peer connection and made each guest reconnect. Replacing
  // the sender's track keeps the same connections and the same session.
  async function switchSource() {
    if (!isSharing()) return;
    if (base && base.kind === 'file') { ui.fileInput.click(); return; }
    const source = await captureScreenAudio();
    if (source) await replaceBase(source);
  }

  async function replaceBase(source) {
    const previous = base;
    base = source;
    source.stream.getAudioTracks()[0].addEventListener('ended', () => { if (base === source) stopSharing(); });
    const micWasOn = !!mic;
    if (mic) await mixMicrophone(false);
    await setOutgoing(source.stream);
    if (micWasOn) await mixMicrophone(true);
    if (previous) previous.stop();
    showSharingControls(true);
    ui.fileName.textContent = source.name || '';
    ui.filePlayBtn.textContent = 'مکث';
    if (source.name) { ui.nowPlayingInput.value = source.name; api.setNowPlaying(source.name); }
    startSignalCheck();
    notices.showInfo('منبع صدا عوض شد. مهمان‌ها قطع نشدن.');
  }

  // Drops the capture and every connection without touching the UI, so both
  // "stop sharing" and "you are not the host any more" can reuse it.
  function teardownMedia() {
    clearInterval(signalTimer);
    if (mic) { mic.stream.getTracks().forEach((t) => t.stop()); mic.ctx.close(); mic = null; }
    ui.micToggle.checked = false;
    if (base) base.stop();
    base = null;
    outgoing = null;
    relayStream(null);
    for (const pc of peers.values()) pc.close();
    peers.clear();
    meter.stop();
    timer.stop();
    stats.stop();
  }

  function stopSharing() {
    if (!isSharing()) return;
    teardownMedia();
    showSharingControls(false);
    setStage(ui.hostStage, 'idle');
    ui.hostTitle.textContent = 'تو میزبان این اتاقی';
    ui.hostStatus.textContent = 'پخش متوقف شد. هر وقت خواستی دوباره شروع کن.';
    api.setSharing(false);
  }

  // -- signaling -----------------------------------------------------------

  async function handleOffer(guestId, offerSdp) {
    if (!isSharing()) return; // not sharing right now; ignore

    const existing = peers.get(guestId);
    if (existing) existing.close();

    const pc = new RTCPeerConnection(await rtcConfig);
    peers.set(guestId, pc);
    outgoing.getTracks().forEach((track) => pc.addTrack(track, outgoing));

    pc.onicecandidate = (e) => { if (e.candidate) api.signal(guestId, 'ice', e.candidate); };
    // Now that a guest leaving the room no longer closes their connection, the
    // connection itself has to say when it is really finished.
    pc.onconnectionstatechange = () => {
      if (peers.get(guestId) !== pc) return;
      if (DEAD_STATES.includes(pc.connectionState)) {
        pc.close();
        peers.delete(guestId);
      }
    };

    // An offer is another browser's text: one that does not parse costs that
    // guest their connection, never the host's page.
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      const answer = await pc.createAnswer();
      answer.sdp = quality.tuneOpus(answer.sdp);
      await pc.setLocalDescription(answer);
      await quality.applyTo(pc, guestId);
      api.signal(guestId, 'answer', answer.sdp);
    } catch (e) {
      pc.close();
      if (peers.get(guestId) === pc) peers.delete(guestId);
    }
  }

  function handleIce(guestId, candidate) {
    const pc = peers.get(guestId);
    if (pc && candidate) pc.addIceCandidate(candidate).catch(() => {});
  }

  // A guest asking to be sent less.
  function handleQualityRequest(guestId, cap) {
    if (!quality.rememberCap(guestId, cap)) return;
    const pc = peers.get(guestId);
    if (pc) quality.applyTo(pc, guestId);
  }

  function handlePeerLeft(guestId, force) {
    const pc = peers.get(guestId);
    if (!pc) return;
    // Membership is tracked over the event stream, but the audio does not
    // travel over it. A phone whose screen locks drops its stream within
    // seconds while the media path keeps playing perfectly — and closing the
    // connection here is what actually cut the audio a few seconds after the
    // screen went off. The connection's own state is the authority on whether
    // it is dead, unless we removed them on purpose (`force`).
    if (!force && ALIVE_STATES.includes(pc.connectionState)) return;
    pc.close();
    peers.delete(guestId);
    quality.forget(guestId);
  }

  // -- host-only controls --------------------------------------------------

  function submitNowPlaying() {
    api.setNowPlaying(ui.nowPlayingInput.value);
    ui.nowPlayingBtn.textContent = 'ثبت شد ✔';
    setTimeout(() => { ui.nowPlayingBtn.textContent = 'ثبت'; }, 1500);
  }

  function pushSettings() {
    api.updateSettings({
      locked: ui.lockToggle.checked,
      closeOnHostLeave: ui.closeOnLeaveToggle.checked,
      relayAllowed: !ui.directOnlyToggle.checked,
    });
  }

  ui.startShareBtn.addEventListener('click', startSharing);
  ui.switchSourceBtn.addEventListener('click', switchSource);
  ui.stopShareBtn.addEventListener('click', stopSharing);
  ui.nowPlayingBtn.addEventListener('click', submitNowPlaying);
  ui.nowPlayingInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNowPlaying(); });
  ui.lockToggle.addEventListener('change', pushSettings);
  ui.closeOnLeaveToggle.addEventListener('change', pushSettings);
  ui.directOnlyToggle.addEventListener('change', pushSettings);
  ui.micToggle.addEventListener('change', () => mixMicrophone(ui.micToggle.checked));

  ui.fileInput.addEventListener('change', async () => {
    const file = ui.fileInput.files && ui.fileInput.files[0];
    ui.fileInput.value = ''; // the same file again must fire `change` again
    if (!file) return;
    const source = await captureFile(file);
    if (!source) return;
    if (isSharing()) await replaceBase(source);
    else await begin(source);
  });

  ui.filePlayBtn.addEventListener('click', () => {
    if (!base || !base.element) return;
    const el = base.element;
    if (el.paused || el.ended) {
      if (el.ended) el.currentTime = 0;
      el.play().catch(() => {});
      ui.filePlayBtn.textContent = 'مکث';
    } else {
      el.pause();
      ui.filePlayBtn.textContent = 'ادامه';
    }
  });

  // The host's name goes into the link preview, so it is asked for next to
  // the invite rather than tucked away.
  let nameTimer = null;
  ui.hostNameInput.value = prefs.name();
  ui.hostNameInput.addEventListener('input', () => {
    prefs.setName(ui.hostNameInput.value);
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => api.setName(ui.hostNameInput.value), NAME_DEBOUNCE_MS);
  });

  ui.qualitySelect.value = quality.quality;
  ui.qualitySelect.addEventListener('change', () => {
    quality.quality = ui.qualitySelect.value;
    onQualityChange(quality.quality); // remembered for the next room

    for (const [guestId, pc] of peers) quality.applyTo(pc, guestId);
  });

  // The rehearsal opens by itself the first time; after a share has worked
  // once, it waits behind its summary line.
  ui.hostRehearsal.open = !prefs.sharedBefore();

  // A phone can only play a file of its own into the room; say so plainly
  // instead of offering a button that fails after a permission prompt.
  if (!canCaptureSystemAudio) {
    ui.fileShareLabel.classList.replace('btn-secondary', 'btn-primary');
    ui.fileShareText.textContent = 'یه فایل صوتی از گوشیت پخش کن';
    ui.hostPlatformNote.textContent = 'مرورگرهای گوشی اجازه نمی‌دن صدای اپ‌های دیگه (مثل اسپاتیفای) فرستاده بشه. یه فایل از گوشیت پخش کن، یا همین لینک رو روی کامپیوترت باز کن و از اونجا هرچی گوش می‌دی رو پخش کن.';
    show(ui.hostPlatformNote, true);
  }
  showSharingControls(false);

  return {
    peers,
    isSharing,
    handleOffer,
    handleIce,
    handleQualityRequest,
    handlePeerLeft,
    handleRelayDemand(count) {
      relayDemand = count || 0;
      if (relay) relay.setDemand(relayDemand);
    },

    applySettings(settings) {
      if (!settings) return;
      ui.lockToggle.checked = !!settings.locked;
      ui.closeOnLeaveToggle.checked = !!settings.closeOnHostLeave;
      if (typeof settings.relayAllowed === 'boolean') ui.directOnlyToggle.checked = !settings.relayAllowed;
    },

    // Our own name, once the room knows us: the link preview uses it.
    announceName() {
      if (ui.hostNameInput.value) api.setName(ui.hostNameInput.value);
    },

    // Taking the room over, from a hand-over or the previous host leaving.
    activate({ fresh = false } = {}) {
      if (!fresh) return;
      setStage(ui.hostStage, 'idle');
      ui.hostTitle.textContent = 'حالا تو میزبانی';
      ui.hostStatus.textContent = 'هنوز چیزی پخش نمی‌شه.';
      showSharingControls(false);
    },

    // Handing it to someone else: the media goes, the UI resets, and whoever
    // owns the page turns us back into a listener.
    deactivate() {
      teardownMedia();
      showSharingControls(false);
    },

    endRoom() { teardownMedia(); },
  };
}
