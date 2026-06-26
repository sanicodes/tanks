// Synthesized sound effects via the Web Audio API — no asset files. The context
// starts suspended under autoplay rules; resume() runs on the first user gesture
// (the name-gate button). All sounds are short oscillator/noise bursts.

let ctx = null;
let master = null;
let muted = (() => {
  try {
    return localStorage.getItem('tanks:muted') === '1';
  } catch {
    return false;
  }
})();

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.3;
  master.connect(ctx.destination);
  return ctx;
}

function tone({ freq, type = 'sine', dur = 0.15, gain = 0.5, attack = 0.005, slideTo = null, when = 0 }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.08, gain = 0.4, when = 0, lp = false } = {}) {
  if (!ctx) return;
  const t0 = ctx.currentTime + when;
  const frames = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let node = src;
  if (lp) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 800;
    node = src.connect(f);
    node.connect(g).connect(master);
  } else {
    src.connect(g).connect(master);
  }
  src.start(t0);
}

let lastShot = 0;
export const sfx = {
  resume() {
    const c = ensure();
    if (c && c.state === 'suspended') c.resume();
  },
  get muted() {
    return muted;
  },
  toggleMuted() {
    muted = !muted;
    try {
      localStorage.setItem('tanks:muted', muted ? '1' : '0');
    } catch {}
    return muted;
  },

  // muzzle pop — throttled so a field full of scouts doesn't machine-gun the ears
  shoot() {
    if (muted || !ensure()) return;
    const now = ctx.currentTime;
    if (now - lastShot < 0.03) return;
    lastShot = now;
    tone({ freq: 320, type: 'square', dur: 0.06, gain: 0.18, slideTo: 140 });
    noise({ dur: 0.04, gain: 0.12 });
  },
  hit() {
    if (muted || !ensure()) return;
    tone({ freq: 180, type: 'sawtooth', dur: 0.05, gain: 0.12, slideTo: 90 });
  },
  explode() {
    if (muted || !ensure()) return;
    noise({ dur: 0.45, gain: 0.5, lp: true });
    tone({ freq: 120, type: 'sine', dur: 0.4, gain: 0.4, slideTo: 40 });
  },
  pickup() {
    if (muted || !ensure()) return;
    tone({ freq: 880, type: 'triangle', dur: 0.1, gain: 0.3 });
    tone({ freq: 1318.5, type: 'triangle', dur: 0.16, gain: 0.3, when: 0.08 });
  },
  beep() {
    if (muted || !ensure()) return;
    tone({ freq: 660, type: 'square', dur: 0.12, gain: 0.22 });
  },
  go() {
    if (muted || !ensure()) return;
    tone({ freq: 990, type: 'square', dur: 0.25, gain: 0.26 });
  },
  win() {
    if (muted || !ensure()) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => tone({ freq: f, type: 'square', dur: 0.2, gain: 0.28, when: i * 0.12 }));
  },
};
