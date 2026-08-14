// The HTTP surface: one table of routes, and handlers thin enough that the
// interesting logic all lives on the Room.

import { iceServers } from './config.js';
import { clientIp, originOf, readJSONBody, sendJSON, serveStatic } from './http.js';
import { openSseStream } from './sse.js';

// Why a join was refused -> what to answer. Each of these is a different
// situation for the person holding the link, and the client says something
// different for each.
const JOIN_REFUSALS = {
  'missing-credentials': [400, 'missing clientId or secret'],
  removed: [403, 'removed'],
  'client-id-taken': [409, 'client-id-taken'],
  'room-locked': [423, 'room-locked'],
};

const SIGNAL_REFUSALS = {
  'not-host': [403, 'only host may address a specific guest'],
  'target-not-connected': [404, 'target not connected'],
};

export function createRouter(rooms) {
  // -- helpers -------------------------------------------------------------

  const roomOr404 = (res, id) => {
    const room = rooms.get(id);
    if (!room) { sendJSON(res, 404, { error: 'room-not-found' }); return null; }
    return room;
  };

  // Reads the body, finds the room, and proves the sender is who they claim.
  // `run(room, body, res)` only happens once all three succeed, which is why
  // no handler below repeats any of it.
  const withAuth = ({ hostOnly = false } = {}, run) => (req, res, id) => {
    const room = roomOr404(res, id);
    if (!room) return;
    readJSONBody(req, res, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad-json' });
      const { clientId, secret } = body;
      if (!clientId || !secret) return sendJSON(res, 400, { error: 'missing credentials' });
      if (!room.verify(clientId, secret)) return sendJSON(res, 403, { error: 'bad-credentials' });
      if (hostOnly && !room.isHost(clientId)) return sendJSON(res, 403, { error: 'not-host' });
      return run(room, body, res);
    });
  };

  // A member acting on another member: both must exist, and it can't be you.
  const target = (room, body, res) => {
    const { targetId } = body;
    if (!targetId || room.isHost(targetId)) { sendJSON(res, 400, { error: 'bad-target' }); return null; }
    if (!room.has(targetId)) { sendJSON(res, 404, { error: 'not-a-member' }); return null; }
    return targetId;
  };

  // -- handlers ------------------------------------------------------------

  const createRoom = (req, res) => {
    const refusal = rooms.refuseCreation(clientIp(req));
    if (refusal === 'server-full') return sendJSON(res, 503, { error: 'server-full' });
    if (refusal) return sendJSON(res, 429, { error: 'rate-limited' });
    return sendJSON(res, 200, { roomId: rooms.create().id });
  };

  // Lets the room page tell "this room doesn't exist" apart from "the network
  // is flaky" — EventSource reports both as a bare error event.
  const roomInfo = (req, res, id) => {
    const room = roomOr404(res, id);
    if (!room) return;
    sendJSON(res, 200, {
      exists: true,
      isSharing: room.isSharing,
      listenerCount: room.members.length,
      locked: room.locked,
    });
  };

  const events = (req, res, id, url) => {
    const room = roomOr404(res, id);
    if (!room) return;
    const clientId = url.searchParams.get('clientId');
    const secret = url.searchParams.get('secret');

    const refusal = room.refuseReason(clientId, secret);
    if (refusal) {
      const [status, error] = JOIN_REFUSALS[refusal];
      return sendJSON(res, status, { error });
    }

    const connection = openSseStream(req, res, {
      onClose: (closed) => room.markDisconnected(clientId, closed),
    });
    return room.join(clientId, secret, connection);
  };

  const sharing = withAuth({ hostOnly: true }, (room, body, res) => {
    room.setSharing(body.action === 'start');
    sendJSON(res, 200, { ok: true });
  });

  const nowPlaying = withAuth({ hostOnly: true }, (room, body, res) => {
    sendJSON(res, 200, { ok: true, text: room.setNowPlaying(body.text) });
  });

  const settings = withAuth({ hostOnly: true }, (room, body, res) => {
    sendJSON(res, 200, { ok: true, ...room.updateSettings(body) });
  });

  const kick = withAuth({ hostOnly: true }, (room, body, res) => {
    const targetId = target(room, body, res);
    if (!targetId) return;
    room.kick(targetId);
    sendJSON(res, 200, { ok: true });
  });

  const transferHost = withAuth({ hostOnly: true }, (room, body, res) => {
    const targetId = target(room, body, res);
    if (!targetId) return;
    room.transferHostTo(targetId);
    sendJSON(res, 200, { ok: true });
  });

  const react = withAuth({}, (room, body, res) => {
    const refusal = room.react(body.clientId, body.kind);
    if (refusal === 'unknown-reaction') return sendJSON(res, 400, { error: refusal });
    if (refusal === 'too-fast') return sendJSON(res, 429, { error: refusal });
    return sendJSON(res, 200, { ok: true });
  });

  const rename = withAuth({}, (room, body, res) => {
    sendJSON(res, 200, { ok: true, name: room.rename(body.clientId, body.name) });
  });

  // Relays one WebRTC signaling message (offer / answer / ICE candidate).
  const signal = (req, res, id) => {
    const room = roomOr404(res, id);
    if (!room) return;
    readJSONBody(req, res, (err, body) => {
      if (err) return sendJSON(res, 400, { error: 'bad-json' });
      const { clientId, secret, to, type, payload } = body;
      if (!to || !type) return sendJSON(res, 400, { error: 'missing fields' });
      if (!clientId || !secret) return sendJSON(res, 400, { error: 'missing credentials' });
      if (!room.verify(clientId, secret)) return sendJSON(res, 403, { error: 'bad-credentials' });

      const refusal = room.relaySignal(clientId, to, type, payload);
      if (refusal) {
        const [status, error] = SIGNAL_REFUSALS[refusal];
        return sendJSON(res, status, { error });
      }
      return sendJSON(res, 200, { ok: true });
    });
  };

  // -- table ---------------------------------------------------------------

  const ROOM = '([A-Z0-9]+)';
  const routes = [
    ['POST', /^\/api\/rooms$/, createRoom],
    ['GET', /^\/api\/ice$/, (req, res) => sendJSON(res, 200, { iceServers: iceServers() })],
    ['GET', new RegExp(`^/api/rooms/${ROOM}$`, 'i'), roomInfo],
    ['GET', new RegExp(`^/api/rooms/${ROOM}/events$`, 'i'), events],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/sharing$`, 'i'), sharing],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/signal$`, 'i'), signal],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/now-playing$`, 'i'), nowPlaying],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/settings$`, 'i'), settings],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/kick$`, 'i'), kick],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/host$`, 'i'), transferHost],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/reaction$`, 'i'), react],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/name$`, 'i'), rename],
  ];

  return function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const match = pathname.match(pattern);
      if (match) return handler(req, res, (match[1] || '').toUpperCase(), url);
    }

    const isRead = req.method === 'GET' || req.method === 'HEAD';
    // Every room code renders the same page; the code itself is read from the
    // URL by the client.
    if (isRead && /^\/r\/[A-Z0-9]+$/i.test(pathname)) {
      return serveStatic(res, '/room.html', req.method, originOf(req));
    }
    if (isRead) return serveStatic(res, pathname, req.method, originOf(req));

    res.writeHead(404);
    return res.end('not found');
  };
}
