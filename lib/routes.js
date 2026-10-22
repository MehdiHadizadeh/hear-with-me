// The HTTP surface: one table of routes, and handlers thin enough that the
// interesting logic all lives on the Room.

import { timingSafeEqual } from 'node:crypto';
import {
  API_REQUESTS_PER_MINUTE,
  METRIC_EVENTS_PER_MINUTE,
  MAX_RELAY_CHUNK_BYTES,
  ROOM_LOOKUPS_PER_MINUTE,
  STATS_TOKEN,
  iceServers,
} from './config.js';
import {
  clientIp, escapeHtml, originOf, readBinaryBody, readJSONBody, sendJSON, serveStatic,
} from './http.js';
import { openSseStream } from './sse.js';
import { keepFresh, RELAY_FORMATS } from '../public/shared/relay-framing.js';
import { roomPreview } from '../public/shared/preview.js';

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

const RELAY_REFUSALS = {
  'not-sharing': 409,
  'relay-disabled': 403,
  'no-relay': 409,
  'is-host': 400,
};

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createRouter(rooms, { limiter, metrics } = {}) {
  const allow = (bucket, req, limit) => !limiter || limiter.hit(bucket, clientIp(req), limit);
  const record = (event, props) => { if (metrics) metrics.record(event, props); };

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
    record('room-created');
    return sendJSON(res, 200, { roomId: rooms.create().id });
  };

  // Lets the room page tell "this room doesn't exist" apart from "the network
  // is flaky" — EventSource reports both as a bare error event.
  const roomInfo = (req, res, id) => {
    if (!allow('lookup', req, ROOM_LOOKUPS_PER_MINUTE)) return sendJSON(res, 429, { error: 'rate-limited' });
    const room = roomOr404(res, id);
    if (!room) return;
    sendJSON(res, 200, room.publicInfo());
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
    const on = body.action === 'start';
    room.setSharing(on, { relayFormat: body.relayFormat, source: body.source, direct: body.direct });
    if (on) record('share-started', { source: room.shareSource });
    sendJSON(res, 200, { ok: true, relayFormat: room.relay.format });
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

  // { url } starts a track, { clear: true } ends it, anything else is the
  // player's position.
  const track = withAuth({ hostOnly: true }, (room, body, res) => {
    if (body.clear) { room.clearTrack(); return sendJSON(res, 200, { ok: true, track: null }); }
    if (typeof body.url === 'string') {
      const set = room.setTrack(body.url, body.via);
      if (!set) return sendJSON(res, 400, { error: 'unsupported-link' });
      record('share-started', { source: 'link' });
      return sendJSON(res, 200, { ok: true, track: set });
    }
    const updated = room.updateTrack(body);
    return updated ? sendJSON(res, 200, { ok: true, track: updated }) : sendJSON(res, 409, { error: 'no-track' });
  });

  const leave = withAuth({}, (room, body, res) => {
    room.leave(body.clientId);
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

  // -- the screen-off relay ------------------------------------------------

  // A listener first trades its secret for a short-lived token over a POST,
  // because the stream URL ends up in an <audio src> — and from there in
  // history, logs and proxies — where a secret has no business being.
  const relayToken = withAuth({}, (room, body, res) => {
    const refusal = room.relayRefusal(body.clientId);
    if (refusal) return sendJSON(res, RELAY_REFUSALS[refusal], { error: refusal });
    return sendJSON(res, 200, { token: room.issueRelayToken(body.clientId), format: room.relay.format });
  });

  const relayListen = (req, res, id, url) => {
    const room = roomOr404(res, id);
    if (!room) return;
    const clientId = room.relayTokenOwner(url.searchParams.get('t'));
    if (!clientId) return sendJSON(res, 403, { error: 'bad-token' });
    const refusal = room.relayRefusal(clientId);
    if (refusal) return sendJSON(res, RELAY_REFUSALS[refusal], { error: refusal });

    // An endless file. No Content-Length and no ranges: a media element
    // treats that as a live stream and plays whatever arrives, the way it
    // plays internet radio.
    res.writeHead(200, {
      'Content-Type': RELAY_FORMATS[room.relay.format].contentType,
      'Cache-Control': 'no-cache, no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    if (req.method === 'HEAD') return res.end();

    // Bytes wait here, not in the response's own buffer, while the listener
    // is slow: here they can be thrown away once they are too late to play
    // (shared/relay-framing.js, keepFresh).
    const queue = [];
    let blocked = false;
    const flush = () => {
      blocked = false;
      while (queue.length) {
        const { bytes } = queue.shift();
        try { if (!res.write(bytes)) { blocked = true; return; } } catch (e) { return; }
      }
    };
    res.on('drain', flush);
    const listener = {
      clientId,
      write: (bytes) => {
        queue.push({ bytes, at: Date.now() });
        if (!keepFresh(queue, room.relay.format)) { listener.end(); room.relay.removeListener(listener); return; }
        if (!blocked) flush();
      },
      end: () => { try { res.end(); } catch (e) { /* gone */ } },
    };
    room.relay.addListener(listener);
    req.on('close', () => room.relay.removeListener(listener));
    return undefined;
  };

  // The host's encoder posting a quarter second at a time. The body is audio,
  // so the credentials travel as headers.
  const relayUpload = (req, res, id, url) => {
    const room = roomOr404(res, id);
    if (!room) return;
    const clientId = req.headers['x-hwm-client'];
    if (!room.verify(clientId, req.headers['x-hwm-secret'])) return sendJSON(res, 403, { error: 'bad-credentials' });
    if (!room.isHost(clientId)) return sendJSON(res, 403, { error: 'not-host' });
    if (!room.isSharing) return sendJSON(res, 409, { error: 'not-sharing' });

    const generation = Number(url.searchParams.get('gen'));
    const seq = Number(url.searchParams.get('seq'));
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(seq) || seq < 0) {
      return sendJSON(res, 400, { error: 'bad-sequence' });
    }
    readBinaryBody(req, MAX_RELAY_CHUNK_BYTES, (chunk) => {
      if (!chunk) return sendJSON(res, 413, { error: 'chunk-too-large' });
      const refusal = room.relay.push(generation, seq, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
      if (refusal === 'no-format') return sendJSON(res, 409, { error: 'no-relay' });
      room.touch();
      return sendJSON(res, 200, { ok: true, listeners: room.relay.demand });
    });
  };

  // -- what the app counts about itself ------------------------------------

  const metric = (req, res) => {
    if (!allow('metric', req, METRIC_EVENTS_PER_MINUTE)) return sendJSON(res, 429, { error: 'rate-limited' });
    readJSONBody(req, res, (err, body) => {
      if (err || !body) return sendJSON(res, 400, { error: 'bad-json' });
      record(body.event, body.props);
      return sendJSON(res, 200, { ok: true }); // unknown events are dropped, not argued with
    });
  };

  const stats = (req, res, id, url) => {
    if (!STATS_TOKEN || !sameSecret(url.searchParams.get('token') || '', STATS_TOKEN)) {
      return sendJSON(res, 403, { error: 'forbidden' });
    }
    return sendJSON(res, 200, { rooms: rooms.size, days: metrics ? metrics.snapshot() : {} });
  };

  // -- table ---------------------------------------------------------------

  const ROOM = '([A-Z0-9]+)';
  const routes = [
    ['POST', /^\/api\/rooms$/, createRoom],
    ['GET', /^\/api\/ice$/, (req, res) => sendJSON(res, 200, { iceServers: iceServers() })],
    ['POST', /^\/api\/metrics$/, metric],
    ['GET', /^\/api\/stats$/, stats],
    ['GET', new RegExp(`^/api/rooms/${ROOM}$`, 'i'), roomInfo],
    ['GET', new RegExp(`^/api/rooms/${ROOM}/events$`, 'i'), events],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/sharing$`, 'i'), sharing],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/signal$`, 'i'), signal],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/now-playing$`, 'i'), nowPlaying],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/settings$`, 'i'), settings],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/kick$`, 'i'), kick],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/host$`, 'i'), transferHost],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/track$`, 'i'), track],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/leave$`, 'i'), leave],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/reaction$`, 'i'), react],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/name$`, 'i'), rename],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/relay-token$`, 'i'), relayToken],
    ['GET', new RegExp(`^/api/rooms/${ROOM}/relay$`, 'i'), relayListen],
    ['HEAD', new RegExp(`^/api/rooms/${ROOM}/relay$`, 'i'), relayListen],
    ['POST', new RegExp(`^/api/rooms/${ROOM}/relay$`, 'i'), relayUpload],
  ];

  return function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    if (pathname.startsWith('/api/') && !allow('api', req, API_REQUESTS_PER_MINUTE)) {
      return sendJSON(res, 429, { error: 'rate-limited' });
    }

    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const match = pathname.match(pattern);
      if (match) return handler(req, res, (match[1] || '').toUpperCase(), url);
    }

    const isRead = req.method === 'GET' || req.method === 'HEAD';
    // Every room code renders the same page; the code itself is read from the
    // URL by the client. The link preview is the one per-room part: it says
    // whose room this is, because that is what makes someone tap it.
    const roomPage = isRead && pathname.match(/^\/r\/([A-Z0-9]+)$/i);
    if (roomPage) {
      const room = allow('lookup', req, ROOM_LOOKUPS_PER_MINUTE) ? rooms.get(roomPage[1].toUpperCase()) : null;
      const preview = roomPreview(room ? room.publicInfo() : null);
      return serveStatic(res, '/room.html', req.method, originOf(req), {
        '%OG_TITLE%': escapeHtml(preview.title),
        '%OG_DESCRIPTION%': escapeHtml(preview.description),
      });
    }
    if (isRead) return serveStatic(res, pathname, req.method, originOf(req));

    res.writeHead(404);
    return res.end('not found');
  };
}
