/* 67 Speed - the voxel island that replaces the flat SVG tree.
 *
 * The model is `buildIsland()` from the voxel-terrain set: a QR code rendered
 * as a tree canopy on a 33x33 island with a pond, shore and path. Its canopy
 * really is the QR's dark modules, so the crown doubles as a scannable code.
 *
 * SEQUENCING
 * The island ships with no timeline of its own - unlike the soil-and-seed
 * model it merges geometry by MATERIAL, not by structural part. But the merge
 * does leave one named THREE.Mesh per material, so the parts can be recovered
 * by name and driven here. Progress 0..1 is SCRUBBED onto that timeline the
 * same way the clicker game does it: the shown value is always a truthful
 * picture of how many reps have landed, never an animation playing on its own.
 *
 *   0.00  bedrock                     0.42  water + shore settle
 *   0.08  subsoil                     0.38  roots take hold
 *   0.16  topsoil                     0.46  trunk and branches grow
 *   0.24  grass + path                0.60  canopy fills in
 *                                     0.86  flowers open
 *
 * RENDERING
 * This page runs MediaPipe pose detection on the GPU, so a permanent 60fps
 * render loop would steal frames from the thing the booth actually measures.
 * The loop therefore runs ONLY while the shown value is still chasing the
 * target, and stops itself the moment it arrives.
 */
import * as THREE from 'three';
import { buildIsland, SEASONS } from './voxel-island.js';

/* The island throws unless the code is EXACTLY 25 modules (QR version 2), and
 * the window is narrow in both directions: too short drops to version 1 (21
 * modules) and too long jumps to version 3 (29). At level M this string wants
 * to be roughly 15-38 alphanumeric characters. Verified sizes:
 *     '67SPEED2026'            -> 21  (too short)
 *     '67 SPEED SCIFAIR 2026'  -> 25  (correct)
 *     'SCIFAIR 2026 67 SPEED BOOTH' -> 29  (too long)
 * If you change this, check the console: a bad length is caught and the page
 * quietly falls back to the old SVG tree. */
const QR_TEXT = '67 SPEED SCIFAIR 2026';
const SEASON  = 'cherry';

const BG        = 0xe7dcc8;   // --bg-1, the Warm Paper scene ground
const CAM_FOV   = 40;
const CAM_DIR   = [1, 0.78, 1];
const CAM_FIT   = 1.16;
const FALL      = 1.4;        // how far above its resting place a stratum starts
const EASE_K    = 5.0;

const ease  = t => 1 - Math.pow(1 - t, 3);
const seg   = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/* Each entry: [start, end] of that part's move, and how it arrives.
 * 'drop' falls into place from above; 'grow' scales up out of its own base. */
const PLAN = {
  bedrock: { at: [0.00, 0.14], how: 'drop', mats: ['bedrock_grey', 'bedrock_deep'] },
  subsoil: { at: [0.08, 0.22], how: 'drop', mats: ['subsoil_sand', 'subsoil_clay'] },
  topsoil: { at: [0.16, 0.30], how: 'drop', mats: ['topsoil_dark', 'topsoil_damp'] },
  surface: { at: [0.24, 0.40], how: 'drop', mats: ['grass_light', 'grass_mid', 'grass_deep', 'path', 'stone'] },
  water:   { at: [0.42, 0.56], how: 'grow', mats: ['water', 'shore'] },
  roots:   { at: [0.38, 0.54], how: 'grow', mats: ['root'] },
  trunk:   { at: [0.46, 0.70], how: 'grow', mats: ['bark'] },
  canopy:  { at: [0.60, 0.96], how: 'grow', mats: ['leaf_1', 'leaf_2', 'leaf_3', 'leaf_4'] },
  petal:   { at: [0.72, 1.00], how: 'grow', mats: ['petal'] },
  flower:  { at: [0.86, 1.00], how: 'grow', mats: ['flower'] },
};

let renderer, scene, camera, canvas;
let last = 0;
let parts = {};              // name -> { holder, how }
let shown = 0, target = 0, running = false, ready = false;

/** Re-origin a part so scaling grows it out of its own base rather than out of
 *  the island floor. The geometry is baked in island space, so the offset is
 *  moved from the mesh into its holder. */
function reOrigin(holder) {
  const box = new THREE.Box3().setFromObject(holder);
  if (box.isEmpty()) return;
  const base = new THREE.Vector3(
    (box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  holder.children.forEach(m => m.geometry.translate(-base.x, -base.y, -base.z));
  holder.position.copy(base);
}

export function initTree(el) {
  canvas = el;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);

  camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.01, 500);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d2c4, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(4, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);   // a sidebar thumbnail; 2048 is wasted here
  key.shadow.bias = -0.0004;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xfff4e6, 0.75);
  fill.position.set(-5, 3, -4);
  scene.add(fill);

  const { group } = buildIsland(THREE, { text: QR_TEXT, season: SEASON });
  group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // Split the per-material meshes into the parts the plan drives.
  const byMat = {};
  group.children.slice().forEach(m => { byMat[m.name] = m; });
  const stage = new THREE.Group();
  for (const [name, spec] of Object.entries(PLAN)) {
    const holder = new THREE.Group();
    holder.name = name;
    spec.mats.forEach(mat => { if (byMat[mat]) holder.add(byMat[mat]); });
    if (!holder.children.length) continue;
    if (spec.how === 'grow') reOrigin(holder);
    stage.add(holder);
    parts[name] = { holder, how: spec.how, at: spec.at, restY: holder.position.y };
  }
  // Anything the plan forgot still has to appear, or it silently vanishes.
  group.children.slice().forEach(m => stage.add(m));
  scene.add(stage);

  const box = new THREE.Box3().setFromObject(stage);
  const sph = box.getBoundingSphere(new THREE.Sphere());
  scene.userData.sphere = sph;

  apply(0);
  onResize();
  addEventListener('resize', onResize);
  addEventListener('visibilitychange', () => { if (!document.hidden) onResize(); });
  if (typeof ResizeObserver !== 'undefined') {
    scene.userData.obs = new ResizeObserver(onResize);
    scene.userData.obs.observe(canvas);
  }
  ready = true;
  renderer.render(scene, camera);
}

function onResize() {
  if (!renderer) return;
  /* Never bail before framing. The camera is positioned ONLY in here, so an
   * early return used to leave it at the origin - inside the terrain, looking
   * at nothing. Fall back to the canvas's own default box and still frame; if
   * the real size is not in yet, ask again next frame. */
  const pending = !canvas.clientWidth || !canvas.clientHeight;
  const w = canvas.clientWidth || canvas.width || 300;
  const h = canvas.clientHeight || canvas.height || 150;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  if (pending) requestAnimationFrame(onResize);

  const sph = scene.userData.sphere;
  const vFov = (camera.fov * Math.PI) / 180;
  const distV = sph.radius / Math.tan(vFov / 2);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = Math.max(distV, sph.radius / Math.tan(hFov / 2)) * CAM_FIT;
  const dir = new THREE.Vector3(...CAM_DIR).normalize();
  camera.position.copy(sph.center).add(dir.multiplyScalar(dist));
  camera.near = Math.max(dist / 100, 0.01);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(sph.center);
  if (ready) renderer.render(scene, camera);
}

/** Put every part where progress t says it should be. Pure function of t. */
function apply(t) {
  for (const p of Object.values(parts)) {
    const k = ease(seg(t, p.at[0], p.at[1]));
    if (p.how === 'drop') {
      p.holder.position.y = p.restY + (1 - k) * FALL;
      p.holder.visible = t >= p.at[0] - 0.001;
    } else {
      const s = Math.max(0.0001, k);
      p.holder.scale.set(0.7 + 0.3 * s, s, 0.7 + 0.3 * s);
      p.holder.visible = k > 0;
    }
  }
}

/** The only public control. p is 0..1; the view eases toward it.
 *  Pass immediate=true to snap - a round resetting to zero should cut back to
 *  bare bedrock, not spend five seconds un-growing in front of the next player. */
export function setTreeProgress(p, immediate = false) {
  target = clamp01(p);
  if (!ready) return;
  if (immediate) {
    shown = target; apply(shown); renderer.render(scene, camera);
    running = false; last = 0; return;
  }
  if (!running) { running = true; requestAnimationFrame(tick); }
}

function tick(now) {
  const dt = Math.min((now - (last || now)) / 1000, 0.1);
  last = now;
  const k = 1 - Math.exp(-EASE_K * dt);
  shown += (target - shown) * k;
  if (Math.abs(target - shown) < 0.0008) shown = target;
  apply(shown);
  renderer.render(scene, camera);
  // Stop the moment it arrives - this page needs the GPU for pose detection.
  if (shown === target) { running = false; last = 0; return; }
  requestAnimationFrame(tick);
}

export function treeInfo() {
  const r = renderer.info.render;
  return { progress: +shown.toFixed(3), target, running,
           drawCalls: r.calls, triangles: r.triangles,
           parts: Object.fromEntries(Object.entries(parts).map(([n, p]) =>
             [n, { visible: p.holder.visible, y: +p.holder.position.y.toFixed(3),
                   scaleY: +p.holder.scale.y.toFixed(3) }])) };
}

export { SEASONS };
