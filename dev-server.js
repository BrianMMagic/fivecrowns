// A local stand-in for Firebase, so the game can be played and tested without
// a database - and without an internet connection.
//
//   node dev-server.js      then open http://localhost:3000
//
// It serves the same static files GitHub Pages will serve, plus an in-memory
// endpoint that speaks the small part of the Firebase Realtime Database REST
// API this app uses. The browser is handed a firebase-config.js pointing at
// it, so nothing in the app has to know the difference.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DB_PREFIX = '/__db';

let db = {}; // the whole database, as one plain object

// ------------------------------------------------------------ database paths
const segments = (p) => p.split('/').filter(Boolean);

function readPath(parts) {
  let node = db;
  for (const key of parts) {
    if (node === null || typeof node !== 'object') return null;
    node = node[key];
    if (node === undefined) return null;
  }
  return node === undefined ? null : node;
}

function writePath(parts, value) {
  if (parts.length === 0) {
    db = value === null ? {} : value;
    return;
  }
  let node = db;
  for (const key of parts.slice(0, -1)) {
    if (node[key] === undefined || node[key] === null || typeof node[key] !== 'object') {
      node[key] = {};
    }
    node = node[key];
  }
  const last = parts[parts.length - 1];
  // Firebase stores no empty nodes: writing null is how you delete.
  if (value === null) delete node[last];
  else node[last] = value;
}

function mergePath(parts, patch) {
  for (const [key, value] of Object.entries(patch)) writePath([...parts, key], value);
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Malformed JSON'));
      }
    });
    req.on('error', reject);
  });

async function handleDb(req, res, url) {
  const rel = url.pathname.slice(DB_PREFIX.length).replace(/\.json$/, '');
  const parts = segments(rel);
  const send = (value) => {
    const body = JSON.stringify(value === undefined ? null : value);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
  };

  if (req.method === 'GET') {
    let value = readPath(parts);
    if (url.searchParams.get('shallow') === 'true' && value && typeof value === 'object') {
      value = Object.fromEntries(Object.keys(value).map((k) => [k, true]));
    }
    return send(value);
  }
  if (req.method === 'PUT') {
    const body = await readBody(req);
    writePath(parts, body === undefined ? null : body);
    return send(body);
  }
  if (req.method === 'PATCH') {
    const body = await readBody(req);
    mergePath(parts, body || {});
    return send(body);
  }
  if (req.method === 'DELETE') {
    writePath(parts, null);
    return send(null);
  }
  res.writeHead(405).end();
}

// ------------------------------------------------------------ static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith(DB_PREFIX)) {
    handleDb(req, res, url).catch((err) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // Point the app at the local database instead of Firebase.
  if (url.pathname === '/js/firebase-config.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
    res.end(`export const DATABASE_URL = '${DB_PREFIX}';\nexport const ROOT = 'fivecrowns';\n`);
    return;
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Five Crowns (local database) at http://localhost:${PORT}`);
});
