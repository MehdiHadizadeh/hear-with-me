// The level meter, read from the audio's own spectrum.
//
// It works for every source — a Spotify tab, a local file, a native app
// captured as system audio — and needs no metadata, no permissions and no
// third-party service. A flat meter is the one honest signal that no sound is
// arriving, which is why it must never be faked.

const FFT_SIZE = 2048;
const FLOOR = 0.04;      // bars never collapse to nothing, or the row disappears
const SMOOTHING = 0.6;   // enough to stop flicker, not enough to lag the beat
const HIGH_BIN_RATIO = 0.6; // ~14kHz at 48kHz; above that is near-silent

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  // Browsers start the context suspended until a user gesture; every caller
  // here runs off a click, so this resolves in practice.
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

// A suspended AudioContext only resumes from inside a user-gesture handler.
// Ours is created in ontrack, which is not one, so on mobile the meter would
// sit flat forever without this.
export function resumeAudio() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

// Bars are spaced logarithmically, the way we hear pitch. A linear split puts
// almost all musical energy in the first few bars and leaves the rest
// permanently dead, which reads as "the meter doesn't respond".
function bandEdges(barCount, binCount) {
  const lowBin = 1;
  const highBin = Math.floor(binCount * HIGH_BIN_RATIO);
  const edges = [];
  for (let i = 0; i <= barCount; i++) {
    edges.push(Math.round(lowBin * Math.pow(highBin / lowBin, i / barCount)));
  }
  return edges;
}

export function createLevelMeter(container, barCount = 32) {
  const bars = [];
  for (let i = 0; i < barCount; i++) bars.push(container.appendChild(document.createElement('span')));
  const edges = bandEdges(barCount, FFT_SIZE / 2);

  let source = null;
  let analyser = null;
  let data = null;
  let frame = null;

  function draw() {
    frame = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(data);
    for (let i = 0; i < bars.length; i++) {
      const from = edges[i];
      const to = Math.max(from + 1, edges[i + 1]);
      let peak = 0;
      for (let j = from; j < to; j++) if (data[j] > peak) peak = data[j];
      bars[i].style.transform = `scaleY(${Math.max(FLOOR, peak / 255)})`;
    }
  }

  const meter = {
    attach(stream) {
      meter.stop();
      if (!stream || stream.getAudioTracks().length === 0) return;
      const ctx = getAudioContext();
      if (!ctx) return; // no Web Audio here; the rest of the app still works
      try {
        source = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = SMOOTHING;
        data = new Uint8Array(analyser.frequencyBinCount);
        source.connect(analyser); // analyser only: nothing is routed to output
        container.classList.remove('idle');
        draw();
      } catch (e) {
        meter.stop();
      }
    },

    isRunning() { return frame !== null; },

    stop() {
      if (frame) { cancelAnimationFrame(frame); frame = null; }
      if (source) { try { source.disconnect(); } catch (e) { /* already gone */ } source = null; }
      analyser = null;
      data = null;
      container.classList.add('idle');
      for (const bar of bars) bar.style.transform = `scaleY(${FLOOR})`;
    },
  };

  return meter;
}
