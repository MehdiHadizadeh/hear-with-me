// Hear With Me — a tiny, dependency-free "listen together, live" server.
//
// Zero npm dependencies on purpose: only Node's built-in modules are used, so
// `node server.js` works right after cloning.
//
// Architecture (Capture / Streaming / Room / Playback):
//   - Capture:   lives entirely in the host's browser (getDisplayMedia tab or
//                system audio capture). This server never touches it.
//   - Streaming: real audio flows peer-to-peer over WebRTC, directly between
//                host and each guest. This server never sees an audio byte.
//   - Room:      THIS PROCESS. It relays small JSON signaling messages (who's
//                the host, "sharing started/stopped", SDP offers/answers/ICE)
//                over Server-Sent Events, and takes plain POSTs back.
//   - Playback:  lives entirely in each guest's browser. Any device with a
//                browser can be a guest — receiving a WebRTC stream is a
//                completely different capability from *capturing* one.
//
// This file only wires the pieces together:
//   lib/config.js  what an operator can change
//   lib/rooms.js   every room in the process, plus creation caps and sweeping
//   lib/room.js    one room's behaviour, with no HTTP in sight
//   lib/routes.js  the HTTP surface
//   lib/sse.js     the event stream a member joins through
//   lib/http.js    bodies, JSON, static files

import http from 'node:http';
import { PORT } from './lib/config.js';
import { createRouter } from './lib/routes.js';
import { Rooms } from './lib/rooms.js';

const rooms = new Rooms();
rooms.startSweeping();

const server = http.createServer(createRouter(rooms));

server.listen(PORT, () => {
  console.log(`Hear With Me listening on http://localhost:${PORT}`);
});
