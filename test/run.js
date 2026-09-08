// Rules and engine tests. No framework: node test/run.js
import assert from 'node:assert/strict';
import * as R from '../shared/rules.js';
import * as G from '../server/game.js';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const card = (rank, suit) => ({ id: `${suit}${rank}_x${Math.random()}`, rank, suit });
const joker = () => ({ id: `jk_${Math.random()}`, rank: null, suit: 'joker' });

// ---------------------------------------------------------------- deck
test('the deck is 116 unique cards', () => {
  const deck = R.buildDeck();
  assert.equal(deck.length, 116);
  assert.equal(new Set(deck.map((c) => c.id)).size, 116);
  assert.equal(deck.filter((c) => R.isJoker(c)).length, 6);
  // two of every suit/rank combination
  for (const suit of R.SUITS) {
    for (let rank = 3; rank <= 13; rank++) {
      assert.equal(deck.filter((c) => c.suit === suit && c.rank === rank).length, 2);
    }
  }
});

test('rounds deal 3..13 cards with a matching wild rank', () => {
  assert.equal(R.handSizeForRound(1), 3);
  assert.equal(R.handSizeForRound(11), 13);
  assert.equal(R.wildRankForRound(1), 3);
  assert.equal(R.wildRankForRound(11), 13);
});

// ---------------------------------------------------------------- melds
test('books need three of a number, runs need three in a suit', () => {
  const ok = (cards, wild) => R.validateMeld(cards, wild).ok;
  assert.ok(ok([card(7, 'stars'), card(7, 'hearts'), card(7, 'spades')], 5));
  assert.ok(ok([card(7, 'stars'), card(7, 'stars'), card(7, 'spades')], 5)); // two decks
  assert.ok(ok([card(4, 'clubs'), card(5, 'clubs'), card(6, 'clubs')], 9));
  assert.ok(!ok([card(4, 'clubs'), card(5, 'clubs')], 9)); // too short
  assert.ok(!ok([card(4, 'clubs'), card(5, 'hearts'), card(6, 'clubs')], 9)); // mixed suits
  assert.ok(!ok([card(4, 'clubs'), card(6, 'clubs'), card(9, 'clubs')], 13)); // not consecutive
});

test('wild cards fill gaps but a run cannot wrap past K or below 3', () => {
  const v = (cards, wild) => R.validateMeld(cards, wild);
  assert.equal(v([card(4, 'stars'), joker(), card(6, 'stars')], 9).type, 'run');
  assert.equal(v([card(12, 'stars'), card(13, 'stars'), joker()], 9).start, 11); // J-Q-K, not Q-K-?
  assert.equal(v([card(3, 'stars'), card(4, 'stars'), joker()], 9).start, 3); // 3-4-5
  // K + two wilds can only be J-Q-K
  assert.equal(v([card(13, 'hearts'), joker(), joker()], 9).type, 'book');
  // a four-card run needs the whole window inside 3..K
  assert.ok(v([card(11, 'spades'), card(12, 'spades'), card(13, 'spades'), joker()], 9).ok);
});

test("the round's rank is wild but can still play as itself", () => {
  // Round 5: fives are wild. 4-5-6 of stars is a legal run.
  assert.ok(R.validateMeld([card(4, 'stars'), card(5, 'stars'), card(6, 'stars')], 5).ok);
  // Three wilds are allowed by the standard rules, and refused when turned off.
  assert.ok(R.validateMeld([joker(), joker(), card(5, 'stars')], 5).ok);
  assert.ok(!R.validateMeld([joker(), joker(), joker()], 5, { allowAllWild: false }).ok);
});

test('a run cannot repeat a rank', () => {
  const r = R.validateMeld([card(5, 'stars'), card(5, 'stars'), card(6, 'stars'), joker()], 9);
  assert.ok(!r.ok);
});

// ---------------------------------------------------------------- scoring
test('unmelded cards score face value, wilds 20, jokers 50', () => {
  const wild = 7;
  assert.equal(R.cardValue(card(4, 'stars'), wild), 4);
  assert.equal(R.cardValue(card(11, 'stars'), wild), 11);
  assert.equal(R.cardValue(card(13, 'stars'), wild), 13);
  assert.equal(R.cardValue(card(7, 'stars'), wild), R.WILD_VALUE);
  assert.equal(R.cardValue(joker(), wild), R.JOKER_VALUE);
  assert.equal(R.handValue([card(4, 'stars'), card(7, 'clubs'), joker()], 7), 4 + 20 + 50);
});

// ---------------------------------------------------------------- lay-down
test('you may only lay down on a normal turn if it uses every card', () => {
  const hand = [card(7, 'stars'), card(7, 'hearts'), card(7, 'clubs'), card(9, 'spades')];
  const melds = [[hand[0].id, hand[1].id, hand[2].id]];
  const opts = { wildRank: 5, mustUseAll: true, allowAllWild: true };
  // discarding the spare 9 uses everything - that is going out
  assert.ok(R.validateLayDown(hand, melds, hand[3].id, opts).ok);
  // keeping the 9 back leaves a card over
  const extra = card(2, 'spades');
  assert.ok(!R.validateLayDown([...hand, extra], melds, hand[3].id, opts).ok);
});

test('a card cannot be melded twice or melded and discarded', () => {
  const hand = [card(7, 'stars'), card(7, 'hearts'), card(7, 'clubs')];
  const opts = { wildRank: 5, mustUseAll: false, allowAllWild: true };
  const ids = hand.map((c) => c.id);
  assert.ok(!R.validateLayDown(hand, [ids, ids], null, opts).ok);
  assert.ok(!R.validateLayDown(hand, [ids], ids[0], opts).ok);
});

// ---------------------------------------------------------------- engine
function seat(names, settings) {
  const game = G.createGame(settings);
  names.forEach((name, i) => G.addPlayer(game, { name, token: `t${i}`, isHost: i === 0 }));
  return game;
}

test('a game will not start with fewer than two players', () => {
  const game = seat(['Solo']);
  assert.ok(G.startGame(game).error);
});

test('dealing gives everyone the round hand size and starts the discard pile', () => {
  const game = seat(['A', 'B', 'C']);
  G.startGame(game);
  assert.equal(game.round, 1);
  assert.equal(game.wildRank, 3);
  for (const p of game.players) assert.equal(p.hand.length, 3);
  assert.equal(game.discardPile.length, 1);
  assert.equal(game.drawPile.length, 116 - 3 * 3 - 1);
  assert.equal(game.turnIndex, (game.dealerIndex + 1) % 3);
});

test('turn order is enforced: you draw once, then discard', () => {
  const game = seat(['A', 'B']);
  G.startGame(game);
  const up = game.players[game.turnIndex];
  const waiting = game.players[(game.turnIndex + 1) % 2];

  assert.ok(G.discardCard(game, up, up.hand[0].id).error, 'cannot discard before drawing');
  assert.ok(G.drawCard(game, waiting, 'stock').error, 'cannot play out of turn');
  assert.ok(!G.drawCard(game, up, 'stock').error);
  assert.equal(up.hand.length, 4);
  assert.ok(G.drawCard(game, up, 'stock').error, 'cannot draw twice');
  assert.ok(!G.discardCard(game, up, up.hand[0].id).error);
  assert.equal(up.hand.length, 3);
  assert.equal(game.players[game.turnIndex].id, waiting.id);
});

test('taking the discard removes it from the pile', () => {
  const game = seat(['A', 'B']);
  G.startGame(game);
  const up = game.players[game.turnIndex];
  const top = game.discardPile[game.discardPile.length - 1];
  G.drawCard(game, up, 'discard');
  assert.ok(up.hand.some((c) => c.id === top.id));
  assert.equal(game.discardPile.length, 0);
});

test('going out gives everyone else exactly one more turn, then scores', () => {
  const game = seat(['A', 'B', 'C']);
  G.startGame(game);
  const [i0, i1, i2] = [game.turnIndex, (game.turnIndex + 1) % 3, (game.turnIndex + 2) % 3];
  const goer = game.players[i0];

  // Stack the deck: give the player up next a ready-made book.
  goer.hand = [card(7, 'stars'), card(7, 'hearts'), card(7, 'clubs')];
  G.drawCard(game, goer, 'stock');
  const spare = goer.hand[3];
  const meld = goer.hand.slice(0, 3).map((c) => c.id);
  assert.ok(!G.layDown(game, goer, [meld], spare.id).error);
  assert.equal(game.outPlayerIndex, i0);
  assert.equal(game.phase, 'playing');

  // The other two each take one last turn.
  for (const idx of [i1, i2]) {
    assert.equal(game.turnIndex, idx);
    const p = game.players[idx];
    G.drawCard(game, p, 'stock');
    G.layDown(game, p, [], p.hand[0].id);
  }
  assert.equal(game.phase, 'roundEnd');
  assert.equal(goer.roundScores[0], 0, 'going out scores zero');
  assert.equal(goer.total, 0);
  for (const idx of [i1, i2]) {
    const p = game.players[idx];
    assert.equal(p.leftover.length, 3, 'three cards left after drawing and discarding');
    assert.equal(p.roundScores[0], R.handValue(p.leftover, 3));
  }
});

test('the player who went out cannot be dealt another turn in that round', () => {
  const game = seat(['A', 'B']);
  G.startGame(game);
  const goer = game.players[game.turnIndex];
  goer.hand = [card(7, 'stars'), card(7, 'hearts'), card(7, 'clubs')];
  G.drawCard(game, goer, 'stock');
  G.layDown(game, goer, [goer.hand.slice(0, 3).map((c) => c.id)], goer.hand[3].id);
  const other = game.players[game.turnIndex];
  G.drawCard(game, other, 'stock');
  G.layDown(game, other, [], other.hand[0].id);
  assert.equal(game.phase, 'roundEnd');
});

test('a normal turn rejects a lay-down that leaves cards behind', () => {
  const game = seat(['A', 'B']);
  G.startGame(game);
  const p = game.players[game.turnIndex];
  p.hand = [card(7, 'stars'), card(7, 'hearts'), card(7, 'clubs')];
  G.drawCard(game, p, 'stock');
  const res = G.layDown(game, p, [p.hand.slice(0, 3).map((c) => c.id)], null);
  assert.ok(res.error, 'no discard chosen');
  // A known card that neither matches the 7s nor is wild in round 1.
  p.hand[3] = card(9, 'spades');
  const bad = G.layDown(game, p, [[p.hand[0].id, p.hand[1].id, p.hand[3].id]], p.hand[2].id);
  assert.ok(bad.error, 'that group is not a legal meld');
});

test('the draw pile is refilled from the discards when it runs out', () => {
  const game = seat(['A', 'B']);
  G.startGame(game);
  const p = game.players[game.turnIndex];
  game.discardPile = [...game.drawPile.splice(0), ...game.discardPile];
  assert.equal(game.drawPile.length, 0);
  const top = game.discardPile[game.discardPile.length - 1];
  assert.ok(!G.drawCard(game, p, 'stock').error);
  assert.ok(game.drawPile.length > 0);
  assert.equal(game.discardPile.length, 1);
  assert.equal(game.discardPile[0].id, top.id);
});

// Build a hand of exactly `size` cards that is guaranteed to be a legal
// go-out: books of a single rank, using both decks when a book needs more
// than five cards. Ranks avoid the round's wild rank so every card is natural.
function stackedGoOut(size, wildRank) {
  const chunks = [];
  let left = size;
  while (left > 0) {
    if (left <= 10) {
      chunks.push(left);
      left = 0;
    } else {
      chunks.push(3);
      left -= 3;
    }
  }
  const ranks = [];
  for (let r = 3; r <= 13 && ranks.length < chunks.length; r++) if (r !== wildRank) ranks.push(r);
  const melds = chunks.map((n, ci) =>
    Array.from({ length: n }, (_, i) => card(ranks[ci], R.SUITS[i % 5]))
  );
  return melds;
}

test('a full 11-round game ends with the lowest score winning', () => {
  const game = seat(['A', 'B', 'C']);
  G.startGame(game);
  const firstDealer = game.dealerIndex;

  for (let round = 1; round <= 11; round++) {
    assert.equal(game.round, round);
    assert.equal(game.wildRank, round + 2);
    assert.equal(game.dealerIndex, (firstDealer + round - 1) % 3);
    for (const p of game.players) assert.equal(p.hand.length, R.handSizeForRound(round));
    assert.equal(game.turnIndex, (game.dealerIndex + 1) % 3);

    // The player on lead goes out with a stacked hand.
    const goerIndex = game.turnIndex;
    const goer = game.players[goerIndex];
    const melds = stackedGoOut(R.handSizeForRound(round), game.wildRank);
    goer.hand = melds.flat();
    G.drawCard(game, goer, 'stock');
    const spare = goer.hand[goer.hand.length - 1];
    const res = G.layDown(game, goer, melds.map((m) => m.map((c) => c.id)), spare.id);
    assert.ok(!res.error, res.error);
    assert.equal(game.outPlayerIndex, goerIndex);

    // Everyone else takes their one last turn.
    while (game.phase === 'playing') {
      const p = game.players[game.turnIndex];
      assert.notEqual(game.turnIndex, goerIndex, 'the player who went out does not play again');
      G.drawCard(game, p, 'stock');
      G.layDown(game, p, [], p.hand[0].id);
    }

    assert.equal(goer.roundScores[round - 1], 0, 'going out scores zero');
    for (const p of game.players) {
      if (p === goer) continue;
      assert.equal(p.leftover.length, R.handSizeForRound(round));
      assert.equal(p.roundScores[round - 1], R.handValue(p.leftover, game.wildRank));
    }

    if (round < 11) {
      assert.equal(game.phase, 'roundEnd');
      G.nextRound(game);
    }
  }

  assert.equal(game.phase, 'gameOver');
  for (const p of game.players) {
    assert.equal(p.roundScores.length, 11);
    assert.equal(p.total, p.roundScores.reduce((a, b) => a + b, 0));
  }
  // The lead player rotates with the dealer, so a different player goes out
  // each round; whoever was stuck with the fewest points wins.
  const best = Math.min(...game.players.map((p) => p.total));
  const winners = game.players.filter((p) => p.total === best);
  assert.ok(winners.length >= 1);
  assert.ok(game.log.some((l) => l.text.includes('Game over')));
  assert.ok(winners.every((w) => game.log[game.log.length - 1].text.includes(w.name)));
});

test('the round only ends after the last turn, not before', () => {
  const game = seat(['A', 'B', 'C', 'D']);
  G.startGame(game);
  const goerIndex = game.turnIndex;
  const goer = game.players[goerIndex];
  const melds = stackedGoOut(3, game.wildRank);
  goer.hand = melds.flat();
  G.drawCard(game, goer, 'stock');
  G.layDown(game, goer, melds.map((m) => m.map((c) => c.id)), goer.hand[goer.hand.length - 1].id);

  let turns = 0;
  while (game.phase === 'playing') {
    const p = game.players[game.turnIndex];
    G.drawCard(game, p, 'stock');
    G.layDown(game, p, [], p.hand[0].id);
    turns++;
  }
  assert.equal(turns, 3, 'the other three players each got exactly one turn');
  assert.equal(game.phase, 'roundEnd');
});

/** Every one of the 116 cards is somewhere, exactly once. */
function assertCardsConserved(game) {
  const ids = [
    ...game.drawPile,
    ...game.discardPile,
    ...game.players.flatMap((p) => [...p.hand, ...p.melds.flat(), ...p.leftover]),
  ].map((c) => c.id);
  assert.equal(ids.length, 116, 'no cards appeared or vanished');
  assert.equal(new Set(ids).size, 116, 'no card was duplicated');
}

test('no card is ever lost or duplicated, and illegal moves change nothing', () => {
  for (let trial = 0; trial < 5; trial++) {
    const game = seat(['A', 'B', 'C']);
    G.startGame(game);
    assertCardsConserved(game);

    for (let step = 0; step < 600; step++) {
      if (game.phase === 'roundEnd') G.nextRound(game);
      if (game.phase === 'gameOver') break;
      const p = game.players[game.turnIndex];
      const other = game.players[(game.turnIndex + 1) % 3];

      // Illegal moves are refused, whatever the state.
      assert.ok(G.drawCard(game, other, 'stock').error, 'out of turn draw');
      assert.ok(G.layDown(game, p, [], 'no-such-card').error, 'discarding a card not held');
      if (p.hand.length >= 3) {
        const three = p.hand.slice(0, 3).map((c) => c.id);
        assert.ok(G.layDown(game, p, [[...three, three[0]]], null).error, 'reusing a card');
      }

      if (game.turnPhase === 'draw') {
        G.drawCard(game, p, Math.random() < 0.35 ? 'discard' : 'stock');
      } else {
        G.discardCard(game, p, p.hand[Math.floor(Math.random() * p.hand.length)].id);
      }
      assertCardsConserved(game);
    }
  }
});

test('you cannot skip ahead to the next round or restart mid-game', () => {
  const game = seat(['A', 'B']);
  G.startGame(game);
  assert.ok(G.nextRound(game).error, 'the round is still being played');
  assert.ok(G.rematch(game).error, 'the game is not over');
  assert.ok(G.addPlayer(game, { name: 'Late', token: 'tz' }).error, 'no joining a game in progress');
});

test('a rematch clears the scores and deals a fresh round 1', () => {
  const game = seat(['A', 'B']);
  G.startGame(game);
  game.players.forEach((p) => {
    p.total = 40;
    p.roundScores = Array(11).fill(4);
  });
  game.round = 11;
  game.phase = 'gameOver';
  assert.ok(!G.rematch(game).error);
  assert.equal(game.round, 1);
  assert.equal(game.phase, 'playing');
  for (const p of game.players) {
    assert.equal(p.total, 0);
    assert.equal(p.roundScores.length, 0);
    assert.equal(p.hand.length, 3);
  }
});

test('a game is capped at seven players', () => {
  const game = seat(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  assert.equal(game.players.length, 7);
  assert.ok(G.addPlayer(game, { name: 'H', token: 'th' }).error);
});

test('what other players can see is hidden', () => {
  const game = seat(['A', 'B']);
  G.startGame(game);
  const [a, b] = game.players;
  const view = G.redact(game, a.id);
  assert.equal(view.players[0].hand.length, 3);
  assert.equal(view.players[1].hand, null);
  assert.equal(view.players[1].handCount, 3);
  assert.ok(!('drawPile' in view));
  assert.equal(view.drawPileCount, game.drawPile.length);
});

for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} passed`);
