// Data-driven battlefields. Add maps without touching engine code.
//
// Arena {
//   name, width, height,
//   boxes:[{x,y,w,h}...],        // solid obstacles (tanks slide, bullets die)
//   spawnRed:[[x,y,angle?]...],  // team spawns (tdm / last-tank-standing)
//   spawnBlue:[[x,y,angle?]...],
//   spawnFFA:[[x,y,angle?]...],  // free-for-all spawn pool
//   pads:[[x,y]...],             // pickup-crate spawn pads
// }
// Angles point a fresh tank's turret toward the action (radians). 0 = +x (right).

import { ARENA_SCALE, PICKUP_RADIUS } from './constants.js';
import { circleHitsBox, clamp } from './physics.js';

const PI = Math.PI;

// Crossfire — a big central cross of walls splitting the field into four lanes.
function crossfire() {
  const W = 1280, H = 760;
  const cx = W / 2, cy = H / 2;
  const t = 46; // wall thickness
  return {
    name: 'Crossfire',
    width: W, height: H,
    boxes: [
      { x: cx - t / 2, y: 150, w: t, h: H - 300 }, // vertical bar
      { x: 230, y: cy - t / 2, w: W - 460, h: t }, // horizontal bar
      { x: 150, y: 150, w: 120, h: 40 }, // corner nubs
      { x: W - 270, y: 150, w: 120, h: 40 },
      { x: 150, y: H - 190, w: 120, h: 40 },
      { x: W - 270, y: H - 190, w: 120, h: 40 },
    ],
    spawnRed: [
      [110, 150, 0], [110, cy, 0], [110, H - 150, 0], [200, 260, 0], [200, H - 260, 0], [120, 380, 0],
    ],
    spawnBlue: [
      [W - 110, 150, PI], [W - 110, cy, PI], [W - 110, H - 150, PI], [W - 200, 260, PI], [W - 200, H - 260, PI], [W - 120, 380, PI],
    ],
    spawnFFA: [
      [110, 110, 0], [W - 110, 110, PI], [110, H - 110, 0], [W - 110, H - 110, PI],
      [cx, 110, PI / 2], [cx, H - 110, -PI / 2], [180, cy, 0], [W - 180, cy, PI],
    ],
    pads: [[cx, 100], [cx, H - 100], [290, cy - 95], [W - 290, cy + 95]],
  };
}

// Dustbowl — open arena with scattered pillars; lots of room to manoeuvre.
function dustbowl() {
  const W = 1280, H = 720;
  const cx = W / 2, cy = H / 2;
  return {
    name: 'Dustbowl',
    width: W, height: H,
    boxes: [
      { x: cx - 70, y: cy - 70, w: 140, h: 140 }, // central block
      { x: 300, y: 170, w: 70, h: 70 },
      { x: W - 370, y: 170, w: 70, h: 70 },
      { x: 300, y: H - 240, w: 70, h: 70 },
      { x: W - 370, y: H - 240, w: 70, h: 70 },
      { x: cx - 35, y: 90, w: 70, h: 70 },
      { x: cx - 35, y: H - 160, w: 70, h: 70 },
      { x: 150, y: cy - 35, w: 70, h: 70 },
      { x: W - 220, y: cy - 35, w: 70, h: 70 },
    ],
    spawnRed: [
      [100, cy, 0], [100, 160, 0], [100, H - 160, 0], [200, cy - 90, 0], [200, cy + 90, 0], [120, cy, 0],
    ],
    spawnBlue: [
      [W - 100, cy, PI], [W - 100, 160, PI], [W - 100, H - 160, PI], [W - 200, cy - 90, PI], [W - 200, cy + 90, PI], [W - 120, cy, PI],
    ],
    spawnFFA: [
      [110, 110, 0], [W - 110, 110, PI], [110, H - 110, 0], [W - 110, H - 110, PI],
      [cx, 130, PI / 2], [cx, H - 130, -PI / 2], [160, cy, 0], [W - 160, cy, PI],
    ],
    pads: [[cx, 220], [cx, H - 220], [cx - 260, cy], [cx + 260, cy]],
  };
}

// Fortress — two symmetric walled bases with a single front opening each.
function fortress() {
  const W = 1320, H = 760;
  const cx = W / 2, cy = H / 2;
  const t = 44;
  return {
    name: 'Fortress',
    width: W, height: H,
    boxes: [
      // left base (red): back wall + two arms leaving a front gap
      { x: 150, y: cy - 170, w: t, h: 130 },
      { x: 150, y: cy + 40, w: t, h: 130 },
      { x: 150, y: cy - 170, w: 150, h: t },
      { x: 150, y: cy + 170 - t, w: 150, h: t },
      // right base (blue)
      { x: W - 150 - t, y: cy - 170, w: t, h: 130 },
      { x: W - 150 - t, y: cy + 40, w: t, h: 130 },
      { x: W - 300, y: cy - 170, w: 150, h: t },
      { x: W - 300, y: cy + 170 - t, w: 150, h: t },
      // midfield cover
      { x: cx - t / 2, y: 120, w: t, h: 180 },
      { x: cx - t / 2, y: H - 300, w: t, h: 180 },
      { x: cx - 110, y: cy - t / 2, w: 220, h: t },
    ],
    spawnRed: [
      [200, cy, 0], [200, cy - 110, 0], [200, cy + 110, 0], [110, cy, 0], [260, cy - 60, 0], [260, cy + 60, 0],
    ],
    spawnBlue: [
      [W - 200, cy, PI], [W - 200, cy - 110, PI], [W - 200, cy + 110, PI], [W - 110, cy, PI], [W - 260, cy - 60, PI], [W - 260, cy + 60, PI],
    ],
    spawnFFA: [
      [110, 110, 0], [W - 110, 110, PI], [110, H - 110, 0], [W - 110, H - 110, PI],
      [cx, 90, PI / 2], [cx, H - 90, -PI / 2], [cx - 200, cy, 0], [cx + 200, cy, PI],
    ],
    pads: [[cx, 90], [cx, H - 90], [200, cy], [W - 200, cy]],
  };
}

// Maze — a denser grid of blocks for close-quarters, peek-and-shoot fights.
function maze() {
  const W = 1280, H = 760;
  const cx = W / 2, cy = H / 2;
  const s = 64;
  const blocks = [];
  // a loose lattice with gaps for movement
  const cols = [240, 430, 620, W - 620, W - 430, W - 240];
  const rows = [180, 350, H - 350, H - 180];
  for (let i = 0; i < cols.length; i++) {
    for (let j = 0; j < rows.length; j++) {
      if ((i + j) % 2 === 0) blocks.push({ x: cols[i] - s / 2, y: rows[j] - s / 2, w: s, h: s });
    }
  }
  return {
    name: 'Maze',
    width: W, height: H,
    boxes: blocks,
    spawnRed: [
      [100, cy, 0], [100, 140, 0], [100, H - 140, 0], [100, cy - 120, 0], [100, cy + 120, 0], [150, cy, 0],
    ],
    spawnBlue: [
      [W - 100, cy, PI], [W - 100, 140, PI], [W - 100, H - 140, PI], [W - 100, cy - 120, PI], [W - 100, cy + 120, PI], [W - 150, cy, PI],
    ],
    spawnFFA: [
      [100, 100, 0], [W - 100, 100, PI], [100, H - 100, 0], [W - 100, H - 100, PI],
      [cx, 100, PI / 2], [cx, H - 100, -PI / 2], [cx, cy, 0], [120, cy, 0],
    ],
    pads: [[cx, cy - 95], [cx, 110], [cx, H - 110], [120, cy], [W - 120, cy]],
  };
}

const PAD_CLEARANCE = PICKUP_RADIUS + 6;

function clearPad([x, y], boxes, width, height) {
  let px = x;
  let py = y;
  const maxPasses = Math.max(1, boxes.length * 2);

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (const box of boxes) {
      if (!circleHitsBox(px, py, PAD_CLEARANCE, box)) continue;

      const nx = clamp(px, box.x, box.x + box.w);
      const ny = clamp(py, box.y, box.y + box.h);
      const dx = px - nx;
      const dy = py - ny;
      const d = Math.hypot(dx, dy);

      if (d > 0) {
        const push = PAD_CLEARANCE - d + 0.5;
        if (push > 0) {
          px += (dx / d) * push;
          py += (dy / d) * push;
          moved = true;
        }
      } else {
        const exits = [
          { d: Math.abs(px - box.x), x: box.x - PAD_CLEARANCE, y: py },
          { d: Math.abs(box.x + box.w - px), x: box.x + box.w + PAD_CLEARANCE, y: py },
          { d: Math.abs(py - box.y), x: px, y: box.y - PAD_CLEARANCE },
          { d: Math.abs(box.y + box.h - py), x: px, y: box.y + box.h + PAD_CLEARANCE },
        ];
        exits.sort((a, b) => a.d - b.d);
        px = exits[0].x;
        py = exits[0].y;
        moved = true;
      }

      px = clamp(px, PAD_CLEARANCE, width - PAD_CLEARANCE);
      py = clamp(py, PAD_CLEARANCE, height - PAD_CLEARANCE);
    }
    if (!moved) break;
  }

  return [Math.round(px), Math.round(py)];
}

// Scale a base layout up to play size. Coordinates, sizes, spawns and pads all
// scale; spawn angles (the optional third element) are left alone.
function scaleArena(a, k) {
  const s = (n) => Math.round(n * k);
  const pt = ([x, y, ang = 0]) => [s(x), s(y), ang];
  const width = s(a.width);
  const height = s(a.height);
  const boxes = a.boxes.map((b) => ({ x: s(b.x), y: s(b.y), w: s(b.w), h: s(b.h) }));
  return {
    name: a.name,
    width,
    height,
    boxes,
    spawnRed: a.spawnRed.map(pt),
    spawnBlue: a.spawnBlue.map(pt),
    spawnFFA: a.spawnFFA.map(pt),
    pads: a.pads.map(([x, y]) => clearPad([s(x), s(y)], boxes, width, height)),
  };
}

export const ARENAS = {
  crossfire: scaleArena(crossfire(), ARENA_SCALE),
  dustbowl: scaleArena(dustbowl(), ARENA_SCALE),
  fortress: scaleArena(fortress(), ARENA_SCALE),
  maze: scaleArena(maze(), ARENA_SCALE),
};

export function getArena(key = 'crossfire') {
  return ARENAS[key] || ARENAS.crossfire;
}
