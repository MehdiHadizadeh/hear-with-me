// How late the sound arrives on each path, end to end, on this machine.
//
// The host's capture is replaced by an oscillator switched on at known
// moments; each guest listens to what its <audio> element plays and notes
// when the tone appears. Host and guests share one machine, so one clock.
// Network distance is not in these numbers — run it against a deployment
// with BASE=... for that.
//
//   node tools/measure-latency.mjs            (starts its own server)
//   BASE=https://... node tools/measure-latency.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PULSES = 8;
const GAP_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const waitForServer = (url) => new Promise((resolve, reject) => {
  const attempt = (n) => http.get(url, (res) => { res.resume(); resolve(); })
    .on('error', () => (n <= 0 ? reject(new Error('no server')) : setTimeout(() => attempt(n - 1), 300)));
  attempt(30);
});

// A capture that hums quietly (a real stream is never digital silence) and
// beeps on demand.
const HOST_CAPTURE = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    const gain = ctx.createGain();
    gain.gain.value = 0.03;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    window.__pulse = () => {
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(1, t);
      gain.gain.setValueAtTime(0.03, t + 0.3);
      return Date.now();
    };
    return dest.stream;
  };
};

// Started once the guest is live: notes each tone's onset, wall clock.
const LISTEN = async () => {
  const el = document.getElementById('remoteAudio');
  const ctx = new AudioContext();
  await ctx.resume();
  const an = ctx.createAnalyser();
  an.fftSize = 256;
  ctx.createMediaStreamSource(el.srcObject || el.captureStream()).connect(an);
  const data = new Float32Array(an.fftSize);
  window.__onsets = [];
  let loud = false;
  setInterval(() => {
    an.getFloatTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    if (!loud && peak > 0.4) { loud = true; window.__onsets.push(Date.now()); }
    if (loud && peak < 0.15) loud = false;
  }, 5);
};

let BASE = process.env.BASE;
let server = null;
if (!BASE) {
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: String(port) } });
}
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
try {
  await waitForServer(`${BASE}/`);
  const { roomId } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json();
  const open = async (query, init) => {
    const page = await (await browser.newContext()).newPage();
    if (init) await page.addInitScript(init);
    await page.goto(`${BASE}/r/${roomId}${query}`);
    return page;
  };
  const host = await open('', HOST_CAPTURE);
  await host.waitForSelector('#hostCard', { state: 'visible' });
  await host.click('#startShareBtn');
  await host.waitForFunction(() => typeof window.__pulse === 'function');

  const guests = { direct: await open('?mode=direct'), 'screen-off': await open('?mode=relay') };
  for (const page of Object.values(guests)) {
    await page.waitForFunction(() => document.getElementById('guestStatusTitle').textContent.includes('زنده'), null, { timeout: 30000 });
  }
  await sleep(4000); // past the relay's join backlog
  for (const page of Object.values(guests)) await page.evaluate(LISTEN);

  const sent = [];
  for (let i = 0; i < PULSES; i++) { sent.push(await host.evaluate(() => window.__pulse())); await sleep(GAP_MS); }

  for (const [label, page] of Object.entries(guests)) {
    const onsets = await page.evaluate(() => window.__onsets);
    const delays = sent
      .map((t) => onsets.find((o) => o >= t && o - t < GAP_MS))
      .map((o, i) => (o === undefined ? null : o - sent[i]))
      .filter((d) => d !== null)
      .sort((a, b) => a - b);
    const median = delays.length ? delays[Math.floor(delays.length / 2)] : null;
    console.log(`${label}: heard ${delays.length}/${PULSES} beeps · median ${median} ms · range ${delays[0]}–${delays[delays.length - 1]} ms`);
  }
} finally {
  await browser.close();
  if (server) server.kill();
}
