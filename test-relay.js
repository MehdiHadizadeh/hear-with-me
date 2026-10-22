// End-to-end checks for the reach work, in real browsers:
//   - the screen-off path (AAC through the server into a plain <audio>)
//   - falling back to it when a direct connection never comes up
//   - the host's "direct only" switch
//   - the phone's first tap and its default
//   - hosting from a file, mixing in the microphone, the signal check
//   - the end card
//
//   npm install --no-save playwright && npx playwright install chromium
//   node test-relay.js
//
// What a desktop browser cannot show is that a locked phone keeps playing.
// That needs a real phone; see README.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const pass = (msg) => console.log(`PASS: ${msg}`);
const fail = (msg) => { failures++; console.log(`FAIL: ${msg}`); };
const check = (ok, msg) => (ok ? pass(msg) : fail(msg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Polls `test` until it is true or `ms` runs out; true if it ever was.
const until = async (test, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    try { if (await test()) return true; } catch (e) { /* not yet */ }
  }
  return false;
};

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
// fetch, not http.get: BASE may be an https deployment.
const waitForServer = async (url) => {
  for (let i = 30; ; i--) {
    try { await fetch(url); return; } catch (e) { if (i <= 0) throw new Error('server did not start'); await sleep(300); }
  }
};

// A few seconds of a loud tone, as a file the host can pick.
function toneWav(seconds = 30) {
  const rate = 48000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.6 * 32767);
    buf.writeInt16LE(v, 44 + i * 4);
    buf.writeInt16LE(v, 46 + i * 4);
  }
  const file = path.join(os.tmpdir(), `hwm-tone-${process.pid}.wav`);
  fs.writeFileSync(file, buf);
  return file;
}

// What a guest's <audio> element is doing, and how loud what it plays is —
// measured on a fresh tap of the element, which headless Chromium reports
// reliably once playback is under way.
async function probe(page) {
  return page.evaluate(async () => {
    const el = document.getElementById('remoteAudio');
    let peak = null;
    try {
      const ctx = new AudioContext();
      await ctx.resume();
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      ctx.createMediaStreamSource(el.srcObject || el.captureStream()).connect(an);
      const data = new Float32Array(an.fftSize);
      peak = 0;
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 100));
        an.getFloatTimeDomainData(data);
        for (const v of data) peak = Math.max(peak, Math.abs(v));
      }
      ctx.close();
    } catch (e) { peak = `error: ${e.message}`; }
    return {
      path: el.srcObject ? 'direct' : (el.getAttribute('src') || '').includes('/relay?t=') ? 'relay' : 'none',
      paused: el.paused,
      t: el.currentTime,
      title: document.getElementById('guestStatusTitle').textContent,
      chip: document.getElementById('pathChip').dataset.path,
      peak,
    };
  });
}
const loud = (p) => typeof p.peak === 'number' && p.peak > 0.05;
const waitLive = (page, ms = 20000) => page.waitForFunction(
  () => document.getElementById('guestStatusTitle').textContent.includes('زنده'), null, { timeout: ms },
).then(() => true, () => false);

(async () => {
  // BASE=http://127.0.0.1:8787 runs the same checks against another server
  // (the Cloudflare edition under `wrangler dev`, with STATS_TOKEN=t).
  let BASE = process.env.BASE;
  let server = null;
  if (!BASE) {
    const PORT = await freePort();
    BASE = `http://localhost:${PORT}`;
    server = spawn(process.execPath, ['server.js'], {
      cwd: HERE, stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, PORT: String(PORT), DISCONNECT_GRACE_MS: '800', STATS_TOKEN: 't' },
    });
  }
  const browser = await chromium.launch({
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--enable-usermedia-screen-capturing',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });
  const wav = toneWav();

  const open = async (url, { mobile = false, init } = {}) => {
    const context = await browser.newContext(mobile ? { ...devices['Pixel 7'] } : {});
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    if (init) await page.addInitScript(init);
    await page.goto(url);
    return page;
  };

  try {
    await waitForServer(`${BASE}/`);
    const newRoom = async () => (await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json()).roomId;

    // -- a host sharing a tab, proven live by the signal check ---------------
    const roomId = await newRoom();
    const host = await open(`${BASE}/r/${roomId}?debug=1`);
    await host.waitForSelector('#hostCard', { state: 'visible' });
    await host.fill('#hostNameInput', 'مهدی');
    await host.click('#startShareBtn');
    const hostLive = await host.waitForFunction(() => document.getElementById('hostTitle').textContent.includes('زنده'), null, { timeout: 15000 }).then(() => true, () => false);
    check(hostLive, 'the host is called live only once the signal check heard sound');

    // Polled rather than read once: over a real network the host's name can
    // arrive a couple of seconds after the share does.
    const previewOk = await until(async () => /og:title" content="مهدی داره زنده پخش می‌کنه"/.test(await (await fetch(`${BASE}/r/${roomId}`)).text()));
    check(previewOk, 'the link preview names the host and says it is live');

    // -- desktop guest choosing the screen-off path ------------------------
    const g1 = await open(`${BASE}/r/${roomId}?mode=relay`);
    check(await waitLive(g1), 'a guest on the screen-off path goes live');
    await sleep(2500);
    const p1 = await probe(g1);
    console.log('  relay guest:', JSON.stringify(p1));
    check(p1.path === 'relay' && p1.chip === 'relay' && !p1.paused, 'it is playing the relay stream, and its chip says so');
    check(loud(p1), `real sound arrives through the relay (peak ${p1.peak})`);
    const who = await g1.textContent('#guestWho');
    check(who.includes('مهدی'), `the guest page leads with who is playing ("${who}")`);
    const format = await g1.evaluate(async () => {
      const src = document.getElementById('remoteAudio').getAttribute('src');
      const res = await fetch(src, { method: 'HEAD' });
      return res.headers.get('content-type');
    }).catch(() => null);
    // AAC wherever the host's browser can encode it (desktop Chrome and Edge);
    // a browser build without that encoder (Chromium on Linux CI) falls back
    // to WebM, and that fallback is what is checked there.
    const canAac = await host.evaluate(async () => {
      try {
        return (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000, aac: { format: 'adts' } })).supported;
      } catch (e) { return false; }
    });
    check(format === null || (canAac ? /audio\/aac/.test(format) : /audio\/webm/.test(format)),
      `the stream is ${canAac ? 'AAC, which iPhones play' : 'the WebM fallback (this browser cannot encode AAC)'} (${format})`);

    // -- a direct connection that never comes up falls back to the relay ---
    const neverConnects = () => {
      // A peer connection that sits in "new" forever: what blocked UDP looks
      // like from the page.
      window.RTCPeerConnection = class {
        constructor() { this.connectionState = 'new'; }
        addTransceiver() {}
        createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0\r\n' }); }
        setLocalDescription() { return Promise.resolve(); }
        setRemoteDescription() { return Promise.resolve(); }
        addIceCandidate() { return Promise.resolve(); }
        getStats() { return Promise.resolve(new Map()); }
        close() {}
      };
    };
    const g2 = await open(`${BASE}/r/${roomId}`, { init: neverConnects });
    check(await waitLive(g2, 25000), 'a guest whose direct connection never comes up still goes live');
    const p2 = await probe(g2);
    check(p2.path === 'relay' && loud(p2), 'it fell back to the relay and hears sound');
    const fallbackNote = await g2.textContent('#noticeText');
    check(fallbackNote.includes('اتصال مستقیم برقرار نشد'), 'and it says why, with the VPN hint');

    // -- a phone: the first tap, and screen-off by default -----------------
    const phone = await open(`${BASE}/r/${roomId}`, { mobile: true });
    await phone.waitForSelector('#listenGate', { state: 'visible', timeout: 10000 });
    const relayDefault = await phone.getAttribute('#modeRelay', 'aria-checked');
    check(relayDefault === 'true', 'a phone is offered the screen-off path by default');
    await phone.click('#listenBtn');
    check(await waitLive(phone), 'one tap and the phone is live');
    const pp = await probe(phone);
    check(pp.path === 'relay', 'the phone listens on the screen-off path');
    const reactionsOn = await phone.isEnabled('.reaction[data-kind="love"]');
    check(reactionsOn, 'reactions switch on once live');

    // -- the host keeps everyone direct -------------------------------------
    await host.click('#roomSettings > summary');
    await host.check('#directOnlyToggle');
    const movedDirect = await until(async () => g1.evaluate(() => !!document.getElementById('remoteAudio').srcObject
      && document.getElementById('guestStatusTitle').textContent.includes('زنده')), 25000);
    const pd = await probe(g1);
    check(movedDirect && pd.path === 'direct' && loud(pd), 'turning "direct only" on moves relay listeners to the direct path');
    await host.uncheck('#directOnlyToggle');

    // -- the microphone mixed in, and the guests keep their audio -----------
    await host.check('#micToggle');
    await sleep(2000);
    await until(async () => g1.evaluate(() => document.getElementById('guestStatusTitle').textContent.includes('زنده')), 15000);
    const pm = await probe(g1);
    check(loud(pm), 'mixing the microphone in keeps the guest\'s audio');
    await host.uncheck('#micToggle');

    // -- the end card ---------------------------------------------------------
    await sleep(Math.max(0, 21000 - 2000));
    await host.click('#stopShareBtn');
    const endShown = await g1.waitForSelector('#endCard', { state: 'visible', timeout: 5000 }).then(() => true, () => false);
    check(endShown, 'when the share ends, a guest who listened gets the end card');
    const endText = endShown ? await g1.textContent('#endTitle') : '';
    check(endText.includes('مهدی'), 'the end card names whose computer the sound came from');

    // -- hosting from a file (what a phone can do) ---------------------------
    const fileRoom = await newRoom();
    const fileHost = await open(`${BASE}/r/${fileRoom}`, { mobile: true });
    await fileHost.waitForSelector('#hostCard', { state: 'visible' });
    const startHidden = !(await fileHost.isVisible('#startShareBtn'));
    check(startHidden, 'a phone host is not offered tab capture it cannot do');
    await fileHost.setInputFiles('#fileInput', wav);
    const fileLive = await fileHost.waitForFunction(() => document.getElementById('hostTitle').textContent.includes('زنده'), null, { timeout: 15000 }).then(() => true, () => false);
    check(fileLive, 'a phone host plays a file into the room and goes live');
    const fileGuest = await open(`${BASE}/r/${fileRoom}`);
    check(await waitLive(fileGuest), 'a guest hears the file-hosted room');
    const pf = await probe(fileGuest);
    check(loud(pf), `the file's tone arrives (peak ${pf.peak})`);
    const np = await fileGuest.textContent('#guestNowPlaying');
    check(np.includes('hwm-tone'), 'the file names itself as what is playing');

    // -- the counters saw all of it ------------------------------------------
    // Readable only where STATS_TOKEN=t (the servers this test starts, and
    // `wrangler dev` with .dev.vars); a deployment keeps its counters private.
    const statsRes = await fetch(`${BASE}/api/stats?token=${process.env.STATS_TOKEN || 't'}`);
    if (statsRes.status === 403) {
      console.log('NOTE: counters are not readable on this deployment; skipped');
    } else {
      const stats = await statsRes.json();
      const day = Object.values(stats.days).pop() || {};
      console.log('  counters:', JSON.stringify(day));
      check(day['listen-started|path=relay'] >= 2 && day['listen-started|why=fallback'] >= 1, 'the counters recorded relay listens and the fallback');
      check(day['share-started|source=file'] >= 1, 'and the file-hosted share');
    }
  } catch (e) {
    fail(`threw: ${e.stack}`);
  } finally {
    await browser.close();
    if (server) server.kill();
    fs.rmSync(wav, { force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
  }
})();
