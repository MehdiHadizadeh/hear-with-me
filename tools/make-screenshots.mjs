// Screenshots for the README, taken from the real app rather than a mockup.
//
// Dev-only, like make-assets.mjs: it starts the server on a free port, drives
// Chromium with a fake audio device (so the meter really moves and the room is
// really live), and writes PNGs into docs/.
//
//   npm install --no-save playwright && npx playwright install chromium
//   node tools/make-screenshots.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'docs');

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A steady, music-like signal for the meter to draw: forty tones spread from
// bass to treble, each swelling and fading at its own pace. The fake capture
// device only beeps now and then, which photographs as a flat meter and reads
// as "no sound". Written as a file because the page can play a file into the
// room, which is a real way to host.
function writeDemoTrack(name) {
  const rate = 48000;
  const seconds = 40;
  const tones = Array.from({ length: 40 }, (_, i) => ({
    freq: 80 * Math.pow(100, i / 39),
    weight: 1 - (i / 39) * 0.75,
    pace: 0.25 + ((i * 7) % 13) / 9,
    phase: (i * 2.399) % (Math.PI * 2),
  }));
  const samples = new Float32Array(rate * seconds);
  let peak = 0;
  for (let n = 0; n < samples.length; n++) {
    const t = n / rate;
    let v = 0;
    for (const tone of tones) {
      v += tone.weight * (0.55 + 0.45 * Math.sin(2 * Math.PI * tone.pace * t + tone.phase))
        * Math.sin(2 * Math.PI * tone.freq * t);
    }
    samples[n] = v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  const data = Buffer.alloc(samples.length * 4);
  for (let n = 0; n < samples.length; n++) {
    const v = Math.round((samples[n] / peak) * 0.8 * 32767);
    data.writeInt16LE(v, n * 4);
    data.writeInt16LE(v, n * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwm-shots-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const port = await freePort();
  const base = `http://localhost:${port}`;

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(port) },
  });

  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      // Resolves getDisplayMedia() instantly with a fake screen and tone,
      // bypassing the OS picker.
      '--auto-select-desktop-capture-source=Entire screen',
      '--enable-usermedia-screen-capturing',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });

  // The fake device beeps with silent gaps; a shot taken in a gap shows a flat
  // meter, which reads as "no sound". Wait for a bar that is really up.
  const waitForSound = (page, selector) => page.waitForFunction((sel) => [...document.querySelectorAll(sel)]
    .some((bar) => Number((/scaleY\(([\d.]+)\)/.exec(bar.style.transform) || [])[1]) > 0.45), selector, { timeout: 20000, polling: 50 })
    .catch(() => console.log(`note: no loud moment on ${selector}; shooting anyway`));

  const shot = async (page, name) => {
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`wrote docs/${name}.png`);
  };

  try {
    for (let i = 30; ; i--) {
      try { await fetch(`${base}/`); break; } catch (e) {
        if (i <= 0) throw new Error('server did not start');
        await wait(200);
      }
    }

    const { roomId } = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json();

    // 1. The landing page, on the desktop the host is always using.
    const landing = await (await browser.newContext({ viewport: { width: 1280, height: 780 }, colorScheme: 'dark' })).newPage();
    await landing.goto(`${base}/`);
    await landing.waitForTimeout(1200); // let the wave field settle mid-drift
    await shot(landing, 'landing');

    // 2. The host and the guest are both in the room before the sound starts.
    // The fake device's tone is only reliably there in the first seconds of a
    // share, so everything slow happens first and the shots are taken fast.
    const hostPage = await (await browser.newContext({ viewport: { width: 1280, height: 640 }, colorScheme: 'dark' })).newPage();
    await hostPage.goto(`${base}/r/${roomId}`);
    await hostPage.waitForSelector('#hostCard', { state: 'visible' });
    await hostPage.fill('#hostNameInput', 'مهدی');

    // The guest, on the phone they are always holding.
    const guestPage = await (await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: 'dark',
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    })).newPage();
    await guestPage.goto(`${base}/r/${roomId}`);
    await guestPage.waitForSelector('#guestCard', { state: 'visible' });
    // The name lives in the settings drawer, which stays shut in the shot.
    await guestPage.click('#guestDrawer > summary');
    await guestPage.fill('#nameInput', 'سارا');
    await guestPage.dispatchEvent('#nameInput', 'blur');
    await guestPage.click('#guestDrawer > summary');
    // A phone starts with one tap; a desktop page starts by itself.
    try { await guestPage.click('#listenBtn', { timeout: 2000 }); } catch (e) { /* no gate */ }

    // 3. Now the host shares, and the guest goes live by itself.
    await hostPage.setInputFiles('#fileInput', writeDemoTrack('Weird Fishes · Radiohead.wav'));
    await hostPage.waitForFunction(() => document.getElementById('stopShareBtn').style.display !== 'none');
    try { await guestPage.click('#enableAudioBtn', { timeout: 1500 }); } catch (e) { /* autoplay allowed */ }
    await guestPage.waitForFunction(
      () => document.getElementById('guestStatusTitle').textContent.includes('زنده'),
      { timeout: 15000 },
    );

    // A reaction, so the host shot shows the back channel doing its job.
    await guestPage.click('.reaction[data-kind="whatsthis"]');
    await wait(500);
    // Keep the question toast, drop the "arrived" one.
    await hostPage.evaluate(() => { const toasts = document.querySelectorAll('.toast'); if (toasts.length > 1) toasts[0].remove(); });
    await waitForSound(hostPage, '#hostMeter span');
    // The name field was typed into a moment ago; a focus ring in the shot looks like a mistake.
    await hostPage.evaluate(() => document.activeElement && document.activeElement.blur());
    await shot(hostPage, 'host');

    await guestPage.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#toasts').replaceChildren(); });
    await waitForSound(guestPage, '#guestMeter span');
    await shot(guestPage, 'guest');

  } finally {
    await browser.close();
    server.kill();
  }
})();
