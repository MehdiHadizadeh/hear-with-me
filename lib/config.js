// Every knob this deployment has, read once from the environment.
//
// Kept apart from the code that uses it so that "what can an operator change?"
// is one short file rather than a grep across the server.

const num = (name, fallback) => Number(process.env[name]) || fallback;

export const PORT = process.env.PORT || 3000;

export const ROOM_ID_ALPHABET = '346789ABCDEFGHJKLMNPQRTUVWXYZ'; // no ambiguous chars
export const ROOM_ID_LENGTH = 6; // ~29^6 codes; typeable, not trivially guessable

// Idle and empty rooms are swept after this.
export const ROOM_TTL_MS = num('ROOM_TTL_MS', 6 * 60 * 60 * 1000);

// A room nobody ever opened is either a misclick or a script. Keeping it for
// the full TTL is what let `POST /api/rooms` in a loop pin memory for six
// hours, so an unvisited room is swept far sooner than a used one.
export const UNJOINED_ROOM_TTL_MS = num('UNJOINED_ROOM_TTL_MS', 15 * 60 * 1000);
export const SWEEP_INTERVAL_MS = num('SWEEP_INTERVAL_MS', 2 * 60 * 1000);

// Creating a room costs one POST and no proof of anything. These two caps are
// not abuse "protection" in any serious sense — they only stop a single bored
// client from filling the process's memory.
export const MAX_ROOMS = num('MAX_ROOMS', 500);
export const ROOMS_PER_IP = num('ROOMS_PER_IP', 12);
export const ROOMS_PER_IP_WINDOW_MS = num('ROOMS_PER_IP_WINDOW_MS', 10 * 60 * 1000);

// An SSE connection drops for boring reasons all the time: the laptop sleeps,
// wifi blips, a proxy times the stream out. EventSource silently reconnects a
// few seconds later, so a drop is NOT evidence that the member left. Treating
// it as a departure used to stop the sharing and hand the room to a guest on
// every hiccup, so a departure is only finalized after this grace period with
// no reconnect. (Overridable so tests don't sit through the real one.)
export const DISCONNECT_GRACE_MS = num('DISCONNECT_GRACE_MS', 10 * 1000);

export const SSE_KEEPALIVE_MS = num('SSE_KEEPALIVE_MS', 20 * 1000);

// Reactions are cheap on purpose, but one per client per second is already
// more than anyone reads.
export const REACTION_MIN_INTERVAL_MS = num('REACTION_MIN_INTERVAL_MS', 900);

export const MAX_NAME_LENGTH = 24;
export const MAX_NOW_PLAYING_LENGTH = 120;
export const MAX_BODY_BYTES = 200 * 1024; // signaling payloads are SDP text; this is generous

// ICE is configuration, not code: hardcoding it in the client meant adding a
// TURN server later required editing (and cache-busting) the browser bundle.
// The client asks for this at startup instead.
export function iceServers() {
  const servers = [{ urls: (process.env.STUN_URL || 'stun:stun.l.google.com:19302').split(',') }];
  // Without TURN, a small fraction of very restrictive NATs cannot connect at
  // all. Set TURN_URL/TURN_USERNAME/TURN_PASSWORD to add one.
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_PASSWORD || '',
    });
  }
  return servers;
}
