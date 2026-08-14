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
      '--no-sandbox',
    ],
  });

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
    const landing = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    await landing.goto(`${base}/`);
    await landing.waitForTimeout(1200); // let the wave field settle mid-drift
    await shot(landing, 'landing');

    // 2. The host, mid-session: live meter, a track label, a guest on the roster.
    const hostPage = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await hostPage.goto(`${base}/r/${roomId}`);
    await hostPage.waitForSelector('#hostCard', { state: 'visible' });
    await hostPage.click('#startShareBtn');
    await hostPage.waitForFunction(() => document.getElementById('stopShareBtn').style.display !== 'none');
    await hostPage.fill('#nowPlayingInput', 'Radiohead — Weird Fishes');
    await hostPage.click('#nowPlayingBtn');

    // 3. The guest, on the phone they are always holding.
    const guestPage = await (await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    })).newPage();
    await guestPage.goto(`${base}/r/${roomId}`);
    await guestPage.waitForSelector('#guestCard', { state: 'visible' });
    try { await guestPage.click('#enableAudioBtn', { timeout: 2000 }); } catch (e) { /* autoplay allowed */ }
    await guestPage.waitForFunction(
      () => document.getElementById('guestStatusTitle').textContent.includes('زنده'),
      { timeout: 15000 },
    );
    await guestPage.fill('#nameInput', 'سارا');
    await guestPage.dispatchEvent('#nameInput', 'blur');

    // A reaction, so the host shot shows the back channel doing its job.
    await guestPage.click('.reaction[data-kind="whatsthis"]');
    await wait(600);
    await shot(hostPage, 'host');

    await guestPage.evaluate(() => window.scrollTo(0, 0));
    await wait(400);
    await shot(guestPage, 'guest');
  } finally {
    await browser.close();
    server.kill();
  }
})();
