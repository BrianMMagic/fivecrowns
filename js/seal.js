// A hand sealed to one phone.
//
// Every player's cards sit in the same database, so the database is not
// trusted to keep them apart. Each phone makes an ECDH keypair when it joins
// and publishes only the public half; the dealer seals each hand to the player
// it belongs to. Nobody else can open it, however loose the database rules are.
//
// ECDH P-256 -> HKDF-SHA256 -> AES-GCM, all from WebCrypto.

const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
const INFO = 'fivecrowns-hand-v1';

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('This browser cannot seal hands.');
  return c.subtle;
}

export function available() {
  return !!(globalThis.crypto && globalThis.crypto.subtle);
}

const toB64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return btoa(out);
};

const fromB64 = (text) => {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

export async function newKeypair() {
  const pair = await subtle().generateKey(CURVE, true, ['deriveBits']);
  const [publicJwk, privateJwk] = await Promise.all([
    subtle().exportKey('jwk', pair.publicKey),
    subtle().exportKey('jwk', pair.privateKey),
  ]);
  return { publicJwk, privateJwk };
}

const importPublic = (jwk) => subtle().importKey('jwk', jwk, CURVE, false, []);
const importPrivate = (jwk) => subtle().importKey('jwk', jwk, CURVE, false, ['deriveBits']);

/** The shared secret is run through HKDF rather than used raw. */
async function aesKeyFrom(privateKey, publicKey) {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const material = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(INFO),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Seal a value so only the holder of recipientJwk's private key can read it.
 * A throwaway keypair per sealing means two hands never share a key.
 */
export async function seal(recipientJwk, value) {
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ephemeral = await subtle().generateKey(CURVE, true, ['deriveBits']);
  const theirPublic = await importPublic(recipientJwk);
  const key = await aesKeyFrom(ephemeral.privateKey, theirPublic);
  const cipher = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain);
  const epk = await subtle().exportKey('jwk', ephemeral.publicKey);
  return { epk, iv: toB64(iv), ct: toB64(cipher) };
}

export async function open(privateJwk, envelope) {
  if (!envelope || !envelope.epk || !envelope.iv || !envelope.ct) {
    throw new Error('Nothing to open.');
  }
  const [mine, theirs] = await Promise.all([
    importPrivate(privateJwk),
    importPublic(envelope.epk),
  ]);
  const key = await aesKeyFrom(mine, theirs);
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromB64(envelope.iv) },
    key,
    fromB64(envelope.ct)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
