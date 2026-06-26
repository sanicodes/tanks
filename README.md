# 🛡️ Tank Arena

Server-authoritative multiplayer **top-down tank shooter**. Built on the same
netcode skeleton as [Saka](../saka): one Node process hosts many rooms, each
running its own fixed **60 Hz** physics loop. Clients send **inputs only** — the
server simulates and broadcasts **30 Hz** snapshots; clients render and
interpolate (tanks ~100 ms in the past, bullets dead-reckoned for smoothness).

## Run it

```bash
npm install
npm start          # http://localhost:3000   (npm run dev for --watch)
```

Open the URL in two browser tabs, create a battle in one, join from the other,
pick teams + tanks in the room lobby, then the host starts the match. `PORT`
overrides the port.

## Controls

Drive `WASD` / arrows · Aim with the **mouse** · Fire `click` or `Space`
(auto-fires while held, gated by your tank's reload) · Switch tank `1`–`4`
(applies on your next spawn).

## Game modes

- **Team Deathmatch** — Red vs Blue, respawns on, first team to the frag limit
  (or most frags when time runs out).
- **Free-for-all** — everyone is hostile, respawns on, first player to the frag
  limit. Tanks get a unique colour; a live leaderboard tracks the field.
- **Last Tank Standing** — team elimination rounds, **no respawn**; the surviving
  side takes the round, first team to N round wins takes the match.

## Battlefields

Four data-driven arenas (`shared/arenas.js`) with different obstacle layouts:
**Crossfire** (central cross of walls), **Dustbowl** (open with pillars),
**Fortress** (two walled bases), and **Maze** (dense close-quarters lattice).
Each defines its own walls, team/FFA spawns, and pickup pads.

## Tanks & weapons

Four classes, each with its own hull stats and **bullet** (`shared/constants.js`):

| Class   | HP  | Speed | Weapon |
|---------|-----|-------|--------|
| Scout   | 70  | fast  | rapid 7-dmg peashooter (slight spread) |
| Fighter | 110 | med   | balanced 17-dmg round |
| Heavy   | 185 | slow  | 44-dmg shell with **splash** damage |
| Sniper  | 80  | med   | 58-dmg round that **pierces** through tanks |

Firing recoils the hull; hits apply knockback. Health regenerates after a few
seconds without damage, and fresh spawns get brief invulnerability.

## Pickups

Crates spawn on arena pads during a match (all modes): **health** (+55),
**shield** (incoming damage −60%), **rapid** (reload ×0.45), and **damage**
(outgoing ×1.6). Active buffs show as coloured rings around the tank.

## What's built

- **Shared sim** (`shared/`) — `Body` circle physics, tank/tank + tank/wall
  collision (slide, no bounce), substepped integration, data-driven arenas, and
  tank/bullet factories. Pure isomorphic ESM — identical math on server and
  client.
- **Server** (`server/`) — Socket.IO, per-room 60 Hz loop, 30 Hz snapshots,
  full `lobby → countdown → play → (roundend) → ended` state machine for all
  three modes, server-authoritative damage/kills/respawns, pickups, host-owned
  settings + start, team/class picking, optional room passwords, forfeit
  handling, and auto-return to the room lobby after a match.
- **Client** (`client/`) — canvas renderer with entity interpolation, tanks
  drawn as hull + treads + independently-aiming turret, muzzle flashes,
  explosions and debris, health bars, buff rings, scoreboard/leaderboard HUD,
  respawn + winner overlays, and synthesized Web Audio SFX (no asset files).

## Layout

```
shared/   constants.js  physics.js  factory.js  arenas.js   # runs on both sides
server/   index.js (bootstrap)  net.js (sockets+registry)  Room.js (game loop)
client/   index.html  main.js  render.js  ui.js  sfx.js
```
# tanks
