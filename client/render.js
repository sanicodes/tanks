// Canvas rendering with entity interpolation. Tanks render ~INTERP_DELAY_MS in
// the past (lerped between snapshots); bullets are dead-reckoned from their last
// known velocity so fast rounds stay smooth. Decoupled from net rate via rAF.

import {
  INTERP_DELAY_MS, TANK_CLASSES, PICKUP_RADIUS, VIEW_W, VIEW_H,
  FOG_RADIUS, FOG_RADIUS_BY_CLASS, CAMERA_FOLLOW, CAMERA_ZOOM, CAMERA_ZOOM_BY_CLASS,
} from '/shared/constants.js';
import { lerpAngle, clamp, circleHitsBox } from '/shared/physics.js';

const TEAM = { red: '#e15a4a', blue: '#4a78e1' };
const TREAD = '#2a2a2e';
const PU = {
  health: { c: '#5ad16e', glyph: '+' },
  shield: { c: '#5ad1e1', glyph: '◇' },
  rapid: { c: '#f4d35e', glyph: '»' },
  damage: { c: '#f4823e', glyph: '✷' },
};
const BUFF_RING = { shield: '#5ad1e1', rapid: '#f4d35e', damage: '#f4823e' };
const BUFFER_MAX = 30;
const MS_PER_TICK = 1000 / 60;

// stable-ish color for a free-for-all tank, derived from its socket id
function ffaColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 62% 58%)`;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.init = null;
    this.staticById = new Map(); // id -> {team, cls, name, maxHp, color, radius}
    this.selfId = null;
    this.mode = 'tdm';
    this.buffer = []; // [{recvTime, tanks:Map}]
    this.bullets = []; // latest bullets
    this.bulletsAt = 0; // recvTime of latest bullets
    this.pickups = [];
    this.effects = []; // [{x,y,born,kind,color,...}]
    this.prevBulletIds = new Set();
    this.bulletPos = new Map(); // id -> {x,y} last seen, for impact puffs
    this.localBullets = []; // client-predicted own shots
    this._latestPositions = null; // tanks this frame (for local-bullet culling)
    this.prevTanks = new Map(); // id -> {dead,hp,x,y}
    this.selfPos = null; // latest interpolated self position (for aim)
    this.camera = { x: 0, y: 0, zoom: CAMERA_ZOOM }; // world-space top-left of the viewport
    this.cameraReady = false;
    this.lastFocus = null; // last good camera focus (for dead/spectator)
    this.visionZones = null;
    this.fogCanvas = document.createElement('canvas');
    this.fogCanvas.width = VIEW_W;
    this.fogCanvas.height = VIEW_H;
    this.fogCtx = this.fogCanvas.getContext('2d');
    this.fog = true;
    this.onShoot = null;
    this.onExplode = null;
    this.onHit = null;
  }

  setInit(init) {
    this.init = init;
    this.mode = init.mode;
    this.fog = init.fog !== false;
    this.staticById.clear();
    for (const p of init.players) {
      const cls = TANK_CLASSES[p.cls] || TANK_CLASSES.fighter;
      this.staticById.set(p.id, {
        team: p.team,
        cls: p.cls,
        name: p.name,
        maxHp: p.maxHp,
        radius: cls.radius,
        color: p.team === 'red' || p.team === 'blue' ? TEAM[p.team] : ffaColor(p.id),
      });
    }
    this.canvas.width = VIEW_W;
    this.canvas.height = VIEW_H;
    this.fogCanvas.width = VIEW_W;
    this.fogCanvas.height = VIEW_H;
    this.effects = [];
    this.prevTanks.clear();
    this.lastFocus = { x: init.arena.width / 2, y: init.arena.height / 2 };
    this.cameraReady = false;
    this.visionZones = null;
  }

  setSelf(id) {
    this.selfId = id;
  }

  pushSnapshot(snap) {
    const tanks = new Map();
    for (const t of snap.tanks) tanks.set(t.id, t);
    this.buffer.push({ recvTime: performance.now(), tanks });
    if (this.buffer.length > BUFFER_MAX) this.buffer.shift();
    this.bullets = snap.bullets || [];
    this.bulletsAt = performance.now();
    this.pickups = snap.pickups || [];
    this._detectEvents(tanks);
  }

  // derive one-shot effects (muzzle flash, explosions, hits) from snapshot diffs
  _detectEvents(tanks) {
    const ids = new Set();
    for (const b of this.bullets) {
      ids.add(b.id);
      // muzzle flash + sound on a newly seen round — but our own shots are
      // already predicted client-side, so don't double up for them
      if (!this.prevBulletIds.has(b.id) && b.owner !== this.selfId) {
        this.effects.push({ kind: 'muzzle', x: b.x, y: b.y, born: performance.now(), color: '#ffe7a8' });
        if (this.onShoot) this.onShoot();
      }
      this.bulletPos.set(b.id, { x: b.x, y: b.y });
    }
    // a round that disappeared this tick hit something — puff at its last spot
    for (const id of this.prevBulletIds) {
      if (!ids.has(id)) {
        const p = this.bulletPos.get(id);
        if (p) this._impact(p.x, p.y, '#cfcabd');
        this.bulletPos.delete(id);
      }
    }
    this.prevBulletIds = ids;

    for (const [id, t] of tanks) {
      const prev = this.prevTanks.get(id);
      if (prev) {
        if (t.dead && !prev.dead) {
          const st = this.staticById.get(id);
          this._spawnExplosion(prev.x, prev.y, st ? st.color : '#ffaa55');
          if (this.onExplode) this.onExplode();
        } else if (!t.dead && t.hp < prev.hp - 0.5) {
          this.effects.push({ kind: 'spark', x: t.x, y: t.y, born: performance.now() });
          if (this.onHit) this.onHit();
        }
      }
      this.prevTanks.set(id, { dead: t.dead, hp: t.hp, x: t.x, y: t.y });
    }
    for (const id of [...this.prevTanks.keys()]) if (!tanks.has(id)) this.prevTanks.delete(id);
  }

  _spawnExplosion(x, y, color) {
    const now = performance.now();
    this.effects.push({ kind: 'blast', x, y, born: now, color });
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 4;
      this.effects.push({
        kind: 'debris', x, y, born: now,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        color: Math.random() < 0.5 ? color : '#ffcf6b',
      });
    }
  }

  getSelfPos() {
    return this.selfPos;
  }

  screenToWorld(x, y) {
    const z = this.camera.zoom || CAMERA_ZOOM;
    return { x: this.camera.x + x / z, y: this.camera.y + y / z };
  }

  // interpolated tank states for renderTime
  _interpTanks(renderTime) {
    const buf = this.buffer;
    if (buf.length === 0) return null;
    if (buf.length === 1) return buf[0].tanks;
    let a = buf[0];
    let b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].recvTime <= renderTime && renderTime <= buf[i + 1].recvTime) {
        a = buf[i];
        b = buf[i + 1];
        break;
      }
    }
    if (renderTime <= buf[0].recvTime) return buf[0].tanks;
    if (renderTime >= b.recvTime) return b.tanks;
    const span = b.recvTime - a.recvTime || 1;
    const f = (renderTime - a.recvTime) / span;
    const out = new Map();
    for (const [id, tb] of b.tanks) {
      const ta = a.tanks.get(id);
      if (ta) {
        out.set(id, {
          id,
          x: ta.x + (tb.x - ta.x) * f,
          y: ta.y + (tb.y - ta.y) * f,
          h: lerpAngle((ta.h / 100), (tb.h / 100), f) * 100,
          tr: lerpAngle((ta.tr / 100), (tb.tr / 100), f) * 100,
          hp: ta.hp + (tb.hp - ta.hp) * f,
          dead: tb.dead,
          buffs: tb.buffs,
          protect: tb.protect,
          respawnMs: tb.respawnMs,
          elim: tb.elim,
        });
      } else out.set(id, tb);
    }
    return out;
  }

  render() {
    const { ctx } = this;
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    if (!this.init) return;
    const now = performance.now();
    const renderTime = now - INTERP_DELAY_MS;
    const positions = this._interpTanks(renderTime);

    // --- camera follows our tank (clamped inside the arena) ---
    let focus = null;
    if (positions) {
      const self = positions.get(this.selfId);
      if (self) {
        this.selfPos = self;
        if (!self.dead) focus = { x: self.x, y: self.y };
      }
    }
    if (!focus) focus = this._fallbackFocus(positions);
    this.lastFocus = focus;
    this._latestPositions = positions;
    const aw = this.init.arena.width;
    const ah = this.init.arena.height;
    const targetZoom = this._targetZoom(positions);
    const zoom = this.cameraReady
      ? this.camera.zoom + (targetZoom - this.camera.zoom) * CAMERA_FOLLOW
      : targetZoom;
    const viewW = VIEW_W / zoom;
    const viewH = VIEW_H / zoom;
    const targetCamX = aw <= viewW ? (aw - viewW) / 2 : clamp(focus.x - viewW / 2, 0, aw - viewW);
    const targetCamY = ah <= viewH ? (ah - viewH) / 2 : clamp(focus.y - viewH / 2, 0, ah - viewH);
    let camX = targetCamX;
    let camY = targetCamY;
    if (this.cameraReady) {
      const dx = targetCamX - this.camera.x;
      const dy = targetCamY - this.camera.y;
      if (Math.hypot(dx, dy) < viewW * 0.45) {
        camX = this.camera.x + dx * CAMERA_FOLLOW;
        camY = this.camera.y + dy * CAMERA_FOLLOW;
      }
    }
    this.cameraReady = true;
    this.camera = { x: camX, y: camY, zoom };
    this.visionZones = this._visionZones(positions);

    // --- world (drawn in world space, shifted by the camera) ---
    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(-camX, -camY);
    this._drawField(camX, camY, viewW, viewH);
    this._drawPickups(now);
    this._drawBullets(renderTime);
    this._drawLocalBullets(now);
    if (positions) {
      for (const [id, t] of positions) if (!t.dead && this._canSeeTank(id, t)) this._drawTank(id, t, now);
      for (const [id, t] of positions) if (!t.dead && this._canSeeTank(id, t)) this._drawNameHealth(id, t);
    }
    this._drawEffects(now);
    ctx.restore();

    // --- fog of war (screen space, over the world) ---
    if (this.fog) this._drawFog();
  }

  // pick a camera target when we have no live tank of our own
  _fallbackFocus(positions) {
    const myTeam = this.staticById.get(this.selfId)?.team;
    if (positions && myTeam) {
      for (const [id, t] of positions) {
        if (!t.dead && this.staticById.get(id)?.team === myTeam) return { x: t.x, y: t.y };
      }
    }
    return this.lastFocus || { x: this.init.arena.width / 2, y: this.init.arena.height / 2 };
  }

  _targetZoom(positions) {
    if (positions) {
      const self = positions.get(this.selfId);
      if (self && !self.dead) {
        const st = this.staticById.get(this.selfId);
        return CAMERA_ZOOM_BY_CLASS[st?.cls] || CAMERA_ZOOM;
      }
    }
    return CAMERA_ZOOM;
  }

  _drawField(camX, camY, viewW, viewH) {
    const { ctx, init } = this;
    const W = init.arena.width;
    const H = init.arena.height;
    // ground (only the visible slice)
    ctx.fillStyle = '#3b3f37';
    ctx.fillRect(camX, camY, viewW, viewH);
    // grid (clipped to the viewport)
    ctx.strokeStyle = 'rgba(255,255,255,.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.floor(camX / 64) * 64;
    const y0 = Math.floor(camY / 64) * 64;
    for (let x = x0; x <= camX + viewW; x += 64) {
      ctx.moveTo(x, camY);
      ctx.lineTo(x, camY + viewH);
    }
    for (let y = y0; y <= camY + viewH; y += 64) {
      ctx.moveTo(camX, y);
      ctx.lineTo(camX + viewW, y);
    }
    ctx.stroke();
    // perimeter
    ctx.strokeStyle = 'rgba(0,0,0,.5)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    // obstacles (only those overlapping the viewport)
    for (const b of init.arena.boxes) {
      if (b.x + b.w < camX || b.x > camX + viewW || b.y + b.h < camY || b.y > camY + viewH) continue;
      ctx.fillStyle = '#5a5650';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = 'rgba(255,255,255,.08)';
      ctx.fillRect(b.x, b.y, b.w, 4);
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      ctx.fillRect(b.x, b.y + b.h - 4, b.w, 4);
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
    }
  }

  _visionZones(positions) {
    const myStatic = this.staticById.get(this.selfId);
    if (!this.fog || !myStatic) return null; // pure spectators see the whole field
    const reveal = [];
    if (positions) {
      for (const [id, t] of positions) {
        if (t.dead) continue;
        const st = this.staticById.get(id);
        if (!st) continue;
        const friendly = id === this.selfId || (this.mode !== 'ffa' && st.team === myStatic.team);
        if (friendly) {
          const radius = FOG_RADIUS_BY_CLASS[st.cls] || FOG_RADIUS;
          reveal.push({ x: t.x, y: t.y, radius });
        }
      }
    }
    if (reveal.length === 0) {
      const f = this.lastFocus || { x: this.camera.x + VIEW_W / 2, y: this.camera.y + VIEW_H / 2 };
      reveal.push({ x: f.x, y: f.y, radius: FOG_RADIUS });
    }
    return reveal;
  }

  _isVisibleWorld(x, y, margin = 0) {
    if (!this.fog || !this.staticById.get(this.selfId)) return true;
    if (!this.visionZones) return true;
    for (const z of this.visionZones) {
      const r = z.radius + margin;
      const dx = x - z.x;
      const dy = y - z.y;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  _canSeeTank(id, t) {
    const st = this.staticById.get(id);
    if (!st) return false;
    return this._isVisibleWorld(t.x, t.y, st.radius);
  }

  // dark overlay punched with soft holes around our tank + living teammates
  _drawFog() {
    const { ctx, fogCtx } = this;
    if (!this.visionZones) return;
    const cam = this.camera;
    const zoom = cam.zoom || CAMERA_ZOOM;
    fogCtx.save();
    fogCtx.clearRect(0, 0, VIEW_W, VIEW_H);
    fogCtx.fillStyle = 'rgba(7,9,8,0.985)';
    fogCtx.fillRect(0, 0, VIEW_W, VIEW_H);
    fogCtx.globalCompositeOperation = 'destination-out';
    for (const r of this.visionZones) {
      const x = (r.x - cam.x) * zoom;
      const y = (r.y - cam.y) * zoom;
      const radius = (r.radius || FOG_RADIUS) * zoom;
      const g = fogCtx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.68, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      fogCtx.fillStyle = g;
      fogCtx.beginPath();
      fogCtx.arc(x, y, radius, 0, Math.PI * 2);
      fogCtx.fill();
    }
    fogCtx.restore();
    ctx.drawImage(this.fogCanvas, 0, 0);
  }

  _drawPickups(now) {
    const { ctx } = this;
    for (const p of this.pickups) {
      if (!this._isVisibleWorld(p.x, p.y, PICKUP_RADIUS)) continue;
      const info = PU[p.type] || { c: '#fff', glyph: '?' };
      const bob = Math.sin(now / 300 + p.x) * 2;
      ctx.save();
      ctx.translate(p.x, p.y + bob);
      ctx.shadowColor = info.c;
      ctx.shadowBlur = 14;
      roundRect(ctx, -PICKUP_RADIUS, -PICKUP_RADIUS, PICKUP_RADIUS * 2, PICKUP_RADIUS * 2, 4);
      ctx.fillStyle = info.c;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#1c1c1c';
      ctx.font = '700 16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(info.glyph, 0, 1);
      ctx.restore();
    }
  }

  _drawBullets(renderTime) {
    const dtTicks = (renderTime - this.bulletsAt) / MS_PER_TICK;
    for (const b of this.bullets) {
      if (b.owner === this.selfId) continue; // our own rounds are predicted locally
      const vx = b.vx / 100;
      const vy = b.vy / 100;
      const x = b.x + vx * dtTicks;
      const y = b.y + vy * dtTicks;
      if (!this._isVisibleWorld(x, y, b.r + 18)) continue;
      const color = b.team === 'red' || b.team === 'blue' ? TEAM[b.team] : '#f0d264';
      this._bulletSprite(x, y, vx, vy, b.r, color);
    }
  }

  // advance + draw client-predicted own bullets; cull on walls/bounds/hits/ttl
  _drawLocalBullets(now) {
    if (!this.localBullets.length) return;
    const color = this.staticById.get(this.selfId)?.color || '#f0d264';
    const W = this.init.arena.width;
    const H = this.init.arena.height;
    const myTeam = this.staticById.get(this.selfId)?.team;
    const survivors = [];
    for (const b of this.localBullets) {
      const dtTicks = (now - b.last) / MS_PER_TICK;
      b.last = now;
      b.x += b.vx * dtTicks;
      b.y += b.vy * dtTicks;
      if (now - b.born > b.ttl) continue;
      if (b.x < 0 || b.y < 0 || b.x > W || b.y > H) {
        this._impact(b.x, b.y, '#cfcabd');
        continue;
      }
      let hit = false;
      for (const box of this.init.arena.boxes) {
        if (circleHitsBox(b.x, b.y, b.r, box)) {
          this._impact(b.x, b.y, '#cfcabd');
          hit = true;
          break;
        }
      }
      if (hit) continue;
      if (this._latestPositions) {
        for (const [id, t] of this._latestPositions) {
          if (t.dead || id === this.selfId) continue;
          const st = this.staticById.get(id);
          if (!st) continue;
          const enemy = this.mode === 'ffa' || st.team !== myTeam;
          if (!enemy) continue;
          const dx = t.x - b.x;
          const dy = t.y - b.y;
          const rr = st.radius + b.r;
          if (dx * dx + dy * dy <= rr * rr) {
            this._impact(b.x, b.y, '#ffd98a');
            hit = true;
            break;
          }
        }
      }
      if (hit) continue;
      if (!this._isVisibleWorld(b.x, b.y, b.r + 18)) {
        survivors.push(b);
        continue;
      }
      this._bulletSprite(b.x, b.y, b.vx, b.vy, b.r, color);
      survivors.push(b);
    }
    this.localBullets = survivors;
  }

  // x,y world position; vx,vy in px/tick; draws a glowing tracer round
  _bulletSprite(x, y, vx, vy, r, color) {
    const { ctx } = this;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 9;
    ctx.strokeStyle = color;
    ctx.lineWidth = r * 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - vx * 1.8, y - vy * 1.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
  }

  // spawn a predicted round from our muzzle (called by main on fire)
  spawnLocalBullet(x, y, ang, cls) {
    const spec = TANK_CLASSES[cls];
    if (!spec) return;
    const bs = spec.bullet;
    const off = spec.radius + bs.radius + 2;
    const now = performance.now();
    this.localBullets.push({
      x: x + Math.cos(ang) * off,
      y: y + Math.sin(ang) * off,
      vx: Math.cos(ang) * bs.speed,
      vy: Math.sin(ang) * bs.speed,
      r: bs.radius,
      ttl: bs.ttlMs,
      born: now,
      last: now,
    });
    this.effects.push({ kind: 'muzzle', x: x + Math.cos(ang) * off, y: y + Math.sin(ang) * off, born: now, color: '#ffe7a8' });
    if (this.onShoot) this.onShoot();
  }

  getSelfClass() {
    return this.staticById.get(this.selfId)?.cls || null;
  }

  _impact(x, y, color) {
    this.effects.push({ kind: 'puff', x, y, born: performance.now(), color });
  }

  _drawTank(id, t, now) {
    const st = this.staticById.get(id);
    if (!st) return;
    const r = st.radius;
    const isSelf = id === this.selfId;
    const hull = t.h / 100;
    const turret = t.tr / 100;
    const { ctx } = this;

    ctx.save();
    ctx.translate(t.x, t.y);

    // --- hull + treads (rotated to movement heading) ---
    ctx.save();
    ctx.rotate(hull);
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    roundRect(ctx, -r * 1.0 + 2, -r * 1.1 + 3, r * 2.0, r * 2.2, 4);
    ctx.fill();
    // treads
    ctx.fillStyle = TREAD;
    roundRect(ctx, -r * 1.05, -r * 1.15, r * 2.1, r * 0.5, 3);
    ctx.fill();
    roundRect(ctx, -r * 1.05, r * 0.65, r * 2.1, r * 0.5, 3);
    ctx.fill();
    // tread links
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.lineWidth = 1.5;
    for (let i = -r; i <= r; i += r * 0.42) {
      ctx.beginPath();
      ctx.moveTo(i, -r * 1.15);
      ctx.lineTo(i, -r * 1.15 + r * 0.5);
      ctx.moveTo(i, r * 0.65);
      ctx.lineTo(i, r * 0.65 + r * 0.5);
      ctx.stroke();
    }
    // body
    const grad = ctx.createLinearGradient(0, -r, 0, r);
    grad.addColorStop(0, shade(st.color, 1.15));
    grad.addColorStop(1, shade(st.color, 0.8));
    ctx.fillStyle = grad;
    roundRect(ctx, -r * 0.85, -r * 0.78, r * 1.7, r * 1.56, 4);
    ctx.fill();
    ctx.strokeStyle = isSelf ? '#fff' : 'rgba(0,0,0,.5)';
    ctx.lineWidth = isSelf ? 2.5 : 1.5;
    ctx.stroke();
    ctx.restore();

    // --- turret + barrel (rotated to aim) ---
    ctx.save();
    ctx.rotate(turret);
    ctx.fillStyle = '#3a3a40';
    roundRect(ctx, 0, -r * 0.18, r * 1.85, r * 0.36, r * 0.12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // turret dome (un-rotated circle)
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = shade(st.color, 1.25);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // --- status rings ---
    let ringR = r * 1.3;
    if (t.protect) {
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.4 + 0.3 * Math.sin(now / 120)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ringR += 4;
    }
    if (Array.isArray(t.buffs)) {
      for (const b of t.buffs) {
        const c = BUFF_RING[b];
        if (!c) continue;
        ctx.beginPath();
        ctx.arc(0, 0, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = c;
        ctx.shadowColor = c;
        ctx.shadowBlur = 8;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ringR += 4;
      }
    }
    ctx.restore();
  }

  _drawNameHealth(id, t) {
    const st = this.staticById.get(id);
    if (!st) return;
    const { ctx } = this;
    const r = st.radius;
    const w = Math.max(34, r * 2.4);
    const x = t.x - w / 2;
    const y = t.y - r - 14;
    const pct = Math.max(0, Math.min(1, t.hp / st.maxHp));
    // bar
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(x, y, w, 5);
    ctx.fillStyle = pct > 0.5 ? '#5ad16e' : pct > 0.25 ? '#f4d35e' : '#f06d5f';
    ctx.fillRect(x + 1, y + 1, (w - 2) * pct, 3);
    ctx.strokeStyle = 'rgba(255,255,255,.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 4);
    // name
    const isSelf = id === this.selfId;
    ctx.font = `${isSelf ? '600 ' : ''}12px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.strokeText(st.name, t.x, y - 2);
    ctx.fillStyle = isSelf ? '#fff' : st.team === 'red' ? '#f3b0a8' : st.team === 'blue' ? '#aec3f3' : '#e8e8e8';
    ctx.fillText(st.name, t.x, y - 2);
  }

  _drawEffects(now) {
    const { ctx } = this;
    const keep = [];
    for (const e of this.effects) {
      const age = now - e.born;
      if (e.kind === 'muzzle') {
        if (age > 90) continue;
        const a = 1 - age / 90;
        if (!this._isVisibleWorld(e.x, e.y, 20)) {
          keep.push(e);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = a;
        ctx.fillStyle = e.color;
        ctx.shadowColor = e.color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(e.x, e.y, 5 * a + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        keep.push(e);
      } else if (e.kind === 'puff') {
        if (age > 200) continue;
        const a = 1 - age / 200;
        const rad = 3 + (1 - a) * 9;
        if (!this._isVisibleWorld(e.x, e.y, rad + 8)) {
          keep.push(e);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = a * 0.8;
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(e.x, e.y, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        keep.push(e);
      } else if (e.kind === 'spark') {
        if (age > 160) continue;
        const a = 1 - age / 160;
        if (!this._isVisibleWorld(e.x, e.y, 18)) {
          keep.push(e);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = a;
        ctx.fillStyle = '#ffd98a';
        ctx.beginPath();
        ctx.arc(e.x, e.y, 4 * a, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        keep.push(e);
      } else if (e.kind === 'blast') {
        if (age > 360) continue;
        const a = 1 - age / 360;
        const rad = 10 + (1 - a) * 42;
        if (!this._isVisibleWorld(e.x, e.y, rad)) {
          keep.push(e);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = a * 0.8;
        ctx.fillStyle = '#ffcf6b';
        ctx.shadowColor = '#ff8a3a';
        ctx.shadowBlur = 30;
        ctx.beginPath();
        ctx.arc(e.x, e.y, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        keep.push(e);
      } else if (e.kind === 'debris') {
        if (age > 500) continue;
        const a = 1 - age / 500;
        const px = e.x + e.vx * (age / MS_PER_TICK);
        const py = e.y + e.vy * (age / MS_PER_TICK);
        if (!this._isVisibleWorld(px, py, 12)) {
          keep.push(e);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = a;
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.arc(px, py, 3 * a + 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        keep.push(e);
      }
    }
    this.effects = keep;
  }

  reset() {
    this.init = null;
    this.buffer = [];
    this.bullets = [];
    this.localBullets = [];
    this.bulletPos.clear();
    this.pickups = [];
    this.effects = [];
    this.prevBulletIds = new Set();
    this.prevTanks.clear();
    this.selfPos = null;
    this._latestPositions = null;
    this.camera = { x: 0, y: 0, zoom: CAMERA_ZOOM };
    this.cameraReady = false;
    this.visionZones = null;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// lighten (>1) or darken (<1) a hex or hsl color via canvas-friendly tweak
function shade(color, mult) {
  if (color.startsWith('hsl')) {
    return color.replace(/(\d+)%\)$/, (m, l) => `${Math.min(100, Math.round(+l * mult))}%)`);
  }
  const c = color.replace('#', '');
  const n = parseInt(c, 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  r = Math.min(255, Math.round(r * mult));
  g = Math.min(255, Math.round(g * mult));
  b = Math.min(255, Math.round(b * mult));
  return `rgb(${r},${g},${b})`;
}
