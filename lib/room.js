// One room, as a thing with behaviour rather than a bag of maps that six
// free functions reach into.
//
// The Room knows nothing about HTTP. It talks to members through a small
// `connection` interface — `{ send(event, data), end() }` — which the SSE
// layer provides. That is what lets the room logic be reasoned about (and
// tested) without a socket in sight.

import { timingSafeEqual } from 'node:crypto';
import {
  DISCONNECT_GRACE_MS,
  MAX_NAME_LENGTH,
  MAX_NOW_PLAYING_LENGTH,
  REACTION_MIN_INTERVAL_MS,
} from './config.js';
import { REACTION_KINDS } from '../public/shared/reactions.js';

// Names are typed by guests and rendered in someone else's interface. Control
// characters and the bidi overrides go first: this UI is right-to-left, and a
// stray U+202E in a guest's name would reverse the host's own layout around it.
const CONTROL_AND_BIDI = /[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

export function cleanName(raw) {
  return String(raw == null ? '' : raw)
    .replace(CONTROL_AND_BIDI, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

export class Room {
  constructor(id, { graceMs = DISCONNECT_GRACE_MS, onClosed = () => {} } = {}) {
    this.id = id;
    this.graceMs = graceMs;
    this.onClosed = onClosed; // the store removes us when a room ends itself

    this.hostId = null;
    this.members = [];                  // client ids, in join order
    this.connections = new Map();       // clientId -> live SSE connection
    this.secrets = new Map();           // clientId -> secret proving a POST is theirs
    this.names = new Map();             // clientId -> the name they chose
    this.joinedAt = new Map();          // clientId -> ms epoch
    this.reactedAt = new Map();         // clientId -> ms epoch of last reaction
    this.pendingDepartures = new Map(); // clientId -> grace timer
    this.banned = new Set();

    this.isSharing = false;
    this.sharingStartedAt = null;
    this.nowPlaying = '';
    this.locked = false;
    this.closeOnHostLeave = false;

    this.everJoined = false;
    this.lastActivity = Date.now();
  }

  // -- identity ------------------------------------------------------------

  // A clientId travels in URLs and signaling messages, so it identifies a
  // member but proves nothing. The secret, sent once on joining, is what makes
  // a POST theirs — without it, anyone who knew a room code could take over
  // the host's slot or simply stop their sharing.
  knows(clientId) { return this.secrets.has(clientId); }

  verify(clientId, secret) {
    const expected = this.secrets.get(clientId);
    if (typeof expected !== 'string' || typeof secret !== 'string') return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  isHost(clientId) { return this.hostId === clientId; }
  has(clientId) { return this.members.includes(clientId); }
  get isEmpty() { return this.members.length === 0; }

  touch() { this.lastActivity = Date.now(); }

  // -- messaging -----------------------------------------------------------

  send(clientId, event, data) {
    const connection = this.connections.get(clientId);
    if (connection) connection.send(event, data);
  }

  broadcast(event, data) {
    for (const connection of this.connections.values()) connection.send(event, data);
  }

  toHost(event, data) {
    if (this.hostId) this.send(this.hostId, event, data);
  }

  // -- membership ----------------------------------------------------------

  // Why a member may not open a stream, or null if they may. Checked before
  // any state changes so a refusal leaves nothing behind.
  refuseReason(clientId, secret) {
    if (!clientId || !secret) return 'missing-credentials';
    if (this.banned.has(clientId)) return 'removed';
    if (this.knows(clientId)) return this.verify(clientId, secret) ? null : 'client-id-taken';
    // A locked room still lets its own members reconnect: the lock is about
    // who may arrive, and a phone that lost signal has already arrived.
    return this.locked ? 'room-locked' : null;
  }

  // Opening an SSE stream *is* how a client joins.
  join(clientId, secret, connection) {
    if (!this.knows(clientId)) this.secrets.set(clientId, secret);

    // Inside the grace period they were only reconnecting: cancel the pending
    // departure so they keep their place (and, for a host, the room).
    const pending = this.pendingDepartures.get(clientId);
    if (pending) { clearTimeout(pending); this.pendingDepartures.delete(clientId); }

    if (!this.has(clientId)) this.members.push(clientId);
    if (!this.joinedAt.has(clientId)) this.joinedAt.set(clientId, Date.now());
    this.connections.set(clientId, connection);
    this.everJoined = true;
    this.touch();
    if (this.hostId === null) this.hostId = clientId;

    this.send(clientId, 'welcome', this.welcome(clientId));
    this.announceRoster();
  }

  welcome(clientId) {
    return {
      isHost: this.isHost(clientId),
      isSharing: this.isSharing,
      listenerCount: this.members.length,
      members: this.roster(),
      settings: this.settings(),
      nowPlaying: this.nowPlaying,
      // Elapsed rather than a start timestamp: the client's clock may be
      // minutes off ours, and it only needs to know how long this has run.
      sharingElapsedMs: this.sharingStartedAt === null ? null : Date.now() - this.sharingStartedAt,
    };
  }

  // A dropped stream is not a departure. Start the clock instead, and say the
  // member is unreachable so the roster tells the truth in the meantime.
  markDisconnected(clientId, connection) {
    // A reconnecting EventSource usually opens its new stream before the old
    // one reports closed. If this connection is already stale, the member is
    // present right now and touching state here would evict them.
    if (this.connections.get(clientId) !== connection) return;
    this.connections.delete(clientId);
    this.touch();

    const timer = setTimeout(() => this.finalizeDeparture(clientId), this.graceMs);
    if (timer.unref) timer.unref(); // never hold the process open for this
    this.pendingDepartures.set(clientId, timer);
    this.broadcast('members', { members: this.roster() });
  }

  finalizeDeparture(clientId) {
    this.pendingDepartures.delete(clientId);
    if (this.connections.has(clientId)) return; // came back

    const wasHost = this.isHost(clientId);
    this.forget(clientId);

    if (!wasHost) {
      // Tell the host so it can close that peer connection.
      this.toHost('peer-left', { clientId });
      this.announceRoster();
      return;
    }

    // The host really left, so sharing stops with them — their captured
    // stream died with their browser tab.
    this.stopSharing();

    // Promoting the first guest hands a stranger's room to whoever happened to
    // join first, which is not always what the host wanted. So it is the
    // host's own choice, made before they leave.
    if (this.closeOnHostLeave) return this.close('host-left');

    this.hostId = this.members[0] || null;
    this.broadcast('sharing-stopped', { reason: 'host-left' });
    if (this.hostId) {
      this.send(this.hostId, 'you-are-host', { reason: 'host-left' });
      this.broadcast('host-changed', { hostId: this.hostId });
    }
    this.announceRoster();
  }

  // Removes every trace of a member without deciding what it means.
  forget(clientId) {
    this.members = this.members.filter((m) => m !== clientId);
    this.secrets.delete(clientId);
    this.names.delete(clientId);
    this.joinedAt.delete(clientId);
    this.reactedAt.delete(clientId);
    this.touch();
  }

  // Removing someone on purpose. No grace period: this one isn't a dropped
  // connection, it's a decision.
  evict(clientId, reason) {
    const connection = this.connections.get(clientId);
    if (connection) {
      connection.send('evicted', { reason });
      this.connections.delete(clientId);
      connection.end();
    }
    const pending = this.pendingDepartures.get(clientId);
    if (pending) { clearTimeout(pending); this.pendingDepartures.delete(clientId); }
    this.forget(clientId);

    // `force`, because the host normally ignores a departure while the peer
    // connection still looks healthy — that check exists for phones whose
    // event stream drops, and it would keep a removed guest listening.
    this.toHost('peer-left', { clientId, force: true });
    this.announceRoster();
  }

  kick(clientId) {
    this.banned.add(clientId);
    this.evict(clientId, 'kicked');
  }

  // Ends the room for everyone at once, rather than leaving each client to
  // discover the 404 on its own schedule.
  close(reason) {
    this.broadcast('room-closed', { reason });
    for (const connection of this.connections.values()) connection.end();
    for (const timer of this.pendingDepartures.values()) clearTimeout(timer);
    this.connections.clear();
    this.pendingDepartures.clear();
    this.onClosed(this);
  }

  // -- roster --------------------------------------------------------------

  // The host needs to know *who* is here, not just how many, or there is
  // nobody to point "remove" and "make host" at.
  roster() {
    const now = Date.now();
    return this.members.map((id) => ({
      id,
      isHost: this.isHost(id),
      connected: this.connections.has(id),
      name: this.names.get(id) || '',
      // Elapsed, not a timestamp: the receiving clock may be off, and "joined
      // 6 minutes ago" is how you tell two nameless guests apart.
      joinedMsAgo: Math.max(0, now - (this.joinedAt.get(id) || now)),
    }));
  }

  announceRoster() {
    this.broadcast('listener-count', { count: this.members.length });
    this.broadcast('members', { members: this.roster() });
  }

  rename(clientId, rawName) {
    const name = cleanName(rawName);
    if (name) this.names.set(clientId, name);
    else this.names.delete(clientId);
    this.touch();
    this.broadcast('members', { members: this.roster() });
    return name;
  }

  // -- what the host controls ----------------------------------------------

  settings() {
    return { locked: this.locked, closeOnHostLeave: this.closeOnHostLeave };
  }

  updateSettings({ locked, closeOnHostLeave }) {
    if (typeof locked === 'boolean') this.locked = locked;
    if (typeof closeOnHostLeave === 'boolean') this.closeOnHostLeave = closeOnHostLeave;
    this.touch();
    this.broadcast('room-settings', this.settings());
    return this.settings();
  }

  startSharing() {
    this.isSharing = true;
    this.sharingStartedAt = Date.now();
    // A "now playing" label belongs to one sharing session, so each start
    // begins with a blank one rather than inheriting the last session's.
    this.nowPlaying = '';
    this.touch();
  }

  stopSharing() {
    this.isSharing = false;
    this.sharingStartedAt = null;
    this.nowPlaying = '';
    this.touch();
  }

  setSharing(on) {
    if (on) this.startSharing(); else this.stopSharing();
    this.broadcast(on ? 'sharing-started' : 'sharing-stopped', { reason: 'host-action' });
  }

  // Nothing detects this automatically: no browser API lets a page read what
  // another tab is playing, and the audio can just as easily come from a
  // native app, where no metadata exists at all.
  setNowPlaying(text) {
    this.nowPlaying = String(text == null ? '' : text)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NOW_PLAYING_LENGTH);
    this.touch();
    this.broadcast('now-playing', { text: this.nowPlaying });
    return this.nowPlaying;
  }

  // Handing the room over. Sharing always stops: the stream belonged to the
  // old host's browser and cannot be handed over with the title.
  transferHostTo(clientId) {
    this.hostId = clientId;
    this.stopSharing();
    this.broadcast('sharing-stopped', { reason: 'host-changed' });
    this.broadcast('host-changed', { hostId: clientId });
    // The reason is not decoration: "the host left" and "the host handed it to
    // you" call for different next steps from whoever now holds the room.
    this.send(clientId, 'you-are-host', { reason: 'transfer' });
    this.announceRoster();
  }

  // -- the guest's back channel --------------------------------------------

  react(clientId, kind) {
    if (!REACTION_KINDS.includes(kind)) return 'unknown-reaction';
    const now = Date.now();
    if (now - (this.reactedAt.get(clientId) || 0) < REACTION_MIN_INTERVAL_MS) return 'too-fast';
    this.reactedAt.set(clientId, now);
    this.lastActivity = now;
    this.broadcast('reaction', { from: clientId, kind });
    return null;
  }

  // -- signaling -----------------------------------------------------------

  // `to` is either the literal "host" (any guest addressing the current host)
  // or a specific guest's id, which only the host may address.
  relaySignal(from, to, type, payload) {
    const targetId = to === 'host' ? this.hostId : to;
    if (to !== 'host' && !this.isHost(from)) return 'not-host';
    if (!targetId || !this.connections.has(targetId)) return 'target-not-connected';
    this.touch();
    this.send(targetId, 'signal', { from, type, payload });
    return null;
  }
}
