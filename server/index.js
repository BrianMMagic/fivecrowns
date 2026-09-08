// Five Crowns server. No dependencies: node's http module serves the client,
// takes actions as JSON POSTs, and pushes state with server-sent events.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as G from './game.js';
import * as R from '../shared/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'rooms.json');
const ROOM_TTL_MS = 1000 * 60 * 60 * 24 * 3; // keep unfinished games for 3 days

/** code -> { code, game, subs: Set<{res, token}> } */
const rooms = new Map();

// ---------------------------------------------------------------- persistence
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save().catch((e) => console.error('save failed:', e.message));
  }, 400);
}

async function save() {
  const out = {};
  for (const [code, room] of rooms) out[code] = room.game;
  await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fsp.writeFile(DATA_FILE, JSON.stringify(out));
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [code, game] of Object.entries(raw)) {
      for (const p of game.players) p.connected = false;
      rooms.set(code, { code, game, subs: new Set() });
    }
    console.log(`Restored ${rooms.size} room(s).`);
  } catch {
    /* first run */
  }
}

function sweep() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.game.updatedAt < cutoff && room.subs.size === 0) rooms.delete(code);
  }
  scheduleSave();
}

// ---------------------------------------------------------------- room codes
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
function newRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate a room code.');
}

// ---------------------------------------------------------------- broadcasting
function broadcast(room) {
  for (const sub of room.subs) {
    const player = G.playerByToken(room.game, sub.token);
    sendEvent(sub.res, 'state', G.redact(room.game, player ? player.id : null));
  }
  scheduleSave();
}

function sendEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* the client vanished; the close handler cleans up */
  }
}

// ---------------------------------------------------------------- http helpers
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Malformed request.'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  // Resolve inside the two directories we publish, and nowhere else.
  const base = rel.startsWith('/shared/') ? ROOT : path.join(ROOT, 'public');
  const file = path.resolve(base, '.' + rel);
  const allowed = [path.join(ROOT, 'public'), path.join(ROOT, 'shared')];
  if (!allowed.some((dir) => file === dir || file.startsWith(dir + path.sep))) {
    return json(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------- api
function findRoom(code) {
  return rooms.get(String(code || '').toUpperCase().trim()) || null;
}

async function handleApi(req, res, urlPath, query) {
  if (urlPath === '/api/stream' && req.method === 'GET') {
    const room = findRoom(query.get('room'));
    if (!room) return json(res, 404, { error: 'No game with that code.' });
    const token = query.get('token');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const sub = { res, token };
    room.subs.add(sub);

    const player = G.playerByToken(room.game, token);
    if (player && !player.connected) {
      player.connected = true;
      broadcast(room);
    } else {
      sendEvent(res, 'state', G.redact(room.game, player ? player.id : null));
    }

    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    const cleanup = () => {
      clearInterval(ping);
      room.subs.delete(sub);
      const p = G.playerByToken(room.game, token);
      if (p && ![...room.subs].some((s) => s.token === token)) {
        p.connected = false;
        broadcast(room);
      }
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
    return;
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const body = await readBody(req);

  if (urlPath === '/api/create') {
    const code = newRoomCode();
    const game = G.createGame({ allowAllWildMelds: body.allowAllWildMelds });
    const room = { code, game, subs: new Set() };
    const token = body.token || crypto.randomUUID();
    const added = G.addPlayer(game, { name: body.name, token, isHost: true });
    if (added.error) return json(res, 400, { error: added.error });
    rooms.set(code, room);
    scheduleSave();
    return json(res, 200, { room: code, token, playerId: added.player.id });
  }

  if (urlPath === '/api/join') {
    const room = findRoom(body.room);
    if (!room) return json(res, 404, { error: 'No game with that code.' });
    const token = body.token || crypto.randomUUID();
    const existing = G.playerByToken(room.game, token);
    if (existing) {
      return json(res, 200, { room: room.code, token, playerId: existing.id, rejoined: true });
    }
    const added = G.addPlayer(room.game, { name: body.name, token, isHost: false });
    if (added.error) return json(res, 400, { error: added.error });
    broadcast(room);
    return json(res, 200, { room: room.code, token, playerId: added.player.id });
  }

  if (urlPath === '/api/action') {
    const room = findRoom(body.room);
    if (!room) return json(res, 404, { error: 'No game with that code.' });
    const player = G.playerByToken(room.game, body.token);
    if (!player) return json(res, 403, { error: 'You are not in this game.' });

    const result = applyAction(room.game, player, body.action, body.payload || {});
    if (result.error) return json(res, 400, { error: result.error });
    broadcast(room);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Unknown endpoint' });
}

function applyAction(game, player, action, payload) {
  switch (action) {
    case 'start':
      if (!player.isHost) return { error: 'Only the host can start the game.' };
      return G.startGame(game);
    case 'draw':
      return G.drawCard(game, player, payload.source);
    case 'discard':
      return G.discardCard(game, player, payload.cardId);
    case 'layDown':
      if (!Array.isArray(payload.melds)) return { error: 'Malformed lay-down.' };
      return G.layDown(game, player, payload.melds, payload.discardId);
    case 'nextRound':
      return G.nextRound(game);
    case 'rematch':
      return G.rematch(game);
    default:
      return { error: 'Unknown action.' };
  }
}

// ---------------------------------------------------------------- server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const urlPath = url.pathname;
  if (urlPath.startsWith('/api/')) {
    handleApi(req, res, urlPath, url.searchParams).catch((err) =>
      json(res, 400, { error: err.message || 'Something went wrong.' })
    );
    return;
  }
  serveStatic(req, res, urlPath);
});

server.on('clientError', (err, socket) => socket.destroy());

load();
setInterval(sweep, 1000 * 60 * 30).unref();

server.listen(PORT, () => {
  console.log(`Five Crowns running at http://localhost:${PORT}`);
});
