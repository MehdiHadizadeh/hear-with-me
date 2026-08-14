// Quick smoke test: two browser contexts (host + guest) with fake audio
// devices, verifying the WebRTC connection actually reaches "connected".
//
// This is a dev-only script, not part of the app's runtime (the server
// itself has zero dependencies). To run it:
//   npm install --no-save playwright
//   node test-e2e.js
import { chromium } from 'playwright';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { spawn } from 'node:child_process';

// Let Playwright find the Chromium it installed. Only override this if you
// need a specific binary (`CHROMIUM_PATH=... node test-e2e.js`) — hardcoding
// a path here previously made the test Linux-only.
const EXECUTABLE = process.env.CHROMIUM_PATH || undefined;

// Picked at startup so a dev server (or a server.js left behind by an
// interrupted run) can't own the port: ours would die with EADDRINUSE and the
// whole suite would silently run against that other server, which uses the
// production disconnect grace and would fail the departure checks below for a
// reason no assertion names.
let PORT = process.env.PORT || null;
let BASE = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForServer(url, isGone, tries = 30) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const gone = isGone();
      if (gone) return reject(new Error(gone));
      http.get(url, (res) => { res.resume(); resolve(); })
        .on('error', () => { if (n <= 0) reject(new Error('server did not start')); else setTimeout(() => attempt(n - 1), 300); });
    };
    attempt(tries);
  });
}

(async () => {
  PORT = PORT || await freePort();
  BASE = `http://localhost:${PORT}`;

  const server = spawn(process.execPath, ['server.js'], {
    cwd: HERE,
    stdio: 'inherit',
    // Short disconnect grace so the "a guest leaves" case doesn't cost the
    // full 10 seconds the server waits in production.
    env: { ...process.env, PORT: String(PORT), DISCONNECT_GRACE_MS: '800' },
  });
  let serverGone = null;
  server.once('exit', (code, signal) => {
    serverGone = `server.js exited before the tests finished (code ${code}${signal ? `, signal ${signal}` : ''}) — see its output above`;
  });
  server.once('error', (e) => { serverGone = `could not start server.js: ${e.message}`; });

  try {
    await waitForServer(`${BASE}/`, () => serverGone);

    const roomRes = await fetch(`${BASE}/api/rooms`, { method: 'POST' });
    const { roomId } = await roomRes.json();
    console.log('room:', roomId);

    const browser = await chromium.launch({
      ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        // Makes getDisplayMedia() resolve instantly with a fake screen+tone,
        // bypassing the OS/browser picker UI (Chromium test flag).
        '--auto-select-desktop-capture-source=Entire screen',
        '--enable-usermedia-screen-capturing',
        '--no-sandbox',
      ],
    });

    // Each participant needs its own context: identity lives in sessionStorage,
    // so two pages sharing one context would fight over the same membership.
    const openParticipant = async (label) => {
      const page = await (await browser.newContext()).newPage();
      page.on('console', (m) => console.log(`[${label}]`, m.text()));
      page.on('pageerror', (e) => console.log(`[${label} pageerror]`, e.message));
      return page;
    };

    // Joins as a guest and reports whether audio actually reached it.
    const connectGuest = async (page, label) => {
      await page.goto(`${BASE}/r/${roomId}?debug=1`);
      await page.waitForSelector('#guestCard', { state: 'visible', timeout: 5000 });
      console.log(`${label} card visible -> this client is a guest`);

      // Autoplay: click the "enable audio" overlay if it appears.
      try { await page.click('#enableAudioBtn', { timeout: 2000 }); } catch (e) { /* autoplay already allowed */ }

      const live = await page.waitForFunction(
        () => document.getElementById('guestStatusTitle').textContent.includes('زنده'),
        { timeout: 15000 }
      ).then(() => true).catch(() => false);

      const hasTrack = await page.evaluate(() => {
        const el = document.getElementById('remoteAudio');
        return !!(el.srcObject && el.srcObject.getAudioTracks && el.srcObject.getAudioTracks().length > 0);
      });

      if (live && hasTrack) {
        console.log(`PASS: ${label} reached "زنده — در حال شنیدن" with a live audio track`);
      } else {
        console.log(`FAIL: ${label} did not get audio. live=${live} track=${hasTrack} status=${await page.textContent('#guestStatusTitle')}`);
        process.exitCode = 1;
      }
      return live && hasTrack;
    };

    const hostPage = await openParticipant('host');

    await hostPage.goto(`${BASE}/r/${roomId}?debug=1`);
    await hostPage.waitForSelector('#hostCard', { state: 'visible', timeout: 5000 });
    console.log('host card visible -> this client became host');

    await hostPage.click('#startShareBtn');
    await hostPage.waitForFunction(
      () => document.getElementById('stopShareBtn').style.display !== 'none',
      { timeout: 8000 }
    );
    console.log('host is sharing');

    const guestPage = await openParticipant('guest1');
    await connectGuest(guestPage, 'guest1');

    // Two guests at once was the architecture's central untested assumption:
    // the host holds a separate RTCPeerConnection per guest, so the second
    // guest must get its own stream without disturbing the first.
    const guest2Page = await openParticipant('guest2');
    await connectGuest(guest2Page, 'guest2');

    const firstGuestStillLive = await guestPage.evaluate(() => {
      const el = document.getElementById('remoteAudio');
      const tracks = el.srcObject ? el.srcObject.getAudioTracks() : [];
      return tracks.length > 0 && tracks[0].readyState === 'live'
        && document.getElementById('guestStatusTitle').textContent.includes('زنده');
    });
    console.log(firstGuestStillLive
      ? 'PASS: first guest still live after a second guest joined'
      : 'FAIL: second guest disrupted the first guest');
    if (!firstGuestStillLive) process.exitCode = 1;

    const hostPeerCount = await hostPage.evaluate(() => window.__hwmPeerCount && window.__hwmPeerCount());
    console.log('host peer connections:', hostPeerCount);
    if (hostPeerCount !== 2) {
      console.log('FAIL: host should hold one peer connection per guest');
      process.exitCode = 1;
    }

    // Guests, not people: the host is in the room but is not listening to it,
    // and counting them made "۱ نفر" appear the moment you opened your own room.
    const listeners = await guestPage.textContent('#listenerText');
    console.log('listener count shown to a guest:', listeners);
    if (!listeners.includes('۲ مهمان')) {
      console.log('FAIL: the room holds 2 guests besides the host');
      process.exitCode = 1;
    }

    // The host's roster is what the remove and hand-over buttons hang off.
    const memberRows = await hostPage.$$eval('#memberList li', (els) => els.length);
    console.log('guest rows on the host roster:', memberRows);
    if (memberRows !== 2) {
      console.log('FAIL: host roster should list both guests');
      process.exitCode = 1;
    }

    // Swapping the source must re-point the existing connections rather than
    // rebuild them: the guests' tracks have to survive it.
    const beforeSwitch = await hostPage.evaluate(() => window.__hwmPeerCount());
    await hostPage.click('#switchSourceBtn');
    await hostPage.waitForTimeout(1500);
    const afterSwitch = await hostPage.evaluate(() => window.__hwmPeerCount());
    const stillLive = await guestPage.evaluate(() => {
      const el = document.getElementById('remoteAudio');
      const tracks = el.srcObject ? el.srcObject.getAudioTracks() : [];
      return tracks.length > 0 && tracks[0].readyState === 'live';
    });
    if (beforeSwitch === afterSwitch && afterSwitch === 2 && stillLive) {
      console.log('PASS: source switch kept both peer connections and the guest audio');
    } else {
      console.log(`FAIL: source switch disturbed the connections (before=${beforeSwitch} after=${afterSwitch} live=${stillLive})`);
      process.exitCode = 1;
    }

    // A guest asking for less. The host holds one connection per guest, so the
    // request has to narrow that one stream and leave the other at full rate.
    await guestPage.selectOption('#receiveQuality', 'low');
    await hostPage.waitForTimeout(1200);
    const bitrates = await hostPage.evaluate(async () => {
      const out = [];
      for (const pc of window.__hwmHostPcs()) {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        const params = sender.getParameters();
        out.push(params.encodings && params.encodings[0] ? params.encodings[0].maxBitrate : null);
      }
      return out.sort((a, b) => a - b);
    });
    console.log('per-guest sender bitrates:', bitrates);
    if (bitrates.length === 2 && bitrates[0] === 64000 && bitrates[1] === 256000) {
      console.log('PASS: the guest that asked for less got less, and only that guest');
    } else {
      console.log('FAIL: a guest quality request should only narrow its own stream');
      process.exitCode = 1;
    }

    // The meter reads the audio itself, so it is the one indicator that can
    // tell "connected" apart from "connected but silent". Sample the bars
    // twice: they must move, and not just sit at the idle floor.
    // Sampled across a window, not at two instants: Chromium's fake audio
    // device emits a beep with silent gaps, so a single snapshot lands on
    // silence often enough to make a two-sample check flaky.
    const meterMoves = async (page, label, selector) => {
      const result = await page.evaluate(async (sel) => {
        const snapshot = () => [...document.querySelectorAll(sel)].map((b) => b.style.transform);
        const frames = new Set();
        let peak = 0;
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          const bars = snapshot();
          frames.add(bars.join('|'));
          for (const t of bars) {
            const m = /scaleY\(([\d.]+)\)/.exec(t);
            if (m) peak = Math.max(peak, parseFloat(m[1]));
          }
          await new Promise((r) => setTimeout(r, 80));
        }
        return { frames: frames.size, peak };
      }, selector);

      const ok = result.frames > 1 && result.peak > 0.1;
      console.log(ok
        ? `PASS: ${label} level meter is reacting to the audio (peak ${result.peak.toFixed(2)})`
        : `FAIL: ${label} level meter is flat (frames=${result.frames} peak=${result.peak})`);
      if (!ok) process.exitCode = 1;
    };
    await meterMoves(guestPage, 'guest1', '#guestMeter span');
    await meterMoves(hostPage, 'host', '#hostMeter span');

    // The label has no automatic source — no browser API can read what another
    // tab is playing — so the host sets it and every guest receives it.
    await hostPage.fill('#nowPlayingInput', 'Radiohead — Weird Fishes');
    await hostPage.click('#nowPlayingBtn');
    const labelReached = await guestPage.waitForFunction(
      () => document.getElementById('guestNowPlaying').textContent.includes('Weird Fishes'),
      { timeout: 5000 }
    ).then(() => true).catch(() => false);
    console.log(labelReached
      ? 'PASS: now-playing label reached the guest'
      : 'FAIL: now-playing label never reached the guest');
    if (!labelReached) process.exitCode = 1;

    const ticking = await guestPage.evaluate(async () => {
      const read = () => document.getElementById('guestElapsed').textContent;
      const before = read();
      await new Promise((r) => setTimeout(r, 1600));
      return { before, after: read() };
    });
    console.log(ticking.before !== ticking.after
      ? `PASS: elapsed timer is running (${ticking.before} -> ${ticking.after})`
      : `FAIL: elapsed timer stuck at ${ticking.before}`);
    if (ticking.before === ticking.after) process.exitCode = 1;

    // Opus must be negotiated for music, not for a phone call. Read it off the
    // connection that actually got established, not off our own intent.
    const opus = await guestPage.evaluate(async () => {
      const pc = window.__hwmGuestPc && window.__hwmGuestPc();
      if (!pc) return { error: 'no peer connection' };
      const sdp = pc.remoteDescription ? pc.remoteDescription.sdp : '';
      const fmtp = /a=fmtp:\d+ ([^\r\n]*stereo[^\r\n]*)/.exec(sdp);
      let codec = null;
      const stats = await pc.getStats();
      stats.forEach((r) => { if (r.type === 'codec' && /opus/i.test(r.mimeType || '')) codec = r; });
      return {
        fmtp: fmtp ? fmtp[1] : null,
        channels: codec ? codec.channels : null,
        clockRate: codec ? codec.clockRate : null,
      };
    });
    const opusOk = !!opus.fmtp && opus.fmtp.includes('stereo=1')
      && opus.fmtp.includes('usedtx=0') && /maxaveragebitrate=\d{6}/.test(opus.fmtp)
      && opus.channels === 2;
    console.log(opusOk
      ? `PASS: Opus negotiated for music (${opus.channels}ch @ ${opus.clockRate}Hz)`
      : `FAIL: Opus still on speech defaults ${JSON.stringify(opus)}`);
    if (!opusOk) process.exitCode = 1;

    // Muting must not depend on HTMLMediaElement.volume, which iOS ignores.
    const muting = await guestPage.evaluate(() => {
      const el = document.getElementById('remoteAudio');
      const bar = document.getElementById('volumeBar');
      const btn = document.getElementById('muteBtn');
      const out = {};

      btn.click();
      out.mutedAfterButton = el.muted;
      out.buttonReflectsState = btn.getAttribute('aria-pressed') === 'true';
      btn.click();
      out.unmutedAfterSecondClick = el.muted === false;

      bar.value = '0';
      bar.dispatchEvent(new Event('input'));
      out.mutedAtZero = el.muted;

      bar.value = '0.7';
      bar.dispatchEvent(new Event('input'));
      out.unmutedAboveZero = el.muted === false && Math.abs(el.volume - 0.7) < 0.01;
      return out;
    });
    const mutingOk = Object.values(muting).every(Boolean);
    console.log(mutingOk
      ? 'PASS: mute button and slider-to-zero both silence playback'
      : `FAIL: muting is broken ${JSON.stringify(muting)}`);
    if (!mutingOk) process.exitCode = 1;

    // The diagnostic used to answer "is this connection direct, or does it
    // only work through a relay we don't run?" — worth keeping honest.
    const route = await hostPage.evaluate(() => window.__hwmRoute());
    const routeOk = Array.isArray(route) && route.length === 2
      && route.every((r) => r.local && r.remote && r.needsTurn === false);
    console.log(routeOk
      ? `PASS: route diagnostic reports both connections (${route[0].local} <-> ${route[0].remote})`
      : `FAIL: route diagnostic broken ${JSON.stringify(route)}`);
    if (!routeOk) process.exitCode = 1;

    // Losing the event stream must not cut the audio. A phone that locks its
    // screen drops SSE within seconds while the media path keeps playing, and
    // the room used to react by telling the host to close that connection —
    // silencing a guest who was still listening fine.
    await guestPage.evaluate(() => window.__hwmKillEventStream());
    await hostPage.waitForTimeout(2500); // well past the test server's 800ms grace
    const survived = await guestPage.evaluate(() => {
      const el = document.getElementById('remoteAudio');
      const tracks = el.srcObject ? el.srcObject.getAudioTracks() : [];
      const pc = window.__hwmGuestPc();
      return {
        track: tracks.length > 0 && tracks[0].readyState === 'live',
        state: pc ? pc.connectionState : 'none',
      };
    });
    const hostKept = await hostPage.evaluate(() => window.__hwmPeerCount());
    const keptPlaying = survived.track && survived.state === 'connected' && hostKept === 2;
    console.log(keptPlaying
      ? 'PASS: audio survives losing the event stream'
      : `FAIL: audio died with the event stream ${JSON.stringify(survived)} hostPeers=${hostKept}`);
    if (!keptPlaying) process.exitCode = 1;

    // A guest whose offer never reaches the host used to sit on "connecting to
    // host..." forever: the connection stays in 'new', never reaches 'failed',
    // so the retry path never ran and only a manual reload recovered it. This
    // is what a phone coming back from a locked screen looked like.
    const stuckPage = await openParticipant('stuck');
    await stuckPage.route('**/signal', (route) => route.abort());
    await stuckPage.goto(`${BASE}/r/${roomId}?debug=1`);
    await stuckPage.waitForSelector('#guestCard', { state: 'visible', timeout: 5000 });
    const recovered = await stuckPage.waitForFunction(
      () => document.getElementById('guestStatusSub').textContent.includes('تلاش دوباره'),
      { timeout: 20000 }
    ).then(() => true).catch(() => false);
    console.log(recovered
      ? 'PASS: a guest with no answer retries instead of hanging'
      : `FAIL: guest hung on "${await stuckPage.textContent('#guestStatusTitle')}"`);
    if (!recovered) process.exitCode = 1;
    await stuckPage.context().close();

    // When a guest leaves, the host must drop that guest's peer connection and
    // leave every other guest alone.
    await guest2Page.context().close();
    await hostPage.waitForFunction(() => window.__hwmPeerCount() === 1, { timeout: 8000 })
      .then(() => console.log('PASS: host released the departed guest\'s peer connection'))
      .catch(async () => {
        console.log('FAIL: host still holds', await hostPage.evaluate(() => window.__hwmPeerCount()), 'peer connections');
        process.exitCode = 1;
      });

    const survivorStillLive = await guestPage.evaluate(() =>
      document.getElementById('guestStatusTitle').textContent.includes('زنده'));
    console.log(survivorStillLive
      ? 'PASS: remaining guest kept its audio'
      : 'FAIL: remaining guest lost audio when the other guest left');
    if (!survivorStillLive) process.exitCode = 1;

    // A code that doesn't exist must reach a real dead end. EventSource stops
    // retrying after the 404, so the page has to say so rather than sit on
    // "reconnecting..." forever.
    const strayPage = await (await browser.newContext()).newPage();
    await strayPage.goto(`${BASE}/r/ZZZZZZ`);
    const sawNotFound = await strayPage.waitForFunction(
      () => document.getElementById('notFoundCard').style.display === 'block',
      { timeout: 8000 }
    ).then(() => true).catch(() => false);
    console.log(sawNotFound
      ? 'PASS: unknown room code shows the "room not found" card'
      : 'FAIL: unknown room code did not surface a not-found state');
    if (!sawNotFound) process.exitCode = 1;

    await browser.close();
  } finally {
    server.kill();
  }
})();
