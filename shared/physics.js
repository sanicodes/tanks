// Core movement physics. Pure, isomorphic ESM — the server runs it for real;
// the client can import the math for prediction/aim. No Node- or DOM-specific APIs.
//
// Tanks are circular Bodies. Arena obstacles are axis-aligned Boxes {x,y,w,h}.
// Tanks slide along walls (no bounce); bullets are handled separately in the Room.

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// shortest-arc interpolation between two angles (radians), fraction t in [0,1]
export function lerpAngle(a, target, t) {
  let d = target - a;
  d = ((d + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

let _nextId = 1;

export class Body {
  constructor(opts = {}) {
    this.id = opts.id ?? _nextId++;
    this.x = opts.x ?? 0;
    this.y = opts.y ?? 0;
    this.vx = opts.vx ?? 0;
    this.vy = opts.vy ?? 0;
    this.radius = opts.radius ?? 14;
    this.invMass = opts.invMass ?? 1; // 0 = immovable
    this.damping = opts.damping ?? 0.86;
    this.hull = opts.hull ?? 0; // facing of the hull (move direction), radians
    this.turret = opts.turret ?? 0; // facing of the turret (aim), radians
    this.kind = opts.kind ?? 'tank';
  }
}

// --- Tank vs tank: positional push-out + normal impulse (equal-mass shove). ---
export function collideBodies(a, b) {
  const invSum = a.invMass + b.invMass;
  if (invSum === 0) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const r = a.radius + b.radius;
  const dist = Math.hypot(dx, dy);
  if (dist === 0 || dist >= r) return;

  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = r - dist;
  a.x -= nx * overlap * (a.invMass / invSum);
  a.y -= ny * overlap * (a.invMass / invSum);
  b.x += nx * overlap * (b.invMass / invSum);
  b.y += ny * overlap * (b.invMass / invSum);

  const relN = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (relN < 0) {
    const e = 0.2; // tanks barely bounce off each other
    const j = (-(1 + e) * relN) / invSum;
    a.vx -= j * nx * a.invMass;
    a.vy -= j * ny * a.invMass;
    b.vx += j * nx * b.invMass;
    b.vy += j * ny * b.invMass;
  }
}

// --- Circle vs axis-aligned box: push the circle to the nearest outside edge
// and kill velocity heading into the wall (slide, don't bounce). ---
export function collideBox(c, box) {
  if (c.invMass === 0) return;
  const px = clamp(c.x, box.x, box.x + box.w);
  const py = clamp(c.y, box.y, box.y + box.h);
  let dx = c.x - px;
  let dy = c.y - py;
  let d2 = dx * dx + dy * dy;
  if (d2 > c.radius * c.radius) return;

  if (d2 === 0) {
    // center is inside the box: eject through the nearest face
    const left = c.x - box.x;
    const right = box.x + box.w - c.x;
    const top = c.y - box.y;
    const bottom = box.y + box.h - c.y;
    const m = Math.min(left, right, top, bottom);
    if (m === left) {
      c.x = box.x - c.radius;
      if (c.vx > 0) c.vx = 0;
    } else if (m === right) {
      c.x = box.x + box.w + c.radius;
      if (c.vx < 0) c.vx = 0;
    } else if (m === top) {
      c.y = box.y - c.radius;
      if (c.vy > 0) c.vy = 0;
    } else {
      c.y = box.y + box.h + c.radius;
      if (c.vy < 0) c.vy = 0;
    }
    return;
  }

  const dist = Math.sqrt(d2);
  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = c.radius - dist;
  c.x += nx * overlap;
  c.y += ny * overlap;
  const vn = c.vx * nx + c.vy * ny;
  if (vn < 0) {
    c.vx -= vn * nx;
    c.vy -= vn * ny;
  }
}

// Is a point (with radius r) overlapping a box? Used for bullet/pickup tests.
export function circleHitsBox(x, y, r, box) {
  const px = clamp(x, box.x, box.x + box.w);
  const py = clamp(y, box.y, box.y + box.h);
  const dx = x - px;
  const dy = y - py;
  return dx * dx + dy * dy <= r * r;
}

export function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

const MAX_SUBSTEPS = 8;

// One full movement tick for tanks: drag, then substepped integrate + resolve so
// a fast tank can't tunnel through a wall in a single step. Input acceleration
// must already be applied to velocities before calling this.
export function stepTanks(bodies, boxes, bounds, passes) {
  let maxStep = 0;
  let minRadius = Infinity;
  for (const b of bodies) {
    if (b.invMass === 0) continue;
    b.vx *= b.damping;
    b.vy *= b.damping;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > maxStep) maxStep = sp;
    if (b.radius < minRadius) minRadius = b.radius;
  }
  const budget = Number.isFinite(minRadius) ? Math.max(1, minRadius * 0.5) : 1;
  const sub = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(maxStep / budget)));

  for (let s = 0; s < sub; s++) {
    for (const b of bodies) {
      if (b.invMass === 0) continue;
      b.x += b.vx / sub;
      b.y += b.vy / sub;
    }
    resolveTanks(bodies, boxes, bounds, passes);
  }
}

function resolveTanks(bodies, boxes, bounds, passes) {
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        collideBodies(bodies[i], bodies[j]);
      }
    }
    for (const b of bodies) {
      if (b.invMass === 0) continue;
      for (const box of boxes) collideBox(b, box);
      // arena perimeter
      const r = b.radius;
      if (b.x < r) {
        b.x = r;
        if (b.vx < 0) b.vx = 0;
      } else if (b.x > bounds.w - r) {
        b.x = bounds.w - r;
        if (b.vx > 0) b.vx = 0;
      }
      if (b.y < r) {
        b.y = r;
        if (b.vy < 0) b.vy = 0;
      } else if (b.y > bounds.h - r) {
        b.y = bounds.h - r;
        if (b.vy > 0) b.vy = 0;
      }
    }
  }
}
