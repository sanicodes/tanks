// One game room. Phases: lobby -> countdown -> play -> (roundend) -> ended.
// In `lobby`, players pick team + tank class and the OWNER configures the match;
// the 60 Hz loop runs only while a match is live. The server is the sole source
// of truth — clients send inputs (movement, aim, and shot requests), never positions.
//
// Modes:
//   tdm  Team Deathmatch — red vs blue, respawns on, first team to frag limit.
//   ffa  Free-for-all    — everyone hostile, respawns on, first player to frag limit.
//   lts  Last Tank Standing — team elimination rounds, no respawn; first to N rounds.

import { stepTanks, circleHitsBox, clamp } from '../shared/physics.js';
import { ARENAS, getArena } from '../shared/arenas.js';
import { makeTank, makeBullet, applyTankInput, classSpec } from '../shared/factory.js';
import {
  SNAPSHOT_HZ, SOLVER_PASSES, CLASS_KEYS, TANK_CLASSES, DEFAULT_CLASS,
  FRAG_LIMIT, TIME_LIMIT_MS, COUNTDOWN_MS, END_SCREEN_MS,
  FOG_DEFAULT,
  RESPAWN_MS, REGEN_DELAY_MS, REGEN_PER_SEC, SPAWN_PROTECT_MS, KNOCKBACK,
  SPLASH_MIN_FRAC, LTS_ROUND_WINS, LTS_ROUND_END_MS,
  PICKUP_TYPES, PICKUP_RADIUS, PICKUP_FIRST_MS, PICKUP_RESPAWN_MS,
  HEALTH_PICKUP_AMOUNT, SHIELD_MS, RAPID_MS, RAPID_RELOAD_MULT, DAMAGE_MS, DAMAGE_MULT,
  MAX_PLAYERS_PER_ROOM,
} from '../shared/constants.js';

const TICK_HZ = 60;
const MS_PER_TICK = 1000 / TICK_HZ;
const SNAPSHOT_EVERY = Math.round(TICK_HZ / SNAPSHOT_HZ);
const msToTicks = (ms) => Math.round((ms / 1000) * TICK_HZ);

const MODES = ['tdm', 'ffa', 'lts'];
const MAX_FRAG_LIMIT = 100; // 0 = unlimited
const MIN_TIME_MS = 60 * 1000;
const MAX_TIME_MS = 30 * 60 * 1000; // 0 = unlimited

export class Room {
  constructor(io, { id, name, arenaKey = 'crossfire', password = null }) {
    this.io = io;
    this.id = id;
    this.name = name;
    this.password = password || null;

    const aKey = ARENAS[arenaKey] ? arenaKey : 'crossfire';
    this.settings = {
      mode: 'tdm',
      arenaKey: aKey,
      fragLimit: FRAG_LIMIT,
      timeLimitMs: TIME_LIMIT_MS,
      fog: FOG_DEFAULT,
    };
    this.arena = getArena(aKey);

    this.players = new Map(); // socketId -> player (insertion order = join order)
    this.ownerId = null;
    this.bullets = [];
    this.pickups = [];

    this.state = 'lobby';
    this.stateTicks = 0;
    this.elapsedMs = 0;
    this.tick = 0;
    this.roundNo = 0;
    this.roundActive = false;
    this.roundWins = { red: 0, blue: 0 };
    this.lastRoundWinner = null;

    this.loop = null;
    this.endTimer = null;
  }

  get mode() {
    return this.settings.mode;
  }
  get count() {
    return this.players.size;
  }
  isFull() {
    return this.players.size >= MAX_PLAYERS_PER_ROOM;
  }
  isOwner(id) {
    return this.ownerId === id;
  }
  _isLive() {
    return this.state === 'play' || this.state === 'countdown' || this.state === 'roundend';
  }

  // tank bodies the engine simulates: playing, has a tank, and not destroyed
  get activeTanks() {
    const out = [];
    for (const p of this.players.values()) if (this._isActive(p)) out.push(p.tank);
    return out;
  }
  _isActive(p) {
    return p.team !== 'spec' && p.tank && !p.dead;
  }

  _teamCounts() {
    const c = { red: 0, blue: 0, ffa: 0 };
    for (const p of this.players.values()) if (p.team in c) c[p.team]++;
    return c;
  }
  _playingCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.team !== 'spec') n++;
    return n;
  }
  _aliveCount(team) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team && this._isActive(p)) n++;
    return n;
  }
  _teamKills() {
    const k = { red: 0, blue: 0 };
    for (const p of this.players.values()) if (p.team in k) k[p.team] += p.kills;
    return k;
  }
  _topKills() {
    let m = 0;
    for (const p of this.players.values()) if (p.team !== 'spec' && p.kills > m) m = p.kills;
    return m;
  }
  _isEnemy(a, b) {
    if (a === b) return false;
    return this.mode === 'ffa' ? true : a.team !== b.team;
  }
  _canHit(bullet, target) {
    if (target.id === bullet.owner) return false;
    return this.mode === 'ffa' ? true : target.team !== bullet.team;
  }
  _hasBuff(p, key) {
    return (p.buffs?.[key] || 0) > this.tick;
  }
  _activeBuffs(p) {
    const out = [];
    if (!p.buffs) return out;
    for (const k of Object.keys(p.buffs)) if (p.buffs[k] > this.tick) out.push(k);
    return out;
  }

  // ---------------------------------------------------------------- players
  addPlayer(socketId, name) {
    const player = {
      id: socketId,
      name: (name || 'Player').slice(0, 16),
      team: 'spec',
      cls: DEFAULT_CLASS,
      input: { u: false, d: false, l: false, r: false, fire: false, aim: 0, shotSeq: 0 },
      tank: null,
      dead: false,
      respawnAt: 0,
      reloadUntil: 0,
      seenShotSeq: 0,
      protectUntil: 0,
      lastHitAt: 0,
      buffs: {},
      kills: 0,
      deaths: 0,
      score: 0,
    };
    this.players.set(socketId, player);
    if (!this.ownerId) this.ownerId = socketId;
    this.sendRoom();
    return player;
  }

  removePlayer(socketId) {
    const wasOwner = this.ownerId === socketId;
    this.players.delete(socketId);
    if (this.players.size === 0) {
      this._clearEndTimer();
      this.stop();
      return;
    }
    if (wasOwner) this.ownerId = this.players.keys().next().value;
    if (this._isLive()) {
      if (this._endIfForfeit()) return;
      if (this.mode === 'lts') this._checkRound();
      this.sendInit();
      this.sendScores();
    }
    this.sendRoom();
  }

  setInput(socketId, input) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.input.u = !!input.u;
    p.input.d = !!input.d;
    p.input.l = !!input.l;
    p.input.r = !!input.r;
    p.input.fire = !!input.fire;
    if (typeof input.aim === 'number' && Number.isFinite(input.aim)) p.input.aim = input.aim;
    if (typeof input.shotSeq === 'number' && Number.isFinite(input.shotSeq)) {
      const seq = Math.max(0, Math.floor(input.shotSeq));
      if (seq > p.input.shotSeq) p.input.shotSeq = seq;
    }
  }

  setTeam(socketId, team) {
    const p = this.players.get(socketId);
    if (!p || this.state !== 'lobby') return;
    const valid = this.mode === 'ffa' ? ['ffa', 'spec'] : ['red', 'blue', 'spec'];
    if (!valid.includes(team)) return;
    p.team = team;
    this.sendRoom();
  }

  setClass(socketId, cls) {
    const p = this.players.get(socketId);
    if (!p || !TANK_CLASSES[cls]) return;
    p.cls = cls;
    this.sendRoom();
  }

  shuffleTeams(socketId) {
    if (!this.isOwner(socketId) || this.state !== 'lobby' || this.mode === 'ffa') return;
    const pool = [...this.players.values()];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    pool.forEach((p, i) => (p.team = i % 2 === 0 ? 'red' : 'blue'));
    this.sendRoom();
  }

  // ---------------------------------------------------------------- owner actions
  setSettings(socketId, s = {}) {
    if (!this.isOwner(socketId) || this.state !== 'lobby') return;
    if (MODES.includes(s.mode) && s.mode !== this.mode) this._setMode(s.mode);
    if (s.arenaKey !== undefined && ARENAS[s.arenaKey]) {
      this.settings.arenaKey = s.arenaKey;
      this.arena = getArena(s.arenaKey);
    }
    if (s.fragLimit !== undefined) {
      this.settings.fragLimit = clamp(Math.round(+s.fragLimit) || 0, 0, MAX_FRAG_LIMIT);
    }
    if (s.timeLimitMs !== undefined) {
      const t = Math.round(+s.timeLimitMs) || 0;
      this.settings.timeLimitMs = t === 0 ? 0 : clamp(t, MIN_TIME_MS, MAX_TIME_MS);
    }
    if (s.fog !== undefined) this.settings.fog = !!s.fog;
    this.sendRoom();
  }

  // switching modes reconciles every player's team with the new mode
  _setMode(mode) {
    this.settings.mode = mode;
    if (mode === 'ffa') {
      for (const p of this.players.values()) if (p.team === 'red' || p.team === 'blue') p.team = 'ffa';
    } else {
      // place anyone who was in FFA onto the smaller team
      for (const p of this.players.values()) {
        if (p.team !== 'ffa') continue;
        const c = this._teamCounts();
        p.team = c.red <= c.blue ? 'red' : 'blue';
      }
    }
  }

  startMatch(socketId) {
    if (!this.isOwner(socketId) || this.state !== 'lobby') return;
    if (!this._enoughToStart()) return;
    this._resetStats();
    this.elapsedMs = 0;
    this.roundNo = 0;
    this.roundWins = { red: 0, blue: 0 };
    this._enterCountdown();
  }

  rematch(socketId) {
    if (!this.isOwner(socketId) || this.state !== 'ended') return;
    this._clearEndTimer();
    this._resetStats();
    this.elapsedMs = 0;
    this.roundNo = 0;
    this.roundWins = { red: 0, blue: 0 };
    this._enterCountdown();
  }

  _enoughToStart() {
    if (this.mode === 'ffa') return this._playingCount() >= 2;
    const c = this._teamCounts();
    return c.red >= 1 && c.blue >= 1;
  }

  _resetStats() {
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.score = 0;
    }
  }

  // ---------------------------------------------------------------- spawning
  _spawnFor(player) {
    const a = this.arena;
    if (this.mode === 'ffa') {
      return a.spawnFFA[Math.floor(Math.random() * a.spawnFFA.length)];
    }
    const spawns = player.team === 'blue' ? a.spawnBlue : a.spawnRed;
    let idx = 0;
    for (const p of this.players.values()) {
      if (p === player) break;
      if (p.team === player.team) idx++;
    }
    return spawns[idx % spawns.length];
  }

  _placeTank(player, spawn) {
    const [x, y, a = 0] = spawn;
    if (!player.tank || player.tank.cls !== player.cls) {
      player.tank = makeTank(player.cls, player.team, x, y, a);
    }
    const t = player.tank;
    t.team = player.team;
    t.x = x;
    t.y = y;
    t.vx = 0;
    t.vy = 0;
    t.hull = a;
    t.turret = a;
    t.hp = t.maxHp;
    player.dead = false;
    player.buffs = {};
    player.reloadUntil = this.tick;
    player.seenShotSeq = player.input?.shotSeq || 0;
    player.protectUntil = this.tick + msToTicks(SPAWN_PROTECT_MS);
    player.lastHitAt = this.tick;
  }

  _placeAll() {
    for (const p of this.players.values()) {
      if (p.team !== 'spec') this._placeTank(p, this._spawnFor(p));
    }
  }

  _resetPickups() {
    this.pickups = this.arena.pads.map(([x, y]) => ({
      x, y, type: null, timer: msToTicks(PICKUP_FIRST_MS),
    }));
  }

  // ---------------------------------------------------------------- loop
  stop() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }
  _clearEndTimer() {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
  }

  _enterCountdown() {
    this._clearEndTimer();
    this.bullets = [];
    this._resetPickups();
    this._placeAll();
    this.state = 'countdown';
    this.stateTicks = msToTicks(COUNTDOWN_MS);
    if (this.mode === 'lts') this.roundActive = false;
    this.sendInit();
    this.broadcastState();
    this.sendScores();
    if (!this.loop) this.loop = setInterval(() => this._frame(), MS_PER_TICK);
  }

  _enterPlay() {
    this._discardQueuedShots();
    this.state = 'play';
    if (this.mode === 'lts') {
      this.roundActive = true;
      this.roundNo++;
    }
    this.broadcastState();
  }

  _nextRound() {
    this._enterCountdown();
  }

  _toLobby() {
    this._clearEndTimer();
    this.stop();
    this.state = 'lobby';
    this.bullets = [];
    this.pickups = [];
    this.elapsedMs = 0;
    this.roundActive = false;
    this.sendRoom();
  }

  _frame() {
    this.tick++;
    this._simulate();
    if (this.tick % SNAPSHOT_EVERY === 0) this.broadcastSnapshot();
  }

  _simulate() {
    if (this.state === 'countdown') {
      if (--this.stateTicks <= 0) this._enterPlay();
      return;
    }
    if (this.state === 'roundend') {
      if (--this.stateTicks <= 0) this._nextRound();
      return;
    }
    if (this.state !== 'play') return;

    // 1. movement + firing
    for (const p of this.players.values()) {
      if (!this._isActive(p)) {
        p.seenShotSeq = p.input.shotSeq;
        continue;
      }
      applyTankInput(p.tank, p.input);
      if (p.input.shotSeq > p.seenShotSeq) {
        p.seenShotSeq = p.input.shotSeq;
        if (this.tick >= p.reloadUntil) this._fire(p);
      }
    }

    // 2. resolve tank movement / collisions
    stepTanks(this.activeTanks, this.arena.boxes, { w: this.arena.width, h: this.arena.height }, SOLVER_PASSES);

    // 3. bullets, regen, respawns, pickups
    this._stepBullets();
    this._regen();
    this._respawns();
    this._updatePickups();

    // 4. match progression
    this.elapsedMs += MS_PER_TICK;
    if (this.mode === 'lts') this._checkRound();
    this._checkWin();
    this._endIfForfeit();
  }

  _fire(player) {
    const t = player.tank;
    const spec = classSpec(t.cls);
    const dmgMult = this._hasBuff(player, 'damage') ? DAMAGE_MULT : 1;
    this.bullets.push(makeBullet(t, player.id, dmgMult));
    // recoil shoves the hull backwards along the barrel
    t.vx -= Math.cos(t.turret) * spec.recoil;
    t.vy -= Math.sin(t.turret) * spec.recoil;
    const reload = spec.reloadMs * (this._hasBuff(player, 'rapid') ? RAPID_RELOAD_MULT : 1);
    player.reloadUntil = this.tick + msToTicks(reload);
  }

  _discardQueuedShots() {
    for (const p of this.players.values()) p.seenShotSeq = p.input.shotSeq;
  }

  _stepBullets() {
    const survivors = [];
    for (const b of this.bullets) {
      if (--b.ttl <= 0) {
        this._splash(b, b.x, b.y, null);
        continue;
      }
      const speed = Math.hypot(b.vx, b.vy) || 1;
      const steps = Math.max(1, Math.ceil(speed / 4));
      let removed = false;
      for (let s = 0; s < steps && !removed; s++) {
        b.x += b.vx / steps;
        b.y += b.vy / steps;
        if (b.x < 0 || b.y < 0 || b.x > this.arena.width || b.y > this.arena.height) {
          this._splash(b, b.x, b.y, null);
          removed = true;
          break;
        }
        for (const box of this.arena.boxes) {
          if (circleHitsBox(b.x, b.y, b.radius, box)) {
            this._splash(b, b.x, b.y, null);
            removed = true;
            break;
          }
        }
        if (removed) break;
        for (const p of this.players.values()) {
          if (!this._isActive(p) || !this._canHit(b, p)) continue;
          if (b.hits && b.hits.has(p.id)) continue;
          const t = p.tank;
          const dx = t.x - b.x;
          const dy = t.y - b.y;
          const rr = t.radius + b.radius;
          if (dx * dx + dy * dy <= rr * rr) {
            this._damage(p, b.damage, this.players.get(b.owner), b.vx / speed, b.vy / speed);
            if (b.pierce) {
              (b.hits ||= new Set()).add(p.id);
            } else {
              this._splash(b, b.x, b.y, p.id);
              removed = true;
              break;
            }
          }
        }
      }
      if (!removed) survivors.push(b);
    }
    this.bullets = survivors;
  }

  // area damage on impact (heavy shell); `directId` already took the direct hit
  _splash(b, hx, hy, directId) {
    if (!b.splash) return;
    const killer = this.players.get(b.owner);
    for (const p of this.players.values()) {
      if (!this._isActive(p) || !this._canHit(b, p) || p.id === directId) continue;
      const t = p.tank;
      const d = Math.hypot(t.x - hx, t.y - hy);
      if (d > b.splash + t.radius) continue;
      const frac = SPLASH_MIN_FRAC + (1 - SPLASH_MIN_FRAC) * clamp(1 - d / b.splash, 0, 1);
      const inv = 1 / (d || 1);
      this._damage(p, b.damage * frac, killer, (t.x - hx) * inv, (t.y - hy) * inv);
    }
  }

  _damage(target, dmg, killer, dirx, diry) {
    if (this.tick < (target.protectUntil || 0)) return;
    const t = target.tank;
    if (!t) return;
    if (this._hasBuff(target, 'shield')) dmg *= 0.4;
    t.hp -= dmg;
    target.lastHitAt = this.tick;
    const k = (dmg * KNOCKBACK) / 30;
    t.vx += dirx * k;
    t.vy += diry * k;
    if (t.hp <= 0) this._kill(target, killer);
  }

  _kill(victim, killer) {
    if (victim.dead) return;
    victim.dead = true;
    victim.deaths++;
    victim.tank.hp = 0;
    victim.buffs = {};
    if (killer && killer !== victim && this._isEnemy(killer, victim)) {
      killer.kills++;
      killer.score++;
    }
    if (this.mode !== 'lts') victim.respawnAt = this.tick + msToTicks(RESPAWN_MS);
    this.sendScores();
    if (this.mode === 'lts') this._checkRound();
  }

  _regen() {
    const delay = msToTicks(REGEN_DELAY_MS);
    const per = REGEN_PER_SEC / TICK_HZ;
    for (const p of this.players.values()) {
      if (!this._isActive(p)) continue;
      const t = p.tank;
      if (t.hp < t.maxHp && this.tick - p.lastHitAt >= delay) {
        t.hp = Math.min(t.maxHp, t.hp + per);
      }
    }
  }

  _respawns() {
    if (this.mode === 'lts') return;
    for (const p of this.players.values()) {
      if (p.team !== 'spec' && p.dead && this.tick >= p.respawnAt) {
        this._placeTank(p, this._spawnFor(p));
      }
    }
  }

  _updatePickups() {
    for (const pad of this.pickups) {
      if (!pad.type) {
        if (--pad.timer <= 0) pad.type = PICKUP_TYPES[Math.floor(Math.random() * PICKUP_TYPES.length)];
        continue;
      }
      for (const p of this.players.values()) {
        if (!this._isActive(p)) continue;
        const t = p.tank;
        const gap = Math.hypot(t.x - pad.x, t.y - pad.y) - t.radius - PICKUP_RADIUS;
        if (gap <= 0) {
          this._collect(p, pad.type);
          pad.type = null;
          pad.timer = msToTicks(PICKUP_RESPAWN_MS);
          break;
        }
      }
    }
  }

  _collect(player, type) {
    const t = player.tank;
    player.buffs = player.buffs || {};
    if (type === 'health') t.hp = Math.min(t.maxHp, t.hp + HEALTH_PICKUP_AMOUNT);
    else if (type === 'shield') player.buffs.shield = this.tick + msToTicks(SHIELD_MS);
    else if (type === 'rapid') player.buffs.rapid = this.tick + msToTicks(RAPID_MS);
    else if (type === 'damage') player.buffs.damage = this.tick + msToTicks(DAMAGE_MS);
  }

  // ---------------------------------------------------------------- win logic
  _checkRound() {
    if (this.mode !== 'lts' || !this.roundActive) return;
    const aliveR = this._aliveCount('red');
    const aliveB = this._aliveCount('blue');
    if (aliveR > 0 && aliveB > 0) return;
    this.roundActive = false;
    const winner = aliveR > 0 ? 'red' : aliveB > 0 ? 'blue' : null;
    if (winner) this.roundWins[winner]++;
    this.lastRoundWinner = winner;
    this.sendScores();
    if (winner && this.roundWins[winner] >= LTS_ROUND_WINS) {
      this._endMatch();
      return;
    }
    this.state = 'roundend';
    this.stateTicks = msToTicks(LTS_ROUND_END_MS);
    this.broadcastState();
  }

  _checkWin() {
    const tl = this.settings.timeLimitMs;
    const fl = this.settings.fragLimit;
    if (this.mode === 'tdm') {
      const k = this._teamKills();
      if (fl > 0 && (k.red >= fl || k.blue >= fl)) return this._endMatch();
    } else if (this.mode === 'ffa') {
      if (fl > 0 && this._topKills() >= fl) return this._endMatch();
    }
    if (tl > 0 && this.elapsedMs >= tl) this._endMatch();
  }

  _endIfForfeit() {
    if (!this._isLive()) return false;
    if (this.mode === 'ffa') {
      if (this._playingCount() < 1) {
        this._endMatch();
        return true;
      }
      return false;
    }
    const c = this._teamCounts();
    if (c.red === 0 || c.blue === 0) {
      // the side still standing takes the win (unless both emptied)
      const survivor = c.red > 0 ? 'red' : c.blue > 0 ? 'blue' : null;
      this._endMatch(survivor);
      return true;
    }
    return false;
  }

  _winner() {
    if (this._forcedWinner) {
      const t = this._forcedWinner;
      return { label: `${t === 'red' ? 'Red' : 'Blue'} Team wins!`, color: t };
    }
    if (this.mode === 'tdm') {
      const k = this._teamKills();
      if (k.red > k.blue) return { label: 'Red Team wins!', color: 'red' };
      if (k.blue > k.red) return { label: 'Blue Team wins!', color: 'blue' };
      return { label: "It's a draw", color: null };
    }
    if (this.mode === 'lts') {
      const r = this.roundWins;
      if (r.red > r.blue) return { label: 'Red Team wins!', color: 'red' };
      if (r.blue > r.red) return { label: 'Blue Team wins!', color: 'blue' };
      return { label: "It's a draw", color: null };
    }
    // ffa
    let best = null;
    let tie = false;
    for (const p of this.players.values()) {
      if (p.team === 'spec') continue;
      if (!best || p.kills > best.kills) {
        best = p;
        tie = false;
      } else if (p.kills === best.kills && p !== best) tie = true;
    }
    if (!best || (tie && best.kills === 0)) return { label: "It's a draw", color: null };
    return { label: `${best.name} wins!`, color: null, winnerId: best.id };
  }

  _endMatch(forcedWinner = null) {
    this._forcedWinner = forcedWinner; // set when a side forfeits by leaving
    this.state = 'ended';
    this.roundActive = false;
    this.stop();
    this.bullets = [];
    this.sendRoom();
    this.broadcastState();
    this.sendScores();
    this.endTimer = setTimeout(() => {
      if (this.state === 'ended') this._toLobby();
    }, END_SCREEN_MS);
  }

  // ---------------------------------------------------------------- net out
  timeLeftMs() {
    const tl = this.settings.timeLimitMs;
    return tl > 0 ? Math.max(0, tl - this.elapsedMs) : null;
  }

  roomData() {
    return {
      roomId: this.id,
      name: this.name,
      ownerId: this.ownerId,
      state: this.state,
      mode: this.mode,
      settings: this.settings,
      arenas: Object.keys(ARENAS).map((k) => ({ key: k, name: ARENAS[k].name })),
      classes: CLASS_KEYS.map((k) => ({ key: k, name: TANK_CLASSES[k].name, blurb: TANK_CLASSES[k].blurb })),
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, cls: p.cls })),
    };
  }
  sendRoom() {
    this.io.to(this.id).emit('room', this.roomData());
  }

  initData() {
    return {
      roomId: this.id,
      name: this.name,
      mode: this.mode,
      fog: this.settings.fog,
      arena: {
        name: this.arena.name,
        width: this.arena.width,
        height: this.arena.height,
        boxes: this.arena.boxes,
      },
      players: [...this.players.values()]
        .filter((p) => p.team !== 'spec' && p.tank)
        .map((p) => ({ id: p.id, name: p.name, team: p.team, cls: p.cls, maxHp: classSpec(p.cls).hp })),
      state: this.state,
    };
  }
  sendInit() {
    this.io.to(this.id).emit('gameInit', this.initData());
  }

  scoresData() {
    return {
      mode: this.mode,
      teamKills: this._teamKills(),
      roundWins: this.roundWins,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, team: p.team, cls: p.cls,
        kills: p.kills, deaths: p.deaths, score: p.score,
      })),
    };
  }
  sendScores() {
    this.io.to(this.id).emit('scores', this.scoresData());
  }

  broadcastState() {
    this.io.to(this.id).emit('state', {
      state: this.state,
      mode: this.mode,
      timeLeftMs: this.timeLeftMs(),
      countdownMs: this.state === 'countdown' ? Math.max(0, Math.round(this.stateTicks * MS_PER_TICK)) : null,
      roundWins: this.roundWins,
      lastRoundWinner: this.lastRoundWinner,
      winner: this.state === 'ended' ? this._winner() : null,
    });
  }

  snapshot() {
    const tanks = [];
    for (const p of this.players.values()) {
      if (p.team === 'spec' || !p.tank) continue;
      const t = p.tank;
      const e = {
        id: p.id,
        x: Math.round(t.x),
        y: Math.round(t.y),
        h: Math.round(t.hull * 100),
        tr: Math.round(t.turret * 100),
        hp: Math.max(0, Math.round(t.hp)),
        dead: !!p.dead,
      };
      const buffs = this._activeBuffs(p);
      if (buffs.length) e.buffs = buffs;
      if (this.tick < (p.protectUntil || 0)) e.protect = 1;
      if (p.dead) {
        if (this.mode === 'lts') e.elim = 1;
        else e.respawnMs = Math.max(0, Math.round((p.respawnAt - this.tick) * MS_PER_TICK));
      }
      tanks.push(e);
    }
    return {
      t: this.tick,
      state: this.state,
      timeLeftMs: this.timeLeftMs(),
      countdownMs: this.state === 'countdown' ? Math.max(0, Math.round(this.stateTicks * MS_PER_TICK)) : null,
      tanks,
      bullets: this.bullets.map((b) => ({
        id: b.id, x: Math.round(b.x), y: Math.round(b.y),
        vx: Math.round(b.vx * 100), vy: Math.round(b.vy * 100),
        r: b.radius, team: b.team, cls: b.cls, owner: b.owner,
      })),
      pickups: this.pickups.filter((p) => p.type).map((p) => ({ type: p.type, x: p.x, y: p.y })),
    };
  }
  broadcastSnapshot() {
    this.io.to(this.id).emit('snapshot', this.snapshot());
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      players: this.players.size,
      max: MAX_PLAYERS_PER_ROOM,
      state: this.state,
      mode: this.mode,
      locked: !!this.password,
    };
  }
}
