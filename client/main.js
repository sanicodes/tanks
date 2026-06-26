// Client entry: connects, captures input (WASD move + mouse aim + shot), buffers
// snapshots, drives the render loop. Sends INPUTS ONLY — never positions.
// Screens: global lobby -> room lobby (team + class + host settings) -> battle.

import { Renderer } from '/render.js';
import { ui } from '/ui.js';
import { sfx } from '/sfx.js';
import { CLASS_KEYS, TANK_CLASSES, RAPID_RELOAD_MULT } from '/shared/constants.js';

/* global io */
const socket = io();
const canvas = document.getElementById('c');
const renderer = new Renderer(canvas);

let selfId = null;
let inRoom = false;
let roomData = null;
let scores = null;
let mode = 'tdm';
let lastWinner = null;

const $ = (id) => document.getElementById(id);
const isOwner = () => !!roomData && roomData.ownerId === selfId;

let myName = '';
const playerName = () => myName || 'Player';

// derive fx hooks
renderer.onShoot = () => sfx.shoot();
renderer.onExplode = () => sfx.explode();
let lastHitSound = 0;
renderer.onHit = () => {
  const n = performance.now();
  if (n - lastHitSound > 60) {
    lastHitSound = n;
    sfx.hit();
  }
};

const handlers = {
  onTeam: (team) => socket.emit('team', { team }),
  onClass: (cls) => socket.emit('class', { cls }),
  onSetting: (s) => socket.emit('room:settings', s),
};

function route(state) {
  if (!inRoom) return;
  ui.show(state === 'lobby' ? 'roomlobby' : 'game');
}

// ---------------------------------------------------------------- name gate
const nameInput = $('name');
const enterBtn = $('enterBtn');
nameInput.value = (localStorage.getItem('tanks:name') || '').slice(0, 16);
const syncEnter = () => {
  enterBtn.disabled = nameInput.value.trim().length === 0;
};
syncEnter();
nameInput.addEventListener('input', syncEnter);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !enterBtn.disabled) enterName();
});
enterBtn.onclick = enterName;

function enterName() {
  const n = nameInput.value.trim().slice(0, 16);
  if (!n) return;
  myName = n;
  sfx.resume();
  try {
    localStorage.setItem('tanks:name', n);
  } catch {}
  $('whoami').textContent = n;
  ui.show('lobby');
  socket.emit('lobby:join');
}

$('changeName').onclick = (e) => {
  e.preventDefault();
  nameInput.value = myName;
  syncEnter();
  ui.show('welcome');
  nameInput.focus();
};

ui.show('welcome');

// ---------------------------------------------------------------- connection
socket.on('connect', () => {
  selfId = socket.id;
  if (!inRoom) socket.emit('lobby:join');
});

socket.on('lobby:rooms', (rooms) => {
  if (!inRoom) ui.renderRoomList(rooms, joinRoom);
});

function joinRoom(roomId, locked) {
  let password;
  if (locked) {
    password = prompt('This battle is locked. Enter the password:');
    if (password === null) return;
  }
  ui.setError('');
  socket.emit('room:join', { roomId, playerName: playerName(), password }, (res) => {
    if (res?.error) return ui.setError(res.error);
    enterRoom(res.selfId);
  });
}

$('createBtn').onclick = () => {
  ui.setError('');
  const name = ($('roomName').value || '').trim() || `${playerName()}'s battle`;
  const password = ($('roomPass').value || '').trim();
  socket.emit('room:create', { name, playerName: playerName(), password }, (res) => {
    if (res?.error) return ui.setError(res.error);
    enterRoom(res.selfId);
  });
};

$('refreshBtn').onclick = () =>
  socket.emit('lobby:list', (rooms) => ui.renderRoomList(rooms, joinRoom));

function enterRoom(id) {
  selfId = id || selfId;
  inRoom = true;
  renderer.setSelf(selfId);
  if (roomData) {
    route(roomData.state);
    if (roomData.state === 'lobby') ui.renderRoom(roomData, selfId, handlers);
  } else {
    ui.show('roomlobby');
  }
}

function leaveRoom() {
  socket.emit('room:leave');
  inRoom = false;
  roomData = null;
  scores = null;
  renderer.reset();
  ui.setWinner('lobby');
  ui.setRespawn(null);
  ui.show('lobby');
}
$('leaveBtn').onclick = leaveRoom;
$('rlLeave').onclick = leaveRoom;

// ---------------------------------------------------------------- sound toggle
const muteBtn = $('muteBtn');
const syncMute = () => {
  muteBtn.textContent = sfx.muted ? '🔇' : '🔊';
};
muteBtn.onclick = () => {
  sfx.toggleMuted();
  sfx.resume();
  syncMute();
};
syncMute();

// ---------------------------------------------------------------- room actions
$('startBtn').onclick = () => socket.emit('room:start');
$('shuffleBtn').onclick = () => socket.emit('room:shuffle');
$('rematchBtn').onclick = () => socket.emit('rematch');

// ---------------------------------------------------------------- server -> client
socket.on('room', (r) => {
  roomData = r;
  mode = r.mode;
  if (!inRoom) return;
  route(r.state);
  if (r.state === 'lobby') {
    ui.setWinner('lobby');
    ui.setRespawn(null);
    ui.renderRoom(r, selfId, handlers);
  }
});

socket.on('gameInit', (init) => {
  mode = init.mode;
  renderer.setInit(init);
  renderer.setSelf(selfId);
});

socket.on('scores', (s) => {
  scores = s;
  mode = s.mode;
  ui.setTopScore(s, mode, selfId);
  ui.renderLeaderboard(s, mode, selfId);
});

let prevPickupCount = 0;
let lastCountSecond = -1;
socket.on('snapshot', (snap) => {
  renderer.pushSnapshot(snap);
  ui.setClock(snap.timeLeftMs);
  ui.setCountdown(snap.countdownMs);
  // countdown beeps
  if (snap.countdownMs != null && snap.countdownMs > 0) {
    const sec = Math.ceil(snap.countdownMs / 1000);
    if (sec !== lastCountSecond) {
      lastCountSecond = sec;
      sfx.beep();
    }
  } else if (lastCountSecond !== -1) {
    lastCountSecond = -1;
    sfx.go();
  }
  // respawn overlay for self
  const self = snap.tanks.find((t) => t.id === selfId);
  selfState = self || null;
  ui.setRespawn(self || null);
  // pickup grab sound (a pad's crate vanished)
  if (snap.pickups.length < prevPickupCount) sfx.pickup();
  prevPickupCount = snap.pickups.length;
});

socket.on('state', (s) => {
  mode = s.mode;
  lastWinner = s.winner;
  ui.setClock(s.timeLeftMs);
  ui.setCountdown(s.countdownMs);
  ui.setBanner(s.state, s.lastRoundWinner);
  ui.setWinner(s.state, s.winner);
  ui.setEndControls(s.state, isOwner());
  if (s.state === 'ended') sfx.win();
  route(s.state);
});

// ---------------------------------------------------------------- input
const keys = {};
const MOVE = {
  u: ['KeyW', 'ArrowUp'],
  d: ['KeyS', 'ArrowDown'],
  l: ['KeyA', 'ArrowLeft'],
  r: ['KeyD', 'ArrowRight'],
};
const TRACKED = new Set([...Object.values(MOVE).flat(), 'Space']);

let mouseX = 0;
let mouseY = 0; // canvas-space mouse position
let firing = false;
let aim = 0;
let selfState = null; // our tank entry from the latest snapshot
let nextShotAt = 0; // client-predicted reload clock (performance.now ms)
let shotSeq = 0; // monotonically increasing, one server shot request per press

function canvasPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return [(clientX - rect.left) * sx, (clientY - rect.top) * sy];
}

canvas.addEventListener('mousemove', (e) => {
  [mouseX, mouseY] = canvasPoint(e.clientX, e.clientY);
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    firing = true;
    sfx.resume();
    requestShot();
  }
});
addEventListener('mouseup', (e) => {
  if (e.button === 0 && firing) {
    firing = false;
    pushInput();
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

addEventListener('keydown', (e) => {
  // class switch 1-4 (applies on next spawn)
  if (inRoom && e.code.startsWith('Digit')) {
    const n = +e.code.slice(5) - 1;
    if (n >= 0 && n < CLASS_KEYS.length) {
      socket.emit('class', { cls: CLASS_KEYS[n] });
      return;
    }
  }
  if (!inRoom || !TRACKED.has(e.code)) return;
  e.preventDefault();
  if (!keys[e.code]) {
    keys[e.code] = true;
    if (e.code === 'Space') requestShot();
    else pushInput();
  }
});
addEventListener('keyup', (e) => {
  if (!TRACKED.has(e.code)) return;
  keys[e.code] = false;
  pushInput();
});
addEventListener('blur', () => {
  for (const k of Object.keys(keys)) keys[k] = false;
  firing = false;
  pushInput();
});

let lastSent = '';
function pushInput() {
  if (!inRoom) return;
  const down = (list) => list.some((k) => keys[k]);
  // aim toward the mouse in WORLD space (mouse is canvas-space; add the camera)
  const self = renderer.getSelfPos();
  const cam = renderer.camera;
  if (self) aim = Math.atan2(mouseY + cam.y - self.y, mouseX + cam.x - self.x);
  const input = {
    u: down(MOVE.u),
    d: down(MOVE.d),
    l: down(MOVE.l),
    r: down(MOVE.r),
    fire: firing || keys['Space'],
    aim,
    shotSeq,
  };
  const sig = `${+input.u}${+input.d}${+input.l}${+input.r}${+input.fire}${shotSeq}:${aim.toFixed(2)}`;
  if (sig !== lastSent) {
    lastSent = sig;
    socket.emit('input', input);
  }
}

// aim follows the mouse continuously even when no keys change
setInterval(pushInput, 45);

// --- client-side predicted shooting ---------------------------------------
// Each press sends one shot request. The local tracer appears immediately when
// our predicted reload is ready; the server remains authoritative for damage.
function requestShot() {
  if (!inRoom) return;
  shotSeq++;
  pushInput();
  predictShot();
}

function predictShot() {
  if (!inRoom) return;
  if (!selfState || selfState.dead) return;
  const cls = renderer.getSelfClass();
  const pos = renderer.getSelfPos();
  if (!cls || !pos) return;
  const now = performance.now();
  if (now < nextShotAt) return;
  const spec = TANK_CLASSES[cls];
  const rapid = Array.isArray(selfState.buffs) && selfState.buffs.includes('rapid');
  nextShotAt = now + spec.reloadMs * (rapid ? RAPID_RELOAD_MULT : 1);
  renderer.spawnLocalBullet(pos.x, pos.y, aim, cls);
}

// ---------------------------------------------------------------- render loop
function frame() {
  renderer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
