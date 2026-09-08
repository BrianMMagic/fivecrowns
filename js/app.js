import * as R from './rules.js';
import { createTable } from './table.js';
import { configured } from './db.js';

const appEl = document.getElementById('app');
const toastEl = document.getElementById('toast');

const S = {
  state: null,
  order: [],           // local left-to-right order of my hand, by card id
  selection: new Set(),
  builder: null,       // { melds: [[cardId]], discardId } while laying down
};

// ------------------------------------------------------------------ utilities
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = null;
function toast(message, kind = 'error') {
  toastEl.textContent = message;
  toastEl.className = `toast show${kind === 'info' ? ' info' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = 'toast'), 3600);
}

// The seat this browser holds. ?p=2, ?p=3 and so on let one browser be
// several players at once, which is how you try the game out on your own.
const SEAT = new URLSearchParams(location.search).get('p');
const suffix = SEAT ? `.${SEAT}` : '';

const table = createTable({
  seatSuffix: suffix,
  onState(next) {
    const before = S.state;
    S.state = next;
    if (!next) return;
    if (!before || before.round !== next.round) {
      S.order = [];
      S.selection.clear();
      S.builder = null;
    }
    if (before && before.turnIndex !== next.turnIndex) S.builder = null;
    render();
  },
  onError(message) {
    toast(message);
  },
});

/** Make a move. The table layer decides whether to apply or post it. */
function act(action, payload = {}) {
  return table.act(action, payload).catch((e) => toast(e.message));
}

const rememberRoom = (room) => localStorage.setItem(`fivecrowns.last${suffix}`, room);
const lastRoom = () => localStorage.getItem(`fivecrowns.last${suffix}`);

// ------------------------------------------------------------------ state view
const me = () => (S.state ? S.state.players.find((p) => p.id === S.state.you) : null);
const myIndex = () => (S.state ? S.state.players.findIndex((p) => p.id === S.state.you) : -1);
const isMyTurn = () =>
  S.state && S.state.phase === 'playing' && S.state.turnIndex === myIndex();

/** My hand in the order I have arranged it, with any new cards on the right. */
function orderedHand() {
  const hand = me()?.hand || [];
  const pos = new Map(S.order.map((id, i) => [id, i]));
  return hand.slice().sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
}

function syncOrder() {
  const ids = (me()?.hand || []).map((c) => c.id);
  const known = new Set(ids);
  S.order = S.order.filter((id) => known.has(id));
  for (const id of ids) if (!S.order.includes(id)) S.order.push(id);
  for (const id of [...S.selection]) if (!known.has(id)) S.selection.delete(id);
}

function sortHand(mode) {
  const sorted = R.sortCards(me()?.hand || [], mode, S.state.wildRank);
  S.order = sorted.map((c) => c.id);
  render();
}

// ------------------------------------------------------------------ card html
function cardHTML(card, opts = {}) {
  const { small, selected, action, id, disabled } = opts;
  const cls = ['card'];
  if (small) cls.push('small');
  if (selected) cls.push('selected');

  if (!card) {
    return `<div class="card empty${small ? ' small' : ''}">${esc(opts.placeholder || '')}</div>`;
  }
  if (card === 'back') {
    return `<div class="card back${small ? ' small' : ''}"></div>`;
  }

  const wild = S.state && R.isWild(card, S.state.wildRank);
  let face;
  if (R.isJoker(card)) {
    cls.push('joker');
    face = `<span class="corner">JKR</span><span class="pip">★</span>`;
  } else {
    cls.push(R.SUIT_INFO[card.suit].code);
    const sym = R.SUIT_INFO[card.suit].symbol;
    face = `<span class="corner">${R.rankLabel(card.rank)}${sym}</span><span class="pip">${sym}</span>`;
  }
  const tag = wild && !R.isJoker(card) ? `<span class="wildtag">WILD</span>` : '';
  const label = `${R.cardLabel(card)}${wild ? ' (wild)' : ''}`;

  if (action) {
    return `<button class="${cls.join(' ')}" data-act="${action}" data-id="${esc(id ?? card.id)}"
      ${disabled ? 'disabled' : ''} aria-label="${esc(label)}"
      aria-pressed="${selected ? 'true' : 'false'}">${face}${tag}</button>`;
  }
  return `<div class="${cls.join(' ')}" title="${esc(label)}">${face}${tag}</div>`;
}

const meldHTML = (cards, extra = '') =>
  `<div class="meld">${cards.map((c) => cardHTML(c, { small: true })).join('')}${extra}</div>`;

// ------------------------------------------------------------------ views
function render() {
  if (!S.state) return renderHome();
  syncOrder();
  const phase = S.state.phase;
  if (phase === 'lobby') return renderLobby();
  if (phase === 'roundEnd' || phase === 'gameOver') return renderScoresView();
  return renderTable();
}

function renderHome() {
  const hashCode = (location.hash || '').replace('#', '').toUpperCase().slice(0, 4);
  appEl.innerHTML = `
    <div class="center" style="padding:1.6rem 0 1rem">
      <h1>👑 Five Crowns</h1>
      <p class="muted">No shuffling, no dealing, no arguing about the score.</p>
    </div>
    <div class="panel">
      <h2>Start a game</h2>
      <label><span>Your name</span>
        <input id="host-name" maxlength="16" autocomplete="nickname" placeholder="e.g. Brian"></label>
      <label style="display:flex;gap:0.55rem;align-items:flex-start;margin-bottom:1rem">
        <input type="checkbox" id="all-wild" checked style="width:auto;margin-top:0.15rem;flex:0 0 auto">
        <span style="margin:0">Allow melds made only of wild cards
          <br><span class="small">The printed rules allow it. Turn this off if your family doesn't.</span></span>
      </label>
      <button class="wide" data-act="create">Create a game</button>
      <p class="small muted" style="margin:0.7rem 0 0">You'll get a 4-letter code to text everyone.</p>
    </div>
    <div class="panel">
      <h2>Join a game</h2>
      <label><span>Game code</span>
        <input id="join-code" maxlength="4" autocapitalize="characters" autocomplete="off"
          spellcheck="false" placeholder="ABCD" value="${esc(hashCode)}"></label>
      <label><span>Your name</span>
        <input id="join-name" maxlength="16" autocomplete="nickname" placeholder="e.g. Anna"></label>
      <button class="wide subtle" data-act="join">Join</button>
    </div>
    ${rulesHTML()}`;
}

function renderLobby() {
  const st = S.state;
  const host = me()?.isHost;
  const enough = st.players.length >= 2;
  appEl.innerHTML = `
    <div class="center" style="padding:0.8rem 0">
      <p class="muted small" style="margin-bottom:0.2rem">Game code</p>
      <div class="code">${esc(st.code || '')}</div>
      <button class="tiny ghost" data-act="share" style="margin-top:0.6rem">Copy invite link</button>
    </div>
    <div class="panel">
      <h2>Players (${st.players.length}/${R.MAX_PLAYERS})</h2>
      <div class="players">
        ${st.players
          .map(
            (p) => `<div class="player-row ${p.id === st.you ? 'self' : ''}">
              <span class="dot ${p.connected ? 'on' : ''}"></span>
              <span class="pname">${esc(p.name)}</span>
              ${p.isHost ? '<span class="badge">host</span>' : ''}
            </div>`
          )
          .join('')}
      </div>
      ${
        host
          ? `<button class="wide" data-act="start" ${enough ? '' : 'disabled'} style="margin-top:0.8rem">
               ${enough ? 'Deal round 1' : 'Waiting for one more player…'}</button>`
          : `<p class="muted small" style="margin:0.8rem 0 0">Waiting for the host to start…</p>`
      }
    </div>
    ${rulesHTML()}`;
}

function renderTable() {
  const st = S.state;
  const turnPlayer = st.players[st.turnIndex];
  const yourTurn = isMyTurn();
  const laidDown = st.players.filter((p) => p.melds.length > 0);

  // While you are laying down, everything you don't need gets out of the way
  // so the cards and the melds you are building stay on one screen.
  const building = !!S.builder;

  appEl.innerHTML = `
    <div class="topbar">
      <span class="title">Round ${st.round}/${st.totalRounds}</span>
      <span class="badge wild">${esc(R.rankName(st.wildRank))} wild</span>
      <span class="badge" style="margin-left:auto">${st.drawPileCount} left</span>
    </div>

    ${
      building
        ? ''
        : `<div class="players">
      ${st.players
        .map((p, i) => {
          const active = i === st.turnIndex;
          return `<div class="player-row ${active ? 'active' : ''} ${p.id === st.you ? 'self' : ''}">
            <span class="dot ${p.connected ? 'on' : ''}"></span>
            <span class="pname">${esc(p.name)}</span>
            ${p.isOut ? '<span class="badge turn">went out</span>' : ''}
            ${active && !p.isOut ? '<span class="badge turn">turn</span>' : ''}
            <span class="badge">${p.handCount}<span class="wordy"> card${p.handCount === 1 ? '' : 's'}</span></span>
            <span class="badge">${p.total} pts</span>
          </div>`;
        })
        .join('')}
    </div>

    <div class="panel">
      <div class="piles">
        <div class="pile">
          ${
            yourTurn && st.turnPhase === 'draw'
              ? `<button class="card back" data-act="draw-stock" aria-label="Draw from the draw pile"></button>`
              : cardHTML('back')
          }
          <div class="label">Draw pile</div>
        </div>
        <div class="pile">
          ${
            st.discardTop
              ? yourTurn && st.turnPhase === 'draw'
                ? cardHTML(st.discardTop, { action: 'draw-discard' })
                : cardHTML(st.discardTop)
              : cardHTML(null, { placeholder: 'empty' })
          }
          <div class="label">Discard</div>
        </div>
      </div>
      ${
        st.finalTurn
          ? `<p class="center small" style="color:var(--gold);margin:0.6rem 0 0">
               ${esc(st.players[st.outPlayerIndex].name)} went out — one last turn each.</p>`
          : ''
      }
    </div>

    ${
      laidDown.length
        ? `<div class="panel"><h2 class="small muted" style="text-transform:uppercase;letter-spacing:0.06em">On the table</h2>
            ${laidDown
              .map(
                (p) => `<div style="margin-bottom:0.5rem">
                  <div class="small muted" style="margin-bottom:0.25rem">${esc(p.name)}</div>
                  <div class="melds">${p.melds.map((m) => meldHTML(m)).join('')}</div>
                </div>`
              )
              .join('')}
           </div>`
        : ''
    }`
    }

    ${building ? builderHTML() : handHTML()}

    <div class="actionbar">${building ? builderActionsHTML() : actionsHTML(turnPlayer, yourTurn)}</div>

    ${
      building
        ? ''
        : `<details class="panel rules"><summary>Scores</summary>${scoreTableHTML()}</details>
    <details class="panel rules"><summary>What just happened</summary>
      <div class="log">${st.log
        .slice()
        .reverse()
        .map((l) => `<div>${esc(l.text)}</div>`)
        .join('')}</div>
    </details>
    ${rulesHTML()}`
    }`;
}

function handHTML() {
  const hand = orderedHand();
  return `
    <div class="panel">
      <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:nowrap">
        <h2 style="margin:0;white-space:nowrap">Your hand</h2>
        <span style="margin-left:auto;display:flex;gap:0.35rem;flex:0 0 auto">
          <span class="muted small" style="align-self:center">sort</span>
          <button class="tiny ghost" data-act="sort-rank">Number</button>
          <button class="tiny ghost" data-act="sort-suit">Suit</button>
        </span>
      </div>
      <div class="hand">
        ${hand
          .map((c) => cardHTML(c, { action: 'pick', selected: S.selection.has(c.id) }))
          .join('')}
      </div>
      <p class="small muted" style="margin:0">Tap a card to select it. Drag a card to move it in your hand.</p>
    </div>`;
}

function actionsHTML(turnPlayer, yourTurn) {
  const st = S.state;
  if (!yourTurn) {
    return `<button class="wide subtle" disabled>Waiting for ${esc(turnPlayer.name)}…</button>`;
  }
  if (st.turnPhase === 'draw') {
    return `<div class="row">
      <button data-act="draw-stock">Draw a card</button>
      <button class="subtle" data-act="draw-discard" ${st.discardTop ? '' : 'disabled'}>
        Take ${st.discardTop ? esc(R.cardLabel(st.discardTop)) : 'discard'}</button>
    </div>`;
  }
  const one = S.selection.size === 1;
  return `<div class="row">
    <button data-act="discard" ${one ? '' : 'disabled'}>
      ${one ? 'Discard selected card' : 'Select a card to discard'}</button>
    <button class="subtle" data-act="open-builder">
      ${st.finalTurn ? 'Lay down & finish' : 'Lay down & go out'}</button>
  </div>`;
}

// ------------------------------------------------------------------ lay-down builder
function builderHTML() {
  const st = S.state;
  const b = S.builder;
  const byId = new Map((me().hand || []).map((c) => [c.id, c]));
  const used = new Set(b.melds.flat());
  if (b.discardId) used.add(b.discardId);
  const remaining = orderedHand().filter((c) => !used.has(c.id));
  const leftoverPoints = R.handValue(remaining, st.wildRank);

  return `
    <div class="panel">
      <div style="display:flex;align-items:baseline;gap:0.45rem;flex-wrap:wrap">
        <h2 style="margin:0">${st.finalTurn ? 'Lay down' : 'Go out'}</h2>
        <span class="small muted">${
          st.finalTurn
            ? 'anything you keep counts against you'
            : 'every card but your discard must be melded'
        }</span>
      </div>

      <div class="tray">
        <div class="small muted">Putting down</div>
        <div class="melds">
          ${
            b.melds.length
              ? b.melds
                  .map((group, i) =>
                    meldHTML(
                      group.map((id) => byId.get(id)),
                      `<button class="tiny danger" data-act="unmeld" data-i="${i}" aria-label="Break up this meld">×</button>`
                    )
                  )
                  .join('')
              : '<span class="small muted">nothing yet</span>'
          }
        </div>
        <div class="small muted">Discarding</div>
        <div class="melds">
          ${
            b.discardId
              ? meldHTML(
                  [byId.get(b.discardId)],
                  `<button class="tiny danger" data-act="undiscard" aria-label="Take the discard back">×</button>`
                )
              : '<span class="small muted">pick a card below</span>'
          }
        </div>
      </div>

      <div class="small muted" style="margin:0.8rem 0 0.1rem">
        Still in hand${st.finalTurn ? ` — worth ${leftoverPoints} against you` : ''}
      </div>
      <div class="hand" style="min-height:3.5rem;padding-bottom:0.2rem">
        ${remaining.map((c) => cardHTML(c, { action: 'pick', selected: S.selection.has(c.id) })).join('')}
      </div>
    </div>`;
}

function builderActionsHTML() {
  const st = S.state;
  const b = S.builder;
  const sel = S.selection.size;
  // These live in the sticky bar so they stay under your thumb however long
  // your hand is - on a 13-card round the cards alone fill the screen.
  return `
    <div class="row tight" style="margin-bottom:0.45rem">
      <button class="subtle" data-act="make-meld" ${sel >= 3 ? '' : 'disabled'}>
        Meld (${sel})</button>
      <button class="subtle" data-act="set-discard" ${sel === 1 ? '' : 'disabled'}>
        Set discard</button>
    </div>
    <div class="row tight">
      <button class="ghost" data-act="cancel-builder">Cancel</button>
      <button data-act="submit-builder" ${b.discardId ? '' : 'disabled'}>
        ${st.finalTurn ? 'Finish turn' : 'Go out'}</button>
    </div>`;
}

function openBuilder() {
  S.builder = { melds: [], discardId: null };
  S.selection.clear();
  render();
}

function makeMeld() {
  const ids = [...S.selection];
  const byId = new Map(me().hand.map((c) => [c.id, c]));
  const cards = ids.map((id) => byId.get(id));
  const check = R.validateMeld(cards, S.state.wildRank, {
    allowAllWild: S.state.settings.allowAllWildMelds,
  });
  if (!check.ok) return toast(check.error);
  S.builder.melds.push(ids);
  S.selection.clear();
  render();
}

function submitBuilder() {
  const b = S.builder;
  const check = R.validateLayDown(me().hand, b.melds, b.discardId, {
    wildRank: S.state.wildRank,
    mustUseAll: !S.state.finalTurn,
    allowAllWild: S.state.settings.allowAllWildMelds,
  });
  if (!check.ok) return toast(check.error);
  S.builder = null;
  S.selection.clear();
  act('layDown', { melds: b.melds, discardId: b.discardId });
}

// ------------------------------------------------------------------ scores
function scoreTableHTML() {
  const st = S.state;
  const played = Math.max(0, ...st.players.map((p) => p.roundScores.length));
  const best = Math.min(...st.players.map((p) => p.total));
  return `<table class="scores">
    <thead><tr><th>Player</th>
      ${Array.from({ length: played }, (_, i) => `<th>R${i + 1}</th>`).join('')}
      <th>Total</th></tr></thead>
    <tbody>
      ${st.players
        .map(
          (p) => `<tr>
            <td>${esc(p.name)}</td>
            ${Array.from(
              { length: played },
              (_, i) => `<td>${p.roundScores[i] ?? '—'}</td>`
            ).join('')}
            <td class="${p.total === best ? 'lead' : ''}">${p.total}</td>
          </tr>`
        )
        .join('')}
    </tbody>
  </table>`;
}

function renderScoresView() {
  const st = S.state;
  const over = st.phase === 'gameOver';
  const best = Math.min(...st.players.map((p) => p.total));
  const winners = st.players.filter((p) => p.total === best);
  const host = me()?.isHost;

  appEl.innerHTML = `
    <div class="center" style="padding:1rem 0 0.4rem">
      <h1>${over ? '👑 ' + esc(winners.map((w) => w.name).join(' & ')) + ' wins!' : `Round ${st.round} done`}</h1>
      <p class="muted">${
        over ? `Lowest score after ${st.totalRounds} rounds: ${best} points.` : 'Lowest score is winning.'
      }</p>
    </div>

    <div class="panel">${scoreTableHTML()}</div>

    <div class="panel">
      <h2 class="small muted" style="text-transform:uppercase;letter-spacing:0.06em">Round ${st.round} hands</h2>
      ${st.players
        .map((p) => {
          const pts = p.roundScores[st.round - 1] ?? 0;
          return `<div style="margin-bottom:0.7rem">
            <div class="small" style="margin-bottom:0.25rem">
              <strong>${esc(p.name)}</strong>
              <span class="muted">— ${pts} point${pts === 1 ? '' : 's'}${p.isOut ? ', went out' : ''}</span>
            </div>
            <div class="melds">
              ${p.melds.map((m) => meldHTML(m)).join('')}
              ${
                p.leftover.length
                  ? `<div class="meld invalid">${p.leftover
                      .map((c) => (c ? cardHTML(c, { small: true }) : cardHTML('back', { small: true })))
                      .join('')}<span class="small" style="color:var(--danger);font-weight:700;padding:0 0.3rem">+${pts}</span></div>`
                  : ''
              }
            </div>
          </div>`;
        })
        .join('')}
    </div>

    <div class="actionbar">
      ${
        over
          ? host
            ? `<button class="wide" data-act="rematch">Play again</button>`
            : `<button class="wide subtle" disabled>Waiting for the host…</button>`
          : host
            ? `<button class="wide" data-act="next-round">
                 Deal round ${st.round + 1} (${R.handSizeForRound(st.round + 1)} cards, ${esc(
                   R.rankName(R.wildRankForRound(st.round + 1))
                 )} wild)</button>`
            : `<button class="wide subtle" disabled>Waiting for the host to deal…</button>`
      }
    </div>`;
}

function rulesHTML() {
  return `<details class="panel rules"><summary>How Five Crowns works</summary><ul>
    <li>11 rounds. Round 1 deals 3 cards, round 11 deals 13 — and the rank you were dealt is wild that round (3s wild in round 1 … Kings wild in round 11).</li>
    <li>Jokers are always wild.</li>
    <li>On your turn: take the top card of the draw pile or the discard pile, then discard one card.</li>
    <li>A <strong>book</strong> is 3+ cards of the same number. A <strong>run</strong> is 3+ cards in a row in one suit. Runs stop at 3 and at K — they don't wrap around.</li>
    <li>Go out by melding your whole hand with exactly one card left to discard. Everyone else then gets one last turn.</li>
    <li>Cards you can't meld count against you: number cards face value, J 11, Q 12, K 13, the round's wild rank 20, jokers 50.</li>
    <li>Lowest total after 11 rounds wins.</li>
  </ul></details>`;
}

// ------------------------------------------------------------------ hand drag
let drag = null;

appEl.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('button.card[data-act="pick"]');
  if (!card) return;
  drag = { id: card.dataset.id, x: e.clientX, y: e.clientY, moved: false, el: card };
});

appEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 10) drag.moved = true;
  if (drag.moved) drag.el.style.opacity = '0.55';
});

appEl.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const dragged = drag;
  drag = null;
  dragged.el.style.opacity = '';
  if (!dragged.moved) return; // a tap: the click handler deals with it

  const row = dragged.el.closest('.hand');
  if (!row) return;
  const cards = [...row.querySelectorAll('button.card[data-act="pick"]')];
  // Drop before whichever card's midpoint we ended up left of.
  let targetId = null;
  for (const el of cards) {
    if (el === dragged.el) continue;
    const box = el.getBoundingClientRect();
    if (e.clientY < box.bottom && e.clientX < box.left + box.width / 2) {
      targetId = el.dataset.id;
      break;
    }
  }
  const order = S.order.filter((id) => id !== dragged.id);
  const at = targetId ? order.indexOf(targetId) : order.length;
  order.splice(at < 0 ? order.length : at, 0, dragged.id);
  S.order = order;
  render();
});

appEl.addEventListener('pointercancel', () => {
  if (drag) drag.el.style.opacity = '';
  drag = null;
});

// ------------------------------------------------------------------ actions
appEl.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const action = el.dataset.act;

  switch (action) {
    case 'create': {
      const name = document.getElementById('host-name').value.trim();
      if (!name) return toast('Enter your name first.');
      const allowAllWildMelds = document.getElementById('all-wild').checked;
      el.disabled = true;
      try {
        const room = await table.create(name, { allowAllWildMelds });
        rememberRoom(room);
        history.replaceState(null, '', `#${room}`);
      } catch (err) {
        toast(err.message);
      } finally {
        el.disabled = false;
      }
      return;
    }
    case 'join': {
      const room = document.getElementById('join-code').value.trim().toUpperCase();
      const name = document.getElementById('join-name').value.trim();
      if (room.length !== 4) return toast('Game codes are 4 letters.');
      if (!name) return toast('Enter your name first.');
      el.disabled = true;
      try {
        await table.join(room, name);
        rememberRoom(room);
        history.replaceState(null, '', `#${room}`);
      } catch (err) {
        toast(err.message);
      } finally {
        el.disabled = false;
      }
      return;
    }
    case 'share': {
      const link = `${location.origin}${location.pathname}#${table.code}`;
      try {
        if (navigator.share) await navigator.share({ title: 'Five Crowns', url: link });
        else {
          await navigator.clipboard.writeText(link);
          toast('Invite link copied.', 'info');
        }
      } catch {
        toast(link, 'info');
      }
      return;
    }
    case 'start': return void table.start().catch((e) => toast(e.message));
    case 'next-round': return void table.nextRound().catch((e) => toast(e.message));
    case 'rematch': return void table.rematch().catch((e) => toast(e.message));
    case 'draw-stock': return void act('draw', { source: 'stock' });
    case 'draw-discard': return void act('draw', { source: 'discard' });
    case 'discard': {
      const [cardId] = [...S.selection];
      if (!cardId) return;
      S.selection.clear();
      return void act('discard', { cardId });
    }
    case 'sort-rank': return sortHand('rank');
    case 'sort-suit': return sortHand('suit');
    case 'pick': {
      const id = el.dataset.id;
      if (S.selection.has(id)) S.selection.delete(id);
      else S.selection.add(id);
      return render();
    }
    case 'open-builder': return openBuilder();
    case 'cancel-builder': {
      S.builder = null;
      S.selection.clear();
      return render();
    }
    case 'make-meld': return makeMeld();
    case 'set-discard': {
      S.builder.discardId = [...S.selection][0];
      S.selection.clear();
      return render();
    }
    case 'undiscard': {
      S.builder.discardId = null;
      return render();
    }
    case 'unmeld': {
      S.builder.melds.splice(Number(el.dataset.i), 1);
      return render();
    }
    case 'submit-builder': return submitBuilder();
  }
});

// ------------------------------------------------------------------ boot
(async function boot() {
  if (!configured()) {
    appEl.innerHTML = `<div class="panel" style="margin-top:2rem">
      <h2>Not set up yet</h2>
      <p class="muted">This copy has no game database configured, so rooms cannot be
      created. Whoever put it online needs to paste a Firebase Realtime Database URL
      into <code>js/firebase-config.js</code> — see the README.</p></div>`;
    return;
  }
  const hash = (location.hash || '').replace('#', '').toUpperCase().slice(0, 4);
  const room = hash || lastRoom();
  if (room) {
    try {
      if (await table.resume(room)) {
        rememberRoom(room);
        history.replaceState(null, '', `#${room}`);
        return;
      }
    } catch {
      /* fall through to the front page */
    }
  }
  renderHome();
})();
