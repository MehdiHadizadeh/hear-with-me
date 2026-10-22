// The host's half of the screen-off path: encoding the shared sound and
// posting it to the server, but only while someone is listening that way.
//
// AAC first. Every phone plays an AAC stream in a plain <audio> element,
// iPhones included, and a listener can join it at any frame — so one format
// serves everyone. WebCodecs encodes it where the browser allows (desktop
// Chrome and Edge do); MediaRecorder's WebM/Opus is the fallback, which
// iPhones cannot play.
//
// Uploads are triggered by the encoder's own output, never by a timer: the
// host's tab is almost always in the background (they are looking at the
// music), and browsers slow background timers to a crawl.

const AAC = { codec: 'mp4a.40.2', bitrate: 128000, aac: { format: 'adts' } };
const WEBM_MIME = 'audio/webm;codecs=opus';
const WEBM_TIMESLICE_MS = 250;
const UPLOAD_EVERY_MS = 250;   // of audio, not of wall clock
const LINGER_MS = 15000;       // a guest reloading should not restart the encoder

// Decided once per page: which format this browser can produce.
export async function pickRelayFormat() {
  try {
    if (typeof AudioEncoder !== 'undefined' && typeof MediaStreamTrackProcessor !== 'undefined') {
      const { supported } = await AudioEncoder.isConfigSupported({ ...AAC, sampleRate: 48000, numberOfChannels: 2 });
      if (supported) return 'aac';
    }
  } catch (e) { /* fall through */ }
  if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(WEBM_MIME)) return 'webm';
  return null;
}

const concat = (parts) => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// One AAC encoding run over one track. Stops when told to or when the track
// ends.
function aacRun(track, upload) {
  const own = track.clone(); // the reader takes ownership of what it reads
  const reader = new MediaStreamTrackProcessor({ track: own }).readable.getReader();
  let encoder = null;
  let running = true;
  let batch = [];
  let batchMs = 0;
  let frameMs = 1024 / 48;

  function flush() {
    if (!batch.length) return;
    upload(concat(batch));
    batch = [];
    batchMs = 0;
  }

  async function configure(data) {
    const channels = Math.min(2, data.numberOfChannels);
    if (channels !== data.numberOfChannels) throw new Error('more than two channels');
    frameMs = (1024 / data.sampleRate) * 1000;
    encoder = new AudioEncoder({
      output(chunk) {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        batch.push(bytes);
        batchMs += frameMs;
        if (batchMs >= UPLOAD_EVERY_MS) flush();
      },
      error() { stop(); },
    });
    const config = { ...AAC, sampleRate: data.sampleRate, numberOfChannels: channels };
    // A steady byte rate keeps a phone's player from sitting seconds behind,
    // waiting for its read buffer to fill during a quiet passage.
    const constant = { ...config, bitrateMode: 'constant' };
    encoder.configure((await AudioEncoder.isConfigSupported(constant)).supported ? constant : config);
  }

  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !running) { if (value) value.close(); break; }
        if (!encoder) await configure(value);
        if (encoder.state === 'configured') encoder.encode(value);
        value.close();
      }
    } catch (e) { /* track ended or encoder refused: the run is over */ }
    stop();
  })();

  function stop() {
    if (!running) return;
    running = false;
    try { reader.cancel(); } catch (e) { /* done */ }
    own.stop();
    if (encoder && encoder.state === 'configured') {
      encoder.flush().then(flush, () => {}).finally(() => { try { encoder.close(); } catch (e) { /* closed */ } });
    }
  }
  return { stop };
}

function webmRun(stream, upload) {
  const recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()), {
    mimeType: WEBM_MIME,
    audioBitsPerSecond: 128000,
    audioBitrateMode: 'constant', // same reason as the AAC path
  });
  recorder.ondataavailable = async (e) => {
    if (e.data && e.data.size) upload(new Uint8Array(await e.data.arrayBuffer()));
  };
  recorder.start(WEBM_TIMESLICE_MS);
  return {
    stop() {
      recorder.ondataavailable = null; // its last chunk belongs to nobody now
      if (recorder.state !== 'inactive') recorder.stop();
    },
  };
}

export function createRelayEncoder({ api, format }) {
  let stream = null;
  let demand = 0;
  let run = null;
  let lingerTimer = null;
  let lastGeneration = 0;

  function start() {
    if (!format || run || !stream || !stream.getAudioTracks().length) return;
    // A generation is the encoder's start time and only ever grows, so the
    // server can tell a straggling chunk from a successor.
    const generation = Math.max(Date.now(), lastGeneration + 1);
    lastGeneration = generation;
    let seq = 0;
    const upload = (bytes) => api.uploadRelayChunk(generation, seq++, bytes);
    try {
      run = format === 'aac' ? aacRun(stream.getAudioTracks()[0], upload) : webmRun(stream, upload);
    } catch (e) {
      run = null;
    }
  }

  function stop() {
    clearTimeout(lingerTimer);
    if (run) run.stop();
    run = null;
  }

  function reconcile() {
    clearTimeout(lingerTimer);
    if (stream && demand > 0) { start(); return; }
    if (run) lingerTimer = setTimeout(stop, stream ? LINGER_MS : 0);
  }

  return {
    format,
    get running() { return !!run; },

    setDemand(count) { demand = count || 0; reconcile(); },

    // A new source means a new encoder run. For AAC the listeners do not
    // notice; for WebM the server restarts them on the new file header.
    setStream(next) {
      stop();
      stream = next;
      reconcile();
    },
  };
}
