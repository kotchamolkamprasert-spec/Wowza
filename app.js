// MediaPipe is pulled in via dynamic import() inside initModel() rather than a
// top-level `import`, so this file can load as a classic script. A module script
// cannot be fetched over file:// (no CORS headers), which would stop the whole
// booth from starting when index.html is opened by double-clicking it.
const VISION_BUNDLE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

/* ================= config ================= */
const TREE_STAGE_NEEDS = [0, 10, 25, 50, 100, 125]; // reps needed for each visual growth stage (no labels/levels shown to player)
const TREE_MAX = TREE_STAGE_NEEDS[TREE_STAGE_NEEDS.length - 1];
const SESSION_DURATION = 20; // seconds — tree grows live while you do the 67 move
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
const SWING_ENTER    = 0.12;  // travel past the swing centre needed to register a direction change
const HANDS_UP_MIN   = -0.85; // wrist height vs the shoulder line (0 = shoulders, -1 is about hip level)
const MIN_VISIBILITY = 0.60;  // landmark confidence required before a joint is trusted
const BASELINE_ALPHA = 0.02;  // how fast the swing centre follows the wrist — slow, so it averages out the swing
const SMOOTH_ALPHA   = 0.50;  // denoising of the raw wrist position — kept light, since heavy
                              // smoothing shrinks fast swings more than slow ones
const REP_COOLDOWN_MS = 100;  // a backstop only — the dead band above already blocks rapid
                              // re-triggering, so this stays clear of a fast player's real rate
const SUCCESS_HOLD_MS = 10000;

/* ================= state ================= */
let poseLandmarker = null;
let running = false;
let rafId = null;
let count = 0, bestCombo = 0, comboStreak = 0, currentStage = 0;
let startTime = null;
let soundOn = true;
let audioCtx = null;
let lastPersonSeenTime = performance.now();
let latencyEMA = null;
let treesPlantedToday = Number(localStorage.getItem('t67p_treesToday') || 0);
let communityTotal = Number(localStorage.getItem('t67p_communityTotal') || 0);

// timed 20-second challenge session
let sessionState = 'WAITING'; // WAITING -> RUNNING -> ENDED
let timeLeft = SESSION_DURATION;
let sessionTimerInterval = null;

// per-wrist adaptive extremum + hysteresis state
function newWristTracker(){ return { smoothY:null, baseY:null, state:'NEUTRAL' }; }
let wristL = newWristTracker();
let wristR = newWristTracker();

/* ================= DOM ================= */
const $ = id => document.getElementById(id);
const video=$('video'), overlay=$('overlay'), ctx=overlay.getContext('2d');
const powerOverlay=$('power-overlay'), powerBtn=$('powerBtn'), powerErr=$('powerErr');
const hud=$('hud'), hudCount=$('hudCount'), hudRecord=$('hudRecord');
const latencyVal=$('latencyVal'), fpsVal=$('fpsVal'), fpsPill=$('fpsPill');
const hintLine=$('hintLine'), swingMeter=$('swingMeter'), swingFillL=$('swingFillL'), swingFillR=$('swingFillR');
const timerBadge=$('timerBadge'), timerNum=$('timerNum');
const successOverlay=$('successOverlay'), successEmoji=$('successEmoji'), successTitle=$('successTitle'), successDesc=$('successDesc'), successCount=$('successCount'), lbName=$('lbName'), lbSubmitBtn=$('lbSubmitBtn'), lbSkipBtn=$('lbSkipBtn');
const liveCountBig=$('liveCountBig'), progressFill=$('progressFill'), progressText=$('progressText');
const statTotal=$('statTotal'), statBest=$('statBest'), statTime=$('statTime'), statTrees=$('statTrees');
const communityTotalEl=$('communityTotal'), soundToggle=$('soundToggle'), toastZone=$('toast-zone');
const treeGroups=document.querySelectorAll('.tree-group');
const restartCamBtn=$('restartCamBtn'), resetRoundBtn=$('resetRoundBtn'), lbList=$('lbList');

statTrees.textContent = treesPlantedToday;
communityTotalEl.textContent = `${communityTotal} จังหวะ · ปลูกสำเร็จ ${treesPlantedToday} ต้น`;
setTreeStage(0); renderLeaderboard();

function setTreeStage(stage){
  treeGroups.forEach(g=>g.classList.toggle('active', Number(g.dataset.stage)===stage));
}

/* ================= leaderboard (local only) ================= */
function getLeaderboard(){ try{ return JSON.parse(localStorage.getItem('t67p_leaderboard')||'[]'); }catch(e){ return []; } }
function getRecord(){ const b = getLeaderboard(); return b.length ? b[0] : null; }
function renderLeaderboard(){
  const board = getLeaderboard();
  if(board.length===0){
    lbList.innerHTML = '<div class="lb-empty">ยังไม่มีใครส่งคะแนน — เล่นให้จบรอบเพื่อขึ้นบอร์ด!</div>';
    hudRecord.textContent = 'ยังไม่มี';
    return;
  }
  lbList.innerHTML = board.slice(0,5).map((e,i)=>
    `<div class="lb-row"><span class="rk">#${i+1}</span><span class="nm">${escapeHtml(e.name||'ผู้เล่นนิรนาม')}</span><span class="sc num">${e.count}</span></div>`
  ).join('');
  hudRecord.textContent = `${board[0].count} จังหวะ`;
}
function escapeHtml(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function submitScore(name){
  const board = getLeaderboard();
  board.push({ name: (name||'').trim().slice(0,16), count, ts: Date.now() });
  board.sort((a,b)=> b.count - a.count);
  localStorage.setItem('t67p_leaderboard', JSON.stringify(board.slice(0,10)));
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
  progressFill.style.width = pct + '%';
  progressText.textContent = `${count} จังหวะ`;
  liveCountBig.textContent = `${count} จังหวะ`;
}

let successTimer=null;

function startSessionTimer(){
  sessionState = 'RUNNING';
  timeLeft = SESSION_DURATION;
  timerBadge.classList.remove('low');
  updateTimerDisplay();
  if(sessionTimerInterval) clearInterval(sessionTimerInterval);
  sessionTimerInterval = setInterval(()=>{
    timeLeft -= 1;
    updateTimerDisplay();
    if(timeLeft <= 0){
      clearInterval(sessionTimerInterval);
      if(sessionState === 'RUNNING') endSession('TIMEUP');
    }
  }, 1000);
}
function updateTimerDisplay(){
  timerNum.textContent = Math.max(0, timeLeft);
  timerBadge.classList.toggle('low', timeLeft <= 5);
}

function endSession(reason){
  if(sessionState === 'ENDED') return;
  sessionState = 'ENDED';
  if(sessionTimerInterval) clearInterval(sessionTimerInterval);
  timerBadge.style.display = 'none';

  const record = getRecord();
  const isNewRecord = count > 0 && (!record || count > record.count);

  if(count >= TREE_MAX){
    treesPlantedToday += 1;
    localStorage.setItem('t67p_treesToday', treesPlantedToday);
    statTrees.textContent = treesPlantedToday;
    communityTotalEl.textContent = `${communityTotal} จังหวะ · ปลูกสำเร็จ ${treesPlantedToday} ต้น`;
  }

  successEmoji.textContent = isNewRecord ? '🏆🌲' : '⏱️🌳';
  successTitle.textContent = 'หมดเวลา 20 วินาที!';
  successDesc.innerHTML = `ทำได้ <b class="num" id="successCount">${count}</b> จังหวะ`
    + (isNewRecord ? ` — <b style="color:var(--gold)">ทำลายสถิติสูงสุดของบูธนี้!</b> 🎉` : record ? ` — สถิติสูงสุดของบูธตอนนี้คือ <b class="num">${record.count}</b> จังหวะ ลองเอาชนะดูใหม่!` : ` — เป็นคนแรกที่ตั้งสถิติของบูธนี้!`)
    + ` ส่งคะแนนขึ้นกระดานได้เลย (ไม่ส่งข้อมูลออกนอกเครื่อง)`;

  lbName.value = '';
  successOverlay.classList.add('show');
  successTimer = setTimeout(()=> finishSuccess(false), SUCCESS_HOLD_MS);
}
function finishSuccess(submitted){
  clearTimeout(successTimer);
  successOverlay.classList.remove('show');
  resetRound(true);
}
lbSubmitBtn.addEventListener('click', ()=>{ submitScore(lbName.value); finishSuccess(true); });
lbSkipBtn.addEventListener('click', ()=> finishSuccess(false));

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
  if(tracker.state !== 'UP' && dev > SWING_ENTER){
    const wasDown = tracker.state === 'DOWN';
    tracker.state = 'UP';
    if(wasDown) onFlip();   // NEUTRAL -> UP is only arming, never a rep
  } else if(tracker.state !== 'DOWN' && dev < -SWING_ENTER){
    const wasUp = tracker.state === 'UP';
    tracker.state = 'DOWN';
    if(wasUp) onFlip();
  }
  return dev;
}

let lastRepTime = 0;
function registerRep(){
  if(sessionState !== 'RUNNING') return;
  const now = performance.now();
  if(now - lastRepTime < REP_COOLDOWN_MS) return;
  lastRepTime = now;
  count += 1; comboStreak += 1;
  if(comboStreak > bestCombo) bestCombo = comboStreak;
  hudCount.textContent = count; statTotal.textContent = count; statBest.textContent = bestCombo;
  communityTotal += 1; localStorage.setItem('t67p_communityTotal', communityTotal);
  communityTotalEl.textContent = `${communityTotal} จังหวะ · ปลูกสำเร็จ ${treesPlantedToday} ต้น`;
  playCountTone(); updateTree(); hintLine.style.display='none';
}

function processPose(landmarks){
  if(sessionState === 'ENDED'){ swingMeter.style.display='none'; return; }
  if(!landmarks){
    swingMeter.style.display='none';
    if(sessionState==='WAITING'){ hintLine.textContent='ยืนให้เห็นหัวไหล่ถึงสะโพก แล้วโยกแขนสองข้างสลับขึ้น-ลง — จับเวลา 20 วิทันทีที่กล้องจับตัวได้'; hintLine.style.display='block'; }
    return;
  }
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

  lastPersonSeenTime = performance.now();
  hintLine.style.display='none';
  swingMeter.style.display='flex';

  if(sessionState === 'WAITING'){
    timerBadge.style.display='flex';
    startSessionTimer();
  }

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
function loop(){
  if(!running) return;
  if(video.readyState >= 2){
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
  }
  if(startTime){
    const secs = Math.floor((Date.now()-startTime)/1000);
    statTime.textContent = Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0');
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
  await new Promise(res=>{ video.onloadedmetadata=()=>{ video.play(); res(); }; });
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
}

async function startKiosk(){
  powerBtn.disabled=true; powerBtn.textContent='กำลังเตรียมกล้อง…'; powerErr.textContent='';
  try{
    if(!poseLandmarker) await initModel();
    await openCamera();
    running=true; startTime=Date.now(); lastPersonSeenTime=performance.now();
    hud.style.display='flex'; hintLine.style.display='block';
    powerOverlay.style.display='none';
    loop();
  }catch(err){
    console.error(err);
    powerErr.textContent = 'เปิดกล้องไม่สำเร็จ: '+(err.message||err)+' — ตรวจสอบว่าเปิดหน้านี้ผ่าน https:// และอนุญาตกล้องแล้ว';
    powerBtn.disabled=false; powerBtn.textContent='▶ เปิดกล้อง เริ่มบูธ';
  }
}
async function restartCamera(){
  running=false; if(rafId) cancelAnimationFrame(rafId);
  if(video.srcObject){ video.srcObject.getTracks().forEach(t=>t.stop()); video.srcObject=null; }
  try{ await openCamera(); running=true; lastPersonSeenTime=performance.now(); loop(); }catch(e){ console.error('restart failed', e); }
}
function resetRound(showToastMsg){
  count=0; bestCombo=0; comboStreak=0; currentStage=0;
  wristL=newWristTracker(); wristR=newWristTracker();
  sessionState='WAITING'; timeLeft=SESSION_DURATION;
  if(sessionTimerInterval) clearInterval(sessionTimerInterval);
  timerBadge.style.display='none'; timerBadge.classList.remove('low'); timerNum.textContent=SESSION_DURATION;
  startTime = running ? Date.now() : null;
  hudCount.textContent=0;
  statTotal.textContent=0; statBest.textContent=0; statTime.textContent='0:00';
  setTreeStage(0);
  progressFill.style.width='0%'; progressText.textContent='0 จังหวะ'; liveCountBig.textContent='0 จังหวะ';
  hintLine.textContent='ยืนให้เห็นหัวไหล่ถึงสะโพก แล้วโยกแขนสองข้างสลับขึ้น-ลง — จับเวลา 20 วิทันทีที่กล้องจับตัวได้'; hintLine.style.display='block';
  if(showToastMsg){ showToast('👋','พร้อมสำหรับคนถัดไปแล้ว','ยืนหน้ากล้องเพื่อเริ่มรอบใหม่'); }
}

powerBtn.addEventListener('click', ()=>{ ensureAudio(); startKiosk(); });
restartCamBtn.addEventListener('click', restartCamera);
resetRoundBtn.addEventListener('click', ()=> resetRound(false));
soundToggle.addEventListener('click', ()=>{ soundOn=!soundOn; soundToggle.classList.toggle('on', soundOn); });
