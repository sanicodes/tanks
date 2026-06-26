// DOM helpers: global lobby list, room lobby (team + class picker + host settings),
// in-match HUD (scores, clock, leaderboard), respawn + winner overlays.
// Pure view layer — main.js owns state/sockets.

const $ = (id) => document.getElementById(id);

const MODE_LABEL = { tdm: 'Team Deathmatch', ffa: 'Free-for-all', lts: 'Last Tank Standing' };
const MODE_SHORT = { tdm: 'TDM', ffa: 'FFA', lts: 'LTS' };

const MODE_OPTS = [
  { label: 'Team DM', value: 'tdm' },
  { label: 'Free-for-all', value: 'ffa' },
  { label: 'Last Tank', value: 'lts' },
];
const FRAG_OPTS = [
  { label: '10', value: 10 },
  { label: '25', value: 25 },
  { label: '50', value: 50 },
  { label: '∞', value: 0 },
];
const TIME_OPTS = [
  { label: '3 min', value: 180000 },
  { label: '5 min', value: 300000 },
  { label: '10 min', value: 600000 },
  { label: '∞', value: 0 },
];
const FOG_OPTS = [
  { label: 'On', value: true },
  { label: 'Off', value: false },
];

export const ui = {
  show(screen) {
    for (const s of ['welcome', 'lobby', 'roomlobby', 'game']) {
      $(s).classList.toggle('hidden', s !== screen);
    }
  },

  setError(msg) {
    $('lobbyErr').textContent = msg || '';
  },

  // ---- global lobby ----
  renderRoomList(rooms, onJoin) {
    const list = $('roomList');
    list.innerHTML = '';
    if (!rooms.length) {
      list.innerHTML = '<div class="empty">No battles yet — start one!</div>';
      return;
    }
    for (const r of rooms) {
      const card = document.createElement('div');
      card.className = 'roomcard';
      const playing = r.state !== 'lobby' && r.state !== 'ended';
      const lock = r.locked ? '🔒 ' : '';
      card.innerHTML = `
        <div>
          <div>${lock}${escapeHtml(r.name)}</div>
          <div class="meta">${MODE_SHORT[r.mode] || ''} · ${r.players}/${r.max} · ${playing ? 'in battle' : 'open'}</div>
        </div>`;
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.textContent = r.players >= r.max ? 'Full' : 'Join';
      btn.disabled = r.players >= r.max;
      btn.onclick = () => onJoin(r.id, r.locked);
      card.appendChild(btn);
      list.appendChild(card);
    }
  },

  // ---- room lobby ----
  renderRoom(room, selfId, handlers) {
    $('rlName').textContent = room.name;
    const isOwner = room.ownerId === selfId;
    $('rlHostTag').classList.toggle('hidden', !isOwner);
    const self = room.players.find((p) => p.id === selfId);
    const mode = room.mode;

    // team columns adapt to the mode
    const teams = $('rlTeams');
    teams.innerHTML = '';
    const cols = mode === 'ffa'
      ? [['ffa', 'Fighters', 'col-ffa'], ['spec', 'Spectators', 'col-spec']]
      : [['red', 'Red Team', 'col-red'], ['spec', 'Spectators', 'col-spec'], ['blue', 'Blue Team', 'col-blue']];
    teams.style.gridTemplateColumns = `repeat(${cols.length}, 1fr)`;
    for (const [key, title, cls] of cols) {
      const col = document.createElement('div');
      col.className = `teamcol ${cls}`;
      const ul = document.createElement('ul');
      ul.className = 'roster';
      for (const p of room.players) {
        if (p.team !== key) continue;
        const li = document.createElement('li');
        let label = p.id === room.ownerId ? `★ ${p.name}` : p.name;
        if (key !== 'spec') label += ` · ${capitalize(p.cls)}`;
        if (p.id === selfId) {
          label += ' (you)';
          li.className = 'self';
        }
        li.textContent = label;
        ul.appendChild(li);
      }
      const btn = document.createElement('button');
      btn.textContent = key === 'spec' ? 'Spectate' : `Join ${title}`;
      btn.onclick = () => handlers.onTeam(key);
      col.innerHTML = `<h3>${title}</h3>`;
      col.appendChild(ul);
      col.appendChild(btn);
      teams.appendChild(col);
    }

    // class picker
    const cp = $('rlClasses');
    cp.innerHTML = '';
    for (const c of room.classes) {
      const b = document.createElement('button');
      b.className = 'classbtn' + (self && self.cls === c.key ? ' sel' : '');
      b.innerHTML = `<strong>${c.name}</strong><span>${c.blurb}</span>`;
      b.onclick = () => handlers.onClass(c.key);
      cp.appendChild(b);
    }

    // settings (owner-editable)
    renderOpts($('rlMode'), MODE_OPTS, mode, isOwner, (v) => handlers.onSetting({ mode: v }));
    const arenaOpts = room.arenas.map((a) => ({ label: a.name, value: a.key }));
    renderOpts($('rlArena'), arenaOpts, room.settings.arenaKey, isOwner, (v) => handlers.onSetting({ arenaKey: v }));
    renderOpts($('rlFrag'), FRAG_OPTS, room.settings.fragLimit, isOwner, (v) => handlers.onSetting({ fragLimit: v }));
    renderOpts($('rlTime'), TIME_OPTS, room.settings.timeLimitMs, isOwner, (v) => handlers.onSetting({ timeLimitMs: v }));
    renderOpts($('rlFog'), FOG_OPTS, room.settings.fog !== false, isOwner, (v) => handlers.onSetting({ fog: v }));
    $('fragLabel').textContent = mode === 'lts' ? 'Round goal' : 'Frag limit';
    $('rlFragRow').classList.toggle('hidden', mode === 'lts');

    // start / shuffle
    let ready;
    if (mode === 'ffa') ready = room.players.filter((p) => p.team !== 'spec').length >= 2;
    else ready = room.players.some((p) => p.team === 'red') && room.players.some((p) => p.team === 'blue');
    $('startBtn').classList.toggle('hidden', !isOwner);
    $('startBtn').disabled = !ready;
    $('shuffleBtn').classList.toggle('hidden', !isOwner || mode === 'ffa');
    $('shuffleBtn').disabled = room.players.length < 2;
    if (isOwner) {
      $('rlWait').textContent = ready
        ? ''
        : mode === 'ffa'
        ? 'Need at least 2 fighters to start.'
        : 'Put at least one tank on each team to start.';
    } else {
      $('rlWait').textContent = 'Waiting for the host to start the battle…';
    }
  },

  // ---- in-match HUD ----
  setTopScore(scores, mode, selfId) {
    if (!scores) return;
    if (mode === 'tdm') {
      $('hudLeft').innerHTML = `<span class="red">${scores.teamKills.red}</span>`;
      $('hudRight').innerHTML = `<span class="blue">${scores.teamKills.blue}</span>`;
      $('hudLeft').classList.remove('hidden');
      $('hudRight').classList.remove('hidden');
    } else if (mode === 'lts') {
      $('hudLeft').innerHTML = `<span class="red">${scores.roundWins.red}</span>`;
      $('hudRight').innerHTML = `<span class="blue">${scores.roundWins.blue}</span>`;
      $('hudLeft').classList.remove('hidden');
      $('hudRight').classList.remove('hidden');
    } else {
      const sorted = [...scores.players].filter((p) => p.team !== 'spec').sort((a, b) => b.kills - a.kills);
      const leader = sorted[0];
      const self = scores.players.find((p) => p.id === selfId);
      $('hudLeft').innerHTML = leader ? `👑 ${escapeHtml(leader.name)} <b>${leader.kills}</b>` : '';
      $('hudRight').innerHTML = self && self.team !== 'spec' ? `You <b>${self.kills}</b>` : 'Spectating';
      $('hudLeft').classList.remove('hidden');
      $('hudRight').classList.remove('hidden');
    }
    $('hudMid').textContent = MODE_LABEL[mode] || '';
  },

  renderLeaderboard(scores, mode, selfId) {
    if (!scores) return;
    const board = $('board');
    board.innerHTML = '';
    const groups = mode === 'ffa'
      ? [['ffa', 'Fighters', 'ffa']]
      : [['red', 'Red', 'red'], ['blue', 'Blue', 'blue']];
    for (const [key, title, cls] of groups) {
      const players = scores.players
        .filter((p) => p.team === key)
        .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
      const h = document.createElement('h4');
      h.className = cls;
      const total = key !== 'ffa' ? ` <span class="cnt">${players.reduce((s, p) => s + p.kills, 0)}</span>` : '';
      h.innerHTML = `${title}${total}`;
      board.appendChild(h);
      const ul = document.createElement('ul');
      if (!players.length) {
        ul.innerHTML = '<li class="empty">—</li>';
      }
      for (const p of players) {
        const li = document.createElement('li');
        if (p.id === selfId) li.className = 'self';
        li.innerHTML = `<span class="nm">${escapeHtml(p.name)}</span><span class="kd">${p.kills}/${p.deaths}</span>`;
        ul.appendChild(li);
      }
      board.appendChild(ul);
    }
  },

  setClock(ms) {
    if (ms === null || ms === undefined) {
      $('clock').textContent = '∞';
      return;
    }
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    $('clock').textContent = `${m}:${String(s).padStart(2, '0')}`;
  },

  setCountdown(ms) {
    const el = $('countdown');
    if (ms === null || ms === undefined || ms <= 0) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    el.textContent = Math.ceil(ms / 1000);
  },

  setBanner(state, lastRoundWinner) {
    let text = '';
    if (state === 'roundend') {
      text = lastRoundWinner
        ? `${lastRoundWinner === 'red' ? 'Red' : 'Blue'} takes the round!`
        : 'Round draw';
    }
    $('banner').textContent = text;
  },

  setRespawn(self) {
    const el = $('respawn');
    if (!self || !self.dead) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    if (self.elim) {
      el.innerHTML = `<div class="rs-big">Destroyed</div><div class="rs-sub">Eliminated — wait for the next round</div>`;
    } else {
      const s = Math.max(0, Math.ceil((self.respawnMs || 0) / 1000));
      el.innerHTML = `<div class="rs-big">Destroyed</div><div class="rs-sub">Respawning in ${s}…</div>`;
    }
  },

  setWinner(state, winner) {
    const el = $('winner');
    if (state !== 'ended' || !winner) {
      el.classList.add('hidden');
      return;
    }
    const color = winner.color === 'red' ? 'var(--red)' : winner.color === 'blue' ? 'var(--blue)' : '#eaeaea';
    el.innerHTML = `<div class="big" style="color:${color}">${escapeHtml(winner.label)}</div>`;
    el.classList.remove('hidden');
  },

  setEndControls(state, isOwner) {
    const ended = state === 'ended';
    $('rematchBtn').classList.toggle('hidden', !(ended && isOwner));
    const note = $('endNote');
    note.classList.toggle('hidden', !ended);
    if (ended) note.textContent = isOwner ? 'Back to lobby soon… (or play again)' : 'Back to lobby soon…';
  },
};

function renderOpts(container, opts, selected, editable, onPick) {
  container.innerHTML = '';
  for (const o of opts) {
    const b = document.createElement('button');
    b.textContent = o.label;
    if (o.value === selected) b.className = 'sel';
    b.disabled = !editable;
    b.onclick = () => onPick(o.value);
    container.appendChild(b);
  }
}

function capitalize(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
