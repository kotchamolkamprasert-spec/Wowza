/* Carnival Clicker - screens, round logic, input.
 *
 * Designed for a booth: every round ends on its own, nothing can get stuck,
 * and an abandoned game falls back to the attract screen by itself.
 */
import { initScene, setupTracks, setProgress, setIdleSpin, preloadModel,
         usingAuthoredModel, usingTree, snapshot, perf, models } from './scene.js';

const ROUND_SECONDS = 60;
const TARGET_CLICKS = 120;      // clicks to finish one build
const IDLE_HOME_MS  = 90000;    // abandoned round -> back to attract
const PAUSE_LIMIT_MS = 25000;   // longest a dead controller may hold a round

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  screen: 'home',
  mode: 'solo',        // a lone player is the common case at a booth
  names: ['', ''],
  clicks: [0, 0],
  running: false,
  endsAt: 0,
  lastInput: Date.now(),
  linked: 0,
  guard: 0,
  paused: false,
  needBoards: 0,
  pauseBegan: 0,
  pauseWaived: false,
};

/* ------------------------------------------------------------- screens */
function screen(name) {
  state.screen = name;
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === name));
  document.body.classList.toggle('showcursor', name === 'setup');
  setIdleSpin(name === 'home');
  if (name === 'home') { setupTracks(1); setProgress(0, .18); refreshBoard(); }
}

/* --------------------------------------------------------------- input */
function press(player) {
  state.lastInput = Date.now();
  if (state.screen === 'home')   { return startSetup(); }
  if (state.screen === 'setup')  { return beginRound(); }
  if (state.screen === 'result') { return startSetup(); }
  if (!state.running) return;

  // Solo takes clicks from any controller, so a lone player can grab whichever
  // box is nearest without wondering which one is "theirs".
  if (state.mode === 'solo') player = 1;
  const track = state.mode === 'versus' ? player - 1 : 0;
  state.clicks[player - 1]++;
  const shown = state.mode === 'coop'
    ? state.clicks[0] + state.clicks[1]
    : state.clicks[player - 1];

  setProgress(track, Math.min(shown / TARGET_CLICKS, 1));
  paintTrack(track, shown, player);
  floatUp(player);
}

/* ----------------------------------------------------------- the round */
function beginRound() {
  state.names[0] = ($('#n1').value || 'PLAYER 1').toUpperCase().slice(0, 12);
  state.names[1] = state.mode === 'solo' ? ''
    : ($('#n2').value || 'PLAYER 2').toUpperCase().slice(0, 12);
  state.clicks = [0, 0];
  state.pauseWaived = false;

  const tracks = state.mode === 'versus' ? 2 : 1;
  // Only demand controllers we actually have; the keyboard covers the rest.
  const wanted = state.mode === 'solo' ? 1 : 2;
  state.needBoards = Math.min(state.linked, wanted);
  setupTracks(tracks);
  buildTrackUI();
  screen('countdown');

  let n = 3;
  const num = $('#countNum');
  num.textContent = n;
  const tick = setInterval(() => {
    n--;
    if (n > 0) {
      num.textContent = n;
      num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
    } else {
      clearInterval(tick);
      num.textContent = 'GO!';
      setTimeout(runRound, 420);
    }
  }, 700);
}

function runRound() {
  screen('play');
  state.running = true;
  state.endsAt = performance.now() + ROUND_SECONDS * 1000;
  feedback(null, 'MEND');                   // flash both boards
  requestAnimationFrame(roundFrame);

  // Safety net.  requestAnimationFrame is paused while the tab is not visible,
  // so a screen blanking or a minimised window would otherwise freeze a round
  // forever with a queue of people waiting.  A plain interval keeps running.
  clearInterval(state.guard);
  state.guard = setInterval(tickClock, 250);
}

function tickClock() {
  if (!state.running) return;
  if (state.paused) {                    // hold the clock while a pad is gone
    state.endsAt += performance.now() - state.pausedAt;
    state.pausedAt = performance.now();
    // But never hold it indefinitely.  A board whose battery died is not
    // coming back, and a booth cannot have a round that refuses to finish
    // with a queue waiting - so hand the round back to the keyboard.
    if (performance.now() - state.pauseBegan > PAUSE_LIMIT_MS) {
      state.pauseWaived = true;
      setPaused(false);
      toast('Controller did not return - finish on the keyboard');
    }
    return;
  }
  const left = Math.max(0, state.endsAt - performance.now());
  const secs = Math.ceil(left / 1000);
  const clock = $('#clock');
  if (clock.textContent !== String(secs)) clock.textContent = secs;
  $('.timer').classList.toggle('warn', secs <= 10);
  if (left <= 0) endRound();
}

function roundFrame() {
  if (!state.running) return;
  tickClock();
  if (state.running) requestAnimationFrame(roundFrame);
}

async function endRound() {
  if (!state.running) return;              // rAF and the guard can both land
  state.running = false;
  setPaused(false);
  clearInterval(state.guard);
  feedback(null, 'MEND');
  await postScores();
  showResult();
}

/* ------------------------------------------------------------ track UI */
function buildTrackUI() {
  const wrap = $('#tracks');
  wrap.innerHTML = '';
  if (state.mode === 'solo') {
    wrap.append(trackEl('p1', state.names[0], 0));
  } else if (state.mode === 'coop') {
    wrap.append(trackEl('co', 'TEAM ' + state.names[0] + ' + ' + state.names[1], 0));
  } else {
    wrap.append(trackEl('p1', state.names[0], 0), trackEl('p2', state.names[1], 1));
  }
  paintTrack(0, 0);
  if (state.mode === 'versus') paintTrack(1, 0);
}

function trackEl(cls, name, i) {
  const el = document.createElement('div');
  el.className = 'track ' + cls;
  el.dataset.i = i;
  el.innerHTML = '<div class="who"><b></b><i>0</i></div><div class="bar"><div></div></div>';
  el.querySelector('b').textContent = name;
  return el;
}

function paintTrack(i, value) {
  const el = $('.track[data-i="' + i + '"]');
  if (!el) return;
  el.querySelector('i').textContent = value;
  el.querySelector('.bar>div').style.width =
    Math.min(100, (value / TARGET_CLICKS) * 100) + '%';
}

function floatUp(player) {
  let host = $('#floats');
  if (!host) { host = document.createElement('div'); host.id = 'floats'; document.body.append(host); }
  const el = document.createElement('div');
  el.className = 'float';
  el.textContent = '+1';
  const side = state.mode === 'versus' ? (player === 1 ? 30 : 70) : 50;
  el.style.left = (side + (Math.random() * 8 - 4)) + '%';
  el.style.top = (52 + Math.random() * 8) + '%';
  el.style.color = state.mode === 'coop' ? 'var(--gold)'
                 : (player === 2 ? 'var(--p2)' : 'var(--p1)');
  host.append(el);
  setTimeout(() => el.remove(), 900);
}

/* -------------------------------------------------------------- result */
function showResult() {
  const [a, b] = state.clicks;
  const body = $('#resultBody');
  body.innerHTML = '';

  if (state.mode === 'solo') {
    $('#resultTitle').textContent = a >= TARGET_CLICKS ? 'BUILD COMPLETE!' : 'TIME!';
    body.append(card('win p1', 'YOUR SCORE', state.names[0], a, ''));
    showRank(a);
  } else if (state.mode === 'coop') {
    const total = a + b;
    $('#resultTitle').textContent = total >= TARGET_CLICKS ? 'BUILD COMPLETE!' : 'TIME!';
    body.append(card('win', 'TEAM SCORE', state.names[0] + ' + ' + state.names[1],
                     total, a + ' + ' + b));
  } else {
    $('#resultTitle').textContent = a === b ? 'DEAD HEAT!'
      : (a > b ? state.names[0] + ' WINS!' : state.names[1] + ' WINS!');
    body.append(card(a >= b ? 'win p1' : 'p1', 'PLAYER 1', state.names[0], a,
                     a > b ? 'winner' : ''));
    body.append(card(b >= a ? 'win p2' : 'p2', 'PLAYER 2', state.names[1], b,
                     b > a ? 'winner' : ''));
  }
  screen('result');
}

/* A lone player has nobody to beat in the room, so give them the board to
   measure against - it is the whole reason solo is worth playing twice. */
async function showRank(score) {
  let rows = [];
  try { rows = await (await fetch('/api/scores')).json(); } catch {}
  const solo = rows.filter(r => r.mode !== 'coop');
  const better = solo.filter(r => r.score > score).length;
  const el = document.createElement('div');
  el.className = 'rankline';
  el.textContent = solo.length <= 1
    ? 'first score on the board today'
    : 'that is #' + (better + 1) + ' of ' + solo.length + ' today';
  $('#resultBody').append(el);
}

function card(cls, label, name, score, note) {
  const el = document.createElement('div');
  el.className = 'card ' + cls;
  el.innerHTML = '<h4></h4><div class="nm"></div><div class="sc"></div><div class="crown"></div>';
  el.querySelector('h4').textContent = label;
  el.querySelector('.nm').textContent = name;
  el.querySelector('.sc').textContent = score;
  el.querySelector('.crown').textContent = (note || '').toUpperCase();
  return el;
}

/* ---------------------------------------------------------- leaderboard */
async function postScores() {
  const send = body => fetch('/api/scores', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});

  if (state.mode === 'solo') {
    await send({ names: [state.names[0]], mode: 'solo',
                 score: state.clicks[0], clicks: state.clicks[0] });
  } else if (state.mode === 'coop') {
    await send({ names: state.names, mode: 'coop',
                 score: state.clicks[0] + state.clicks[1],
                 clicks: state.clicks[0] + state.clicks[1] });
  } else {
    await send({ names: [state.names[0]], mode: 'versus',
                 score: state.clicks[0], clicks: state.clicks[0] });
    await send({ names: [state.names[1]], mode: 'versus',
                 score: state.clicks[1], clicks: state.clicks[1] });
  }
}

async function refreshBoard() {
  let rows = [];
  try { rows = await (await fetch('/api/scores')).json(); } catch {}
  // Solo and versus are both one person clicking for 60 seconds, so they are
  // directly comparable.  A co-op score is two people added together and would
  // sit permanently on top of a mixed board, which makes it meaningless.
  const solo = rows.filter(r => r.mode !== 'coop');
  const teams = rows.filter(r => r.mode === 'coop');
  paintBoard($('#homeBoard'), solo.slice(0, 5));
  paintBoard($('#homeTeams'), teams.slice(0, 5));
  paintBoard($('#fullBoard'), solo.slice(0, 25));
  paintBoard($('#fullTeams'), teams.slice(0, 25));
}

function paintBoard(ol, rows) {
  if (!ol) return;
  ol.innerHTML = '';
  if (!rows.length) {
    ol.innerHTML = '<li class="empty">no scores yet - be the first</li>';
    return;
  }
  for (const r of rows) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="who"></span><span class="md"></span><span class="sc"></span>';
    li.querySelector('.who').textContent = (r.names || ['?']).join(' + ');
    li.querySelector('.md').textContent =
      r.mode === 'coop' ? 'CO-OP' : r.mode === 'solo' ? 'SOLO' : 'VS';
    li.querySelector('.sc').textContent = r.score;
    ol.append(li);
  }
}

/* Freeze the round while a player controller is missing.

   A wireless link will occasionally drop - somebody walks between the board
   and the laptop, or the band gets busy for a second.  Losing time for that
   would be unfair and very visible, so the clock stops and the round waits.
   The player cannot click while disconnected anyway, so nothing is lost. */
function setPaused(on, why) {
  if (on === state.paused) return;
  state.paused = on;
  state.pausedAt = performance.now();
  if (on) state.pauseBegan = performance.now();
  let veil = $('#veil');
  if (!veil) {
    veil = document.createElement('div');
    veil.id = 'veil';
    veil.innerHTML = '<div class="veilbox"><b></b><em></em></div>';
    document.body.append(veil);
  }
  veil.classList.toggle('on', on);
  if (on) {
    veil.querySelector('b').textContent = 'CONTROLLER LOST';
    veil.querySelector('em').textContent = why || 'reconnecting - your time is paused';
  }
}

function checkLinkDuringRound(connected) {
  if (!state.running) return setPaused(false);
  if (state.pauseWaived) return;         // already given up on it this round
  setPaused(connected < state.needBoards);
}

/* A small transient message, used when something needs saying mid-round. */
function toast(text, ms = 3200) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.append(el); }
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), ms);
}

/* ----------------------------------------------------------- controllers */
function feedback(player, line) {
  fetch('/api/feedback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player, line }),
  }).catch(() => {});
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'click') press(msg.player || 1);
    else if (msg.type === 'connect' || msg.type === 'disconnect') pollStatus();
    if (msg.type === 'disconnect') checkLinkDuringRound(0);
  };
  es.onerror = () => { /* EventSource retries on its own */ };
}

async function pollStatus() {
  let s = {};
  try { s = await (await fetch('/api/status')).json(); } catch {}
  const n = Object.keys(s.connected || {}).length;
  state.linked = n;
  checkLinkDuringRound(n);
  const pill = $('#link');
  pill.className = 'link-pill ' + (n >= 2 ? 'two' : n === 1 ? 'one' : 'none');
  pill.querySelector('span').textContent =
    !s.available ? 'pyserial not installed' :
    !s.enabled   ? 'controllers off - keyboard' :
    n === 0 ? 'searching for controllers' :
    n === 1 ? '1 controller' : '2 controllers';
  const hint = $('#linkHint');
  if (hint) {
    hint.textContent =
      state.mode === 'solo'
        ? (n >= 1 ? 'controller ready - or use A / Space'
                  : 'no controller - play with A or Space')
        : n >= 2 ? 'both controllers ready'
        : n === 1 ? 'player 2 can use the keyboard (L or right arrow)'
        : 'keyboard: player 1 = A, player 2 = L';
  }
}

/* ------------------------------------------------------------- wiring */
function applyMode() {
  const solo = state.mode === 'solo';
  $('#p2wrap').classList.toggle('hidden', solo);
  $('#p1label').textContent = solo ? 'YOUR NAME' : 'PLAYER 1';
}

function startSetup() {
  screen('setup');
  applyMode();
  setTimeout(() => $('#n1').focus(), 60);
}

function wire() {
  $('#startBtn').onclick = startSetup;
  $('#goBtn').onclick = beginRound;
  $('#againBtn').onclick = startSetup;
  $$('[data-goto]').forEach(b => b.onclick = () => screen(b.dataset.goto));

  $$('.mode').forEach(b => b.onclick = () => {
    $$('.mode').forEach(x => x.classList.toggle('sel', x === b));
    state.mode = b.dataset.mode;
    applyMode();
  });

  addEventListener('keydown', e => {
    if (e.repeat) return;
    const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
    const k = e.key.toLowerCase();

    if (typing && state.screen === 'setup') {
      if (e.key === 'Enter') { e.preventDefault(); beginRound(); }
      return;                                    // let them type their name
    }
    if (k === ' ' || k === 'a' || k === 'arrowleft')  { e.preventDefault(); press(1); }
    else if (k === 'enter' || k === 'l' || k === 'arrowright') { e.preventDefault(); press(2); }
    else if (k === 'escape') screen('home');
    else if (k === 'b') screen('leaderboard');
  });

  addEventListener('pointerdown', () => { state.lastInput = Date.now(); });

  // an abandoned booth returns to the attract screen by itself
  setInterval(() => {
    if (state.running) return;
    if (state.screen !== 'home' && Date.now() - state.lastInput > IDLE_HOME_MS) {
      screen('home');
    }
  }, 4000);
}

/* --------------------------------------------------------------- boot */
initScene($('#stage'));
await preloadModel('./models/');
console.log(usingAuthoredModel()
  ? 'using the soil-and-seed artwork' + (usingTree() ? ' with the cherry tree' : ' (no tree found)')
  : 'no artwork in web/models - using the procedural tower');
wire();
screen('home');

// Diagnostics hook - lets you drive the booth from the console if something
// looks wrong on the day, and is how the build was verified.
window.CC = { state, screen, press, setProgress, setupTracks, snapshot,
              setPaused, checkLinkDuringRound, tickClock, perf, models,
              beginRound, endRound, TARGET_CLICKS, ROUND_SECONDS };
connectEvents();
pollStatus();
setInterval(pollStatus, 5000);
