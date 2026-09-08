# Five Crowns

A web app for playing [Five Crowns](https://www.setgame.com/five-crowns) with your
family when you're not in the same room. It shuffles, deals, enforces the rules
and keeps score. Everyone plays on their own phone or laptop and only ever sees
their own hand.

It does **not** give advice. It won't suggest melds, tell you what to discard, or
hint that you can go out — but it won't let anyone make an illegal play either.

## Running it

No dependencies, no build step. You need Node 18 or newer.

```sh
npm start          # then open http://localhost:3000
npm test           # 24 rules and engine tests
```

One person creates a game and gets a 4-letter code; everyone else joins with that
code (or the invite link, which is just `.../#CODE`).

### Putting it somewhere your family can reach

The app is a single Node process serving both the page and the game, so almost
any host works. Point the host at `npm start`; it listens on `$PORT` (default
3000).

- **A hosting service** — Render, Railway, Fly.io and similar all run this as-is:
  new web service, build command `echo none`, start command `npm start`.
- **A computer at home** — run `npm start` and expose it with a Cloudflare Tunnel
  (`cloudflared tunnel --url http://localhost:3000`) or ngrok. Fine for a game
  night; the URL disappears when you stop the tunnel.

Two things to know if you deploy it:

- Games live in the server's memory and are mirrored to `data/rooms.json`, so a
  restart or redeploy doesn't lose a game in progress. Run **one** instance —
  two instances would each have their own idea of the game.
- If your host puts the app to sleep when idle, players' connections drop; the
  page reconnects by itself when the server wakes up.

Unfinished games are cleaned up after three days.

## How a turn works

1. Take the top card of the draw pile, or the face-up discard.
2. Then either discard a card, or **lay down and go out**.

Going out means every card in your hand is part of a book or a run, with exactly
one card left to discard. Tap *Lay down & go out*, select cards, and *Meld
these* to group them. If a group isn't a legal meld the app says why and won't
take it. Once someone goes out, everybody else gets one last turn to lay down
whatever they can — anything left in your hand is scored against you.

Tap a card to select it; drag a card to rearrange your hand.

## The rules it enforces

- 116 cards: two 55-card decks (3 through K in five suits — stars, hearts, clubs,
  diamonds, spades) plus six jokers.
- 11 rounds. Round 1 deals 3 cards, round 11 deals 13. **The rank you were dealt
  is wild that round**: 3s in round 1, up to Kings in round 11. Jokers are always
  wild.
- A **book** is 3+ cards of the same number, in any suits (and the same suit can
  repeat — there are two decks). A **run** is 3+ consecutive cards in one suit.
  Runs don't wrap around: they stop at 3 and at K.
- Wild cards stand in for anything, and the round's wild rank can also be played
  as its own number.
- You may only lay cards down as part of going out. There is no laying off onto
  other people's melds.
- Cards left in your hand score against you: number cards face value, J 11, Q 12,
  K 13, the round's wild rank 20, jokers 50.
- Lowest total after 11 rounds wins.
- If the draw pile runs out, the discards are reshuffled into a new one.

The one house rule that families disagree about — whether a meld can be made
entirely of wild cards — is a checkbox when you create the game. The printed
rules allow it, so it defaults to on.

## Layout

```
shared/rules.js    the deck, melds and scoring - used by the server and the browser
server/game.js     the authoritative game: turn order, going out, scoring
server/index.js    http server, JSON actions, server-sent events for live updates
public/            the client (no framework, no build)
test/run.js        node test/run.js
```

The server is the referee. The browser checks your play first so it can explain
the problem immediately, but every action is re-checked on the server, and the
server never sends you anyone else's cards.
