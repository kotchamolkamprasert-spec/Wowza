/* Carnival Clicker - the 3D stage.
 *
 * The stage is the "Soil & Seed" assembly from the voxel-terrain preview.
 * The important idea is unchanged from before: the sequence is SCRUBBED,
 * never played.  Progress 0..1 maps straight onto the model's own 5.6 second
 * timeline, exactly like dragging a video scrubber, so how far the build has
 * got is always a truthful picture of how many clicks have landed.
 *
 *   0.00  bedrock drops in
 *   0.08  clay
 *   0.16  sand
 *   0.24  topsoil
 *   0.38  pebbles
 *   0.45  the seed lands in its dip
 *   0.63  the sprout starts to grow
 *   0.96  fully grown (the last 4% is the model's own settle)
 *
 * Clicks move a TARGET; the shown value eases toward it every frame, so the
 * assembly visibly runs forward as people hammer the button instead of
 * snapping between poses.
 *
 * The look - lights, ground shadow, camera framing, background - is lifted
 * from the preview page (three-d-stage.js + "Soil and Seed.html") so the game
 * shows the same thing the preview does.
 */
import * as THREE from 'three';
import { buildSoilAndSeed } from './soil-seed.js';

/* ---- look, copied from the preview so the two match ------------------- */
const STAGE_BG = 0x221a13;   // Deep Soil: warm dark, same temperature as the model
const CAM_FOV  = 45;
const CAM_DIR  = [1, 0.82, 1];  // the preview's fixed isometric-leaning angle
const CAM_FIT  = 1.18;          // pull-back multiplier from the preview page
const LIFT     = 0.34;          // preview floats the group clear of the shadow

/* ---- game-side tuning -------------------------------------------------- */
const GAP      = 0.62;   // clear space between the two head-to-head models
const EASE_K   = 6.0;    // how fast the shown progress chases the target
const IDLE_SPIN = 0.30;  // rad/s while the home screen is up
const CAM_EASE = 3.2;
/* Past the finish line the bar has nowhere left to go, so the reward becomes
 * rotation: every extra click turns the model a little. Two full turns per
 * extra full bar - about 3.6 degrees a click at a 200 target. */
const OVERSPIN = 4 * Math.PI;

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

let renderer, scene, camera, clock, ground, keyLight, stageRoot;
let resizeObs = null;
let rigs = [];
let camAim = { pos: new THREE.Vector3(3, 2.2, 4), look: new THREE.Vector3() };
let camFirst = true;

/* ----------------------------------------------------------------- a rig */

/** One playfield: the soil-and-seed model plus the scrub state that drives it. */
function makeRig() {
  const { group, parts, animate, duration } = buildSoilAndSeed(THREE);

  group.traverse(o => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  const root = new THREE.Group();
  root.add(group);
  group.position.y += LIFT;

  const rig = {
    root, group, parts, animate, duration,
    target: 0, shown: 0, idle: false, spin: 0,
    over: 0, overspin: 0,     // clicks past the finish line, and the turn they earn
    /* The model's rest pose, measured once. The camera frames THIS rather than
     * the live bounds: mid-assembly the slabs are still 1.9 units up in the
     * air, and framing that would make the camera lurch on every click. */
    restBox: null,
  };

  animate(duration);
  rig.restBox = new THREE.Box3().setFromObject(group);
  animate(0);
  return rig;
}

/* -------------------------------------------------------------- the API */

export function initScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(STAGE_BG);

  camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.01, 500);
  camera.position.set(3, 2.2, 4);

  // Neutral studio, straight from the preview: soft sky/ground wash, one
  // shadow-casting key, and a dim warm fill so silhouettes never go black.
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d2c4, 1.0));
  keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
  keyLight.position.set(4, 7, 5);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.bias = -0.0002;
  scene.add(keyLight);
  const fill = new THREE.DirectionalLight(0xfff4e6, 0.8);
  fill.position.set(-5, 3, -4);
  scene.add(fill);

  // A shadow-only plane: it catches the drop shadow without painting a disc
  // of its own colour over the background.
  ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ opacity: 0.18 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  stageRoot = new THREE.Group();
  scene.add(stageRoot);

  clock = new THREE.Clock();
  onResize();
  addEventListener('resize', onResize);
  /* A hidden tab gets no resize and no ResizeObserver delivery, so a kiosk
   * that was minimised while the screen changed size comes back with a
   * stale drawing buffer. Re-measure on the way back in. */
  addEventListener('visibilitychange', () => { if (!document.hidden) onResize(); });
  if (typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(onResize);
    resizeObs.observe(renderer.domElement);
  }
  renderer.setAnimationLoop(frame);
}

function onResize() {
  if (!renderer) return;
  /* The canvas sits inside the kiosk's left panel, so its own box is the only
   * honest source of size. setSize's third arg stays false: CSS owns the
   * display size, this only matches the drawing buffer to it. */
  const el = renderer.domElement;
  const w = el.clientWidth || innerWidth, h = el.clientHeight || innerHeight;
  if (!w || !h) { requestAnimationFrame(onResize); return; }
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  frameCamera();
}

/** Geometry is procedural, so there is nothing to fetch - but game.js awaits
 *  this, and keeping it means the boot sequence did not have to change. */
export async function preloadModel() { return true; }

/** Lay out the stage: 1 rig for solo and co-op, 2 side by side for versus. */
export function setupTracks(count) {
  for (const rig of rigs) stageRoot.remove(rig.root);
  rigs = [];

  for (let i = 0; i < count; i++) rigs.push(makeRig());

  if (count === 1) {
    rigs[0].root.position.x = 0;
  } else {
    // Space them off their real width rather than a guessed constant.
    const w = rigs[0].restBox.getSize(new THREE.Vector3()).x;
    const dx = (w + GAP) / 2;
    rigs[0].root.position.x = -dx;
    rigs[1].root.position.x = dx;
  }

  for (const rig of rigs) {
    rig.root.scale.setScalar(count === 1 ? 1.0 : 0.86);
    stageRoot.add(rig.root);
  }
  frameCamera();
}

/** Move a track's target. The frame loop eases toward it.
 *  p may exceed 1: the assembly stops at its rest pose, and the surplus spins
 *  the model instead of being thrown away. */
export function setProgress(i, p) {
  const rig = rigs[i];
  if (!rig) return;
  rig.target = clamp01(p);
  rig.over = Math.max(0, p - 1);
}

export function setIdleSpin(on) {
  for (const rig of rigs) rig.idle = on;
}

/* ------------------------------------------------------------ the frame */

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);

  for (const rig of rigs) {
    // Frame-rate independent easing: the same visual speed at 30fps and 144.
    const k = 1 - Math.exp(-EASE_K * dt);
    rig.shown += (rig.target - rig.shown) * k;
    if (Math.abs(rig.target - rig.shown) < 0.0005) rig.shown = rig.target;
    rig.animate(rig.shown * rig.duration);

    if (rig.idle) rig.spin += IDLE_SPIN * dt;
    else rig.spin *= (1 - Math.min(1, dt * 2));   // unwind, do not snap

    // Eased, so a burst of surplus clicks reads as one smooth turn.
    rig.overspin += (rig.over * OVERSPIN - rig.overspin) * k;
    rig.root.rotation.y = rig.spin + rig.overspin;
  }

  // Damped camera move, so a mode change glides instead of cutting.
  const ck = camFirst ? 1 : 1 - Math.exp(-CAM_EASE * dt);
  camFirst = false;
  camera.position.lerp(camAim.pos, ck);
  camera.lookAt(camAim.look);

  renderer.render(scene, camera);
}

/** Pull the camera back until every rig fits, using the preview's angle.
 *  A booth screen is 16:9 but a windowed test is not, so this is computed
 *  from the live aspect rather than trusting a fixed distance. */
function frameCamera() {
  if (!renderer || !rigs.length) return;

  /* Built from position and scale only - the idle spin is deliberately left
   * out, or the camera would creep in and out as the model turned. */
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  const noRot = new THREE.Quaternion();
  for (const rig of rigs) {
    m.compose(rig.root.position, noRot, rig.root.scale);
    box.union(rig.restBox.clone().applyMatrix4(m));
  }
  if (box.isEmpty()) return;

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const vFov = (camera.fov * Math.PI) / 180;
  // Fit vertically, then widen for a narrow viewport - otherwise a portrait
  // window crops the models off at the sides.
  const distV = sphere.radius / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const distH = sphere.radius / Math.tan(hFov / 2);
  const dist = Math.max(distV, distH) * CAM_FIT;

  const dir = new THREE.Vector3(...CAM_DIR).normalize();
  camAim.pos.copy(sphere.center).add(dir.multiplyScalar(dist));
  camAim.look.copy(sphere.center);

  camera.near = Math.max(dist / 100, 0.01);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();

  ground.position.y = box.min.y;
  const span = sphere.radius * 3;
  keyLight.shadow.camera.left = -span;
  keyLight.shadow.camera.right = span;
  keyLight.shadow.camera.top = span;
  keyLight.shadow.camera.bottom = -span;
  keyLight.shadow.camera.updateProjectionMatrix();
}

/* ------------------------------------------------------- diagnostics */

/** Snap every rig and the camera to their settled pose, so a still or a
 *  measurement shows the finished picture rather than a half-eased one. */
function settle() {
  for (const rig of rigs) {
    rig.shown = rig.target;
    rig.overspin = rig.over * OVERSPIN;
    rig.root.rotation.y = rig.spin + rig.overspin;
    rig.animate(rig.shown * rig.duration);
  }
  frameCamera();
  camera.position.copy(camAim.pos);
  camera.lookAt(camAim.look);
}

/** Render cost and draw calls for the current scene.  Worth having on a booth
 *  machine: if the frame rate is poor on the day this says whether it is the
 *  geometry or something else. */
export function perf(frames = 90) {
  settle();
  renderer.render(scene, camera);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) renderer.render(scene, camera);
  const ms = (performance.now() - t0) / frames;
  const r = renderer.info.render;
  return { msPerFrame: +ms.toFixed(2), fpsHeadroom: Math.round(1000 / ms),
           drawCalls: r.calls, triangles: r.triangles };
}

/** Force one render and return it as a PNG data URL.
 *  Used by the diagnostics hook and handy when a booth screen looks wrong. */
export function snapshot() {
  settle();
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}

/** The live rigs, for diagnostics and tests. */
export function models() {
  return rigs.map(r => ({
    progress: r.shown, target: r.target,
    over: +r.over.toFixed(3), spinDeg: +(r.overspin * 180 / Math.PI).toFixed(1),
    t: +(r.shown * r.duration).toFixed(2), duration: r.duration,
    sproutScale: +r.parts.sprout.scale.y.toFixed(3),
    parts: Object.fromEntries(Object.entries(r.parts).map(
      ([k, g]) => [k, { visible: g.visible, y: +g.position.y.toFixed(3) }])),
  }));
}

export function artworkProgress() { return { done: 1, total: 1 }; }
export function usingAuthoredModel() { return true; }
export function usingTree() { return false; }
