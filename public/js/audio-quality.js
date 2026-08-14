// What the audio is allowed to cost, and how that gets onto the wire.
//
// Two dials meet here. The host picks the ceiling for the room; each guest may
// ask for less than that for their own stream. `min` of the two is what any
// one connection is allowed — the upload bandwidth is the host's, so the
// host's choice wins wherever they disagree.

// WebRTC negotiates Opus for a phone call by default: mono, roughly 32kbps,
// discontinuous transmission that cuts quiet passages. That is the right trade
// for speech and the wrong one for music, so both sides advertise stereo and a
// music-grade bitrate.
export const BITRATES = { high: 256000, normal: 128000, low: 64000 };
export const RECEIVE_CAPS = { auto: null, mid: 128000, low: 64000 };

// A cap arriving over signaling is data from another browser: bound it before
// it reaches the encoder.
const MIN_CAP = 16000;
const MAX_CAP = 512000;

export function createQualityPolicy(initialQuality) {
  let quality = BITRATES[initialQuality] ? initialQuality : 'high';
  const caps = new Map(); // guestClientId -> the ceiling that guest asked for

  const target = () => BITRATES[quality];

  const opusParams = () => ({
    stereo: '1',
    'sprop-stereo': '1',
    maxaveragebitrate: String(target()),
    maxplaybackrate: '48000',
    useinbandfec: '1',
    usedtx: '0', // never drop quiet passages; silence is part of the music
  });

  return {
    get quality() { return quality; },
    set quality(value) { quality = BITRATES[value] ? value : 'high'; },

    bitrateFor(guestId) {
      const cap = caps.get(guestId);
      return cap ? Math.min(target(), cap) : target();
    },

    // Remembered per guest, so it survives that guest reconnecting and getting
    // a brand new peer connection.
    rememberCap(guestId, cap) {
      if (cap === null || cap === undefined) { caps.delete(guestId); return true; }
      if (typeof cap !== 'number' || cap < MIN_CAP || cap > MAX_CAP) return false;
      caps.set(guestId, cap);
      return true;
    },

    forget(guestId) { caps.delete(guestId); },

    // The fmtp line is what the *receiver* will accept.
    tuneOpus(sdp) {
      const rtpmap = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
      if (!rtpmap) return sdp;
      const pt = rtpmap[1];

      const existing = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`).exec(sdp);
      const params = new Map();
      if (existing) {
        for (const pair of existing[1].split(';')) {
          const [k, v] = pair.split('=');
          if (k && k.trim()) params.set(k.trim(), v);
        }
      }
      for (const [k, v] of Object.entries(opusParams())) params.set(k, v);

      const line = `a=fmtp:${pt} ${[...params].map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(';')}`;
      return existing
        ? sdp.replace(new RegExp(`a=fmtp:${pt} [^\\r\\n]*`), line)
        : sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000/2[^\\r\\n]*\\r?\\n)`, 'i'), `$1${line}\r\n`);
    },

    // ...and the sender still has to be allowed to spend the bitrate. Also runs
    // when either side changes quality mid-session: the encoder honours a new
    // maxBitrate immediately, with no renegotiation and no gap in the audio.
    async applyTo(pc, guestId) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (!sender || !sender.getParameters) return;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = this.bitrateFor(guestId);
        params.encodings[0].networkPriority = 'high';
        await sender.setParameters(params);
      } catch (e) { /* older browsers: keep the negotiated default */ }
    },
  };
}
