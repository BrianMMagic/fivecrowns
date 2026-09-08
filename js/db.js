// Talks to a Firebase Realtime Database over its plain REST API: no SDK, no
// build step, nothing to install. The database only ever holds public table
// state and sealed hands (see seal.js), so it is never trusted with the game.
//
// Phones watch one small `meta` node and fetch the bigger state only when
// something in it actually changed, which keeps a game to a few kilobytes
// rather than re-downloading every card twice a second.

import { DATABASE_URL, ROOT } from './firebase-config.js';
import { randomCode } from './random.js';

const POLL_MS = 1200;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // a code becomes reusable after a day

const base = () => String(DATABASE_URL || '').replace(/\/+$/, '');

export function configured() {
  return !!base();
}

const url = (path, query) => `${base()}/${ROOT}/${path}.json${query ? '?' + query : ''}`;

async function request(method, path, body, query) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(url(path, query), opts);
  } catch {
    throw new Error('Cannot reach the game database. Check your connection.');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`The database said ${res.status}${text ? ': ' + text.slice(0, 120) : ''}`);
  }
  return res.status === 204 ? null : res.json();
}

export const get = (path, query) => request('GET', path, undefined, query);
export const put = (path, value) => request('PUT', path, value);
export const patch = (path, value) => request('PATCH', path, value);
export const remove = (path) => request('DELETE', path);

const isStale = (meta) => !meta || !meta.created || Date.now() - meta.created > ROOM_TTL_MS;

/** Claim a code nobody is using. */
export async function createRoom(meta) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomCode(4);
    const existing = await get(`rooms/${code}/meta`);
    if (existing && !isStale(existing)) continue;
    await remove(`rooms/${code}`);
    await put(`rooms/${code}/meta`, { created: Date.now(), rev: 1, phase: 'lobby', ...meta });
    return code;
  }
  throw new Error('Could not find a free room code. Try again.');
}

export async function roomExists(code) {
  const meta = await get(`rooms/${code}/meta`);
  return !!meta && !isStale(meta);
}

/**
 * Poll one small node and call back only when it actually changes. Returns a
 * function that stops the watch.
 */
export function watch(path, onChange, onError, intervalMs = POLL_MS) {
  let stopped = false;
  let timer = null;
  let last = null;
  let interval = intervalMs;

  async function tick() {
    if (stopped) return;
    try {
      const value = await get(path);
      if (stopped) return;
      const seen = JSON.stringify(value);
      if (seen !== last) {
        last = seen;
        onChange(value);
      }
      timer = setTimeout(tick, interval);
    } catch (err) {
      if (stopped) return;
      if (onError) onError(err);
      timer = setTimeout(tick, interval * 3); // back off while it is unhappy
    }
  }

  tick();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    /** Poll harder for a moment - used right after you make a move. */
    hurry(ms = 350, forMs = 4000) {
      interval = ms;
      setTimeout(() => {
        interval = intervalMs;
      }, forMs);
    },
  };
}
