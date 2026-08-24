// MediaPipe is pulled in via dynamic import() inside initModel() rather than a
// top-level `import`, so this file can load as a classic script. A module script
// cannot be fetched over file:// (no CORS headers), which would stop the whole
// booth from starting when index.html is opened by double-clicking it.
const VISION_BUNDLE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

/* ================= config ================= */
const TREE_STAGE_NEEDS = [0, 10, 25, 50, 100, 125]; // reps needed for each visual growth stage (no labels/levels shown to player)
const TREE_MAX = TREE_STAGE_NEEDS[TREE_STAGE_NEEDS.length - 1];
const SESSION_DURATION = 60; // seconds — tree grows live while you do the 67 move
function stageForCount(c){ let s = 0; for(let i=0;i<TREE_STAGE_NEEDS.length;i++){ if(c >= TREE_STAGE_NEEDS[i]) s = i; } return s; }
// Pose landmark indices (BlazePose / MediaPipe Pose, 33 keypoints)
const L_SH=11, R_SH=12, L_HIP=23, R_HIP=24, L_WR=15, R_WR=16, L_EL=13, R_EL=14;
const POSE_CONNECTIONS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24]];

/* ---- rep detection tuning ----
   Every distance here is a fraction of torso length (shoulder-mid to hip-mid),
   so the calibration holds at any distance from the camera.
   A swing must cross the whole dead band (2 x SWING_ENTER of travel) to count,
   which is far larger than landmark jitter — that is what stops the counter
   from ticking on its own while someone stands still.
   Too strict? Lower SWING_ENTER. Still counting by itself? Raise it. */
const SWING_ENTER    = 0.10;  // travel past the swing centre needed to register a direction change
const HANDS_UP_MIN   = -0.85; // wrist height vs the shoulder line (0 = shoulders, -1 is about hip level)
const MIN_VISIBILITY = 0.60;  // landmark confidence required before a joint is trusted
const BASELINE_ALPHA = 0.02;  // how fast the swing centre follows the wrist — slow, so it averages out the swing
const SMOOTH_ALPHA   = 0.60;  // denoising of the raw wrist position — kept light, since heavy
                              // smoothing lags the wrist and shrinks fast swings most
const REP_COOLDOWN_MS = 55;   // a backstop only — the dead band above already blocks rapid
                              // re-triggering, so this stays well clear of a fast player's rate
const MAX_SWING_MS   = 1200;  // a direction change slower than this is swaying or drifting, not a
                              // rep. Slow sway and a real swing can be the same SIZE, so speed is
                              // what separates them — this is why gentle rocking scores nothing.
// The end-of-round panel has no timeout: it stays up until the player chooses
// "บันทึกคะแนน" or "ข้าม", so a round never rolls over on its own.

/* ================= state ================= */
let poseLandmarker = null;
let running = false;
let rafId = null;
let count = 0, bestCombo = 0, comboStreak = 0, currentStage = 0;
let soundOn = true;
let audioCtx = null;
let lastPersonSeenTime = performance.now();
let latencyEMA = null;
let treesPlantedToday = Number(localStorage.getItem('t67p_treesToday') || 0);
let communityTotal = Number(localStorage.getItem('t67p_communityTotal') || 0);

// config.js — written by booth-server.ps1 — sets window.SCORE_SERVER. With no
// server that file is simply absent, and everything falls back to localStorage,
// so a booth still works standalone and survives the wifi dropping mid-fair.
const SCORE_SERVER = (window.SCORE_SERVER || '').replace(/\/+$/,'');
let remote = null;       // last state fetched from the host, or null when offline
let netFailed = false;

/* ---- booth resilience ---- */
const ABANDON_MS    = 9000;  // no one visible this long mid-round -> hand back to idle
const COMBO_BREAK_MS = 1600; // gap that ends an unbroken run of reps
const CAM_RETRY_MS  = 2500;  // wait between attempts to bring a dead camera back
const COUNTDOWN_SECS = 3;    // "get ready" beats before the clock starts
const CAM_STALL_MS  = 4000;  // frames stopped advancing this long -> treat as dead
let countdownInterval = null;
let lastVideoTime = -1;          // last distinct video.currentTime seen
let lastFrameAdvanceAt = performance.now();
let pausedMs = 0, pauseStartedAt = null;   // clock stopped while the camera is out
let pulling = false, flushing = false;     // in-flight guards for the score sync
let pendingCommunityDelta = 0;             // reps not yet confirmed by the host
let loopErrors = 0;          // consecutive failed frames
let camRecovering = false;
let lastCamTryAt = 0;
let roundStartAt = null;     // when the current round actually began

// localStorage throws in private mode and when the quota is full. A booth must
// never lose a round over that, so every write goes through here.
function store(key, value){
  try{ localStorage.setItem(key, String(value)); }catch(e){ /* keep playing */ }
}

// timed challenge session (SESSION_DURATION seconds)
// IDLE is the booth's resting screen: camera preview and leaderboard on show, but
// nothing counting. A round only begins when someone presses the play button, so
// the booth never starts a round just because a person walked into frame.
let sessionState = 'IDLE'; // IDLE -> WAITING -> RUNNING -> ENDED -> IDLE
let timeLeft = SESSION_DURATION;
let sessionTimerInterval = null;

// per-wrist adaptive extremum + hysteresis state
function newWristTracker(){ return { smoothY:null, baseY:null, state:'NEUTRAL', lastFlipAt:0 }; }
let wristL = newWristTracker();
let wristR = newWristTracker();

/* ================= DOM ================= */
const $ = id => document.getElementById(id);
const video=$('video'), overlay=$('overlay'), ctx=overlay.getContext('2d');
const powerOverlay=$('power-overlay'), powerBtn=$('powerBtn'), powerErr=$('powerErr');
const hud=$('hud'), hudCount=$('hudCount'), hudRecord=$('hudRecord');
const latencyVal=$('latencyVal'), fpsVal=$('fpsVal'), fpsPill=$('fpsPill');
const hintLine=$('hintLine'), swingMeter=$('swingMeter'), swingFillL=$('swingFillL'), swingFillR=$('swingFillR');
const timerBadge=$('timerBadge'), timerNum=$('timerNum'), timerLbl=$('timerLbl');
const successOverlay=$('successOverlay'), successEmoji=$('successEmoji'), successTitle=$('successTitle'), successDesc=$('successDesc'), successCount=$('successCount'), lbName=$('lbName'), lbSubmitBtn=$('lbSubmitBtn'), lbSkipBtn=$('lbSkipBtn');
const liveCountBig=$('liveCountBig'), progressFill=$('progressFill'), progressText=$('progressText');
const statTotal=$('statTotal'), statBest=$('statBest'), statTime=$('statTime'), statTrees=$('statTrees');
const communityTotalEl=$('communityTotal'), soundToggle=$('soundToggle'), toastZone=$('toast-zone');
const treeGroups=document.querySelectorAll('.tree-group');
const restartCamBtn=$('restartCamBtn'), resetRoundBtn=$('resetRoundBtn'), lbList=$('lbList');
const idleOverlay=$('idleOverlay'), idleTitle=$('idleTitle'), idleNote=$('idleNote'), playBtn=$('playBtn');
const lbScope=$('lbScope'), camPlaceholder=$('camPlaceholder'), camMsg=$('camMsg');
let lastRoundReps = 0, lastRoundPlanted = false;

statTrees.textContent = treesPlantedToday;
communityTotalEl.textContent = `${communityTotal} จังหวะ · ปลูกสำเร็จ ${treesPlantedToday} ต้น`;
setTreeStage(0); renderLeaderboard();

function setTreeStage(stage){
  treeGroups.forEach(g=>g.classList.toggle('active', Number(g.dataset.stage)===stage));
}

/* ================= shared board (booth-server.ps1) =================
   SCORE_SERVER / remote / netFailed are declared up with the rest of the state,
   because renderLeaderboard() runs during start-up and reads them. */

// Every request is bounded. A host that accepts the connection but never answers
// (wedged process, sleeping laptop, captive portal) would otherwise leave a fetch
// pending forever, and the 5s poll would pile those up all day until the tab dies.
function netFetch(url, opts){
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), 4000);
  return fetch(url, Object.assign({ signal: ctl.signal }, opts || {}))
    .finally(()=>clearTimeout(t));
}

async function pullState(){
  if(!SCORE_SERVER || pulling) return;    // never overlap with a poll in flight
  pulling = true;
  try{
    await flushPending();
    const r = await netFetch(SCORE_SERVER + '/api/state', { cache:'no-store' });
    if(!r.ok) throw new Error(r.status);
    remote = await r.json();
    pendingCommunityDelta = 0;            // the host's number now includes ours
    netFailed = false;
  }catch(e){ netFailed = true; }
  finally{ pulling = false; }
  renderLeaderboard(); updateCommunityLine();
}

// One request per round, at the end — never per rep.
async function postRound(payload){
  try{
    const r = await netFetch(SCORE_SERVER + '/api/round', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if(!r.ok) throw new Error(r.status);
    remote = await r.json();
    netFailed = false;
    return true;
  }catch(e){ netFailed = true; return false; }
}

// Rounds played while the host is unreachable are held here and sent on the next
// successful poll, so a wifi blip costs the shared board nothing.
function pendingQueue(){ try{ return JSON.parse(localStorage.getItem('t67p_pending')||'[]'); }catch(e){ return []; } }
// Each item is removed from the stored queue BEFORE it is posted. Rewriting the
// whole array at the end instead would let two overlapping runs read the same
// queue and submit every held round twice.
async function flushPending(){
  if(flushing) return;
  flushing = true;
  try{
    while(true){
      const q = pendingQueue();
      if(!q.length) break;
      const item = q[0];
      store('t67p_pending', JSON.stringify(q.slice(1)));
      if(!(await postRound(item))){
        const back = pendingQueue();      // put it back at the front and stop
        back.unshift(item);
        store('t67p_pending', JSON.stringify(back.slice(0,50)));
        break;
      }
    }
  }finally{ flushing = false; }
}

async function pushRound(name, reps, planted){
  if(!SCORE_SERVER) return false;
  const payload = { name:name||'', count:reps, planted:planted?1:0 };
  const ok = await postRound(payload);
  if(!ok){
    const q = pendingQueue(); q.push(payload);
    store('t67p_pending', JSON.stringify(q.slice(-50)));
  }
  renderLeaderboard(); updateCommunityLine();
  return ok;
}

function updateCommunityLine(){
  // While a round is live the local count is added on top, so the number climbs
  // as you play instead of jumping only when the round is sent.
  // pendingCommunityDelta holds reps the host has not confirmed yet, so the
  // headline number never dips backwards between the round ending and the POST
  // landing — and it keeps climbing even while offline.
  const base = (remote ? remote.communityTotal : communityTotal) + pendingCommunityDelta;
  const trees = remote ? remote.treesPlanted : treesPlantedToday;
  const live = (sessionState === 'RUNNING' || sessionState === 'COUNTDOWN') ? count : 0;
  communityTotalEl.textContent = `${base + live} จังหวะ · ปลูกสำเร็จ ${trees} ต้น`;
  statTrees.textContent = trees;
}

/* ================= leaderboard ================= */
function getLeaderboard(){
  if(remote && remote.leaderboard) return remote.leaderboard;
  try{ return JSON.parse(localStorage.getItem('t67p_leaderboard')||'[]'); }catch(e){ return []; }
}
function getRecord(){ const b = getLeaderboard(); return b.length ? b[0] : null; }
function renderLeaderboard(){
  const board = getLeaderboard();
  if(lbScope){
    // Three cases, kept honest: no host configured at all; host unreachable but
    // still showing the board we last synced; or live.
    lbScope.textContent = !SCORE_SERVER      ? '(เก็บในเครื่องนี้เท่านั้น)'
                        : (netFailed&&remote)? '(ออฟไลน์ — คะแนนล่าสุดที่ซิงก์ไว้)'
                        : netFailed          ? '(ออฟไลน์ — ใช้คะแนนในเครื่องนี้)'
                                             : '(รวมทุกเครื่องในงาน)';
    lbScope.style.color = netFailed ? 'var(--coral)' : '';
  }
  if(board.length===0){
    lbList.innerHTML = '<div class="lb-empty">ยังไม่มีใครส่งคะแนน — เล่นให้จบรอบเพื่อขึ้นบอร์ด!</div>';
    hudRecord.textContent = 'ยังไม่มี';
    return;
  }
  lbList.innerHTML = board.slice(0,5).map((e,i)=>
    `<div class="lb-row"><span class="rk">#${i+1}</span><span class="nm">${escapeHtml(e.name||'ผู้เล่นนิรนาม')}</span><span class="sc num">${Number(e.count)||0}</span></div>`
  ).join('');
  hudRecord.textContent = `${board[0].count} จังหวะ`;
}
function escapeHtml(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function submitScore(name){
  const board = getLeaderboard();
  board.push({ name: (name||'').trim().slice(0,16), count, ts: Date.now() });
  board.sort((a,b)=> b.count - a.count);
  store('t67p_leaderboard', JSON.stringify(board.slice(0,10)));
  renderLeaderboard();
}

/* ================= audio ================= */
function ensureAudio(){ if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)(); if(audioCtx.state==='suspended') audioCtx.resume(); }
function tone(freq,dur=0.09,type='sine',gain=0.05,delay=0){
  if(!soundOn) return; ensureAudio();
  const t0=audioCtx.currentTime+delay, osc=audioCtx.createOscillator(), g=audioCtx.createGain();
  osc.type=type; osc.frequency.setValueAtTime(freq,t0);
  g.gain.setValueAtTime(0,t0); g.gain.linearRampToValueAtTime(gain,t0+0.01); g.gain.exponentialRampToValueAtTime(0.001,t0+dur);
  osc.connect(g); g.connect(audioCtx.destination); osc.start(t0); osc.stop(t0+dur+0.02);
}
const playCountTone = () => tone(420+(count%12)*22, 0.08,'sine',0.045);
const playLevelUpChord = () => [523.25,659.25,783.99,1046.5].forEach((f,i)=>tone(f,0.35,'triangle',0.05,i*0.07));

/* ================= toast / particles ================= */
function showToast(icon,t1,t2){
  const el=document.createElement('div'); el.className='toast';
  el.innerHTML=`<div class="icon">${icon}</div><div><div class="t1">${t1}</div><div class="t2">${t2}</div></div>`;
  toastZone.appendChild(el); setTimeout(()=>el.remove(),3200);
}
function leafBurst(n=16){
  const emojis=['🍃','🌿','✨','🍀'];
  for(let i=0;i<n;i++){
    const s=document.createElement('div'); s.className='leaf-particle'; s.textContent=emojis[Math.floor(Math.random()*emojis.length)];
    s.style.left=Math.random()*100+'vw'; s.style.fontSize=(13+Math.random()*13)+'px'; s.style.animationDuration=(2.1+Math.random()*1.6)+'s';
    document.body.appendChild(s); setTimeout(()=>s.remove(),4000);
  }
}

/* ================= level logic ================= */
function updateTree(){
  const newStage = stageForCount(count);
  if(newStage !== currentStage){
    currentStage = newStage;
    setTreeStage(currentStage);
    if(currentStage > 0 && currentStage % 2 === 0) leafBurst(8); // light feedback every couple of growth steps
  }
  // growth is uncapped — once the forest stage is reached, keep sparkling every 20 reps to show it's still counting
  if(count >= TREE_MAX && count % 20 === 0) leafBurst(6);
  const pct = Math.min(100, (count / TREE_MAX) * 100);
  // Drive the voxel island. Guarded: if the 3D module never loaded the game
  // carries on exactly as before. __treePending covers reps landing before it boots.
  if (window.Tree3D) window.Tree3D.setProgress(pct / 100);
  else window.__treePending = pct / 100;
  progressFill.style.width = pct + '%';
  progressText.textContent = `${count} จังหวะ`;
  liveCountBig.textContent = `${count} จังหวะ`;
}

// Clearing alone leaves a stale id behind, so null it too: sessionTimerInterval
// being falsy is then a truthful "no round clock is running".
function stopSessionTimer(){
  if(sessionTimerInterval) clearInterval(sessionTimerInterval);
  sessionTimerInterval = null;
}
function stopCountdown(){
  if(countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;
  timerBadge.classList.remove('countdown');
  if(timerLbl) timerLbl.textContent = 'วินาที';
}

// COUNTDOWN sits between "a player is in frame" and the clock actually starting.
function startCountdown(){
  if(sessionState !== 'WAITING') return;
  stopCountdown();          // must clear any previous one BEFORE styling this one,
                            // since stopCountdown resets the badge class and label
  sessionState = 'COUNTDOWN';
  let left = COUNTDOWN_SECS;
  timerBadge.style.display = 'flex';
  timerBadge.classList.remove('low');
  timerBadge.classList.add('countdown');
  if(timerLbl) timerLbl.textContent = 'เตรียมตัว';
  timerNum.textContent = left;
  hintLine.textContent = 'เตรียมตัว! ยกมือขึ้นให้พร้อม';
  hintLine.style.display = 'block';
  tone(660, 0.10, 'triangle', 0.05);
  // Derived from the clock, not from counting ticks: a throttled timer (hidden
  // tab, heavy inference load) would otherwise leave the booth stuck showing "1".
  const startedAt = Date.now();
  let shown = left;
  countdownInterval = setInterval(()=>{
    const remain = COUNTDOWN_SECS - Math.floor((Date.now() - startedAt)/1000);
    if(remain <= 0){
      stopCountdown();
      hintLine.style.display = 'none';
      tone(990, 0.22, 'triangle', 0.06);
      startSessionTimer();
      return;
    }
    if(remain !== shown){ shown = remain; timerNum.textContent = remain; tone(660, 0.10, 'triangle', 0.05); }
  }, 150);
}

// The player stepped out before the clock started — go back to waiting for them.
function cancelCountdown(){
  if(sessionState !== 'COUNTDOWN') return;
  stopCountdown();
  sessionState = 'WAITING';
  timerBadge.style.display = 'none';
  timerNum.textContent = SESSION_DURATION;
}

// Elapsed play time, excluding any spell where the camera stopped delivering.
// Counting interval ticks instead would make every player's "60 seconds" a
// different length, since setInterval drifts under the inference load and is
// throttled hard in a background tab — unfair on a leaderboard.
function roundElapsedMs(){
  if(roundStartAt === null) return 0;
  const open = pauseStartedAt ? (Date.now() - pauseStartedAt) : 0;
  return Date.now() - roundStartAt - pausedMs - open;
}
function pauseRound(){
  if(sessionState !== 'RUNNING' || pauseStartedAt !== null) return;
  pauseStartedAt = Date.now();
}
function resumeRound(){
  if(pauseStartedAt === null) return;
  pausedMs += Date.now() - pauseStartedAt;
  pauseStartedAt = null;
}

function startSessionTimer(){
  sessionState = 'RUNNING';
  roundStartAt = Date.now();
  pausedMs = 0; pauseStartedAt = null;
  timeLeft = SESSION_DURATION;
  timerBadge.classList.remove('low');
  updateTimerDisplay();
  stopSessionTimer(); stopCountdown();
  sessionTimerInterval = setInterval(()=>{
    timeLeft = Math.max(0, SESSION_DURATION - Math.floor(roundElapsedMs()/1000));
    updateTimerDisplay();
    if(timeLeft <= 0){
      stopSessionTimer(); stopCountdown();
      if(sessionState === 'RUNNING') endSession('TIMEUP');
    }
  }, 250);   // finer than 1s so the visible number tracks the real clock
}
function updateTimerDisplay(){
  timerNum.textContent = Math.max(0, timeLeft);
  timerBadge.classList.toggle('low', timeLeft <= 5);
}

function endSession(reason){
  if(sessionState === 'ENDED') return;
  sessionState = 'ENDED';
  stopSessionTimer(); stopCountdown();
  timerBadge.style.display = 'none';

  const record = getRecord();
  const isNewRecord = count > 0 && (!record || count > record.count);

  // Bank the round locally now; it is sent to the shared board when the player
  // picks บันทึกคะแนน or ข้าม. Kept separately so an offline booth still tallies.
  lastRoundReps = count;
  lastRoundPlanted = count >= TREE_MAX;
  pendingCommunityDelta += count;   // shown immediately; cleared once the host confirms
  communityTotal += count;
  store('t67p_communityTotal', communityTotal);
  if(lastRoundPlanted){
    treesPlantedToday += 1;
    store('t67p_treesToday', treesPlantedToday);
  }
  updateCommunityLine();

  successEmoji.textContent = isNewRecord ? '🏆🌲' : '⏱️🌳';
  successTitle.textContent = `หมดเวลา ${SESSION_DURATION} วินาที!`;
  successDesc.innerHTML = `ทำได้ <b class="num" id="successCount">${count}</b> จังหวะ`
    + (isNewRecord ? ` — <b style="color:var(--gold)">ทำลายสถิติสูงสุดของบูธนี้!</b> 🎉` : record ? ` — สถิติสูงสุดของบูธตอนนี้คือ <b class="num">${record.count}</b> จังหวะ ลองเอาชนะดูใหม่!` : ` — เป็นคนแรกที่ตั้งสถิติของบูธนี้!`)
    + ` ส่งคะแนนขึ้นกระดานได้เลย (ไม่ส่งข้อมูลออกนอกเครื่อง)`;

  lbName.value = '';
  successOverlay.classList.add('show');
  // No auto-dismiss — the next round starts only when a button below is pressed.
}
function finishSuccess(submitted){
  successOverlay.classList.remove('show');
  resetRound(true);
}
// An empty name box means the player did not want to be on the board: send them
// back to the idle screen without recording anything, same as pressing ข้าม.
// Either button ends the round the same way; a name is the only difference.
// The push is deliberately not awaited: a slow or dead network must never make
// the booth hang between players.
function finishRound(name){
  if(name) submitScore(name);          // local copy, so an offline booth still has a board
  // Not awaited — the booth must hand over to the next player immediately — but
  // the result still drives an honest message rather than a blanket "saved".
  pushRound(name, lastRoundReps, lastRoundPlanted).then(ok=>{
    if(!name)                  showToast('👋','ข้ามการบันทึกคะแนน','พร้อมสำหรับคนถัดไปแล้ว');
    else if(ok)                showToast('🏆','ส่งขึ้นกระดานแล้ว', name);
    else if(SCORE_SERVER)      showToast('📶','ออฟไลน์ — เก็บไว้ส่งภายหลัง', name);
    else                       showToast('💾','บันทึกในเครื่องนี้แล้ว', name);
  });
  finishSuccess(!!name);
}
lbSubmitBtn.addEventListener('click', ()=> finishRound(lbName.value.trim()));
lbSkipBtn.addEventListener('click', ()=> finishRound(''));

/* ================= idle screen ================= */
// The resting state between players: preview + leaderboard, nothing counting.
function showIdle(replay){
  sessionState = 'IDLE';
  stopSessionTimer(); stopCountdown();
  const rec = getRecord();
  idleTitle.textContent = replay ? 'จบรอบแล้ว — เล่นอีกไหม?' : 'พร้อมปลูกป่าหรือยัง?';
  idleNote.textContent = rec ? `สถิติสูงสุดของบูธตอนนี้ ${rec.count} จังหวะ` : 'ยังไม่มีสถิติของบูธ — มาเป็นคนแรกกันเลย!';
  playBtn.textContent = replay ? '▶ เล่นอีกครั้ง' : '▶ เริ่มเล่น';
  hintLine.style.display='none';
  swingMeter.style.display='none';
  timerBadge.style.display='none';
  idleOverlay.classList.add('show');
}
// Arms the round. The clock still waits for the camera to actually see someone.
function startPlaying(){
  if(sessionState !== 'IDLE') return;      // ignore double presses
  // Starting a round with no camera would just strand the player until the
  // walk-away timer fired, with nothing explaining why.
  if(!cameraAlive()){
    showCamTrouble('กล้องยังไม่พร้อม — รอสักครู่ หรือกด "รีสตาร์ทกล้อง"');
    showToast('📷','ยังเปิดกล้องไม่ได้','รอกล้องกลับมาก่อนเริ่มเล่น');
    return;
  }
  idleOverlay.classList.remove('show');
  wristL=newWristTracker(); wristR=newWristTracker();
  // Reset the walk-away clock: nobody is tracked while idling, so a stale value
  // would abort the round the instant it starts.
  lastPersonSeenTime = performance.now();
  lastRepTime = 0;
  sessionState = 'WAITING';
  hintLine.textContent=`ยืนให้เห็นหัวไหล่ถึงสะโพก แล้วโยกแขนสองข้างสลับขึ้น-ลง — จับเวลา ${SESSION_DURATION} วิทันทีที่กล้องจับตัวได้`;
  hintLine.style.display='block';
}
playBtn.addEventListener('click', ()=>{ ensureAudio(); startPlaying(); });

/* ================= rep counting: swing around a drifting centre ================= */
// Confidence of a landmark, tolerating builds that omit the field entirely.
function vis(lm){ return (lm && lm.visibility !== undefined) ? lm.visibility : 1; }

// Returns how far the wrist currently sits above (+) or below (-) the centre of
// its own swing, as a fraction of torso length. Counting a rep requires crossing
// the full dead band between -SWING_ENTER and +SWING_ENTER, so jitter around a
// stationary wrist can never flip the state: the centre simply follows it and
// the deviation stays near zero.
function processWrist(tracker, wrist, torsoLen, shoulderY, onFlip){
  // An unreliable wrist forgets its history, so an arm coming back into view
  // cannot flip straight into a rep off a stale reference.
  if(vis(wrist) < MIN_VISIBILITY){ tracker.state = 'NEUTRAL'; return 0; }

  const y = wrist.y;
  tracker.smoothY = tracker.smoothY === null ? y : tracker.smoothY + SMOOTH_ALPHA * (y - tracker.smoothY);
  tracker.baseY   = tracker.baseY   === null ? y : tracker.baseY   + BASELINE_ALPHA * (y - tracker.baseY);

  // Hands hanging at your sides sit far below this line and cannot score.
  const height = (shoulderY - tracker.smoothY) / torsoLen;
  if(height < HANDS_UP_MIN){ tracker.state = 'NEUTRAL'; return 0; }

  const dev = (tracker.baseY - tracker.smoothY) / torsoLen; // + = above the swing centre
  const flip = dir => {
    const now = performance.now();
    const brisk = (now - tracker.lastFlipAt) <= MAX_SWING_MS;
    const scored = tracker.state !== 'NEUTRAL' && tracker.state !== dir; // NEUTRAL only arms
    tracker.state = dir; tracker.lastFlipAt = now;
    if(scored && brisk) onFlip();
  };
  if(tracker.state !== 'UP' && dev > SWING_ENTER) flip('UP');
  else if(tracker.state !== 'DOWN' && dev < -SWING_ENTER) flip('DOWN');
  return dev;
}

let lastRepTime = 0;
function registerRep(){
  if(sessionState !== 'RUNNING') return;
  const now = performance.now();
  if(now - lastRepTime < REP_COOLDOWN_MS) return;
  // A pause longer than COMBO_BREAK_MS ends the run, so "คอมโบสูงสุด" means the
  // longest unbroken burst rather than just mirroring the total.
  comboStreak = (now - lastRepTime > COMBO_BREAK_MS) ? 1 : comboStreak + 1;
  lastRepTime = now;
  count += 1;
  if(comboStreak > bestCombo) bestCombo = comboStreak;
  hudCount.textContent = count; statTotal.textContent = count; statBest.textContent = bestCombo;
  // The running total is added once when the round ends, not written per rep.
  updateCommunityLine();
  playCountTone(); updateTree(); hintLine.style.display='none';
}

function processPose(landmarks){
  // IDLE still draws the skeleton preview (that happens in drawPose) but must not
  // count or start a clock — the booth waits for a deliberate press instead.
  if(sessionState === 'ENDED' || sessionState === 'IDLE'){ swingMeter.style.display='none'; return; }
  if(!landmarks){
    swingMeter.style.display='none';
    cancelCountdown();     // stepped out before the clock started
    if(sessionState==='WAITING'){ hintLine.textContent=`ยืนให้เห็นหัวไหล่ถึงสะโพก แล้วโยกแขนสองข้างสลับขึ้น-ลง — จับเวลา ${SESSION_DURATION} วิทันทีที่กล้องจับตัวได้`; hintLine.style.display='block'; }
    return;
  }
  // A body is visible: that alone is what the walk-away timer asks about. The
  // stricter quality gates below decide whether reps COUNT, but must never make
  // the booth tell a player standing in front of it that nobody is there.
  lastPersonSeenTime = performance.now();
  const shMid = { x:(landmarks[L_SH].x+landmarks[R_SH].x)/2, y:(landmarks[L_SH].y+landmarks[R_SH].y)/2 };
  const hipMid = { x:(landmarks[L_HIP].x+landmarks[R_HIP].x)/2, y:(landmarks[L_HIP].y+landmarks[R_HIP].y)/2 };
  const torsoLen = Math.hypot(shMid.x-hipMid.x, shMid.y-hipMid.y);
  if(torsoLen < 0.05){ hintLine.textContent='ถอยห่างกล้องอีกนิด ให้เห็นลำตัวชัดเจนขึ้น'; hintLine.style.display='block'; return; }

  // A torso the model is guessing at gives a bogus torsoLen, which would throw
  // off every threshold below, so wait until the trunk is actually visible.
  const torsoSure = Math.min(vis(landmarks[L_SH]), vis(landmarks[R_SH]), vis(landmarks[L_HIP]), vis(landmarks[R_HIP]));
  if(torsoSure < MIN_VISIBILITY){
    swingMeter.style.display='none';
    hintLine.textContent='ขยับให้เห็นหัวไหล่และสะโพกชัด ๆ ในกรอบกล้อง'; hintLine.style.display='block';
    return;
  }

  hintLine.style.display='none';
  swingMeter.style.display='flex';

  // Seeing a player does not start the clock straight away — a short "get ready"
  // gives them time to plant their feet and raise their hands first.
  if(sessionState === 'WAITING') startCountdown();

  const devL = processWrist(wristL, landmarks[L_WR], torsoLen, shMid.y, registerRep);
  const devR = processWrist(wristR, landmarks[R_WR], torsoLen, shMid.y, registerRep);

  // Meters read out the same number the detector uses: a bar reaches either end
  // exactly when that wrist registers a direction change, so staff can see at a
  // glance whether a swing is big enough to score.
  const meter = d => Math.max(0, Math.min(100, 50 + (d / SWING_ENTER) * 50));
  swingFillL.style.width = meter(devL) + '%';
  swingFillR.style.width = meter(devR) + '%';
}

/* ================= drawing ================= */
function drawPose(landmarks){
  ctx.clearRect(0,0,overlay.width,overlay.height);
  if(!landmarks) return;
  ctx.strokeStyle='rgba(111,227,136,0.85)'; ctx.lineWidth=4;
  POSE_CONNECTIONS.forEach(([a,b])=>{
    ctx.beginPath();
    ctx.moveTo(landmarks[a].x*overlay.width, landmarks[a].y*overlay.height);
    ctx.lineTo(landmarks[b].x*overlay.width, landmarks[b].y*overlay.height);
    ctx.stroke();
  });
  [L_SH,R_SH,L_HIP,R_HIP,L_EL,R_EL].forEach(i=>{
    ctx.beginPath(); ctx.arc(landmarks[i].x*overlay.width, landmarks[i].y*overlay.height, 4,0,Math.PI*2);
    ctx.fillStyle='#eaf4ec'; ctx.fill();
  });
  [L_WR,R_WR].forEach(i=>{
    ctx.beginPath(); ctx.arc(landmarks[i].x*overlay.width, landmarks[i].y*overlay.height, 7,0,Math.PI*2);
    ctx.fillStyle='#ffc857'; ctx.fill();
  });
}

/* ================= main loop ================= */
// True only while the webcam track is actually delivering. A unplugged or
// device-grabbed camera leaves video.srcObject in place but the track 'ended'.
function cameraAlive(){
  const s = video.srcObject;
  if(!s) return false;
  const t = s.getVideoTracks()[0];
  return !!t && t.readyState === 'live';
}

function showCamTrouble(msg){
  if(camMsg) camMsg.textContent = msg;
  if(camPlaceholder) camPlaceholder.style.display = 'flex';
}
function hideCamTrouble(){
  // Guarded: this runs every frame, and writing style unconditionally would churn
  // the DOM sixty times a second for nothing.
  if(camPlaceholder && camPlaceholder.style.display !== 'none') camPlaceholder.style.display = 'none';
}

// Brings the camera back without help from staff. Throttled so a permanently
// missing device cannot spin the machine.
async function recoverCamera(){
  if(camRecovering) return;
  const now = performance.now();
  if(now - lastCamTryAt < CAM_RETRY_MS) return;
  camRecovering = true; lastCamTryAt = now;
  showCamTrouble('กล้องหลุด — กำลังเชื่อมต่อใหม่…');
  try{
    if(video.srcObject){
      try{ video.srcObject.getTracks().forEach(t=>t.stop()); }catch(e){}
      video.srcObject = null;
    }
    await openCamera();
    loopErrors = 0;
    hideCamTrouble();
    showToast('📷','กล้องกลับมาแล้ว','เล่นต่อได้เลย');
  }catch(e){
    showCamTrouble('กล้องหลุด — ตรวจสอบสายกล้อง แล้วกด "รีสตาร์ทกล้อง"');
  }finally{
    camRecovering = false;
  }
}

// Someone pressed play then walked off, or stepped out mid-round. Hand the booth
// back to the idle screen instead of running a dead round to completion.
function abortRound(){
  stopSessionTimer(); stopCountdown();
  sessionState = 'ENDED';       // blocks any further counting during the reset
  resetRound(false);
  showToast('👋','ยกเลิกรอบนี้แล้ว','ไม่พบผู้เล่นหน้ากล้อง');
}

function loop(){
  if(!running) return;
  try{
    // A stalled camera is the dangerous case: the track still says 'live' and
    // nothing throws, so without a frame-progress check the booth would sit on a
    // frozen picture all day looking perfectly healthy.
    const stalled = (performance.now() - lastFrameAdvanceAt) > CAM_STALL_MS;
    if(!cameraAlive() || stalled){
      if(stalled) loopErrors = 0;          // it is not the detector's fault
      // Freeze the round clock: a hardware blip must not eat the player's time.
      pauseRound();
      recoverCamera();
    } else if(video.readyState >= 2){
      resumeRound();
      if(video.currentTime !== lastVideoTime){
        lastVideoTime = video.currentTime;
        lastFrameAdvanceAt = performance.now();
      }
      hideCamTrouble();
      const t0 = performance.now();
      const result = poseLandmarker.detectForVideo(video, t0);
      const t1 = performance.now();
      const frameMs = t1 - t0;
      latencyEMA = latencyEMA===null ? frameMs : latencyEMA*0.9 + frameMs*0.1;
      latencyVal.textContent = latencyEMA.toFixed(1);
      const fps = latencyEMA>0 ? Math.min(60, Math.round(1000/Math.max(latencyEMA,1))) : 0;
      fpsVal.textContent = fps;
      fpsPill.textContent = `${latencyEMA.toFixed(0)} ms/frame`;

      const landmarks = (result.landmarks && result.landmarks[0]) ? result.landmarks[0] : null;
      drawPose(landmarks);
      processPose(landmarks);
      loopErrors = 0;
    } else {
      // Camera present but not yet delivering — never leave this state silent.
      showCamTrouble('กำลังเตรียมกล้อง…');
    }

    // Give up on a round nobody is playing.
    if((sessionState === 'RUNNING' || sessionState === 'WAITING' || sessionState === 'COUNTDOWN') &&
       performance.now() - lastPersonSeenTime > ABANDON_MS){
      abortRound();
    }

    if(roundStartAt !== null){
      const secs = Math.floor(roundElapsedMs()/1000);
      statTime.textContent = Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0');
    }
  }catch(err){
    // One bad frame must never end the booth's day. Rescheduling happens below,
    // outside this catch, so the loop always survives.
    loopErrors++;
    if(loopErrors === 1 || loopErrors % 120 === 0) console.error('frame failed', err);
    if(loopErrors > 90){ loopErrors = 0; recoverCamera(); }
  }
  rafId = requestAnimationFrame(loop);
}

/* ================= lifecycle ================= */
async function initModel(){
  const { PoseLandmarker, FilesetResolver } = await import(VISION_BUNDLE);
  const filesetResolver = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  const baseConfig = { runningMode:"VIDEO", numPoses:1, minPoseDetectionConfidence:0.5, minPosePresenceConfidence:0.5, minTrackingConfidence:0.5 };
  const modelUrl = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
  try{
    poseLandmarker = await PoseLandmarker.createFromOptions(filesetResolver, { baseOptions:{ modelAssetPath:modelUrl, delegate:"GPU" }, ...baseConfig });
  }catch(e){
    console.warn('GPU delegate failed, falling back to CPU', e);
    poseLandmarker = await PoseLandmarker.createFromOptions(filesetResolver, { baseOptions:{ modelAssetPath:modelUrl, delegate:"CPU" }, ...baseConfig });
  }
}

async function openCamera(){
  const stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'user', width:{ideal:1280}, height:{ideal:720} }, audio:false });
  video.srcObject = stream;
  // Never await a metadata event unconditionally: it may already have fired, or
  // may never fire on a faulty device, and an unsettled promise would freeze the
  // booth on the loading screen with no error shown.
  await new Promise(res=>{
    if(video.readyState >= 1) return res();
    const done = ()=>{ video.removeEventListener('loadedmetadata', done); res(); };
    video.addEventListener('loadedmetadata', done);
    setTimeout(done, 6000);
  });
  try{ await video.play(); }catch(e){ /* autoplay policy: frames still decode */ }
  overlay.width  = video.videoWidth  || 1280;
  overlay.height = video.videoHeight || 720;
  // Re-arm the stall watchdog, or it would fire on the very first frame.
  lastVideoTime = -1;
  lastFrameAdvanceAt = performance.now();
}

async function startKiosk(){
  powerBtn.disabled=true; powerBtn.textContent='กำลังเตรียมกล้อง…'; powerErr.textContent='';
  try{
    if(!poseLandmarker) await initModel();
    await openCamera();
    running=true; lastPersonSeenTime=performance.now();
    hud.style.display='flex';
    powerOverlay.style.display='none';
    showIdle(false);   // land on the resting screen, not straight into a round
    loop();
  }catch(err){
    console.error(err);
    powerErr.textContent = 'เปิดกล้องไม่สำเร็จ: '+(err.message||err)+' — ตรวจสอบว่าเปิดหน้านี้ผ่าน https:// และอนุญาตกล้องแล้ว';
    powerBtn.disabled=false; powerBtn.textContent='▶ เปิดกล้อง เริ่มบูธ';
  }
}
// Staff button. Tears the stream down and back up; on failure the loop is left
// running so the automatic retry in recoverCamera() keeps trying on its own.
async function restartCamera(){
  if(camRecovering) return;
  camRecovering = true;
  showCamTrouble('กำลังรีสตาร์ทกล้อง…');
  try{
    if(video.srcObject){
      try{ video.srcObject.getTracks().forEach(t=>t.stop()); }catch(e){}
      video.srcObject = null;
    }
    await openCamera();
    loopErrors = 0; lastPersonSeenTime = performance.now();
    hideCamTrouble();
    showToast('📷','กล้องพร้อมแล้ว','เริ่มรอบใหม่ได้เลย');
  }catch(e){
    console.error('restart failed', e);
    showCamTrouble('เปิดกล้องไม่ได้ — ตรวจสอบสายกล้องแล้วลองอีกครั้ง');
  }finally{
    camRecovering = false;
    lastCamTryAt = performance.now();
    if(!running){ running = true; loop(); }   // never leave the booth stopped
  }
}
function resetRound(showToastMsg){
  // Also clears the end-of-round panel, so the staff "เริ่มรอบใหม่" button can
  // always recover a booth left waiting on a player who walked off.
  successOverlay.classList.remove('show');
  count=0; bestCombo=0; comboStreak=0; currentStage=0;
  wristL=newWristTracker(); wristR=newWristTracker();
  timeLeft=SESSION_DURATION;
  stopSessionTimer(); stopCountdown();
  timerBadge.style.display='none'; timerBadge.classList.remove('low'); timerNum.textContent=SESSION_DURATION;
  roundStartAt = null;   // stop the round clock; the last value stays on screen
  hudCount.textContent=0;
  statTotal.textContent=0; statBest.textContent=0; statTime.textContent='0:00';
  setTreeStage(0);
  progressFill.style.width='0%'; progressText.textContent='0 จังหวะ'; liveCountBig.textContent='0 จังหวะ';
  // Back to the resting screen — never straight into another round.
  showIdle(!!showToastMsg);
  // The outcome toast is raised by finishRound(), which knows whether the score
  // was actually sent, merely queued, or skipped — this one must not claim "saved".
}

powerBtn.addEventListener('click', ()=>{ ensureAudio(); startKiosk(); });
restartCamBtn.addEventListener('click', restartCamera);
resetRoundBtn.addEventListener('click', ()=> resetRound(false));
soundToggle.addEventListener('click', ()=>{
  soundOn = !soundOn;
  soundToggle.classList.toggle('on', soundOn);
  soundToggle.setAttribute('aria-checked', soundOn ? 'true' : 'false');
});

// A hidden tab stops requestAnimationFrame, so no rep can be detected and the
// round would be unwinnable. Hand it back rather than let it run out unseen.
document.addEventListener('visibilitychange', ()=>{
  if(document.hidden && (sessionState==='RUNNING' || sessionState==='COUNTDOWN' || sessionState==='WAITING')){
    abortRound();
  }
});

// Pick up scores from the other booths, but only while idle — never mid-round,
// where a network hiccup could stutter the detection loop.
if(SCORE_SERVER){
  pullState();
  setInterval(()=>{ if(sessionState === 'IDLE') pullState(); }, 5000);
}
