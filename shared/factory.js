// Builders + input helpers shared by the server Room (and reusable for any
// client-side prediction), so feel and truth never diverge.

import { Body, lerpAngle } from './physics.js';
import { TANK_CLASSES, DEFAULT_CLASS, HULL_TURN, TURRET_TURN } from './constants.js';

export function classSpec(cls) {
  return TANK_CLASSES[cls] || TANK_CLASSES[DEFAULT_CLASS];
}

export function makeTank(cls, team, x, y, facing = 0) {
  const spec = classSpec(cls);
  const t = new Body({
    x, y,
    radius: spec.radius,
    invMass: 1 / (spec.radius / 14), // bigger hull = heavier shove
    damping: spec.damp,
    hull: facing,
    turret: facing,
    kind: 'tank',
  });
  t.cls = cls;
  t.team = team;
  t.hp = spec.hp;
  t.maxHp = spec.hp;
  return t;
}

// Apply directional input to a tank's velocity + rotate hull/turret toward intent.
// input = { u, d, l, r, aim }. Call once per tick BEFORE stepTanks.
export function applyTankInput(tank, input) {
  const spec = classSpec(tank.cls);
  let ix = (input.r ? 1 : 0) - (input.l ? 1 : 0);
  let iy = (input.d ? 1 : 0) - (input.u ? 1 : 0);
  const len = Math.hypot(ix, iy);
  if (len > 0) {
    ix /= len;
    iy /= len;
    tank.vx += ix * spec.accel;
    tank.vy += iy * spec.accel;
    tank.hull = lerpAngle(tank.hull, Math.atan2(iy, ix), HULL_TURN);
  }
  if (typeof input.aim === 'number') {
    tank.turret = lerpAngle(tank.turret, input.aim, TURRET_TURN);
  }
}

let _bulletId = 1;

// Spawn one bullet leaving a tank's muzzle along its turret (+/- spread).
export function makeBullet(tank, owner, damageMult = 1) {
  const spec = classSpec(tank.cls);
  const b = spec.bullet;
  const ang = tank.turret + (b.spread ? (Math.random() - 0.5) * 2 * b.spread : 0);
  const muzzle = tank.radius + b.radius + 2;
  return {
    id: _bulletId++,
    owner, // socket id of the shooter
    team: tank.team,
    cls: tank.cls,
    x: tank.x + Math.cos(ang) * muzzle,
    y: tank.y + Math.sin(ang) * muzzle,
    vx: Math.cos(ang) * b.speed,
    vy: Math.sin(ang) * b.speed,
    radius: b.radius,
    damage: b.damage * damageMult,
    splash: b.splash || 0,
    pierce: !!b.pierce,
    ttl: Math.round((b.ttlMs / 1000) * 60), // lifetime in ticks
    hits: null, // lazily-created Set of tank ids already damaged (pierce)
  };
}
