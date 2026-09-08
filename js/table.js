// The layer that replaces the server.
//
// One phone a round - the dealer's, exactly as at a real table - holds the
// undealt deck and runs the rules. It publishes two things to the database:
// the public table (whose turn, the top discard, how many cards everyone
// holds, melds, scores) which anyone may read, and one sealed hand per player
// which only that player's phone can open.
//
// Everybody else posts what they want to do to `intents`; the dealer applies
// it through the same rules engine the tests cover, and publishes the result.
// When a round ends the deal passes on, and with it the deck.

import * as G from './game.js';
import * as R from './rules.js';
import * as Seal from './seal.js';
import * as DB from './db.js';
import { randomId } from './random.js';

const SEEN_FRESH_MS = 45000;
const HEARTBEAT_MS = 12000;

const identityKey = (code, suffix) => `fivecrowns.room.${code}${suffix}`;
const deckKey = (code, suffix) => `fivecrowns.deck.${code}${suffix}`;

export function createTable({ onState, onError, seatSuffix = '' }) {
  let code = null;
  let me = null; // { playerId, name, publicJwk, privateJwk }
  let roster = []; // [{ id, name, pub, joined, seen }]
  let meta = null;
  let publicState = null;
  let myHand = null;
  let game = null; // only ever populated on the dealer's phone
  let appliedSeq = {}; // playerId -> last intent applied
  let lastError = null;
  let metaWatch = null;
  let intentWatch = null;
  let heartbeat = null;
  let rosterTimer = null;
  let mySeq = 0;

  const fail = (err) => onError && onError(err.message || String(err));

  // ---------------------------------------------------------------- identity
  function remember(data) {
    try {
      localStorage.setItem(identityKey(code, seatSuffix), JSON.stringify(data));
    } catch {}
  }
  function recall(forCode) {
    try {
      return JSON.parse(localStorage.getItem(identityKey(forCode, seatSuffix)));
    } catch {
      return null;
    }
  }

  /** The deck lives on the dealer's phone; keep a copy so a reload recovers. */
  function stashDeck() {
    try {
      localStorage.setItem(deckKey(code, seatSuffix), JSON.stringify(game));
    } catch {}
  }
  function unstashDeck() {
    try {
      return JSON.parse(localStorage.getItem(deckKey(code, seatSuffix)));
    } catch {
      return null;
    }
  }
  function dropDeck() {
    try {
      localStorage.removeItem(deckKey(code, seatSuffix));
    } catch {}
  }

  // ---------------------------------------------------------------- who deals
  const myIndex = () => roster.findIndex((p) => p.id === me?.playerId);
  const dealerIndex = () => (meta && Number.isInteger(meta.dealerIndex) ? meta.dealerIndex : -1);
  const iAmDealer = () => dealerIndex() >= 0 && dealerIndex() === myIndex();
  const iAmHost = () => !!meta && meta.hostId === me?.playerId;

  // ---------------------------------------------------------------- the view
  /** The shape the interface renders: public table plus my own cards. */
  function view() {
    if (!meta) return null;
    if (meta.phase === 'lobby') {
      return {
        phase: 'lobby',
        you: me?.playerId,
        code,
        round: 0,
        totalRounds: R.ROUNDS,
        settings: { allowAllWildMelds: meta.allowAllWildMelds !== false },
        players: roster.map((p, i) => ({
          id: p.id,
          name: p.name,
          index: i,
          isHost: p.id === meta.hostId,
          connected: Date.now() - (p.seen || 0) < SEEN_FRESH_MS,
          handCount: 0,
          hand: null,
          melds: [],
          leftover: [],
          roundScores: [],
          total: 0,
          isOut: false,
        })),
        log: [],
      };
    }
    if (!publicState) return null;
    const seen = new Map(roster.map((p) => [p.id, p.seen || 0]));
    const state = {
      ...publicState,
      you: me?.playerId,
      code,
      dealerName: roster[dealerIndex()]?.name || '',
      iAmDealer: iAmDealer(),
      pendingError: lastError,
      players: publicState.players.map((p) => ({
        ...p,
        connected: Date.now() - (seen.get(p.id) || 0) < SEEN_FRESH_MS,
        hand: p.id === me?.playerId ? myHand : null,
      })),
    };
    return state;
  }

  const push = () => onState && onState(view());

  // ---------------------------------------------------------------- publishing
  /** Write the public table and re-seal the hands that changed. */
  async function publish(changedIds) {
    const sealed = {};
    const targets = changedIds || game.players.map((p) => p.id);
    for (const id of targets) {
      const player = game.players.find((p) => p.id === id);
      const pub = roster.find((r) => r.id === id)?.pub;
      if (!player || !pub) continue;
      sealed[id] = await Seal.seal(pub, player.hand);
    }

    const table = G.redact(game, null); // nobody's hand travels in the open
    await DB.put(`rooms/${code}/state`, table);
    for (const [id, envelope] of Object.entries(sealed)) {
      await DB.put(`rooms/${code}/hands/${id}`, envelope);
    }
    await DB.patch(`rooms/${code}/meta`, {
      rev: Date.now(),
      phase: game.phase,
      round: game.round,
      wildRank: game.wildRank,
      dealerIndex: game.dealerIndex,
      turnIndex: game.turnIndex,
      turnPhase: game.turnPhase,
    });
    stashDeck();
  }

  // ---------------------------------------------------------------- dealing
  /** Build a game from the public scores so far, then deal the next round. */
  async function dealRound() {
    const carried = publicState?.players || [];
    game = G.createGame({ allowAllWildMelds: meta.allowAllWildMelds !== false });
    game.players = roster.map((p) => {
      const before = carried.find((c) => c.id === p.id);
      return {
        id: p.id,
        token: p.id,
        name: p.name,
        isHost: p.id === meta.hostId,
        connected: true,
        hand: [],
        melds: [],
        leftover: [],
        roundScores: before ? before.roundScores.slice() : [],
        total: before ? before.total : 0,
      };
    });
    game.round = (meta.round || 0);
    game.dealerIndex = dealerIndex();
    game.settings.allowAllWildMelds = meta.allowAllWildMelds !== false;
    G.startRound(game);
    // startRound rotates the dealer itself; we already know who deals.
    game.dealerIndex = dealerIndex();
    game.turnIndex = (game.dealerIndex + 1) % game.players.length;
    await DB.remove(`rooms/${code}/intents`);
    await DB.remove(`rooms/${code}/acks`);
    appliedSeq = {};
    await publish();
  }

  // ---------------------------------------------------------------- intents
  async function applyIntent(playerId, intent) {
    const player = game.players.find((p) => p.id === playerId);
    if (!player) return;
    let result;
    switch (intent.action) {
      case 'draw':
        result = G.drawCard(game, player, intent.payload?.source);
        break;
      case 'discard':
        result = G.discardCard(game, player, intent.payload?.cardId);
        break;
      case 'layDown':
        result = G.layDown(game, player, intent.payload?.melds || [], intent.payload?.discardId);
        break;
      default:
        result = { error: 'Unknown move.' };
    }
    appliedSeq[playerId] = intent.seq;
    await DB.put(`rooms/${code}/acks/${playerId}`, {
      seq: intent.seq,
      error: result.error || null,
    });
    if (result.error) return false;
    return true;
  }

  async function handleIntents(all) {
    if (!game || !iAmDealer()) return;
    let changed = false;
    for (const [playerId, intent] of Object.entries(all || {})) {
      if (!intent || typeof intent.seq !== 'number') continue;
      if (appliedSeq[playerId] === intent.seq) continue;
      const ok = await applyIntent(playerId, intent);
      if (ok) changed = true;
    }
    if (changed) await publish();
  }

  // ---------------------------------------------------------------- watching
  async function refreshRoster() {
    const map = await DB.get(`rooms/${code}/players`);
    roster = Object.entries(map || {})
      .map(([id, p]) => ({ id, name: p.name, pub: p.pub, joined: p.joined || 0, seen: p.seen || 0 }))
      .sort((a, b) => a.joined - b.joined);
  }

  async function onMeta(next) {
    if (!next) return;
    const before = meta;
    meta = next;

    if (meta.phase === 'lobby') {
      await refreshRoster();
      push();
      return;
    }

    if (!before || before.rev !== meta.rev || !publicState) {
      publicState = await DB.get(`rooms/${code}/state`);
      await refreshRoster();
      await loadMyHand();
    }

    // A round ended and the deal has come round to me: shuffle and deal.
    if (meta.phase === 'dealing' && iAmDealer()) {
      await dealRound();
      return;
    }

    if (iAmDealer() && !game) {
      const stashed = unstashDeck();
      if (stashed && stashed.round === meta.round) game = stashed;
    }
    push();
  }

  async function loadMyHand() {
    if (!me) return;
    const envelope = await DB.get(`rooms/${code}/hands/${me.playerId}`);
    if (!envelope) {
      myHand = [];
      return;
    }
    try {
      myHand = await Seal.open(me.privateJwk, envelope);
    } catch {
      myHand = [];
    }
  }

  async function checkAck() {
    const ack = await DB.get(`rooms/${code}/acks/${me.playerId}`);
    if (ack && ack.seq === mySeq && ack.error) {
      lastError = ack.error;
      onError && onError(ack.error);
      lastError = null;
    }
  }

  function startWatching() {
    metaWatch = DB.watch(`rooms/${code}/meta`, (m) => onMeta(m).catch(fail), fail);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      DB.patch(`rooms/${code}/players/${me.playerId}`, { seen: Date.now() }).catch(() => {});
    }, HEARTBEAT_MS);
    if (rosterTimer) clearInterval(rosterTimer);
    rosterTimer = setInterval(() => {
      refreshRoster().then(push).catch(() => {});
    }, HEARTBEAT_MS);
    if (intentWatch) intentWatch.stop();
    intentWatch = DB.watch(
      `rooms/${code}/intents`,
      (all) => handleIntents(all).catch(fail),
      fail,
      900
    );
  }

  // ---------------------------------------------------------------- public api
  async function identify(forCode, name) {
    const mine = recall(forCode);
    if (mine && mine.privateJwk) {
      return { ...mine, name: name || mine.name };
    }
    const pair = await Seal.newKeypair();
    return { playerId: randomId(), name, publicJwk: pair.publicJwk, privateJwk: pair.privateJwk };
  }

  return {
    get code() {
      return code;
    },
    view,

    async create(name, settings = {}) {
      const identity = await identify(null, name);
      code = await DB.createRoom({
        hostId: identity.playerId,
        allowAllWildMelds: settings.allowAllWildMelds !== false,
        round: 0,
      });
      me = identity;
      remember(me);
      await DB.put(`rooms/${code}/players/${me.playerId}`, {
        name: me.name,
        pub: me.publicJwk,
        joined: Date.now(),
        seen: Date.now(),
      });
      meta = await DB.get(`rooms/${code}/meta`);
      await refreshRoster();
      startWatching();
      push();
      return code;
    },

    async join(joinCode, name) {
      const wanted = String(joinCode || '').toUpperCase().trim();
      if (!(await DB.roomExists(wanted))) throw new Error('No game with that code.');
      code = wanted;
      me = await identify(wanted, name);
      remember(me);
      await refreshRoster();
      const already = roster.find((p) => p.id === me.playerId);
      if (!already) {
        const clash = roster.some(
          (p) => p.name.toLowerCase() === String(name).trim().toLowerCase()
        );
        if (clash) throw new Error('Someone in this game already has that name.');
        if (roster.length >= R.MAX_PLAYERS) throw new Error('That game is full.');
        const live = await DB.get(`rooms/${code}/meta`);
        if (live && live.phase !== 'lobby') throw new Error('That game has already started.');
      }
      await DB.put(`rooms/${code}/players/${me.playerId}`, {
        name: me.name,
        pub: me.publicJwk,
        joined: already ? already.joined : Date.now(),
        seen: Date.now(),
      });
      // Nudge meta so everyone else's lobby notices somebody arrived; the
      // roster itself is not what phones are watching.
      await DB.patch(`rooms/${code}/meta`, { lobbyRev: Date.now() });
      meta = await DB.get(`rooms/${code}/meta`);
      await refreshRoster();
      startWatching();
      push();
      return code;
    },

    /** Rejoin a room this phone already belongs to, after a reload. */
    async resume(forCode) {
      const mine = recall(forCode);
      if (!mine) return false;
      if (!(await DB.roomExists(forCode))) return false;
      code = forCode;
      me = mine;
      meta = await DB.get(`rooms/${code}/meta`);
      await refreshRoster();
      if (!roster.some((p) => p.id === me.playerId)) return false;
      await DB.patch(`rooms/${code}/players/${me.playerId}`, { seen: Date.now() });
      startWatching();
      await onMeta(meta);
      return true;
    },

    async start() {
      if (!iAmHost()) throw new Error('Only the host can start the game.');
      await refreshRoster();
      if (roster.length < R.MIN_PLAYERS) {
        throw new Error(`You need at least ${R.MIN_PLAYERS} players.`);
      }
      // The host deals the first round; after that the deal passes on.
      await DB.patch(`rooms/${code}/meta`, {
        phase: 'dealing',
        round: 0,
        dealerIndex: myIndex(),
        rev: Date.now(),
      });
      meta = await DB.get(`rooms/${code}/meta`);
      await dealRound();
    },

    /** Move the deal on to the next player, who then shuffles. */
    async nextRound() {
      if (!publicState || publicState.phase !== 'roundEnd') return;
      const next = (dealerIndex() + 1) % roster.length;
      game = null;
      dropDeck();
      await DB.patch(`rooms/${code}/meta`, {
        phase: 'dealing',
        dealerIndex: next,
        round: publicState.round,
        rev: Date.now(),
      });
    },

    async rematch() {
      const next = (dealerIndex() + 1) % roster.length;
      game = null;
      dropDeck();
      await DB.remove(`rooms/${code}/state`);
      publicState = null;
      await DB.patch(`rooms/${code}/meta`, {
        phase: 'dealing',
        dealerIndex: next,
        round: 0,
        rev: Date.now(),
      });
    },

    /** Make a move: applied here if I am dealing, posted if I am not. */
    async act(action, payload = {}) {
      if (iAmDealer() && game) {
        const player = game.players.find((p) => p.id === me.playerId);
        let result;
        if (action === 'draw') result = G.drawCard(game, player, payload.source);
        else if (action === 'discard') result = G.discardCard(game, player, payload.cardId);
        else if (action === 'layDown') {
          result = G.layDown(game, player, payload.melds || [], payload.discardId);
        } else result = { error: 'Unknown move.' };
        if (result.error) throw new Error(result.error);
        await publish();
        return;
      }
      mySeq += 1;
      await DB.put(`rooms/${code}/intents/${me.playerId}`, {
        seq: mySeq,
        action,
        payload,
        at: Date.now(),
      });
      metaWatch && metaWatch.hurry();
      setTimeout(() => checkAck().catch(() => {}), 1400);
    },

    stop() {
      metaWatch && metaWatch.stop();
      intentWatch && intentWatch.stop();
      clearInterval(heartbeat);
      clearInterval(rosterTimer);
    },
  };
}
