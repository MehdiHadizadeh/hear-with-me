// Tests for the reach work: the screen-off relay (framing and HTTP), the
// link preview, rate limits and the anonymous counters. No browser.
//
//   node test-reach.js
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFramer, createRelay } from './public/shared/relay-framing.js';
import { cleanMetric, minutesBucket } from './public/shared/metrics.js';
import { roomPreview } from './public/shared/preview.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An ADTS frame: MPEG-4 AAC LC, 48kHz, stereo, no CRC, `payload` bytes of
// filler after the 7-byte header. The filler is a marker byte so a test can
// tell frames apart.
function adts(marker, payload = 20) {
  const length = 7 + payload;
  const f = new Uint8Array(length);
  f[0] = 0xff;
  f[1] = 0xf1;
  f[2] = (1 << 6) | (3 << 2) | (2 >> 2); // LC, 48kHz, channel config high bit
  f[3] = ((2 & 3) << 6) | ((length >> 11) & 0x03);
  f[4] = (length >> 3) & 0xff;
  f[5] = ((length & 7) << 5) | 0x1f;
  f[6] = 0xfc;
  f.fill(marker, 7);
  return f;
}
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
const markersIn = (bytes) => { const out = []; let i = 0; while (i + 7 <= bytes.length) { const len = ((bytes[i + 3] & 3) << 11) | (bytes[i + 4] << 3) | (bytes[i + 5] >> 5); out.push(bytes[i + 7]); i += len; } return out; };

function testFraming() {
  console.log('\nAAC framing');
  const f = createFramer('aac', { backlogMs: 1000 });
  const two = cat(adts(1), adts(2));
  // Split mid-frame: the second half must wait for the rest.
  let frames = f.push(two.subarray(0, 40));
  check('a whole frame comes out, a partial one waits', frames.length === 1 && frames[0][7] === 1, frames.length);
  frames = f.push(two.subarray(40));
  check('the rest of the frame completes it', frames.length === 1 && frames[0][7] === 2, frames.length);
  frames = f.push(cat(Uint8Array.of(0x00, 0x13, 0x37), adts(3)));
  check('junk before a frame is skipped (resync)', frames.length === 1 && frames[0][7] === 3, frames.length);
  check('a late joiner starts with the recent frames', JSON.stringify(markersIn(f.joinPrefix())) === '[1,2,3]', markersIn(f.joinPrefix()));

  const g = createFramer('aac', { backlogMs: 100 }); // ~5 frames at 21.3ms
  for (let i = 0; i < 40; i++) g.push(adts(i));
  const kept = markersIn(g.joinPrefix());
  check('the backlog keeps only about backlogMs of audio', kept.length >= 4 && kept.length <= 6 && kept[kept.length - 1] === 39, kept);

  console.log('\nrelay ordering and listeners');
  const writes = [];
  const demand = [];
  const relay = createRelay({ onDemandChange: (n) => demand.push(n) });
  relay.setFormat('aac');
  const listener = { got: [], write(b) { this.got.push(...markersIn(b)); }, end() { this.ended = true; } };
  relay.addListener(listener);
  check('a listener raises the demand the host is told about', demand[demand.length - 1] === 1, demand);
  relay.push(100, 1, adts(11));
  relay.push(100, 0, adts(10)); // arrives late
  check('chunks that overtook each other are put back in order', JSON.stringify(listener.got) === '[10,11]', listener.got);
  check('a straggler from a replaced encoder is ignored', relay.push(50, 2, adts(99)) === 'stale');
  relay.push(200, 0, adts(20)); // a new encoder (source switch)
  check('an AAC listener survives the host switching source', !listener.ended && listener.got[listener.got.length - 1] === 20, listener.got);
  relay.removeListener(listener);
  check('removing the listener drops demand to zero', demand[demand.length - 1] === 0, demand);

  const webm = createRelay();
  webm.setFormat('webm');
  const w = { write() {}, end() { this.ended = true; } };
  webm.addListener(w);
  webm.push(1, 0, Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x80)); // an empty EBML header element
  webm.push(2, 0, Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x80));
  check('a WebM listener is restarted when the host restarts its recorder', w.ended === true);
  writes.length = 0;
}

function testSharedRules() {
  console.log('\nmetrics and preview rules');
  check('an unknown event is dropped', cleanMetric('free-text', {}) === null);
  const m = cleanMetric('listen-started', { path: 'relay', why: 'sql; drop', platform: 'ios', extra: 'x' });
  check('only known dimension values survive', JSON.stringify(m.props) === JSON.stringify({ path: 'relay', platform: 'ios' }), m.props);
  check('minutes bucket', minutesBucket(3 * 60000) === '1-5' && minutesBucket(90 * 60000) === '60+');
  const p = roomPreview({ isSharing: true, hostName: 'مهدی', nowPlaying: 'Radiohead' });
  check('a live room\'s preview names the host and the track', p.title.includes('مهدی') && p.description.includes('Radiohead'), p);
  check('an unnamed host is "someone", not blank', roomPreview({ isSharing: false, hostName: '' }).title.startsWith('یکی'));
}

// ---------------------------------------------------------------------------

const agent = new http.Agent({ keepAlive: false });
let BASE = null;

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body instanceof Uint8Array;
    const payload = body === undefined ? null : raw ? body : Buffer.from(JSON.stringify(body));
    const req = http.request(`${BASE}${p}`, {
      method,
      agent,
      headers: payload ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'Content-Length': payload.length, ...headers } : headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function join(roomId, clientId, secret) {
  const member = { clientId, secret, events: [] };
  member.ready = new Promise((resolve) => {
    member.req = http.get(`${BASE}/api/rooms/${roomId}/events?clientId=${clientId}&secret=${secret}`, { agent }, (res) => {
      res.on('data', (chunk) => {
        for (const frame of String(chunk).split('\n\n')) {
          const name = /^event: (.+)$/m.exec(frame);
          const data = /^data: (.+)$/m.exec(frame);
          if (name) member.events.push({ event: name[1], data: data ? JSON.parse(data[1]) : null });
        }
        if (member.events.length) resolve();
      });
      if (res.statusCode !== 200) resolve();
    });
  });
  member.last = (event) => [...member.events].reverse().find((e) => e.event === event);
  return member;
}

// Opens the relay stream and collects what arrives.
function listen(roomId, token) {
  const out = { status: null, type: null, bytes: [] };
  out.done = new Promise((resolve) => {
    out.req = http.get(`${BASE}/api/rooms/${roomId}/relay?t=${token}`, { agent }, (res) => {
      out.status = res.statusCode;
      out.type = res.headers['content-type'];
      res.on('data', (c) => out.bytes.push(...c));
      res.on('end', resolve);
      if (res.statusCode !== 200) res.resume();
    });
    out.req.on('error', resolve);
  });
  return out;
}

async function testRelayHttp() {
  console.log('\nrelay over HTTP');
  const { json: { roomId } } = await request('POST', '/api/rooms');
  const host = join(roomId, 'h1', 'hsecret');
  await host.ready;
  const guest = join(roomId, 'g1', 'gsecret');
  await guest.ready;

  let r = await request('POST', `/api/rooms/${roomId}/relay-token`, { clientId: 'g1', secret: 'gsecret' });
  check('no token while nothing is shared', r.status === 409, r.status);

  await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'h1', secret: 'hsecret', action: 'start', relayFormat: 'aac', source: 'tab' });
  await sleep(50);
  check('guests learn the relay format with the start of sharing', guest.last('sharing-started').data.relayFormat === 'aac', guest.last('sharing-started'));

  r = await request('POST', `/api/rooms/${roomId}/relay-token`, { clientId: 'g1', secret: 'wrong' });
  check('a token needs the member\'s secret', r.status === 403, r.status);
  r = await request('POST', `/api/rooms/${roomId}/relay-token`, { clientId: 'g1', secret: 'gsecret' });
  check('a member gets a token and the format', r.status === 200 && r.json.token && r.json.format === 'aac', r.json);
  const { token } = r.json;

  const bad = listen(roomId, 'not-a-token');
  await bad.done;
  check('the stream refuses a made-up token', bad.status === 403, bad.status);

  const up = (seq, frame, gen = 7) => request('POST', `/api/rooms/${roomId}/relay?gen=${gen}&seq=${seq}`, frame, { 'x-hwm-client': 'h1', 'x-hwm-secret': 'hsecret' });
  r = await request('POST', `/api/rooms/${roomId}/relay?gen=7&seq=0`, adts(1), { 'x-hwm-client': 'g1', 'x-hwm-secret': 'gsecret' });
  check('only the host may upload', r.status === 403, r.status);

  await up(0, adts(1));
  const one = listen(roomId, token);
  await sleep(80);
  check('the stream is served as AAC', one.status === 200 && /audio\/aac/.test(one.type), [one.status, one.type]);
  await sleep(40);
  check('the host is told someone is listening this way', host.last('relay-demand') && host.last('relay-demand').data.count === 1, host.last('relay-demand'));
  await up(1, adts(2));
  await up(2, adts(3));
  await sleep(80);
  check('the listener gets the backlog and then live frames', JSON.stringify(markersIn(Uint8Array.from(one.bytes))) === '[1,2,3]', markersIn(Uint8Array.from(one.bytes)));

  // The host keeps everyone on the direct path.
  await request('POST', `/api/rooms/${roomId}/settings`, { clientId: 'h1', secret: 'hsecret', relayAllowed: false });
  await one.done;
  check('turning the relay off ends the relay listeners', true);
  r = await request('POST', `/api/rooms/${roomId}/relay-token`, { clientId: 'g1', secret: 'gsecret' });
  check('and refuses new ones', r.status === 403 && r.json.error === 'relay-disabled', r.json);
  check('guests see the setting', guest.last('room-settings').data.relayAllowed === false, guest.last('room-settings'));

  await request('POST', `/api/rooms/${roomId}/settings`, { clientId: 'h1', secret: 'hsecret', relayAllowed: true });
  r = await request('POST', `/api/rooms/${roomId}/relay-token`, { clientId: 'g1', secret: 'gsecret' });
  const two = listen(roomId, r.json.token);
  await sleep(60);
  await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'h1', secret: 'hsecret', action: 'stop' });
  await two.done;
  check('stopping the share ends the stream', two.status === 200);
  const late = listen(roomId, r.json.token);
  await late.done;
  check('tokens die with the share', late.status === 403, late.status);

  host.req.destroy();
  guest.req.destroy();
}

// The Android app hosts through the relay alone: guests must be told there is
// no direct path, and "direct only" cannot be left on, or nobody hears.
async function testRelayOnlyHost() {
  console.log('\nrelay-only host (the Android app)');
  const { json: { roomId } } = await request('POST', '/api/rooms');
  const host = join(roomId, 'h3', 's3');
  await host.ready;
  await request('POST', `/api/rooms/${roomId}/settings`, { clientId: 'h3', secret: 's3', relayAllowed: false });
  const guest = join(roomId, 'g3', 't3');
  await guest.ready;
  await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'h3', secret: 's3', action: 'start', relayFormat: 'aac', source: 'app', direct: false });
  await sleep(60);
  const started = guest.last('sharing-started');
  check('guests are told there is no direct path', started && started.data.directAvailable === false && started.data.shareSource === 'app', started && started.data);
  check('a relay-only share switches "direct only" back off', guest.last('room-settings') && guest.last('room-settings').data.relayAllowed === true, guest.last('room-settings'));
  const r = await request('POST', `/api/rooms/${roomId}/relay-token`, { clientId: 'g3', secret: 't3' });
  check('and the relay takes listeners', r.status === 200 && r.json.token, r.status);
  const late = join(roomId, 'g4', 't4');
  await late.ready;
  check('a late joiner\'s welcome says relay-only too', late.events[0].data.directAvailable === false, late.events[0].data);
  await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'h3', secret: 's3', action: 'stop' });
  await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'h3', secret: 's3', action: 'start', relayFormat: 'aac', source: 'tab' });
  await sleep(60);
  check('the next ordinary share offers the direct path again', guest.last('sharing-started').data.directAvailable === true);
  for (const m of [host, guest, late]) m.req.destroy();
}

async function testPreviewAndInfo() {
  console.log('\nlink preview');
  const { json: { roomId } } = await request('POST', '/api/rooms');
  const host = join(roomId, 'h2', 's2');
  await host.ready;
  await request('POST', `/api/rooms/${roomId}/name`, { clientId: 'h2', secret: 's2', name: 'مهدی <b>' });
  await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'h2', secret: 's2', action: 'start', source: 'tab' });
  await request('POST', `/api/rooms/${roomId}/now-playing`, { clientId: 'h2', secret: 's2', text: 'Weird Fishes "live"' });
  const page = await request('GET', `/r/${roomId}`);
  const title = /property="og:title" content="([^"]*)"/.exec(page.text);
  const desc = /property="og:description" content="([^"]*)"/.exec(page.text);
  check('the room page previews the host by name', title && title[1].includes('مهدی') && title[1].includes('زنده'), title && title[1]);
  check('host-typed text is escaped in the page', title && !title[1].includes('<b>') && desc && desc[1].includes('&quot;live&quot;'), [title && title[1], desc && desc[1]]);
  const info = await request('GET', `/api/rooms/${roomId}`);
  check('room info carries the host name for the page', info.json.hostName === 'مهدی <b>' && info.json.nowPlaying.startsWith('Weird'), info.json);
  const missing = await request('GET', '/r/ZZZZZZ');
  check('an unknown room still gets the general preview', missing.status === 200 && /og:title" content="Hear With Me/.test(missing.text));
  host.req.destroy();
}

async function testMetricsAndLimits() {
  console.log('\ncounters and limits');
  let r = await request('POST', '/api/metrics', { event: 'listen-started', props: { path: 'relay', why: 'default', platform: 'ios' } });
  check('a known event is accepted', r.status === 200, r.status);
  await request('POST', '/api/metrics', { event: 'anything', props: { note: 'free text' } });
  r = await request('GET', '/api/stats?token=wrong');
  check('the counters are not public', r.status === 403, r.status);
  r = await request('GET', '/api/stats?token=letmein');
  const day = r.json && Object.values(r.json.days)[0];
  check('the counters add up, by dimension', day && day['listen-started'] === 1 && day['listen-started|path=relay'] === 1 && day['room-created'] >= 1, day);
  check('nothing outside the allowlist was stored', day && !Object.keys(day).some((k) => k.includes('anything') || k.includes('free')), day && Object.keys(day));

  let limited = 0;
  for (let i = 0; i < 12; i++) {
    const res = await request('GET', '/api/rooms/ZZZZZZ');
    if (res.status === 429) limited++;
  }
  check('looking up codes over and over is rate limited', limited > 0, limited);
}

(async () => {
  testFraming();
  testSharedRules();

  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  BASE = `http://localhost:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: HERE,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(port), STATS_TOKEN: 'letmein', ROOM_LOOKUPS_PER_MINUTE: '8', ROOMS_PER_IP: '1000' },
  });
  try {
    for (let i = 30; ; i--) {
      try { await request('GET', '/'); break; } catch (e) { if (i <= 0) throw e; await sleep(200); }
    }
    await testRelayHttp();
    await testRelayOnlyHost();
    await testPreviewAndInfo();
    await testMetricsAndLimits();
  } catch (e) {
    failed++;
    console.error('harness error:', e);
  } finally {
    server.kill();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
