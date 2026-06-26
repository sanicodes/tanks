// All tunables live here so "feel" can be iterated without touching logic.
// Imported by both the server (authoritative sim) and the client (rendering).

export const DT = 1 / 60; // fixed physics timestep, always 60 Hz on the server

// --- Netcode ---
export const SNAPSHOT_HZ = 60; // server -> client broadcast rate
export const INTERP_DELAY_MS = 70; // client renders tanks this far in the past
export const SOLVER_PASSES = 5; // collision resolution passes per tick

// --- Camera / fog of war (client view) ---
// Arenas are larger than the viewport: the camera follows your tank and fog
// hides everything beyond a radius around you and your living teammates.
export const VIEW_W = 1024;
export const VIEW_H = 640;
export const ARENA_SCALE = 1.5; // base arena layouts are scaled up by this
export const FOG_DEFAULT = true;
export const FOG_RADIUS = 270; // px revealed around a friendly tank
export const FOG_RADIUS_BY_CLASS = {
  scout: FOG_RADIUS,
  fighter: FOG_RADIUS,
  heavy: FOG_RADIUS,
  sniper: 390,
};

// --- Tank movement ---
// Twin-stick control: WASD drives the hull in world space, the mouse aims the
// turret. accel + damp set top speed: v_max ≈ accel*damp/(1-damp) px/tick.
// The hull sprite lerps to face its movement direction; the turret lerps to aim.
export const HULL_TURN = 0.22; // fraction the hull rotates toward move dir each tick
export const TURRET_TURN = 0.5; // fraction the turret rotates toward the aim each tick
export const CAMERA_FOLLOW = 0.18; // fraction the camera moves toward target each frame
export const CAMERA_ZOOM = 1;
export const CAMERA_ZOOM_BY_CLASS = {
  scout: CAMERA_ZOOM,
  fighter: CAMERA_ZOOM,
  heavy: CAMERA_ZOOM,
  sniper: 0.78,
};

// --- Tank classes: hull stats + the weapon (bullet) each one fires ---
// hp        max health
// radius    collision circle (the hull is drawn around it)
// accel     per-tick acceleration while driving
// damp      per-tick velocity multiplier (drag) — with accel sets top speed
// reloadMs  minimum gap between single-shot fire requests
// recoil    backward impulse on the hull when firing
// bullet:
//   speed   px/tick    damage  hp removed on a direct hit
//   radius  px         ttlMs   lifetime before the round fizzles
//   spread  radians of random cone added per shot (machine-gun inaccuracy)
//   splash  optional   area-damage radius on impact (heavy shell)
//   pierce  optional   passes through tanks instead of dying on first hit (sniper)
export const TANK_CLASSES = {
  scout: {
    name: 'Scout',
    blurb: 'Fast & fragile. Rapid pea-shooter.',
    hp: 70, radius: 13, accel: 0.45, damp: 0.91, reloadMs: 170, recoil: 0.25,
    bullet: { speed: 12, damage: 7, radius: 3, ttlMs: 950, spread: 0.06 },
  },
  fighter: {
    name: 'Fighter',
    blurb: 'All-rounder. Solid gun, solid armour.',
    hp: 110, radius: 16, accel: 0.39, damp: 0.89, reloadMs: 420, recoil: 0.55,
    bullet: { speed: 10, damage: 17, radius: 4, ttlMs: 1250, spread: 0.02 },
  },
  heavy: {
    name: 'Heavy',
    blurb: 'Slow tank, big explosive shells.',
    hp: 185, radius: 21, accel: 0.31, damp: 0.88, reloadMs: 1150, recoil: 1.45,
    bullet: { speed: 8, damage: 44, radius: 7, ttlMs: 1500, spread: 0, splash: 70 },
  },
  sniper: {
    name: 'Sniper',
    blurb: 'Long fast rounds that punch through tanks.',
    hp: 80, radius: 14, accel: 0.36, damp: 0.89, reloadMs: 1500, recoil: 1.2,
    bullet: { speed: 19, damage: 58, radius: 3, ttlMs: 2200, spread: 0, pierce: true },
  },
};
export const CLASS_KEYS = Object.keys(TANK_CLASSES);
export const DEFAULT_CLASS = 'fighter';

// --- Combat / lifecycle ---
export const SPLASH_MIN_FRAC = 0.35; // splash damage at the edge of the radius (vs full at center)
export const RESPAWN_MS = 3000; // delay before a destroyed tank returns (tdm/ffa)
export const REGEN_DELAY_MS = 6000; // no damage for this long, then health regenerates
export const REGEN_PER_SEC = 14; // hp/sec once regen kicks in
export const SPAWN_PROTECT_MS = 1500; // brief invulnerability after (re)spawning
export const KNOCKBACK = 0.35; // hull impulse per point of impact damage / 40

// --- Match rules / phases ---
export const FRAG_LIMIT = 25; // tdm: team kills to win · ffa: kills by one player
export const TIME_LIMIT_MS = 6 * 60 * 1000;
export const COUNTDOWN_MS = 3000; // "get ready" before a round goes live
export const END_SCREEN_MS = 8000; // winner overlay, then auto-return to room lobby
export const LTS_ROUND_WINS = 5; // last-tank-standing: round wins to take the match
export const LTS_ROUND_END_MS = 2600; // pause after a round is decided

// --- Pickups (crates spawn on pads during a match, all modes) ---
export const PICKUP_TYPES = ['health', 'shield', 'rapid', 'damage'];
export const PICKUP_RADIUS = 14;
export const PICKUP_FIRST_MS = 8000; // first crate appears this long into a round
export const PICKUP_RESPAWN_MS = 14000; // gap from a grab to the next crate on that pad
export const HEALTH_PICKUP_AMOUNT = 55;
export const SHIELD_MS = 7000;
export const RAPID_MS = 7000;
export const RAPID_RELOAD_MULT = 0.45; // reload time multiplier while 'rapid' is active
export const DAMAGE_MS = 7000;
export const DAMAGE_MULT = 1.6; // outgoing damage multiplier while 'damage' is active

// --- Server / room caps (abuse protection) ---
export const MAX_ROOMS = 50;
export const MAX_PLAYERS_PER_ROOM = 12;
export const ROOM_CREATE_COOLDOWN_MS = 3000;
export const MAX_PASSWORD_LEN = 32;
