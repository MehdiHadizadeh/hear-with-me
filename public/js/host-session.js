// The host's half of a room: capturing audio and answering every guest.
//
// One RTCPeerConnection per guest, because each guest negotiates its own path
// and may ask for its own bitrate. The capture itself is a single stream that
// all of those senders share.

import { setStage, show } from './dom.js';

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

export function createHostSession({ ui, api, quality, meter, timer, rtcConfig, stats, onQualityChange = () => {} }) {
  const peers = new Map(); // guestClientId -> RTCPeerConnection
  let localStream = null;

  const isSharing = () => localStream !== null;

  // -- capture -------------------------------------------------------------

  // Hands back an audio-only stream, or null having already explained on the
  // stage what went wrong.
  async function captureAudio() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: MUSIC_AUDIO });
    } catch (e) {
      try {
        // Some browsers reject the constrained form outright; plain audio is
        // still far better than no sharing at all.
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } catch (e2) {
        setStage(ui.hostStage, isSharing() ? 'live' : 'error');
        if (!isSharing()) {
          ui.hostTitle.textContent = 'دسترسی به صدا داده نشد';
          ui.hostStatus.textContent = 'یا اشتراک رو لغو کردی، یا مرورگرت این قابلیت رو نداره — میزبان باید Chrome یا Edge روی دسکتاپ باشه.';
        }
        return null;
      }
    }

    // We only want audio — the browser forces a video track through this API
    // even for tab/audio-only sharing, so we drop it immediately.
    stream.getVideoTracks().forEach((t) => t.stop());
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      setStage(ui.hostStage, isSharing() ? 'live' : 'error');
      ui.hostTitle.textContent = isSharing() ? 'زنده — داری پخش می‌کنی' : 'این منبع صدا نداشت';
      ui.hostStatus.textContent = 'اون منبع صدا نداشت. دوباره امتحان کن و این بار حتماً تیک «Share tab audio» / «Share audio» رو بزن.';
      return null;
    }
    return new MediaStream(audioTracks);
  }

  function showSharingControls(sharing) {
    show(ui.startShareBtn, !sharing);
    show(ui.switchSourceBtn, sharing);
    show(ui.stopShareBtn, sharing);
    show(ui.hostLiveBox, sharing);
  }

  async function startSharing() {
    ui.hostStatus.textContent = 'منتظر انتخاب تب...';
    const stream = await captureAudio();
    if (!stream) return;

    localStream = stream;
    // The user can also stop it from the browser's own sharing bar.
    stream.getAudioTracks()[0].addEventListener('ended', () => stopSharing());

    showSharingControls(true);
    setStage(ui.hostStage, 'live');
    ui.hostTitle.textContent = 'زنده — داری پخش می‌کنی';
    ui.hostStatus.textContent = 'هرکی وارد اتاق بشه، خودکار وصل می‌شه.';

    // The host watches their own capture level: a flat meter here means the
    // "Share audio" box was never ticked, which is the most common way this
    // goes wrong and was invisible until a guest complained.
    meter.attach(localStream);
    timer.start(0);
    ui.nowPlayingInput.value = '';
    stats.start();

    await api.setSharing(true);
  }

  // Moving from one tab to another used to mean stopping and starting, which
  // tore down every peer connection and made each guest reconnect. Replacing
  // the sender's track keeps the same connections and the same session — from
  // the guest's side the music simply changes.
  async function switchSource() {
    if (!isSharing()) return;
    const previous = localStream;
    const stream = await captureAudio();
    if (!stream) return;

    const track = stream.getAudioTracks()[0];
    localStream = stream;
    track.addEventListener('ended', () => stopSharing());

    await Promise.all([...peers.values()].map(async (pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (sender && sender.replaceTrack) await sender.replaceTrack(track).catch(() => {});
    }));

    previous.getTracks().forEach((t) => t.stop());
    meter.attach(localStream);
    ui.hostStatus.textContent = 'منبع صدا عوض شد — مهمان‌ها قطع نشدن.';
  }

  // Drops the capture and every connection without touching the UI, so both
  // "stop sharing" and "you are not the host any more" can reuse it.
  function teardownMedia() {
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    for (const pc of peers.values()) pc.close();
    peers.clear();
    meter.stop();
    timer.stop();
    stats.stop();
  }

  function stopSharing() {
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
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

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

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    answer.sdp = quality.tuneOpus(answer.sdp);
    await pc.setLocalDescription(answer);
    await quality.applyTo(pc, guestId);
    api.signal(guestId, 'answer', answer.sdp);
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
    });
  }

  ui.startShareBtn.addEventListener('click', startSharing);
  ui.switchSourceBtn.addEventListener('click', switchSource);
  ui.stopShareBtn.addEventListener('click', stopSharing);
  ui.nowPlayingBtn.addEventListener('click', submitNowPlaying);
  ui.nowPlayingInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNowPlaying(); });
  ui.lockToggle.addEventListener('change', pushSettings);
  ui.closeOnLeaveToggle.addEventListener('change', pushSettings);

  ui.qualitySelect.value = quality.quality;
  ui.qualitySelect.addEventListener('change', () => {
    quality.quality = ui.qualitySelect.value;
    onQualityChange(quality.quality); // remembered for the next room

    for (const [guestId, pc] of peers) quality.applyTo(pc, guestId);
  });

  return {
    peers,
    isSharing,
    handleOffer,
    handleIce,
    handleQualityRequest,
    handlePeerLeft,

    applySettings(settings) {
      if (!settings) return;
      ui.lockToggle.checked = !!settings.locked;
      ui.closeOnLeaveToggle.checked = !!settings.closeOnHostLeave;
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
