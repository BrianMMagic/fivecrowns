// Randomness from WebCrypto, which both browsers and node provide, so the
// shuffle is the same code wherever the game is being run.

const webcrypto = globalThis.crypto;

/** A uniform integer in [0, max), without the bias of `% max`. */
export function randomInt(max) {
  if (max <= 0) throw new RangeError('max must be positive');
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  let value;
  do {
    webcrypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return value % max;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A short opaque id: player ids and the like. */
export function randomId(length = 12) {
  let out = '';
  for (let i = 0; i < length; i++) out += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return out;
}

/** A room code people read aloud: no I, O, 0 or 1. */
export function randomCode(length = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}
