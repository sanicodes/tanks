// Socket.IO wiring + room registry. Validates/clamps all client input and
// enforces caps (max rooms, players/room, room-create rate limit).

import { Room } from './Room.js';
import { MAX_ROOMS, ROOM_CREATE_COOLDOWN_MS, MAX_PASSWORD_LEN } from '../shared/constants.js';

const cleanPassword = (p) =>
  typeof p === 'string' && p.trim() ? p.trim().slice(0, MAX_PASSWORD_LEN) : null;

let _roomSeq = 1;
const roomId = () => `r${_roomSeq++}-${Math.random().toString(36).slice(2, 6)}`;

class Registry {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }
  list() {
    return [...this.rooms.values()].map((r) => r.summary());
  }
  create(name, opts = {}) {
    if (this.rooms.size >= MAX_ROOMS) return null;
    const id = roomId();
    const room = new Room(this.io, { id, name: (name || 'Room').slice(0, 24), ...opts });
    this.rooms.set(id, room);
    return room;
  }
  get(id) {
    return this.rooms.get(id);
  }
  destroy(id) {
    const room = this.rooms.get(id);
    if (!room) return;
    room.stop();
    this.rooms.delete(id);
  }
}

export function wireSockets(io) {
  const registry = new Registry(io);
  const emitLobby = () => io.to('lobby').emit('lobby:rooms', registry.list());

  function leaveRoom(socket) {
    const id = socket.data.roomId;
    if (!id) return;
    const room = registry.get(id);
    socket.leave(id);
    socket.data.roomId = null;
    if (room) {
      room.removePlayer(socket.id);
      if (room.count === 0) registry.destroy(id);
    }
    emitLobby();
  }

  io.on('connection', (socket) => {
    socket.data.roomId = null;
    socket.data.lastCreate = 0;

    // --- lobby ---
    socket.on('lobby:join', () => {
      socket.join('lobby');
      socket.emit('lobby:rooms', registry.list());
    });
    socket.on('lobby:leave', () => socket.leave('lobby'));
    socket.on('lobby:list', (cb) => {
      if (typeof cb === 'function') cb(registry.list());
    });

    // --- create / join / leave ---
    socket.on('room:create', ({ name, playerName, password } = {}, cb) => {
      const now = Date.now();
      if (now - socket.data.lastCreate < ROOM_CREATE_COOLDOWN_MS) {
        if (typeof cb === 'function') cb({ error: 'Slow down — creating too fast.' });
        return;
      }
      socket.data.lastCreate = now;
      const room = registry.create(name, { password: cleanPassword(password) });
      if (!room) {
        if (typeof cb === 'function') cb({ error: 'Server is at room capacity.' });
        return;
      }
      doJoin(socket, room, playerName, cb);
    });

    socket.on('room:join', ({ roomId: rid, playerName, password } = {}, cb) => {
      const room = registry.get(rid);
      if (!room) {
        if (typeof cb === 'function') cb({ error: 'Room not found.' });
        return;
      }
      if (room.isFull()) {
        if (typeof cb === 'function') cb({ error: 'Room is full.' });
        return;
      }
      if (room.password && cleanPassword(password) !== room.password) {
        if (typeof cb === 'function') cb({ error: 'Wrong password.', locked: true });
        return;
      }
      doJoin(socket, room, playerName, cb);
    });

    function doJoin(socket, room, playerName, cb) {
      leaveRoom(socket);
      socket.leave('lobby');
      socket.join(room.id);
      socket.data.roomId = room.id;
      room.addPlayer(socket.id, playerName);
      if (typeof cb === 'function') cb({ ok: true, roomId: room.id, selfId: socket.id });
      emitLobby();
    }

    socket.on('room:leave', () => {
      leaveRoom(socket);
      socket.join('lobby');
      socket.emit('lobby:rooms', registry.list());
    });

    // --- gameplay ---
    socket.on('input', (input) => {
      const room = registry.get(socket.data.roomId);
      if (room && input && typeof input === 'object') room.setInput(socket.id, input);
    });

    socket.on('team', ({ team } = {}) => {
      const room = registry.get(socket.data.roomId);
      if (room) {
        room.setTeam(socket.id, team);
        emitLobby();
      }
    });

    socket.on('class', ({ cls } = {}) => {
      const room = registry.get(socket.data.roomId);
      if (room) room.setClass(socket.id, cls);
    });

    socket.on('room:start', () => {
      const room = registry.get(socket.data.roomId);
      if (room) {
        room.startMatch(socket.id);
        emitLobby();
      }
    });

    socket.on('room:shuffle', () => {
      const room = registry.get(socket.data.roomId);
      if (room) room.shuffleTeams(socket.id);
    });

    socket.on('room:settings', (settings) => {
      const room = registry.get(socket.data.roomId);
      if (room && settings && typeof settings === 'object') room.setSettings(socket.id, settings);
    });

    socket.on('rematch', () => {
      const room = registry.get(socket.data.roomId);
      if (room) {
        room.rematch(socket.id);
        emitLobby();
      }
    });

    socket.on('disconnect', () => leaveRoom(socket));
  });

  return registry;
}
