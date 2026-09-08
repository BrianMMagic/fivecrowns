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

### Trying it out on your own

Your seat is remembered per browser, so a second tab would rejoin as the *same*
player. To be several players at once, give each tab its own identity with `?p=`:

```
http://localhost:3000/?p=1     you, the host
http://localhost:3000/?p=2     a second player
http://localhost:3000/?p=3     ...and so on
```

Create the game in the first tab, then paste the 4-letter code into the others.
Arrange the tabs side by side and you can watch a play land on every screen at
once. Reloading a tab keeps that tab's seat and hand.

Round 1 only deals 3 cards, so you'll usually see someone go out within a few
turns — enough to exercise dealing, melding, the last turn everyone else gets,
and the scorecard.

### Testing it on your phone

If your phone and the computer running `npm start` are on the same wifi, open
`http://<your computer's address>:3000` on the phone — no tunnel, no signup. Find
the address with `ipconfig getifaddr en0` on a Mac, `hostname -I` on Linux, or
`ipconfig` on Windows (the IPv4 address). It looks like `192.168.1.24`.

On cellular, or to let the rest of the family in, put it behind a tunnel:

```sh
cloudflared tunnel --url http://localhost:3000
```

That prints a public `https://…trycloudflare.com` address that works anywhere and
stops existing when you stop the command.

### Putting it somewhere your family can reach

Everyone plays in a normal phone browser — nothing to install, no accounts. You
just need one web address to send them, which means putting the app on a host
once.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/BrianMMagic/fivecrowns)

The app is a single Node process serving both the page and the game, so any host
that runs Node works. It listens on `$PORT` (default 3000) and needs no build
step. `render.yaml` in this repo configures [Render](https://render.com):

1. Sign in to Render with GitHub and choose **New → Blueprint**.
2. Pick this repository and the branch the code is on.
3. Deploy. You get a permanent `https://….onrender.com` address to text everyone.

Railway and Fly.io work the same way — start command `npm start`, no build
command.

**GitHub Pages will not work.** It serves static files only, and this game needs
a running process to hold the shared deck, sequence turns, and make sure your
hand goes to you and nobody else.

Three things to know if you deploy it:

- Games live in the server's memory and are mirrored to `data/rooms.json`, so a
  restart doesn't lose a game in progress. Run **one** instance — two instances
  would each have their own idea of the game.
- Free tiers usually sleep after ~15 minutes with no traffic, and their disk is
  wiped when they do. The first person to open the link waits half a minute for
  it to wake, and a game abandoned over dinner may not survive. A paid instance,
  or any host that doesn't sleep, avoids both.
- If your host puts the app to sleep, players' connections drop; the page
  reconnects by itself when the server wakes up.

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
