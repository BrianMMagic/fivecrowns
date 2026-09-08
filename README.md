# Five Crowns

A web app for playing [Five Crowns](https://www.setgame.com/five-crowns) with
your family when you're not in the same room. It shuffles, deals, enforces the
rules and keeps score. Everyone opens the same link on their own phone, types
the 4-letter room code, and plays — no app to install, no accounts, no server to
run.

It does **not** give advice. It won't suggest melds, tell you what to discard, or
hint that you can go out — but it won't let anyone make an illegal play either.

## How it's put together

A static site on GitHub Pages, plus a Firebase Realtime Database to hold games
in progress — the same shape as the Imposter game in this account, and for the
same reason: there is nothing to host and nothing to pay for.

There is no server, so one phone has to run the game. That phone is **the
dealer's**, exactly as at a real table, and the deal passes on at the end of
every round. Whoever is dealing holds the undealt deck and applies everyone's
moves through the rules engine; everybody else posts what they want to do and
reads back the result.

Two kinds of thing go into the database:

- **The public table** — whose turn it is, the top discard, how many cards each
  player holds, melds once they're down, the scores. All of it is visible across
  a real table too.
- **Each player's hand, sealed** — every phone makes an ECDH keypair when it
  joins and publishes only the public half. The dealer seals each hand to the
  phone it belongs to (ECDH P-256 → HKDF-SHA256 → AES-GCM). Reading the raw
  database gets you nothing: no card in anyone's hand is stored in the open.

**The one thing to know:** the undealt deck has to exist somewhere, and that
somewhere is the dealer's phone. Nothing in the app shows it to them, but a
person determined enough to attach developer tools to their own phone could read
it while they hold it. The deal rotates every round, so nobody holds it for more
than a round or two out of eleven. Only a real server removes this entirely.

## Setting it up

**1. A database.** Create a free Firebase project, turn on the Realtime
Database, and put its URL in `js/firebase-config.js`. This copy points at the
same database as the Imposter game; everything it stores lives under a
`fivecrowns` key, so the two never meet.

In the database's **Rules** tab, both games need to be readable and writable —
they hold nothing secret, because the hands are sealed before they get there:

```json
{
  "rules": {
    "rooms":      { ".read": true, ".write": true },
    "fivecrowns": { ".read": true, ".write": true }
  }
}
```

**2. GitHub Pages.** In **Settings → Pages**, set the source to the branch this
code is on, folder `/ (root)`. The site is `index.html` at the top of the repo,
so there's nothing to build. `.nojekyll` stops GitHub trying to run it through
Jekyll.

That's it. The Pages URL is the link you send everyone.

## Playing

One person taps **Create a game** and reads out the 4-letter code. Everyone else
opens the same link, types their name and the code, and taps **Join**. The host
taps **Deal round 1**.

On your turn: take the top card of the draw pile or the discard, then either
discard, or **lay down and go out**. Going out means every card in your hand is
part of a book or a run with exactly one card left to discard. If a group isn't a
legal meld the app says why and won't take it. Once someone goes out everybody
else gets one last turn; whatever is left in your hand is scored against you.

Tap a card to select it, drag a card to rearrange your hand.

## Running it on your own machine

```sh
npm start      # http://localhost:3000
npm test       # 24 rules and engine tests
```

`npm start` serves the same static files Pages will, plus a small in-memory
stand-in for the Firebase database — so you can play a whole game on a laptop,
or across a laptop and a phone on the same wifi, without touching Firebase.
There are no dependencies to install.

To be several players at once while trying it, give each tab its own identity
with `?p=`: `localhost:3000/?p=1`, `?p=2`, `?p=3`. Without that, tabs in one
browser share a seat.

## The rules it enforces

- 116 cards: two 55-card decks (3 through K in five suits — stars, hearts,
  clubs, diamonds, spades) plus six jokers.
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

Whether a meld can be made entirely of wild cards is a checkbox when you create
the game. The printed rules allow it, so it defaults to on.

## Layout

```
index.html          the whole app is one page
css/styles.css
js/rules.js         the deck, melds and scoring
js/game.js          the rules engine: dealing, turn order, going out, scoring
js/table.js         who deals, what goes in the database, sealing hands
js/seal.js          hands sealed to one phone
js/db.js            the Firebase Realtime Database, over plain REST
js/app.js           the interface
js/firebase-config.js   the one thing you have to fill in
dev-server.js       local play with an in-memory database instead of Firebase
test/run.js         node test/run.js
```

`js/rules.js` and `js/game.js` are plain logic with no browser or network in
them, which is why the test suite can play whole games against them in node.
