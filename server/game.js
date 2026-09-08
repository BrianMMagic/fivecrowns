// Authoritative game state. Every rule check happens here; the browser is
// never trusted. Actions return { error } or mutate the game and log a line.

import crypto from 'node:crypto';
import * as R from '../shared/rules.js';

const now = () => Date.now();

export function createGame(settings = {}) {
  return {
    phase: 'lobby', // lobby | playing | roundEnd | gameOver
    players: [],
    round: 0,
    wildRank: null,
    dealerIndex: 0,
    turnIndex: 0,
    turnPhase: 'draw', // draw | act
    drawPile: [],
    discardPile: [],
    outPlayerIndex: null, // who went out this round
    log: [],
    settings: {
      allowAllWildMelds: settings.allowAllWildMelds !== false,
      rounds: R.ROUNDS,
    },
    createdAt: now(),
    updatedAt: now(),
  };
}

function logLine(game, text) {
  game.log.push({ t: now(), text });
  if (game.log.length > 200) game.log.splice(0, game.log.length - 200);
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function addPlayer(game, { name, token, isHost }) {
  if (game.phase !== 'lobby') return { error: 'That game has already started.' };
  if (game.players.length >= R.MAX_PLAYERS) {
    return { error: `A game holds at most ${R.MAX_PLAYERS} players.` };
  }
  const clean = String(name || '').trim().slice(0, 16);
  if (!clean) return { error: 'Please enter a name.' };
  if (game.players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
    return { error: 'Someone in this game already has that name.' };
  }
  const player = {
    id: crypto.randomUUID(),
    token,
    name: clean,
    isHost: !!isHost,
    connected: true,
    hand: [],
    melds: [],
    leftover: [],
    roundScores: [],
    total: 0,
    hasDrawnFrom: null,
  };
  game.players.push(player);
  logLine(game, `${clean} joined.`);
  return { player };
}

export function playerByToken(game, token) {
  return game.players.find((p) => p.token === token) || null;
}

function nextIndex(game, i) {
  return (i + 1) % game.players.length;
}

export function startGame(game) {
  if (game.phase !== 'lobby') return { error: 'The game has already started.' };
  if (game.players.length < R.MIN_PLAYERS) {
    return { error: `You need at least ${R.MIN_PLAYERS} players.` };
  }
  game.dealerIndex = crypto.randomInt(game.players.length);
  game.round = 0;
  startRound(game);
  return {};
}

export function startRound(game) {
  game.round += 1;
  game.phase = 'playing';
  game.wildRank = R.wildRankForRound(game.round);
  game.outPlayerIndex = null;
  const handSize = R.handSizeForRound(game.round);

  const deck = shuffle(R.buildDeck());
  for (const p of game.players) {
    p.hand = deck.splice(0, handSize);
    p.melds = [];
    p.leftover = [];
    p.hasDrawnFrom = null;
  }
  game.discardPile = [deck.pop()];
  game.drawPile = deck;

  game.dealerIndex = game.round === 1 ? game.dealerIndex : nextIndex(game, game.dealerIndex);
  game.turnIndex = nextIndex(game, game.dealerIndex);
  game.turnPhase = 'draw';

  logLine(
    game,
    `Round ${game.round}: ${handSize} cards each, ${R.rankName(game.wildRank)} are wild. ` +
      `${game.players[game.dealerIndex].name} deals.`
  );
  game.updatedAt = now();
}

function requireTurn(game, player) {
  if (game.phase !== 'playing') return 'The round is not in play right now.';
  if (game.players[game.turnIndex].id !== player.id) return "It is not your turn.";
  return null;
}

/** Somebody has gone out, so this player is taking the round's last turn. */
function isFinalTurn(game) {
  return game.outPlayerIndex !== null;
}

function replenishDrawPile(game) {
  if (game.drawPile.length > 0) return;
  const top = game.discardPile.pop();
  const recycled = shuffle(game.discardPile.splice(0));
  game.drawPile = recycled;
  game.discardPile = top ? [top] : [];
  logLine(game, 'The discard pile was reshuffled into a new draw pile.');
}

export function drawCard(game, player, source) {
  const err = requireTurn(game, player);
  if (err) return { error: err };
  if (game.turnPhase !== 'draw') return { error: 'You have already drawn this turn.' };

  let card;
  if (source === 'discard') {
    if (game.discardPile.length === 0) return { error: 'The discard pile is empty.' };
    card = game.discardPile.pop();
    logLine(game, `${player.name} took ${R.cardLabel(card)} from the discard pile.`);
  } else {
    replenishDrawPile(game);
    if (game.drawPile.length === 0) return { error: 'There are no cards left to draw.' };
    card = game.drawPile.pop();
    logLine(game, `${player.name} drew from the draw pile.`);
  }
  player.hand.push(card);
  player.hasDrawnFrom = source === 'discard' ? 'discard' : 'stock';
  game.turnPhase = 'act';
  game.updatedAt = now();
  return {};
}

export function discardCard(game, player, cardId) {
  return layDown(game, player, [], cardId);
}

/**
 * The one move that ends a turn: put down zero or more melds and discard one
 * card. On a normal turn every remaining card must be melded (that is what
 * going out is). On the final turn after someone else went out, whatever is
 * left over is scored against you.
 */
export function layDown(game, player, meldGroups, discardId) {
  const err = requireTurn(game, player);
  if (err) return { error: err };
  if (game.turnPhase === 'draw') return { error: 'Draw a card first.' };
  if (discardId == null) return { error: 'Choose a card to discard.' };

  const finalTurn = isFinalTurn(game);
  const laysDown = meldGroups.length > 0;
  // On a normal turn you may only put cards down if they cover your whole
  // hand - that is what going out means. On the final turn anything you
  // cannot meld simply counts against you.
  const check = R.validateLayDown(player.hand, meldGroups, discardId, {
    wildRank: game.wildRank,
    mustUseAll: !finalTurn && laysDown,
    allowAllWild: game.settings.allowAllWildMelds,
  });
  if (!check.ok) return { error: check.error };

  const discard = player.hand.find((c) => c.id === discardId);
  game.discardPile.push(discard);

  if (!finalTurn && !laysDown) {
    // A plain discard: the hand stays in play for the next go-around.
    player.hand = check.leftover;
    logLine(game, `${player.name} discarded ${R.cardLabel(discard)}.`);
  } else {
    player.hand = [];
    player.melds = check.melds.map((m) => m.cards);
    player.leftover = check.leftover;
    if (!finalTurn) {
      game.outPlayerIndex = game.turnIndex;
      logLine(game, `${player.name} went out! Everyone else gets one last turn.`);
    } else if (laysDown) {
      const n = meldGroups.length;
      logLine(game, `${player.name} laid down ${n} meld${n > 1 ? 's' : ''} and discarded ${R.cardLabel(discard)}.`);
    } else {
      logLine(game, `${player.name} discarded ${R.cardLabel(discard)} with nothing to lay down.`);
    }
  }

  advanceTurn(game);
  game.updatedAt = now();
  return {};
}

function advanceTurn(game) {
  const next = nextIndex(game, game.turnIndex);
  if (game.outPlayerIndex !== null && next === game.outPlayerIndex) {
    endRound(game);
    return;
  }
  game.turnIndex = next;
  game.turnPhase = 'draw';
}

function endRound(game) {
  const wildRank = game.wildRank;
  for (const p of game.players) {
    const unmelded = p.hand.length ? p.hand : p.leftover;
    const score = R.handValue(unmelded, wildRank);
    p.leftover = unmelded;
    p.hand = [];
    p.roundScores[game.round - 1] = score;
    p.total += score;
  }
  const outPlayer = game.players[game.outPlayerIndex];
  logLine(game, `Round ${game.round} over. ${outPlayer ? outPlayer.name + ' went out.' : ''}`);

  if (game.round >= game.settings.rounds) {
    game.phase = 'gameOver';
    const best = Math.min(...game.players.map((p) => p.total));
    const winners = game.players.filter((p) => p.total === best).map((p) => p.name);
    logLine(game, `Game over - ${winners.join(' and ')} won with ${best} points.`);
  } else {
    game.phase = 'roundEnd';
  }
  game.updatedAt = now();
}

export function nextRound(game) {
  if (game.phase !== 'roundEnd') return { error: 'The round is not finished.' };
  startRound(game);
  return {};
}

export function rematch(game) {
  if (game.phase !== 'gameOver') return { error: 'Finish this game first.' };
  for (const p of game.players) {
    p.roundScores = [];
    p.total = 0;
    p.hand = [];
    p.melds = [];
    p.leftover = [];
  }
  game.round = 0;
  game.log = [];
  logLine(game, 'New game!');
  startRound(game);
  return {};
}

/** What one player is allowed to see: their own hand, everyone else's counts. */
export function redact(game, viewerId) {
  const finalTurn = game.outPlayerIndex !== null;
  return {
    phase: game.phase,
    round: game.round,
    totalRounds: game.settings.rounds,
    wildRank: game.wildRank,
    handSize: game.round ? R.handSizeForRound(game.round) : null,
    dealerIndex: game.dealerIndex,
    turnIndex: game.turnIndex,
    turnPhase: game.turnPhase,
    finalTurn,
    outPlayerIndex: game.outPlayerIndex,
    drawPileCount: game.drawPile.length,
    discardTop: game.discardPile[game.discardPile.length - 1] || null,
    discardCount: game.discardPile.length,
    settings: game.settings,
    log: game.log.slice(-40),
    you: viewerId,
    players: game.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      connected: p.connected,
      index: i,
      handCount: p.hand.length,
      hand: p.id === viewerId ? p.hand : null,
      melds: p.melds,
      leftover:
        game.phase === 'roundEnd' || game.phase === 'gameOver' || p.id === viewerId
          ? p.leftover
          : p.leftover.map(() => null),
      leftoverCount: p.leftover.length,
      roundScores: p.roundScores,
      total: p.total,
      isOut: game.outPlayerIndex === i,
    })),
  };
}
