// Every room the process is holding, plus the two policies that keep that
// collection from growing forever: a sweeper and a cap on creation.

import { randomInt } from 'node:crypto';
import { ALPHABET, LENGTH } from '../public/shared/room-code.js';
import { Room } from './room.js';
import {
  MAX_ROOMS,
  ROOMS_PER_IP,
  ROOMS_PER_IP_WINDOW_MS,
  ROOM_TTL_MS,
  SWEEP_INTERVAL_MS,
  UNJOINED_ROOM_TTL_MS,
} from './config.js';

export class Rooms {
  constructor({ graceMs } = {}) {
    this.rooms = new Map();
    this.creationsByIp = new Map(); // ip -> creation timestamps inside the window
    this.graceMs = graceMs;
    this.sweeper = null;
  }

  get size() { return this.rooms.size; }
  get(id) { return this.rooms.get(id); }
  delete(id) { return this.rooms.delete(id); }

  makeId() {
    let id;
    do {
      id = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    } while (this.rooms.has(id));
    return id;
  }

  create() {
    const id = this.makeId();
    const room = new Room(id, {
      ...(this.graceMs === undefined ? {} : { graceMs: this.graceMs }),
      onClosed: (closed) => this.rooms.delete(closed.id),
    });
    this.rooms.set(id, room);
    return room;
  }

  // Null when the caller may create another room, or the reason they may not.
  refuseCreation(ip) {
    if (this.rooms.size >= MAX_ROOMS) return 'server-full';
    const now = Date.now();
    const recent = (this.creationsByIp.get(ip) || []).filter((t) => now - t < ROOMS_PER_IP_WINDOW_MS);
    if (recent.length >= ROOMS_PER_IP) {
      this.creationsByIp.set(ip, recent);
      return 'rate-limited';
    }
    recent.push(now);
    this.creationsByIp.set(ip, recent);
    return null;
  }

  sweep(now = Date.now()) {
    for (const [id, room] of this.rooms) {
      if (!room.isEmpty) continue;
      const ttl = room.everJoined ? ROOM_TTL_MS : UNJOINED_ROOM_TTL_MS;
      if (now - room.lastActivity > ttl) this.rooms.delete(id);
    }
    for (const [ip, stamps] of this.creationsByIp) {
      const recent = stamps.filter((t) => now - t < ROOMS_PER_IP_WINDOW_MS);
      if (recent.length === 0) this.creationsByIp.delete(ip);
      else this.creationsByIp.set(ip, recent);
    }
  }

  startSweeping() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  stopSweeping() {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
  }
}
