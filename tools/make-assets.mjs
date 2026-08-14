// Renders the brand's raster assets — link-preview images and icons — from the
// same fonts, colours and mark the site itself uses, so they can never drift
// from the CSS. Dev-only: the app ships the PNGs, not this script.
//
//   npm install --no-save playwright && npx playwright install chromium
//   node tools/make-assets.mjs
//
// Everything is drawn against a real running server so /style.css and
// /fonts/Vazirmatn.woff2 resolve exactly as they do in the browser.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const PORT = 3199;
const BASE = `http://localhost:${PORT}`;

const MARK = (size, stroke = 4.6) => `
  <svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true">
    <defs>
      <linearGradient id="a" x1="4" y1="20" x2="42" y2="20" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#2FD4B2"/><stop offset="1" stop-color="#6FE9CE"/>
      </linearGradient>
      <linearGradient id="b" x1="4" y1="29" x2="42" y2="29" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#7B69FF"/><stop offset="1" stop-color="#A99CFF"/>
      </linearGradient>
    </defs>
    <g fill="none" stroke-width="${stroke}" stroke-linecap="round">
      <path d="M4 20C10.3 8 16.7 8 23 20C29.3 32 35.7 32 42 20" stroke="url(#a)"/>
      <path d="M4 29C10.3 17 16.7 17 23 29C29.3 41 35.7 41 42 29" stroke="url(#b)"/>
    </g>
  </svg>`;

// One period of the mark's wave, repeated — the same curve as logo.svg.
const wavePath = (mid) => {
  let d = `M0 ${mid}`;
  for (let x = 0; x < 1600; x += 400) {
    d += `C${x + 66.7} ${mid - 45.3} ${x + 133.3} ${mid - 45.3} ${x + 200} ${mid}`;
    d += `C${x + 266.7} ${mid + 45.3} ${x + 333.3} ${mid + 45.3} ${x + 400} ${mid}`;
  }
  return d;
};

const ogPage = ({ eyebrow, title, sub }) => `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8">
<link rel="stylesheet" href="${BASE}/style.css">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body {
    background:
      radial-gradient(90% 120% at 78% 0%, rgba(63,224,190,.14), transparent 55%),
      radial-gradient(70% 100% at 8% 100%, rgba(140,124,255,.15), transparent 60%),
      #070910;
    display: flex; flex-direction: column; justify-content: center;
    padding: 0 84px; position: relative;
  }
  .waves { position: absolute; inset: 0; opacity: .62;
    -webkit-mask-image: linear-gradient(to right, #000 10%, rgba(0,0,0,.55) 45%, rgba(0,0,0,.12) 100%); }
  .waves svg { width: 100%; height: 100%; }
  .waves path { fill: none; stroke-width: 3.4; stroke-linecap: round; }
  .lockup { position: absolute; top: 56px; right: 84px; direction: ltr;
    display: flex; align-items: center; gap: 16px; }
  .lockup .name { font-size: 40px; font-weight: 700; letter-spacing: -.02em; direction: ltr; line-height: 1; }
  .eyebrow {
    position: relative; display: inline-flex; align-items: center; gap: 10px; align-self: flex-start;
    font-size: 21px; font-weight: 600; color: #3FE0BE;
    border: 1px solid rgba(63,224,190,.32); border-radius: 999px; padding: 8px 20px; margin-bottom: 26px;
  }
  .eyebrow i { width: 10px; height: 10px; border-radius: 50%; background: #3FE0BE; }
  h1 { position: relative; font-size: 64px; line-height: 1.3; font-weight: 800; letter-spacing: -.03em; margin: 0 0 24px; max-width: 26ch; text-wrap: balance; }
  p { position: relative; font-size: 27px; color: #9BA5C0; margin: 0; max-width: 34ch; line-height: 1.55; }
</style></head><body>
  <div class="waves"><svg viewBox="0 0 1600 300" preserveAspectRatio="xMidYMid slice">
    <path d="${wavePath(120)}" stroke="#3FE0BE" opacity=".6"/>
    <path d="${wavePath(168)}" stroke="#8C7CFF" opacity=".55"/>
  </svg></div>
  <div class="lockup">${MARK(58)}<span class="name">Hear With Me</span></div>
  ${eyebrow ? `<span class="eyebrow"><i></i>${eyebrow}</span>` : ''}
  <h1>${title}</h1>
  <p>${sub}</p>
</body></html>`;

const iconPage = (size) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${size}px; height: ${size}px; }
  img { display: block; width: ${size}px; height: ${size}px; }
</style></head><body><img src="${BASE}/favicon.svg"></body></html>`;

function waitForServer(tries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(BASE + '/', (res) => { res.resume(); resolve(); })
        .on('error', () => (n <= 0 ? reject(new Error('server did not start')) : setTimeout(() => attempt(n - 1), 250)));
    };
    attempt(tries);
  });
}

// A .ico may simply wrap a PNG — no BMP encoding needed for a 32px icon.
function pngToIco(pngPath, icoPath) {
  const png = fs.readFileSync(pngPath);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type: icon
  header.writeUInt16LE(1, 4);   // one image
  header.writeUInt8(32, 6);     // width
  header.writeUInt8(32, 7);     // height
  header.writeUInt8(0, 8);      // palette size (0 = truecolour)
  header.writeUInt8(0, 9);      // reserved
  header.writeUInt16LE(1, 10);  // colour planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18); // offset of the image data
  fs.writeFileSync(icoPath, Buffer.concat([header, png]));
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: String(PORT) },
});

try {
  await waitForServer();
  const browser = await chromium.launch();

  const shoot = async (html, out, width, height, scale = 1) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(PUBLIC, out) });
    await page.close();
    console.log('wrote public/' + out);
  };

  await shoot(ogPage({
    eyebrow: 'زنده',
    title: 'با هم گوش کنید، هم‌زمان',
    sub: 'صدا مستقیم بین دو مرورگر رد و بدل می‌شه — بدون اکانت، بدون نصب.',
  }), 'og.png', 1200, 630);

  await shoot(ogPage({
    eyebrow: 'دعوت به یک اتاق زنده',
    title: 'یکی می‌خواد با تو گوش بده',
    sub: 'لینک رو باز کن تا هم‌زمان همون صدایی رو بشنوی که اون داره گوش می‌ده.',
  }), 'og-room.png', 1200, 630);

  await shoot(iconPage(180), 'apple-touch-icon.png', 180, 180);
  await shoot(iconPage(192), 'icon-192.png', 192, 192);
  await shoot(iconPage(512), 'icon-512.png', 512, 512);
  await shoot(iconPage(32), 'favicon-32.png', 32, 32);

  pngToIco(path.join(PUBLIC, 'favicon-32.png'), path.join(PUBLIC, 'favicon.ico'));
  fs.unlinkSync(path.join(PUBLIC, 'favicon-32.png'));
  console.log('wrote public/favicon.ico');

  await browser.close();
} finally {
  server.kill();
}
