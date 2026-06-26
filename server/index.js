// Bootstrap: express static server + Socket.IO. One persistent process hosts
// many rooms, each running its own 60 Hz loop (see Room.js). Must NOT be
// serverless — the game loop never stops.

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { wireSockets } from './net.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

// serve the client app and the shared ES modules (imported by the browser)
app.use(express.static(join(ROOT, 'client')));
app.use('/shared', express.static(join(ROOT, 'shared')));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const registry = wireSockets(io);

server.listen(PORT, () => {
  console.log(`Tank Arena server listening on http://localhost:${PORT}`);
});

function shutdown() {
  console.log('\nShutting down…');
  for (const room of registry.rooms.values()) room.stop();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
