// Renders the app's icons and splash from the same mark as the site, so the
// app cannot drift from it. Dev-only; needs Playwright (from the repo root:
// `npm install --no-save playwright`) and Python with Pillow for the resizing.
//
//   node app/tools/make-icons.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hwm-icons-'));

const MARK = `
  <path d="M4 20C10.3 8 16.7 8 23 20C29.3 32 35.7 32 42 20" stroke="#3FE0BE"/>
  <path d="M4 29C10.3 17 16.7 17 23 29C29.3 41 35.7 41 42 29" stroke="#8C7CFF"/>`;

// `scale` is the mark's width as a share of the square; the strokes stay the
// site's 4.6 units, which reads well from launcher size up.
const page = (bg, scale) => `<!doctype html><html><body style="margin:0;background:${bg}">
  <div style="width:1024px;height:1024px;display:grid;place-items:center;background:${bg}">
    <svg width="${1024 * scale}" height="${1024 * scale}" viewBox="2 2 42 42" fill="none" stroke-width="4.6" stroke-linecap="round">${MARK}</svg>
  </div></body></html>`;

const browser = await chromium.launch();
const shot = async (name, bg, scale, transparent = false) => {
  const p = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await p.setContent(page(transparent ? 'transparent' : bg, scale));
  await p.screenshot({ path: path.join(TMP, name), omitBackground: transparent, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
  await p.close();
};
await shot('full.png', '#0B0E18', 0.58);              // launcher, iOS
await shot('foreground.png', '', 0.40, true);          // adaptive icon: inside the safe zone
await shot('splash-mark.png', '', 0.5, true);          // centred on the splash
await browser.close();

execFileSync('python', [path.join(APP, 'tools', 'resize-icons.py'), TMP, APP], { stdio: 'inherit' });
fs.rmSync(TMP, { recursive: true, force: true });
