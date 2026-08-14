// Room Layer tests — the server's own logic, with no browser involved.
//
// Dependency-free like the server itself, so this runs anywhere `node` does:
//   node test-rooms.js
//
// The Playwright test (test-e2e.js) covers the real WebRTC path end to end;
// this one covers the parts that used to break for reasons a happy-path
// browser test never sees: dropped SSE connections, host handoff, and
// clients claiming an identity that isn't theirs.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Chosen at startup rather than hardcoded. On a fixed port, anything already
// listening there — a dev server, or a server.js left behind by an interrupted
// run — makes our own server die with EADDRINUSE while every request below
// quietly goes to *that* server instead. It answers everything correctly
// except that it runs the production 10s disconnect grace, so only the
// grace-period assertions fail and the whole thing reads as a server bug.
let PORT = process.env.PORT || null;
let BASE = null;
const GRACE = 600; // server runs with a shortened disconnect grace, see below

function freePort() {
  return new Promise((resolve, reject) => {
    // Bound the same way server.js binds (all interfaces), so "free" here
    // means free for it too.
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// No connection reuse: one test deliberately makes the server drop a
// connection mid-body, and a pooled socket would carry that damage into the
// next test rather than into the assertion that asked for it.
const agent = new http.Agent({ keepAlive: false });

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, path, body, base) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${base || BASE}${path}`, {
      method,
      agent,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// An SSE member. `events` accumulates every event received, so tests can
// assert on what the server pushed (or didn't push).
function join(roomId, clientId, secret) {
  const member = { clientId, secret, events: [], req: null, status: null };
  member.ready = new Promise((resolve) => {
    member.req = http.get(
      `${BASE}/api/rooms/${roomId}/events?clientId=${encodeURIComponent(clientId)}&secret=${encodeURIComponent(secret)}`,
      { agent },
      (res) => {
        member.status = res.statusCode;
        res.on('data', (chunk) => {
          for (const frame of String(chunk).split('\n\n')) {
            const name = /^event: (.+)$/m.exec(frame);
            const data = /^data: (.+)$/m.exec(frame);
            if (name) member.events.push({ event: name[1], data: data ? JSON.parse(data[1]) : null });
          }
          // Only ready once a real event landed: the stream opens with an
          // anti-buffering comment, and resolving on that would let callers
          // read member.events before the welcome arrives.
          if (member.events.length > 0) resolve();
        });
        if (res.statusCode !== 200) resolve();
      },
    );
    member.req.on('error', () => resolve());
  });
  member.drop = () => member.req.destroy();
  member.saw = (event) => member.events.some((e) => e.event === event);
  return member;
}

async function newRoom() {
  const { status, json } = await request('POST', '/api/rooms');
  // Naming this here rather than letting the caller build a URL with
  // "undefined" in it and chase a 404 through five unrelated assertions.
  if (!json || !json.roomId) throw new Error(`could not create a room (status ${status}): ${JSON.stringify(json)}`);
  return json.roomId;
}

// ---------------------------------------------------------------------------

async function testRoomLifecycle() {
  console.log('\nroom lifecycle');
  const { status, json } = await request('POST', '/api/rooms');
  check('creating a room returns a code', status === 200 && typeof json.roomId === 'string', json);
  check('code is 6 chars, unambiguous alphabet', /^[346789ABCDEFGHJKLMNPQRTUVWXYZ]{6}$/.test(json.roomId), json.roomId);

  const missing = await request('GET', '/api/rooms/ZZZZZZ');
  check('unknown room reports 404', missing.status === 404, missing.status);

  const found = await request('GET', `/api/rooms/${json.roomId}`);
  check('known room reports 200', found.status === 200 && found.json.exists === true, found.json);

  const lower = await request('GET', `/api/rooms/${json.roomId.toLowerCase()}`);
  check('room codes are case-insensitive', lower.status === 200, lower.status);
}

async function testIdentity() {
  console.log('\nidentity');
  const roomId = await newRoom();

  const noCreds = await request('GET', `/api/rooms/${roomId}/events?clientId=a`);
  check('joining without a secret is rejected', noCreds.status === 400, noCreds.status);

  const host = join(roomId, 'host', 'host-secret');
  await host.ready;
  check('host joins and is told it is the host', host.events[0].data.isHost === true, host.events[0]);

  // The whole point of the secret: knowing a room code and a clientId must
  // not be enough to take over that member's slot.
  const impostor = join(roomId, 'host', 'guessed-secret');
  await impostor.ready;
  check('impostor cannot claim an in-use clientId', impostor.status === 409, impostor.status);

  const forged = await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'host', secret: 'guessed-secret', action: 'start' });
  check('forged secret cannot start sharing', forged.status === 403, forged);

  const unsigned = await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'host', action: 'start' });
  check('missing secret cannot start sharing', unsigned.status === 400, unsigned.status);

  const real = await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'host', secret: 'host-secret', action: 'start' });
  check('the real host can start sharing', real.status === 200, real);

  const guest = join(roomId, 'guest', 'guest-secret');
  await guest.ready;
  const guestStop = await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'guest', secret: 'guest-secret', action: 'stop' });
  check('a guest cannot stop the host sharing', guestStop.status === 403, guestStop.json);

  const spoofedSignal = await request('POST', `/api/rooms/${roomId}/signal`, { clientId: 'host', secret: 'nope', to: 'guest', type: 'offer', payload: 'x' });
  check('signaling requires a valid secret', spoofedSignal.status === 403, spoofedSignal.status);

  host.drop(); guest.drop();
}

async function testSignalRelay() {
  console.log('\nsignal relay');
  const roomId = await newRoom();
  const host = join(roomId, 'host', 's1');
  await host.ready;
  const guest = join(roomId, 'guest', 's2');
  await guest.ready;

  await request('POST', `/api/rooms/${roomId}/signal`, { clientId: 'guest', secret: 's2', to: 'host', type: 'offer', payload: 'sdp-here' });
  await sleep(100);
  const relayed = host.events.find((e) => e.event === 'signal');
  check('guest -> host offer is relayed', !!relayed && relayed.data.type === 'offer' && relayed.data.from === 'guest', relayed);

  await request('POST', `/api/rooms/${roomId}/signal`, { clientId: 'host', secret: 's1', to: 'guest', type: 'answer', payload: 'sdp-back' });
  await sleep(100);
  const back = guest.events.find((e) => e.event === 'signal');
  check('host -> guest answer is relayed', !!back && back.data.type === 'answer', back);

  // Only the host may address one specific guest; guests may only reach "host".
  const guest2 = join(roomId, 'guest2', 's3');
  await guest2.ready;
  const sideways = await request('POST', `/api/rooms/${roomId}/signal`, { clientId: 'guest', secret: 's2', to: 'guest2', type: 'offer', payload: 'x' });
  check('a guest cannot address another guest directly', sideways.status === 403, sideways.status);

  host.drop(); guest.drop(); guest2.drop();
}

async function testNowPlaying() {
  console.log('\nnow-playing label');
  const roomId = await newRoom();
  const host = join(roomId, 'host', 's1');
  await host.ready;
  const guest = join(roomId, 'guest', 's2');
  await guest.ready;
  await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'host', secret: 's1', action: 'start' });
  await sleep(100);

  const set = await request('POST', `/api/rooms/${roomId}/now-playing`, { clientId: 'host', secret: 's1', text: '  Radiohead —   Weird   Fishes  ' });
  check('host can set the label', set.status === 200, set.json);
  check('whitespace is collapsed and trimmed', set.json.text === 'Radiohead — Weird Fishes', set.json);
  await sleep(100);
  const pushed = guest.events.find((e) => e.event === 'now-playing');
  check('guests are pushed the label', !!pushed && pushed.data.text === 'Radiohead — Weird Fishes', pushed);

  const byGuest = await request('POST', `/api/rooms/${roomId}/now-playing`, { clientId: 'guest', secret: 's2', text: 'nope' });
  check('a guest cannot set the label', byGuest.status === 403, byGuest.status);

  const unsigned = await request('POST', `/api/rooms/${roomId}/now-playing`, { clientId: 'host', text: 'nope' });
  check('setting the label needs the secret', unsigned.status === 400, unsigned.status);

  const long = await request('POST', `/api/rooms/${roomId}/now-playing`, { clientId: 'host', secret: 's1', text: 'x'.repeat(500) });
  check('label is capped at 120 chars', long.json.text.length === 120, long.json.text.length);

  // A late joiner must see the current label and a mid-session timer.
  const latecomer = join(roomId, 'late', 's3');
  await latecomer.ready;
  await sleep(50);
  const welcome = latecomer.events[0].data;
  check('late joiner receives the current label', welcome.nowPlaying.length === 120, welcome.nowPlaying.length);
  check('late joiner receives elapsed time, not a start timestamp',
    typeof welcome.sharingElapsedMs === 'number' && welcome.sharingElapsedMs >= 0 && welcome.sharingElapsedMs < 60000,
    welcome.sharingElapsedMs);

  // Each sharing session starts clean rather than inheriting the last label.
  await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'host', secret: 's1', action: 'stop' });
  await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'host', secret: 's1', action: 'start' });
  await sleep(50);
  const fresh = join(roomId, 'fresh', 's4');
  await fresh.ready;
  await sleep(50);
  check('a new sharing session clears the old label', fresh.events[0].data.nowPlaying === '', fresh.events[0].data);

  const idle = await newRoom();
  const idleMember = join(idle, 'a', 'sa');
  await idleMember.ready;
  check('elapsed is null when nothing is being shared', idleMember.events[0].data.sharingElapsedMs === null, idleMember.events[0].data);

  host.drop(); guest.drop(); latecomer.drop(); fresh.drop(); idleMember.drop();
}

// The regression this file exists for.
async function testReconnectDoesNotStealTheRoom() {
  console.log('\nSSE reconnect (a dropped connection is not a departure)');

  // Ordering A: the new connection opens before the old one's close is seen.
  {
    const roomId = await newRoom();
    const hostA = join(roomId, 'host', 's1');
    await hostA.ready;
    const guest = join(roomId, 'guest', 's2');
    await guest.ready;
    await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'host', secret: 's1', action: 'start' });
    await sleep(100);
    guest.events.length = 0;

    const hostB = join(roomId, 'host', 's1');
    await hostB.ready;
    hostA.drop();
    await sleep(GRACE * 3);

    check('reconnecting host is still the host', hostB.events[0].data.isHost === true, hostB.events[0]);
    check('reconnecting host is still sharing', hostB.events[0].data.isSharing === true, hostB.events[0]);
    check('guest is not told sharing stopped', !guest.saw('sharing-stopped'), guest.events);
    check('guest is not promoted to host', !guest.saw('you-are-host'), guest.events);

    const stillInControl = await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'host', secret: 's1', action: 'stop' });
    check('host keeps control of the room', stillInControl.status === 200, stillInControl.json);
    hostB.drop(); guest.drop();
  }

  // Ordering B: the connection closes first, and reconnects inside the grace.
  {
    const roomId = await newRoom();
    const hostA = join(roomId, 'host', 's1');
    await hostA.ready;
    const guest = join(roomId, 'guest', 's2');
    await guest.ready;
    await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'host', secret: 's1', action: 'start' });
    await sleep(100);
    guest.events.length = 0;

    hostA.drop();
    await sleep(GRACE / 3);
    const hostB = join(roomId, 'host', 's1');
    await hostB.ready;
    await sleep(GRACE * 3);

    check('host reconnecting within the grace keeps the room', hostB.events[0].data.isHost === true, hostB.events[0]);
    check('sharing survives the blip', hostB.events[0].data.isSharing === true, hostB.events[0]);
    check('guest sees no disruption', !guest.saw('sharing-stopped') && !guest.saw('you-are-host'), guest.events);
    hostB.drop(); guest.drop();
  }
}

async function testRealDeparture() {
  console.log('\nreal departure (grace expires)');
  const roomId = await newRoom();
  const host = join(roomId, 'host', 's1');
  await host.ready;
  const guest = join(roomId, 'guest', 's2');
  await guest.ready;
  await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'host', secret: 's1', action: 'start' });
  await sleep(100);
  guest.events.length = 0;

  host.drop();
  await sleep(GRACE * 3);

  check('guest is told sharing stopped', guest.saw('sharing-stopped'), guest.events);
  check('guest is promoted to host', guest.saw('you-are-host'), guest.events);
  const count = guest.events.filter((e) => e.event === 'listener-count').pop();
  check('listener count drops to 1', count && count.data.count === 1, count);

  const promoted = await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'guest', secret: 's2', action: 'start' });
  check('the promoted member can now share', promoted.status === 200, promoted.json);
  guest.drop();
}

async function testGuestDeparture() {
  console.log('\nguest departure');
  const roomId = await newRoom();
  const host = join(roomId, 'host', 's1');
  await host.ready;
  const guest = join(roomId, 'guest', 's2');
  await guest.ready;
  await sleep(100);
  host.events.length = 0;

  guest.drop();
  await sleep(GRACE * 3);
  const gone = host.events.find((e) => e.event === 'peer-left');
  check('host is told which guest left', !!gone && gone.data.clientId === 'guest', host.events);
  check('host keeps hosting', (await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'host', secret: 's1', action: 'start' })).status === 200);
  host.drop();
}

async function testHttpEdges() {
  console.log('\nHTTP edges');
  const roomId = await newRoom();

  // Sent in chunks, stopping as soon as the server answers: a real client
  // notices the 413 mid-upload rather than blindly finishing a body the server
  // has already refused (and then racing its own write error against the
  // response it never read).
  const oversize = await new Promise((resolve) => {
    const chunk = 'x'.repeat(32 * 1024);
    const total = 300 * 1024;
    let answered = null;
    let sent = 0;
    const req = http.request(`${BASE}/api/rooms/${roomId}/signal`, {
      method: 'POST',
      agent,
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    }, (res) => { res.resume(); answered = res.statusCode; resolve(answered); });
    req.on('error', (e) => resolve(answered !== null ? answered : `error:${e.code}`));

    const pump = () => {
      if (answered !== null || req.destroyed) return;
      if (sent >= total) return req.end();
      sent += chunk.length;
      req.write(chunk, () => setTimeout(pump, 5));
    };
    pump();
  });
  check('oversize body gets a 413, not a reset connection', oversize === 413, oversize);

  const head = await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/style.css`, { method: 'HEAD', agent }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes, length: res.headers['content-length'] }));
    });
    req.on('error', reject);
    req.end();
  });
  check('HEAD returns headers with no body', head.status === 200 && head.bytes === 0 && Number(head.length) > 0, head);

  const traversal = await request('GET', '/../server.js');
  check('path traversal is refused', traversal.status === 404 || traversal.status === 403, traversal.status);

  const encoded = await request('GET', '/%2e%2e/server.js');
  check('encoded path traversal is refused', encoded.status === 404 || encoded.status === 403, encoded.status);

  const root = await request('GET', '/');
  check('/ serves the landing page', root.status === 200 && root.text.includes('Hear With Me'), root.status);

  const room = await request('GET', '/r/ABC123');
  check('/r/<code> serves the room page', room.status === 200 && room.text.includes('roomCode'), room.status);
}

// ---------------------------------------------------------------------------

// Everyone in the room needs to know who else is in it — the host's remove and
// hand-over controls are pointed at these ids.
async function testRoster() {
  console.log('\nroster');
  const roomId = await newRoom();
  const host = join(roomId, 'h', 's-h');
  await host.ready;
  const guest = join(roomId, 'g', 's-g');
  await guest.ready;
  await sleep(60);

  const welcome = host.events.find((e) => e.event === 'welcome');
  check('welcome carries the roster and the settings',
    Array.isArray(welcome.data.members) && welcome.data.settings
    && welcome.data.settings.locked === false, welcome.data);

  const members = host.events.filter((e) => e.event === 'members').pop();
  check('roster lists both members with the host marked',
    members.data.members.length === 2
    && members.data.members.filter((m) => m.isHost).length === 1
    && members.data.members.every((m) => m.connected), members.data);

  // A dropped stream is reported straight away even though the member keeps
  // their place for the length of the grace period.
  guest.drop();
  await sleep(120);
  const afterDrop = host.events.filter((e) => e.event === 'members').pop();
  check('a dropped member is shown as disconnected, not removed',
    afterDrop.data.members.length === 2 && afterDrop.data.members.some((m) => !m.connected), afterDrop.data);

  host.drop();
  await sleep(GRACE + 200);
}

async function testHostControls() {
  console.log('\nhost controls');
  const roomId = await newRoom();
  const host = join(roomId, 'h', 's-h');
  await host.ready;
  const guest = join(roomId, 'g', 's-g');
  await guest.ready;
  await sleep(60);

  const notHost = await request('POST', `/api/rooms/${roomId}/settings`, { clientId: 'g', secret: 's-g', locked: true });
  check('a guest cannot change the room settings', notHost.status === 403, notHost.status);

  const locked = await request('POST', `/api/rooms/${roomId}/settings`, { clientId: 'h', secret: 's-h', locked: true });
  check('the host can lock the room', locked.status === 200 && locked.json.locked === true, locked.json);
  await sleep(50);
  check('everyone is told the room is locked', guest.saw('room-settings'), guest.events.map((e) => e.event));

  const stranger = join(roomId, 'x', 's-x');
  await stranger.ready;
  check('a locked room refuses a newcomer with 423', stranger.status === 423, stranger.status);

  const info = await request('GET', `/api/rooms/${roomId}`);
  check('the room reports itself as locked', info.json.locked === true, info.json);

  guest.drop();
  await sleep(80);
  const back = join(roomId, 'g', 's-g');
  await back.ready;
  check('a locked room still lets its own member reconnect', back.status === 200, back.status);

  // Handing the room over on purpose, rather than by leaving.
  const transfer = await request('POST', `/api/rooms/${roomId}/host`, { clientId: 'h', secret: 's-h', targetId: 'g' });
  check('the host can hand the room to a guest', transfer.status === 200, transfer.json);
  await sleep(60);
  const promoted = back.events.find((e) => e.event === 'you-are-host');
  check('the new host is told, and told why', promoted && promoted.data.reason === 'transfer', promoted && promoted.data);
  check('everyone learns who the host is now',
    host.events.filter((e) => e.event === 'host-changed').pop().data.hostId === 'g');
  check('sharing stops when the room changes hands',
    host.events.some((e) => e.event === 'sharing-stopped' && e.data.reason === 'host-changed'));

  const oldHostShares = await request('POST', `/api/rooms/${roomId}/sharing`, { clientId: 'h', secret: 's-h', action: 'start' });
  check('the previous host can no longer start sharing', oldHostShares.status === 403, oldHostShares.status);

  // Removing someone. The new host ('g') removes the old one ('h').
  const kick = await request('POST', `/api/rooms/${roomId}/kick`, { clientId: 'g', secret: 's-g', targetId: 'h' });
  check('the host can remove a guest', kick.status === 200, kick.json);
  await sleep(80);
  check('the removed member is told', host.saw('evicted'), host.events.map((e) => e.event));
  check('the host is told to drop that peer connection for real',
    back.events.some((e) => e.event === 'peer-left' && e.data.clientId === 'h' && e.data.force === true));

  const rejoin = join(roomId, 'h', 's-h');
  await rejoin.ready;
  check('a removed member cannot walk back in', rejoin.status === 403, rejoin.status);

  const selfKick = await request('POST', `/api/rooms/${roomId}/kick`, { clientId: 'g', secret: 's-g', targetId: 'g' });
  check('the host cannot remove themselves', selfKick.status === 400, selfKick.status);

  back.drop();
  await sleep(GRACE + 200);
}

// The alternative to handing a stranger someone else's room when they leave.
async function testCloseOnHostLeave() {
  console.log('\nclosing the room on the host leaving');
  const roomId = await newRoom();
  const host = join(roomId, 'h', 's-h');
  await host.ready;
  const guest = join(roomId, 'g', 's-g');
  await guest.ready;
  await sleep(60);

  await request('POST', `/api/rooms/${roomId}/settings`, { clientId: 'h', secret: 's-h', closeOnHostLeave: true });
  host.drop();
  await sleep(GRACE + 300);

  check('the guest is told the room closed', guest.saw('room-closed'), guest.events.map((e) => e.event));
  check('the guest is not promoted', !guest.saw('you-are-host'));
  const gone = await request('GET', `/api/rooms/${roomId}`);
  check('the room itself is gone', gone.status === 404, gone.status);
}

async function testNames() {
  console.log('\nguest names');
  const roomId = await newRoom();
  const host = join(roomId, 'h', 's-h');
  await host.ready;
  const guest = join(roomId, 'g', 's-g');
  await guest.ready;
  await sleep(60);

  const named = await request('POST', `/api/rooms/${roomId}/name`, { clientId: 'g', secret: 's-g', name: '  مهدی  ' });
  check('a member can name themselves', named.status === 200 && named.json.name === 'مهدی', named.json);
  await sleep(50);
  const roster = host.events.filter((e) => e.event === 'members').pop().data.members;
  check('the name reaches the host on the roster',
    roster.find((m) => m.id === 'g').name === 'مهدی', roster);
  check('the roster says how long ago each member arrived',
    roster.every((m) => typeof m.joinedMsAgo === 'number'), roster);

  // This UI is right-to-left; an unescaped U+202E in a name would flip the
  // host's own layout around it.
  const nasty = await request('POST', `/api/rooms/${roomId}/name`, {
    clientId: 'g', secret: 's-g', name: `a\u202Eb\u0007c${'x'.repeat(40)}`,
  });
  check('control characters and bidi overrides are stripped',
    !/[\u0000-\u001F\u202A-\u202E]/.test(nasty.json.name), JSON.stringify(nasty.json.name));
  check('names are capped in length', nasty.json.name.length <= 24, nasty.json.name.length);

  const forged = await request('POST', `/api/rooms/${roomId}/name`, { clientId: 'h', secret: 's-g', name: 'نه' });
  check('nobody can rename somebody else', forged.status === 403, forged.status);

  host.drop();
  guest.drop();
  await sleep(GRACE + 200);
}

async function testReactions() {
  console.log('\nreactions');
  const roomId = await newRoom();
  const host = join(roomId, 'h', 's-h');
  await host.ready;
  const guest = join(roomId, 'g', 's-g');
  await guest.ready;
  await sleep(60);

  const sent = await request('POST', `/api/rooms/${roomId}/reaction`, { clientId: 'g', secret: 's-g', kind: 'nosound' });
  check('a guest can send a reaction', sent.status === 200, sent.json);
  await sleep(60);
  const got = host.events.find((e) => e.event === 'reaction');
  check('it reaches the host, with the sender attached',
    got && got.data.kind === 'nosound' && got.data.from === 'g', got && got.data);

  const tooFast = await request('POST', `/api/rooms/${roomId}/reaction`, { clientId: 'g', secret: 's-g', kind: 'love' });
  check('a second one straight away is refused', tooFast.status === 429, tooFast.status);

  const nonsense = await request('POST', `/api/rooms/${roomId}/reaction`, { clientId: 'h', secret: 's-h', kind: 'drop-tables' });
  check('an unknown reaction kind is refused', nonsense.status === 400, nonsense.status);

  const forged = await request('POST', `/api/rooms/${roomId}/reaction`, { clientId: 'g', secret: 'wrong', kind: 'love' });
  check('a reaction still has to prove who it is from', forged.status === 403, forged.status);

  host.drop();
  guest.drop();
  await sleep(GRACE + 200);
}

// Room creation costs one POST and proves nothing, so it runs against its own
// server with the caps turned down far enough to reach in a test.
async function testCapsAndIce() {
  console.log('\ncreation caps and ICE configuration');
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: HERE,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      PORT: String(port),
      ROOMS_PER_IP: '3',
      TURN_URL: 'turn:turn.example:3478',
      TURN_USERNAME: 'u',
      TURN_PASSWORD: 'p',
    },
  });

  try {
    for (let i = 30; ; i--) {
      try { await request('GET', '/', undefined, base); break; } catch (e) {
        if (i <= 0) throw new Error('second server did not start');
        await sleep(200);
      }
    }

    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await request('POST', '/api/rooms', undefined, base)).status);
    check('the first rooms are created', statuses.slice(0, 3).every((s) => s === 200), statuses);
    check('one room too many is refused with 429', statuses[3] === 429, statuses);

    const ice = await request('GET', '/api/ice', undefined, base);
    check('ICE configuration is served to the client', ice.status === 200 && ice.json.iceServers.length === 2, ice.json);
    check('a configured TURN server carries its credentials',
      ice.json.iceServers[1].username === 'u' && ice.json.iceServers[1].credential === 'p', ice.json.iceServers[1]);
  } finally {
    server.kill();
  }
}

// ---------------------------------------------------------------------------

(async () => {
  PORT = PORT || await freePort();
  BASE = `http://localhost:${PORT}`;

  const server = spawn(process.execPath, ['server.js'], {
    cwd: HERE,
    stdio: ['ignore', 'ignore', 'inherit'],
    // The per-IP cap on room creation is exercised by testCapsAndIce against
    // its own server; here it would just starve the suite halfway through.
    env: { ...process.env, PORT: String(PORT), DISCONNECT_GRACE_MS: String(GRACE), ROOMS_PER_IP: '1000' },
  });

  // A server that failed to start must never be mistaken for a server that
  // misbehaved: without this, the readiness probe below is happy the moment
  // *anything* answers on the port.
  let serverGone = null;
  server.once('exit', (code, signal) => {
    serverGone = `server.js exited before the tests finished (code ${code}${signal ? `, signal ${signal}` : ''}) — see its output above`;
  });
  server.once('error', (e) => { serverGone = `could not start server.js: ${e.message}`; });

  try {
    for (let i = 30; ; i--) {
      if (serverGone) throw new Error(serverGone);
      try { await request('GET', '/'); break; } catch (e) {
        if (i <= 0) throw new Error('server did not start');
        await sleep(200);
      }
    }

    await testRoomLifecycle();
    await testIdentity();
    await testSignalRelay();
    await testNowPlaying();
    await testReconnectDoesNotStealTheRoom();
    await testRealDeparture();
    await testGuestDeparture();
    await testRoster();
    await testHostControls();
    await testCloseOnHostLeave();
    await testNames();
    await testReactions();
    await testCapsAndIce();
    await testHttpEdges();

    // The server dying mid-run would leave later assertions failing for a
    // reason none of them describes.
    if (serverGone) throw new Error(serverGone);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('\ntest harness error:', e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
