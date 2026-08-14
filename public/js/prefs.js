// Everything this browser remembers between rooms, and the only place that
// touches localStorage.
//
// Private mode throws on both read and write, so every access is guarded once
// here rather than in five try/catch blocks around the app.

const KEYS = {
  quality: 'hwm-quality',
  receiveCap: 'hwm-receive-cap',
  wakeLock: 'hwm-wakelock',
  name: 'hwm-name',
};

function read(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
}

export const prefs = {
  // One of BITRATES' keys; anything else means the stored value is stale.
  quality: (valid) => {
    const stored = read(KEYS.quality, 'high');
    return valid.includes(stored) ? stored : 'high';
  },
  setQuality: (value) => write(KEYS.quality, value),

  receiveCap: (valid) => {
    const stored = read(KEYS.receiveCap, 'auto');
    return valid.includes(stored) ? stored : 'auto';
  },
  setReceiveCap: (value) => write(KEYS.receiveCap, value),

  // On by default: keeping the screen awake costs battery, but so does a dead
  // stream the listener has to notice and fix.
  wakeLockWanted: () => read(KEYS.wakeLock, '1') !== '0',
  setWakeLockWanted: (on) => write(KEYS.wakeLock, on ? '1' : '0'),

  // The name belongs to the person, not the room: typed once, reused in every
  // room they open on this device.
  name: () => read(KEYS.name, ''),
  setName: (value) => write(KEYS.name, value),
};
