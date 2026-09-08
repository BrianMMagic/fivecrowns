// Five Crowns rules engine.
// Shared verbatim by the server (authority) and the browser (so the UI can
// explain why a play is illegal before it is sent).

export const SUITS = ['stars', 'hearts', 'clubs', 'diamonds', 'spades'];

export const SUIT_INFO = {
  stars:    { symbol: '★', label: 'Stars',    code: 'st' },
  hearts:   { symbol: '♥', label: 'Hearts',   code: 'he' },
  clubs:    { symbol: '♣', label: 'Clubs',    code: 'cl' },
  diamonds: { symbol: '♦', label: 'Diamonds', code: 'di' },
  spades:   { symbol: '♠', label: 'Spades',   code: 'sp' },
};

export const MIN_RANK = 3;
export const MAX_RANK = 13;
export const ROUNDS = 11;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 7;

export const JOKER_VALUE = 50;
export const WILD_VALUE = 20;

/** Round 1 deals 3 cards, round 11 deals 13. The rank dealt is wild. */
export function handSizeForRound(round) {
  return round + 2;
}
export function wildRankForRound(round) {
  return round + 2;
}

export function rankLabel(rank) {
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  return String(rank);
}

export function rankName(rank) {
  if (rank === 11) return 'Jacks';
  if (rank === 12) return 'Queens';
  if (rank === 13) return 'Kings';
  return `${rank}s`;
}

export function cardLabel(card) {
  if (isJoker(card)) return 'Joker';
  return `${rankLabel(card.rank)}${SUIT_INFO[card.suit].symbol}`;
}

/** 116 cards: two 55-card decks (3-K in five suits) plus six jokers. */
export function buildDeck() {
  const cards = [];
  for (let copy = 0; copy < 2; copy++) {
    for (const suit of SUITS) {
      for (let rank = MIN_RANK; rank <= MAX_RANK; rank++) {
        cards.push({ id: `${SUIT_INFO[suit].code}${rank}_${copy}`, rank, suit });
      }
    }
  }
  for (let j = 0; j < 6; j++) cards.push({ id: `jk_${j}`, rank: null, suit: 'joker' });
  return cards;
}

export function isJoker(card) {
  return card.suit === 'joker';
}

export function isWild(card, wildRank) {
  return isJoker(card) || card.rank === wildRank;
}

export function cardValue(card, wildRank) {
  if (isJoker(card)) return JOKER_VALUE;
  if (card.rank === wildRank) return WILD_VALUE;
  return card.rank;
}

export function handValue(cards, wildRank) {
  return cards.reduce((sum, c) => sum + cardValue(c, wildRank), 0);
}

/**
 * Is this group of cards a legal book or run?
 * Returns { ok, type, error }. `type` is 'book', 'run' or 'wild'.
 *
 * A book is 3+ cards of the same rank (suits may repeat - there are two decks).
 * A run is 3+ consecutive ranks in a single suit, no wrapping past K or below 3.
 * Wild cards (jokers, plus every card of the round's rank) stand in for anything.
 */
export function validateMeld(cards, wildRank, opts = {}) {
  const allowAllWild = opts.allowAllWild !== false;
  const n = cards.length;
  if (n < 3) return { ok: false, error: 'A meld needs at least 3 cards.' };

  const naturals = cards.filter((c) => !isWild(c, wildRank));
  const wilds = n - naturals.length;

  if (naturals.length === 0) {
    return allowAllWild
      ? { ok: true, type: 'wild' }
      : { ok: false, error: 'A meld needs at least one card that is not wild.' };
  }

  // Book: every natural shares a rank.
  const bookRank = naturals[0].rank;
  if (naturals.every((c) => c.rank === bookRank)) {
    return { ok: true, type: 'book', rank: bookRank };
  }

  // Run: one suit, distinct ranks, and the gaps are exactly fillable by the wilds.
  const suit = naturals[0].suit;
  if (!naturals.every((c) => c.suit === suit)) {
    return {
      ok: false,
      error: 'Not a book (same number) and not a run (a run must be all one suit).',
    };
  }
  const ranks = naturals.map((c) => c.rank).sort((a, b) => a - b);
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] === ranks[i - 1]) {
      return {
        ok: false,
        error: `A run cannot use two ${rankName(ranks[i])} - and these are not all the same number.`,
      };
    }
  }
  const low = ranks[0];
  const high = ranks[ranks.length - 1];
  if (high - low > n - 1) {
    return {
      ok: false,
      error: `These ${n} cards are too spread out to be a run${wilds ? ' even with the wild cards' : ''}.`,
    };
  }
  // The run occupies a window of n consecutive ranks that must contain every
  // natural and stay inside 3..K.
  const firstStart = Math.max(MIN_RANK, high - n + 1);
  const lastStart = Math.min(low, MAX_RANK - n + 1);
  if (firstStart > lastStart) {
    return { ok: false, error: `A run of ${n} does not fit here - runs stop at 3 and at K.` };
  }
  return { ok: true, type: 'run', suit, start: firstStart };
}

/**
 * Check a whole lay-down: every meld legal, cards actually in hand, nothing
 * used twice. `mustUseAll` is true on a normal turn (you may only lay down if
 * you can go out). Returns { ok, error, melds, leftover }.
 */
export function validateLayDown(hand, meldGroups, discardId, opts) {
  const { wildRank, mustUseAll, allowAllWild } = opts;
  const byId = new Map(hand.map((c) => [c.id, c]));
  const used = new Set();

  const melds = [];
  for (const group of meldGroups) {
    const cards = [];
    for (const id of group) {
      const card = byId.get(id);
      if (!card) return { ok: false, error: 'That card is not in your hand.' };
      if (used.has(id)) return { ok: false, error: 'A card can only be used in one meld.' };
      used.add(id);
      cards.push(card);
    }
    const check = validateMeld(cards, wildRank, { allowAllWild });
    if (!check.ok) return { ok: false, error: check.error };
    melds.push({ cards, type: check.type });
  }

  if (discardId != null) {
    if (!byId.has(discardId)) return { ok: false, error: 'That card is not in your hand.' };
    if (used.has(discardId)) return { ok: false, error: 'You cannot discard a card you melded.' };
    used.add(discardId);
  }

  const leftover = hand.filter((c) => !used.has(c.id));
  if (mustUseAll && leftover.length > 0) {
    return {
      ok: false,
      error:
        leftover.length === 1
          ? 'You still have 1 card left over - to go out, every card except your discard must be in a meld.'
          : `You still have ${leftover.length} cards left over - to go out, every card except your discard must be in a meld.`,
    };
  }
  return { ok: true, melds, leftover };
}

export function sortCards(cards, mode, wildRank) {
  const order = (c) => {
    if (isJoker(c)) return [3, 0, 0];
    if (c.rank === wildRank) return [2, 0, c.rank];
    return [1, SUITS.indexOf(c.suit), c.rank];
  };
  const copy = cards.slice();
  copy.sort((a, b) => {
    const [ga, sa, ra] = order(a);
    const [gb, sb, rb] = order(b);
    if (ga !== gb) return ga - gb;
    if (mode === 'suit') return sa - sb || ra - rb;
    return ra - rb || sa - sb;
  });
  return copy;
}
