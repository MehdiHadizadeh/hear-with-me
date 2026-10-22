// Cutting the host's encoded audio into pieces a listener can join between.
//
// Shared by both servers (the Node one and the Cloudflare Durable Object), so
// it touches nothing but Uint8Array: no Buffer, no streams.
//
// Why this exists: the screen-off path plays the host's audio as one endless
// HTTP response in a plain <audio> element — the way a phone plays internet
// radio, and the only way it keeps playing once the screen locks. A listener
// can arrive at any moment, so the server has to know where in the byte
// stream it is safe to start them.
//
//   aac  — ADTS frames. Every frame carries its own header, so a listener can
//          start at any frame. This is the format every phone plays, iPhone
//          included, and it is what the host sends whenever its browser can
//          encode it (WebCodecs AudioEncoder).
//   webm — the fallback for a browser without an AAC encoder: Opus in WebM
//          from MediaRecorder. A listener needs the file header first, then a
//          Cluster opened for them, so this one is parsed as EBML. iPhones
//          cannot play it.

export const RELAY_FORMATS = {
  aac: { contentType: 'audio/aac' },
  webm: { contentType: 'audio/webm' },
};

function concat(parts) {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// How much audio a listener who arrives mid-stream starts with. Less is lower
// latency; more is a smoother start on a jittery connection.
const DEFAULT_BACKLOG_MS = 1500;

// -- ADTS (AAC) ---------------------------------------------------------------

const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const ADTS_HEADER = 7;
const MAX_BUFFERED = 1 << 20; // a stream that never syncs is junk, not audio

function aacFramer({ backlogMs }) {
  let buffer = new Uint8Array(0);
  let recent = [];     // the newest frames, about backlogMs of them
  let frameMs = 1024 / 48; // updated from the first header seen

  const isSync = (b, i) => b[i] === 0xff && (b[i + 1] & 0xf6) === 0xf0;

  function push(bytes) {
    buffer = buffer.length ? concat([buffer, bytes]) : bytes;
    const frames = [];
    let pos = 0;
    while (pos + ADTS_HEADER <= buffer.length) {
      if (!isSync(buffer, pos)) { pos++; continue; } // resync after a lost chunk
      const length = ((buffer[pos + 3] & 0x03) << 11) | (buffer[pos + 4] << 3) | (buffer[pos + 5] >> 5);
      if (length < ADTS_HEADER) { pos++; continue; }
      if (pos + length > buffer.length) break; // the rest of it is still coming
      const rate = AAC_SAMPLE_RATES[(buffer[pos + 2] >> 2) & 0x0f];
      if (rate) frameMs = (1024 / rate) * 1000;
      frames.push(buffer.slice(pos, pos + length));
      pos += length;
    }
    buffer = buffer.subarray(pos);
    if (buffer.length > MAX_BUFFERED) buffer = new Uint8Array(0);

    recent.push(...frames);
    const keep = Math.max(1, Math.round(backlogMs / frameMs));
    if (recent.length > keep) recent = recent.slice(recent.length - keep);
    return frames;
  }

  return {
    push,
    // Any frame is a valid place to start.
    joinPrefix: () => concat(recent),
    reset() { buffer = new Uint8Array(0); recent = []; },
    // A new recording carries on as the same kind of stream: listeners keep
    // their connection through a source switch.
    restartsListeners: false,
  };
}

// -- WebM (Opus) --------------------------------------------------------------

const EBML = {
  SEGMENT: 0x18538067,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
};
const UNKNOWN_SIZE = -1;
const CLUSTER_OPEN = Uint8Array.of(0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

// An EBML variable-length integer: its byte length and value (with the length
// marker stripped for sizes, kept for ids).
function readVint(buf, pos, keepMarker) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { length, value: !keepMarker && allOnes ? UNKNOWN_SIZE : value };
}

function timecodeElement(ms) {
  const out = new Uint8Array(10);
  out[0] = EBML.TIMECODE;
  out[1] = 0x88; // payload of 8 bytes
  let v = Math.max(0, Math.round(ms));
  for (let i = 9; i >= 2; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  return out;
}

function webmFramer({ backlogMs }) {
  let buffer = new Uint8Array(0);
  let header = [];        // EBML + Segment opening + Info + Tracks
  let headerDone = false;
  let clusterTimecode = 0;
  let recent = [];        // [{ at, bytes }] blocks of the current cluster

  function remember(block) {
    const now = Date.now();
    recent.push({ at: now, bytes: block });
    while (recent.length && now - recent[0].at > backlogMs) recent.shift();
  }

  function push(bytes) {
    buffer = buffer.length ? concat([buffer, bytes]) : bytes;
    const units = [];
    let pos = 0;

    for (;;) {
      const id = readVint(buffer, pos, true);
      if (!id) break;
      const size = readVint(buffer, pos + id.length, false);
      if (!size) break;
      const headLength = id.length + size.length;

      // A live recorder writes Segment and Cluster with unknown size: step
      // into them rather than waiting for an end that never comes.
      if (id.value === EBML.SEGMENT && size.value === UNKNOWN_SIZE) {
        header.push(buffer.slice(pos, pos + headLength));
        pos += headLength;
        continue;
      }
      if (id.value === EBML.CLUSTER) {
        headerDone = true;
        recent = [];
        units.push(buffer.slice(pos, pos + headLength));
        pos += headLength;
        continue;
      }
      if (size.value === UNKNOWN_SIZE) break; // nothing we know how to skip
      const end = pos + headLength + size.value;
      if (end > buffer.length) break;
      const element = buffer.slice(pos, end);
      pos = end;

      if (!headerDone) { header.push(element); continue; }
      if (id.value === EBML.TIMECODE) {
        clusterTimecode = 0;
        for (let i = headLength; i < element.length; i++) clusterTimecode = clusterTimecode * 256 + element[i];
      } else if (id.value === EBML.SIMPLE_BLOCK || id.value === EBML.BLOCK_GROUP) {
        remember(element);
      }
      units.push(element);
    }

    buffer = buffer.subarray(pos);
    if (buffer.length > MAX_BUFFERED) buffer = new Uint8Array(0);
    return units;
  }

  return {
    push,
    // The header, a Cluster opened for this listener at the current
    // cluster's timecode, and the last moment of blocks. Null until the
    // recording has produced a header at all.
    joinPrefix: () => (headerDone
      ? concat([...header, CLUSTER_OPEN, timecodeElement(clusterTimecode), ...recent.map((r) => r.bytes)])
      : null),
    reset() { buffer = new Uint8Array(0); header = []; headerDone = false; clusterTimecode = 0; recent = []; },
    // A new MediaRecorder writes a new file header, which cannot be spliced
    // into the middle of the old file.
    restartsListeners: true,
  };
}

export function createFramer(format, { backlogMs = DEFAULT_BACKLOG_MS } = {}) {
  if (format === 'aac') return aacFramer({ backlogMs });
  if (format === 'webm') return webmFramer({ backlogMs });
  throw new Error(`unknown relay format: ${format}`);
}

// -- keeping each listener near live ------------------------------------------

// A listener whose connection slows down (a train, a weak signal) stops
// reading for a while. Everything sent meanwhile used to wait for them in a
// queue and play afterwards, in order — so every stall was added to their
// delay for good, until a guest was half a minute behind the host. Live audio
// that late is worth less than a gap, so a listener's queue holds this much
// and no more.
export const MAX_LISTENER_LAG_MS = 2500;

// `queue` is [{ bytes, at }], oldest first. Trims what is too old to be worth
// playing and returns true; or returns false when this listener has to start
// over instead — a WebM stream cannot lose pieces from its middle, but AAC can
// lose whole frames and play straight on.
export function keepFresh(queue, format, now = Date.now()) {
  if (!queue.length || now - queue[0].at <= MAX_LISTENER_LAG_MS) return true;
  if (format !== 'aac') return false;
  while (queue.length && now - queue[0].at > MAX_LISTENER_LAG_MS) queue.shift();
  return true;
}

// -- the relay itself -----------------------------------------------------------

// Listeners are `{ write(Uint8Array), end() }`. The servers wrap whatever they
// have — a Node response, a TransformStream writer — in that shape.
export function createRelay({ onDemandChange = () => {}, backlogMs, maxPending = 20 } = {}) {
  let format = null;
  let framer = null;
  let generation = null;
  let nextSeq = 0;
  let pending = new Map(); // seq -> bytes, for uploads that overtook each other
  const listeners = new Set();
  const waiting = new Set(); // listeners still owed their join prefix

  function endListeners() {
    for (const l of listeners) { try { l.end(); } catch (e) { /* gone */ } }
    listeners.clear();
    waiting.clear();
  }

  function deliver(units) {
    if (units.length) {
      for (const l of listeners) if (!waiting.has(l)) for (const u of units) l.write(u);
    }
    if (waiting.size) {
      const prefix = framer.joinPrefix();
      if (prefix) {
        for (const l of waiting) l.write(prefix);
        waiting.clear();
      }
    }
  }

  const relay = {
    get format() { return format; },
    get demand() { return listeners.size; },
    get listeners() { return listeners; },

    // The host says up front what it will send, so the page can tell an
    // iPhone that a WebM stream is not for it before it tries.
    setFormat(next) {
      if (next === format) return;
      const had = listeners.size;
      endListeners();
      format = RELAY_FORMATS[next] ? next : null;
      framer = format ? createFramer(format, { backlogMs }) : null;
      generation = null;
      nextSeq = 0;
      pending = new Map();
      if (had) onDemandChange(0);
    },

    // Chunks arrive as separate requests and can overtake each other on a
    // slow link. Order is restored here rather than by making the host wait
    // for each one, which would add a round trip of latency per chunk.
    // Generations are the encoder's start time: a straggler from an encoder
    // the host already replaced must not be mistaken for a newer one.
    push(gen, seq, bytes) {
      if (!framer) return 'no-format';
      if (generation !== null && gen < generation) return 'stale';
      if (gen !== generation) {
        const restarted = generation !== null;
        generation = gen;
        nextSeq = 0;
        pending = new Map();
        if (restarted && framer.restartsListeners) {
          framer.reset();
          endListeners(); // they reconnect and get the new header
        } else if (restarted) {
          // Same kind of stream, new encoder: drop any half-frame left over.
          framer.reset();
        }
      }
      if (seq < nextSeq) return 'duplicate';
      pending.set(seq, bytes);
      if (pending.size > maxPending) {
        // A chunk is lost for good. Skip ahead instead of stalling forever;
        // the framer resyncs on the next unit it recognises.
        nextSeq = Math.min(...pending.keys());
      }
      while (pending.has(nextSeq)) {
        const next = pending.get(nextSeq);
        pending.delete(nextSeq);
        nextSeq++;
        deliver(framer.push(next));
      }
      return null;
    },

    addListener(listener) {
      listeners.add(listener);
      const prefix = framer && framer.joinPrefix();
      if (prefix) listener.write(prefix);
      else waiting.add(listener);
      onDemandChange(listeners.size);
    },

    removeListener(listener) {
      waiting.delete(listener);
      if (!listeners.delete(listener)) return;
      onDemandChange(listeners.size);
    },

    // Sharing stopped, or the host changed: nothing left to listen to.
    stop() {
      const had = listeners.size;
      endListeners();
      format = null;
      framer = null;
      generation = null;
      nextSeq = 0;
      pending = new Map();
      if (had) onDemandChange(0);
    },
  };
  return relay;
}
