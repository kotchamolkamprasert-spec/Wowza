/* Carnival Clicker - the 3D stage.
 *
 * The important idea: the model is SCRUBBED, never played.  Progress 0..1 maps
 * straight onto the animation, exactly like dragging a video scrubber, so the
 * build-up is always a truthful picture of how many clicks have landed.
 *
 * Two backends, same interface:
 *   GltfModel  - a real authored clip, scrubbed with mixer.setTime()
 *   TowerModel - a procedural stand-in so the game is playable before the
 *                artwork exists.  Drop a .glb in and it is used instead.
 */
import * as THREE from 'three';
import { GLTFLoader } from './vendor/three/loaders/GLTFLoader.js';
import { OBJLoader } from './vendor/three/loaders/OBJLoader.js';
import * as BufferGeometryUtils from './vendor/three/utils/BufferGeometryUtils.js';

const EASE = t => 1 - Math.pow(1 - t, 3);
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

let renderer, scene, camera, clock;
let rigs = [];                 // one per track
let ambientSpin = 0;
let camLook = 1.4;
const TRACK_X = 2.1;   // half the gap between the two models
const SOIL_TOP = 0.42;   // y of the topsoil surface in the glb
const SOIL_DEPTH = 1.18; // how far the block extends below its origin
//: top of a grown tree in world space: lift + soil surface + tree height
const GROWN_TOP = SOIL_DEPTH + SOIL_TOP + 2.03;
const BACK = t => {    // ease-out-back: a satisfying settle at full growth
  const c = 1.70158, u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

/* ------------------------------------------------------------- backends */

class GltfModel {
  constructor(gltf) {
    this.root = gltf.scene;
    this.mixer = new THREE.AnimationMixer(gltf.scene);
    this.clip = gltf.animations[0] || null;
    if (this.clip) {
      // The action must be "playing" for setTime to have anything to act on,
      // but we never call mixer.update(dt) - setTime alone drives it.
      this.mixer.clipAction(this.clip).play();
      this.mixer.setTime(0);
    }
  }
  setProgress(p) {
    if (this.clip) this.mixer.setTime(clamp01(p) * this.clip.duration);
  }
  tick() {}
}

class TowerModel {
  /* A prize tower that assembles itself: chunks fly in from scattered
   * positions and lock into a stack, then a star lights on top. */
  constructor(tint) {
    this.root = new THREE.Group();
    this.pieces = [];
    this.N = 11;

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.75, .35, 48),
      new THREE.MeshStandardMaterial({ color: 0x241f3d, roughness: .75, metalness: .25 }));
    base.position.y = -.18;
    base.receiveShadow = true;
    this.root.add(base);

    for (let i = 0; i < this.N; i++) {
      const t = i / (this.N - 1);
      const r = 1.28 * (1 - t * .62);
      const h = .30;
      const geo = new THREE.CylinderGeometry(r * .88, r, h, 6, 1);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(tint).lerp(new THREE.Color(0xffffff), t * .45),
        roughness: .28, metalness: .55,
        emissive: new THREE.Color(tint), emissiveIntensity: 0,
      });
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;

      const a = i * 2.399;                     // golden-angle scatter
      this.pieces.push({
        mesh: m,
        home: new THREE.Vector3(0, .18 + i * h * 1.02, 0),
        away: new THREE.Vector3(Math.cos(a) * 3.5, .5 + i * .42, Math.sin(a) * 3.5),
        spin: (i % 2 ? 1 : -1) * (1.6 + i * .22),
      });
      this.root.add(m);
    }

    const star = new THREE.Mesh(
      new THREE.OctahedronGeometry(.46, 0),
      new THREE.MeshStandardMaterial({
        color: 0xffd77a, emissive: 0xffc857, emissiveIntensity: 1.4,
        roughness: .2, metalness: .8 }));
    star.position.y = .18 + this.N * .30 * 1.02 + .42;
    star.scale.setScalar(0);
    this.root.add(star);
    this.star = star;
    this.p = 0;
  }

  setProgress(p) {
    this.p = clamp01(p);
    const n = this.N;
    for (let i = 0; i < n; i++) {
      const pc = this.pieces[i];
      // each piece lands over its own slice of the bar, with overlap so the
      // motion is continuous rather than a staircase
      const k = EASE(clamp01((this.p * n * 1.25) - i * 1.0));
      pc.mesh.position.lerpVectors(pc.away, pc.home, k);
      pc.mesh.rotation.y = (1 - k) * pc.spin;
      pc.mesh.rotation.z = (1 - k) * pc.spin * .35;
      pc.mesh.scale.setScalar(.35 + .65 * k);
      pc.mesh.material.opacity = k;
      pc.mesh.material.emissiveIntensity = k * .22;
    }
    const s = EASE(clamp01((this.p - .88) / .12));
    this.star.scale.setScalar(s * 1.0);
  }

  tick(dt, t) {
    this.star.rotation.y += dt * 1.4;
    this.star.position.y += Math.sin(t * 2.2) * dt * .12;
    if (this.p >= 1) this.root.rotation.y += dt * .55;
  }
}

/* The artwork: a soil cross-section with a seed, and a voxel cherry tree.
 *
 * Neither file carries an animation - the glb exported geometry only - but the
 * meshes are named, which is all we need.  Progress drives the parts directly:
 * the sprout pushes up out of the topsoil, the seed is spent, then the tree
 * takes over and blooms.  Scrubbing it backwards un-grows it exactly.
 */

/* The stage files name their parts differently as they grow - "trunk" becomes
 * "t7_trunk", "blossom_pink" becomes "compB_blossom_pink", and the forests use
 * "foliage_main" instead.  None of them ship a .mtl, so colour is chosen by
 * matching the meaningful part of the name.  Order matters: the most specific
 * pattern has to win. */
/* One green family, walked down in value.  The canopy is deliberately deeper
 * than the terrain: in daylight a tree crown really is darker than the grass
 * around it, and the contrast is what makes a forest read as trees rather than
 * a flat green mat.  Terrain shares a single colour so the ground never looks
 * patched together. */
const GREEN = {
  canopyDark:  0x14401f,   // undersides and shadowed clumps
  canopyMain:  0x1f5d2e,   // the bulk of every crown
  canopyLight: 0x38874a,   // sunlit tops
  terrain:     0x448038,   // grass and ground, one value
};

const TINTS = [
  // cherry blossom, on the early stages only
  ['blossom_pink_dark', 0xc9648f],
  ['blossom_white',     0xfae9f0],
  ['blossom_pink',      0xe58cb4],
  // forest canopy
  ['foliage_dark',      GREEN.canopyDark],
  ['foliage_light',     GREEN.canopyLight],
  ['foliage_main',      GREEN.canopyMain],
  // the creatures that turn up in the later stages
  ['camel_hump',        0xbb9058],
  ['camel_leg',         0xa8804c],
  ['camel_neck',        0xc49a64],
  ['camel_head',        0xcaa26c],
  ['camel_body',        0xc9a06a],
  ['bird_beak',         0xe8a33d],
  ['bird_leg',          0xc98a2e],
  ['bird_tail',         0x3f4459],
  ['bird_head',         0x5f6885],
  ['bird_body',         0xeef1f7],
  // wood, earth and water
  ['trunk',             0x6b4a2c],
  ['bark',              0x6b4a2c],
  ['seed',              0x8a5a2c],
  ['water',             0x3f86bd],
  ['grass',             GREEN.terrain],
  ['ground',            GREEN.terrain],
  ['soil',              0x5d4127],
];

/* Parts that make up the land itself.  Everything else - trunks, foliage,
 * blossom, the seed, the bird, the camel - grows up out of it, and is animated
 * separately so a new stage sprouts rather than cross-fading into place. */
const TERRAIN_PARTS = ['grass', 'ground', 'soil', 'water'];

function isTerrain(name) {
  return TERRAIN_PARTS.some(t => name.includes(t));
}

function tintFor(name) {
  for (const [needle, hex] of TINTS) if (name.includes(needle)) return hex;
  return 0x9aa0a6;
}

/** Collapse a voxel pile into one mesh per colour - 266 meshes is 266 draw
 *  calls per player, which is not worth paying for blocks that never move. */
function mergeByKind(group) {
  const buckets = new Map();
  group.updateMatrixWorld(true);
  group.traverse(o => {
    if (!o.isMesh) return;
    const hex = tintFor(o.name);
    const key = hex + (isTerrain(o.name) ? '|t' : '|f');
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(geo);
  });

  const out = new THREE.Group();
  const terrain = new THREE.Group(); terrain.name = 'terrain';
  const flora = new THREE.Group();   flora.name = 'flora';
  out.add(terrain, flora);

  const made = [];
  for (const [key, geos] of buckets) {
    const [hexStr, side] = key.split('|');
    let geo = null;
    try { geo = BufferGeometryUtils.mergeGeometries(geos, false); } catch { geo = null; }
    const mat = new THREE.MeshStandardMaterial({
      color: Number(hexStr), roughness: .85, metalness: .02,
      transparent: true, opacity: 1,
    });
    for (const g of (geo ? [geo] : geos)) {
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      if (side === 't') m.receiveShadow = true;
      (side === 't' ? terrain : flora).add(m);
      made.push(m);
    }
  }

  // Stand the stage on y = 0 and centre it on the origin, baked into the
  // geometry rather than the group transform.  The flora group has to scale
  // upward from ground level, and it can only do that if ground level is zero
  // in its own coordinates.
  const box = new THREE.Box3().setFromObject(out);
  const dx = (box.min.x + box.max.x) / 2, dz = (box.min.z + box.max.z) / 2;
  const dy = box.min.y;
  for (const m of made) m.geometry.translate(-dx, -dy, -dz);
  return out;
}

/** Wrap an object so it scales from a chosen height instead of its origin. */
function pivotAt(obj, y) {
  const pivot = new THREE.Group();
  pivot.position.y = y;
  obj.position.y -= y;
  pivot.add(obj);
  return pivot;
}

/* The eight .obj files are a growth sequence: one cherry tree, then a few, then
 * a forest of sixteen.  Their footprint goes from 2.9 to over 12 units, so each
 * stage is normalised to a target width that grows only gently - otherwise the
 * forest would dwarf the soil block it is supposed to be growing out of. */
const STAGE_FILES = [
  'cherry-blossom-voxel-tree.obj',
  'cherry-blossom-voxel-tree2.obj',
  'cherry-blossom-voxel-tree3.obj',
  'voxel-forest4.obj',
  'voxel-forest5.obj',
  'voxel-forest6.obj',
  'voxel-forest7.obj',
  'voxel-forest8.obj',
];
const STAGE_W0 = 2.4;    // on-screen width of the first tree
const STAGE_W1 = 5.4;    // ...and of the full forest
const SPROUT_END = 0.16; // progress at which the seedling hands over

class GardenModel {
  constructor(soil, stages) {
    this.root = new THREE.Group();
    this.stages = stages;              // shared, may still be filling up
    this.p = 0;
    this.pTarget = 0;
    this.width = STAGE_W0;
    this.height = 2.0;

    soil.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      o.material = o.material.clone();
      o.material.transparent = true;
    });
    // Only the glb needs lifting: it is centred on its own origin so half the
    // block would be underground.  The stage files already stand on y = 0, and
    // lifting the whole rig would put the camera framing out by that much.
    soil.position.y = SOIL_DEPTH;
    this.root.add(soil);
    this.soil = soil;
    this.seed = soil.getObjectByName('seed');
    const sprout = soil.getObjectByName('sprout');
    this.sprout = sprout ? pivotAt(sprout, SOIL_TOP + SOIL_DEPTH) : null;
    if (this.sprout) this.root.add(this.sprout);

    // one pivot per stage; geometry is shared between players, materials are not
    this.slots = stages.map(st => {
      const g = st.group.clone(true);
      g.traverse(o => { if (o.isMesh) o.material = o.material.clone(); });
      const pivot = pivotAt(g, 0);
      pivot.visible = false;
      this.root.add(pivot);
      return { pivot, natural: st.width, tall: st.height,
               terrain: g.getObjectByName('terrain'),
               flora: g.getObjectByName('flora') };
    });
    this.settle();
  }

  /* k    - overall scale of the stage
     fade - opacity, used to retire the outgoing stage
     grow - how far the flora has risen out of the ground, 0..1 */
  _showStage(i, k, fade, grow = 1, floraFade = fade) {
    const slot = this.slots[i];
    if (!slot) return;
    const target = STAGE_W0 + (STAGE_W1 - STAGE_W0) * (i / Math.max(1, this.slots.length - 1));
    const fit = target / slot.natural;
    slot.pivot.visible = k > 0.01;
    slot.pivot.scale.setScalar(Math.max(0.0001, fit * k));

    if (slot.terrain) {
      slot.terrain.traverse(o => { if (o.isMesh) o.material.opacity = fade; });
    }
    if (slot.flora) {
      // Trees rise out of the ground instead of fading in on top of it.
      const g = Math.max(0.0001, grow);
      slot.flora.scale.set(0.86 + 0.14 * g, g, 0.86 + 0.14 * g);
      slot.flora.visible = g > 0.02;
      slot.flora.traverse(o => { if (o.isMesh) o.material.opacity = floraFade; });
    }
    if (k > 0.5) {
      this.width = target;
      this.height = slot.tall * fit;
    }
  }

  setProgress(p) {
    this.pTarget = clamp01(p);
    if (this.p === undefined) { this.p = this.pTarget; this._apply(this.p); }
  }

  /** Jump straight to the target - used for stills and for a fresh round. */
  settle() {
    this.p = this.pTarget ?? 0;
    this._apply(this.p);
  }

  _apply(P) {

    if (this.sprout) {
      const g = EASE(clamp01(P / SPROUT_END));
      const gone = clamp01((P - SPROUT_END) / 0.08);
      this.sprout.scale.set(0.6 + 0.4 * g, Math.max(0.0001, g * (1 - gone)), 0.6 + 0.4 * g);
      this.sprout.visible = g > 0.01 && gone < 0.99;
    }
    if (this.seed) {
      const spent = clamp01((P - 0.05) / 0.14);
      this.seed.scale.setScalar(1 - 0.6 * spent);
      this.seed.traverse(o => { if (o.isMesh) o.material.opacity = 1 - 0.9 * spent; });
      this.seed.visible = spent < 0.99;
    }

    // The glb is an underground cross-section; every stage file carries its own
    // above-ground terrain.  Showing both means two grounds fighting, so the
    // cross-section bows out as the first tree arrives.
    const handover = clamp01((P - SPROUT_END) / 0.10);
    if (handover < 0.5) {                    // still the cross-section
      this.width = 2.4;
      this.height = SOIL_DEPTH + SOIL_TOP + 0.9;
    }
    if (this.soil) {
      this.soil.visible = handover < 0.995;
      this.soil.traverse(o => {
        if (o.isMesh && o !== this.seed) o.material.opacity = 1 - handover;
      });
    }

    for (const slot of this.slots) slot.pivot.visible = false;
    if (!this.slots.length || P <= SPROUT_END) return;

    // continuous position along the sequence, so it scrubs smoothly
    const n = this.slots.length;
    const f = clamp01((P - SPROUT_END) / (1 - SPROUT_END)) * (n - 1);
    const i = Math.min(n - 1, Math.floor(f));
    const frac = f - i;

    // Every click has to move something.  A stage swells slightly across its
    // own span before handing over, so the growth is continuous rather than
    // nine visible jumps, and the dissolve is long enough to read as a change
    // of scene rather than a pop.
    const swell = 0.93 + 0.10 * frac;
    const FADE = 0.42;
    if (frac < 1 - FADE || i === n - 1) {
      this._showStage(i, swell, 1, 1);
    } else {
      const b = (frac - (1 - FADE)) / FADE;
      const e = b * b * (3 - 2 * b);              // smoothstep for the ground
      // The land swaps over quickly and almost invisibly, because consecutive
      // stages share most of it.  What you actually watch is the new planting
      // pushing up out of that ground, which is why this reads as growth
      // rather than one picture dissolving into another.
      // Opacity is driven off b rather than the smoothed e, because smoothstep
      // is almost flat near zero - the new trees were rising while still
      // invisible, which threw away the first third of the animation.
      this._showStage(i, swell * (1 - 0.05 * e), 1 - clamp01(b * 1.7), 1);
      // Incoming trees stay solid: rising out of the ground is already the
      // entrance, and fading them in as well just makes them look like ghosts.
      // Only the land underneath cross-fades, and it barely changes anyway.
      this._showStage(i + 1, 0.94, clamp01(b * 2.5), BACK(b), 1);
    }
  }

  /** Take on any stages that finished loading after this model was built. */
  adopt(bank) {
    for (let i = this.slots.length; i < bank.length; i++) {
      const st = bank[i];
      const g = st.group.clone(true);
      g.traverse(o => { if (o.isMesh) o.material = o.material.clone(); });
      const pivot = pivotAt(g, 0);
      pivot.visible = false;
      this.root.add(pivot);
      this.slots.push({ pivot, natural: st.width, tall: st.height,
                        terrain: g.getObjectByName('terrain'),
                        flora: g.getObjectByName('flora') });
    }
    this._apply(this.p);      // redraw at the eased value, keep the target
  }

  tick(dt, t) {
    // Clicks arrive as steps; the model follows them on a spring-free ease so
    // the growth flows between clicks instead of twitching on each one.
    if (this.pTarget !== undefined && Math.abs(this.pTarget - this.p) > 1e-4) {
      this.p += (this.pTarget - this.p) * (1 - Math.exp(-5.5 * dt));
      this._apply(this.p);
    }
    const sway = Math.sin(t * 1.05) * 0.018 * this.p;
    for (const slot of this.slots) if (slot.pivot.visible) slot.pivot.rotation.z = sway;
    if (this.sprout) this.sprout.rotation.z = sway * 2.5;
    if (this.p >= 1) this.root.rotation.y += dt * 0.16;
  }
}

/* ------------------------------------------------------------- the stage */

export function initScene(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0a16);
  scene.fog = new THREE.Fog(0x0b0a16, 14, 30);

  camera = new THREE.PerspectiveCamera(42, 1, .1, 100);
  camera.position.set(0, 3.6, 10.5);
  camera.lookAt(0, 2.0, 0);

  // Lighting for plain diffuse voxels.  Saturated rim lights look great on
  // glowing procedural shapes and terrible on flat painted blocks - they turn
  // a brown trunk navy - so the coloured lights are kept as a faint accent and
  // the real work is done by a neutral key and a generous sky fill.
  scene.add(new THREE.HemisphereLight(0xbcd2f0, 0x241c30, 0.80));
  scene.add(new THREE.AmbientLight(0xffffff, .16));
  const key = new THREE.DirectionalLight(0xfff2dc, 1.95);
  key.position.set(5, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 30;
  key.shadow.camera.left = -6; key.shadow.camera.right = 6;
  key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
  // Voxel blocks self-shadow into solid black without a normal bias: every
  // face is flat and axis aligned, which is the worst case for shadow acne.
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.04;
  scene.add(key);
  const rim = new THREE.PointLight(0xff5d8f, 16, 22);
  rim.position.set(-6, 3, -4);
  scene.add(rim);
  const rim2 = new THREE.PointLight(0x39d0ff, 16, 22);
  rim2.position.set(6, 3, -4);
  scene.add(rim2);
  // a soft fill from the camera so nothing facing us falls to black
  const fill = new THREE.DirectionalLight(0xffffff, .38);
  fill.position.set(0, 3, 9);
  scene.add(fill);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(24, 64),
    new THREE.MeshStandardMaterial({ color: 0x120f22, roughness: .95, metalness: .1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  clock = new THREE.Clock();
  onResize();
  addEventListener('resize', onResize);
  renderer.setAnimationLoop(frame);
}

function onResize() {
  if (!renderer) return;
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  frameCamera();
}

/* Pull the camera back until everything fits, rather than trusting a fixed
 * distance - a booth screen is 16:9 but a windowed test is not, and a tower
 * sliding off the edge would be invisible to whoever is running the stall. */
let camAim = { d: 8, y: 3, look: 1.4 };

/* The content grows from a seedling to a forest four times wider, so the camera
 * follows it out.  The move is damped in frame(), which turns "the model got
 * bigger" into a slow pull back - the most satisfying part of the whole thing. */
function frameCamera() {
  if (!camera) return;
  const solo = rigs.length <= 1;
  const spread = solo ? 0 : TRACK_X;
  let w = STAGE_W0, h = 2.0;
  for (const rig of rigs) {
    w = Math.max(w, rig.model.width || STAGE_W0);
    h = Math.max(h, rig.model.height || 2.0);
  }
  const halfW = spread + w / 2 + 0.9;
  // A wide flat island seen head on is unreadable, and tilting down stretches
  // it vertically on screen, so the vertical extent gets the generous margin.
  const halfH = h / 2 + 0.9 + w * 0.16;
  const vFov = camera.fov * Math.PI / 180;
  const distV = halfH / Math.tan(vFov / 2);
  const distH = halfW / (Math.tan(vFov / 2) * Math.max(.35, camera.aspect));
  camAim.d = Math.max(distV, distH) * 1.06;
  camAim.look = h * 0.42;
  // height follows the footprint, not the model height: the forest is flat
  // and needs looking down on, the seedling is tall and does not.
  camAim.y = camAim.look + Math.max(1.4, w * 0.46);
}

function frame() {
  const dt = Math.min(clock.getDelta(), .05);
  const t = clock.elapsedTime;
  ambientSpin += dt;
  for (const rig of rigs) {
    rig.model.tick(dt, t);
    if (rig.idle) rig.model.root.rotation.y = ambientSpin * .35;
  }

  frameCamera();
  const k = 1 - Math.exp(-2.2 * dt);          // frame-rate independent easing
  camera.position.z += (camAim.d - camera.position.z) * k;
  camera.position.y += (camAim.y - camera.position.y) * k;
  camLook += (camAim.look - camLook) * k;
  camera.lookAt(0, camLook, 0);

  renderer.render(scene, camera);
}

/* ------------------------------------------------------------- rig setup */

let assets = null;          // null = not tried, false = no artwork present
const stageBank = [];       // fills in the background; models read it live
let stageProgress = { done: 0, total: STAGE_FILES.length };

/** Load the artwork.  The soil is awaited because nothing works without it;
 *  the 35 MB of growth stages stream in afterwards so the booth is playable
 *  within a second of opening rather than after a long blank wait. */
export async function preloadModel(base = './models/') {
  if (assets !== null) return assets;
  const soil = await new GLTFLoader().loadAsync(base + 'soil-and-seed.glb')
    .catch(() => null);
  if (!soil) { assets = false; return assets; }
  assets = { soil: soil.scene };
  loadStages(base);                       // deliberately not awaited
  return assets;
}

async function loadStages(base) {
  const loader = new OBJLoader();
  for (const file of STAGE_FILES) {
    try {
      const raw = await loader.loadAsync(base + file);
      const group = mergeByKind(raw);
      const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
      stageBank.push({ group, width: Math.max(size.x, size.z), height: size.y });
    } catch {
      /* a missing stage just means a shorter sequence */
    }
    stageProgress.done++;
    for (const rig of rigs) if (rig.model.adopt) rig.model.adopt(stageBank);
  }
}

export function artworkProgress() { return { ...stageProgress }; }

function makeModel(tint) {
  if (assets) return new GardenModel(assets.soil.clone(true), stageBank);
  return new TowerModel(tint);
}

/** Lay out the stage: 1 rig for co-op, 2 side by side for head to head. */
export function setupTracks(count) {
  for (const rig of rigs) scene.remove(rig.model.root);
  rigs = [];
  const tints = [0xff5d8f, 0x39d0ff];
  const solo = count === 1;
  for (let i = 0; i < count; i++) {
    const model = makeModel(solo ? 0xffc857 : tints[i]);
    model.root.position.x = solo ? 0 : (i === 0 ? -TRACK_X : TRACK_X);
    model.root.scale.setScalar(solo ? 1.15 : .95);
    model.setProgress(0);
    scene.add(model.root);
    rigs.push({ model, idle: false });
  }
  frameCamera();
}

export function setProgress(i, p) {
  const rig = rigs[i];
  if (rig) rig.model.setProgress(p);
}

export function setIdleSpin(on) {
  for (const rig of rigs) rig.idle = on;
}

/** The live models, for diagnostics and tests. */
export function models() { return rigs.map(r => r.model); }

export function usingAuthoredModel() { return !!assets; }
export function usingTree() { return !!(assets && assets.tree); }

/** Force one render and return it as a PNG data URL.
 *  Used by the diagnostics hook and handy when a booth screen looks wrong. */
/** Render cost and draw calls for the current scene.  Worth having on a booth
 *  machine: if the frame rate is poor on the day this says whether it is the
 *  geometry or something else. */
export function perf(frames = 90) {
  for (const rig of rigs) if (rig.model.settle) rig.model.settle();
  frameCamera();
  camera.position.z = camAim.d; camera.position.y = camAim.y;
  camera.lookAt(0, camAim.look, 0);
  renderer.render(scene, camera);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) renderer.render(scene, camera);
  const ms = (performance.now() - t0) / frames;
  const r = renderer.info.render;
  return { msPerFrame: +ms.toFixed(2), fpsHeadroom: Math.round(1000 / ms),
           drawCalls: r.calls, triangles: r.triangles };
}

export function snapshot() {
  // settle models and camera first, so a still shows the finished pose
  for (const rig of rigs) if (rig.model.settle) rig.model.settle();
  frameCamera();
  camera.position.z = camAim.d;
  camera.position.y = camAim.y;
  camLook = camAim.look;
  camera.lookAt(0, camLook, 0);
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}
