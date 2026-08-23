// Low-resolution soil block, a seed in its planting dip, and a sprout —
// assembled by a one-shot animation. Chunky 13×13 grid.
//
// Voxels are merged per (horizon, material): one named mesh per material for a
// clean OBJ/GLB export, grouped per horizon so each stratum can be animated.

const V = 0.16;   // soil voxel edge, metres
const N = 13;     // grid
const SV = V / 2; // the seed and sprout are modelled at half scale

const COLORS = {
  topsoil_dark: 0x402d20, topsoil_damp: 0x533b26,
  subsoil_sand: 0xcba473, subsoil_clay: 0x9c5b31,
  bedrock_grey: 0x7d878c, bedrock_deep: 0x69747b,
  stone: 0x8b9497,
  seed_shell: 0x8a5a33, seed_tip: 0xc0946a, seed_scar: 0x5d3a1f,
  sprout_stem: 0x4e7a35, sprout_leaf: 0x82b757,
};

const FACES = [
  { n: [1, 0, 0],  v: [[.5,-.5,.5],[.5,-.5,-.5],[.5,.5,-.5],[.5,.5,.5]] },
  { n: [-1, 0, 0], v: [[-.5,-.5,-.5],[-.5,-.5,.5],[-.5,.5,.5],[-.5,.5,-.5]] },
  { n: [0, 1, 0],  v: [[-.5,.5,.5],[.5,.5,.5],[.5,.5,-.5],[-.5,.5,-.5]] },
  { n: [0, -1, 0], v: [[-.5,-.5,-.5],[.5,-.5,-.5],[.5,-.5,.5],[-.5,-.5,.5]] },
  { n: [0, 0, 1],  v: [[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]] },
  { n: [0, 0, -1], v: [[.5,-.5,-.5],[-.5,-.5,-.5],[-.5,.5,-.5],[.5,.5,-.5]] },
];

function rnd(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2246822519) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Face-culled merge of one horizon's voxels. Culling stays inside the horizon
 *  so every slab is a closed solid and can be moved on its own. */
function mesh(cells, scale, origin, buckets, horizon) {
  const key = (x, y, z) => `${x},${y},${z}`;
  for (const [k, matName] of cells) {
    const [x, y, z] = k.split(',').map(Number);
    const entry = `${horizon}|${matName}`;
    let b = buckets.get(entry);
    if (!b) buckets.set(entry, (b = { pos: [], nor: [], uv: [] }));
    const c = [origin[0] + x * scale, origin[1] + y * scale, origin[2] + z * scale];
    for (const f of FACES) {
      if (cells.has(key(x + f.n[0], y + f.n[1], z + f.n[2]))) continue;
      const q = f.v.map((p) => [c[0] + p[0] * scale, c[1] + p[1] * scale, c[2] + p[2] * scale]);
      const uvq = [[0, 0], [1, 0], [1, 1], [0, 1]];
      for (const tri of [[0, 1, 2], [0, 2, 3]])
        for (const i of tri) {
          b.pos.push(q[i][0], q[i][1], q[i][2]);
          b.nor.push(f.n[0], f.n[1], f.n[2]);
          b.uv.push(uvq[i][0], uvq[i][1]);
        }
    }
  }
}

const ease = (t) => 1 - Math.pow(1 - t, 3);
const seg = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));

export function buildSoilAndSeed(THREE) {
  const H = { topsoil: new Map(), sand: new Map(), clay: new Map(), bedrock: new Map() };
  const put = (x, y, z, horizon, mat) => H[horizon].set(`${x},${y},${z}`, mat);
  const C = (N - 1) / 2;

  for (let x = 0; x < N; x++) {
    for (let z = 0; z < N; z++) {
      const edge = Math.min(x, z, N - 1 - x, N - 1 - z);
      const pit = Math.abs(x - C) <= 1 && Math.abs(z - C) <= 1;
      if (!pit) put(x, 0, z, 'topsoil', rnd(x, 0, z) < 0.62 ? 'topsoil_dark' : 'topsoil_damp');
      put(x, -1, z, 'topsoil', rnd(x, -1, z) < 0.7 ? 'topsoil_dark' : 'topsoil_damp');
      for (let y = -2; y >= -3; y--)
        put(x, y, z, 'sand', rnd(x, y, z) < 0.88 ? 'subsoil_sand' : 'subsoil_clay');
      for (let y = -4; y >= -5; y--)
        put(x, y, z, 'clay', rnd(x, y, z) < 0.88 ? 'subsoil_clay' : 'subsoil_sand');
      for (let y = -6; y >= -8; y--) {
        const need = Math.max(0, (-6 - y - 1.2) * 1.5 + rnd(x, y, z) * 1.8 - 0.5);
        if (edge >= need) put(x, y, z, 'bedrock', rnd(x, y, z) < 0.6 ? 'bedrock_grey' : 'bedrock_deep');
      }
      if (edge > 3 && rnd(x, 91, z) > 0.86 && H.bedrock.has(`${x},-8,${z}`))
        put(x, -9, z, 'bedrock', 'bedrock_deep');
    }
  }
  const pebbles = new Map();
  for (const [px, pz] of [[2, 9], [10, 3], [4, 2]]) pebbles.set(`${px},1,${pz}`, 'stone');

  // ---- seed: half-scale ellipsoid with a pinched tip ----
  const seed = new Map();
  const R = [2.4, 3.6, 2.0];
  for (let x = -3; x <= 3; x++)
    for (let y = -4; y <= 4; y++)
      for (let z = -3; z <= 3; z++) {
        if ((x / R[0]) ** 2 + (y / R[1]) ** 2 + (z / R[2]) ** 2 > 1) continue;
        if (y > 2 && Math.abs(x) + Math.abs(z) > 0) continue;
        if (y > 1 && Math.abs(x) + Math.abs(z) > 1) continue;
        const scar = z <= -1 && Math.abs(x) <= 1 && y >= -2 && y <= 1;
        seed.set(`${x},${y},${z}`, scar ? 'seed_scar' : y >= 2 ? 'seed_tip' : 'seed_shell');
      }

  // ---- sprout: stem out of the seed tip, two stepped leaves ----
  const sprout = new Map();
  for (let y = 0; y <= 4; y++) sprout.set(`0,${y},0`, 'sprout_stem');
  for (const [x, y, z] of [[-1,3,0],[-2,4,0],[1,2,0],[2,3,0],[-1,4,0],[1,3,0]])
    sprout.set(`${x},${y},${z}`, 'sprout_leaf');

  const buckets = new Map();
  const soilOrigin = [-C * V, 0, -C * V];
  for (const [name, cells] of Object.entries(H)) mesh(cells, V, soilOrigin, buckets, name);
  mesh(pebbles, V, soilOrigin, buckets, 'pebbles');
  const seedOrigin = [0, V * 1.3, 0];
  mesh(seed, SV, seedOrigin, buckets, 'seed');
  const sproutBase = seedOrigin[1] + 3.5 * SV;
  mesh(sprout, SV, [0, 0, 0], buckets, 'sprout');   // at origin so scale.y grows from its base

  const group = new THREE.Group();
  group.name = 'soil_and_seed';
  const parts = {};
  for (const [k, b] of buckets) {
    const [horizon, name] = k.split('|');
    let holder = parts[horizon];
    if (!holder) {
      holder = parts[horizon] = new THREE.Group();
      holder.name = horizon;
      group.add(holder);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    const m = new THREE.MeshStandardMaterial({
      name,
      color: COLORS[name],
      roughness: name.startsWith('seed') ? 0.55 : name.startsWith('sprout') ? 0.75 : name.startsWith('bedrock') ? 0.7 : 0.92,
      metalness: 0,
      flatShading: true,
    });
    const mm = new THREE.Mesh(g, m);
    mm.name = name;
    holder.add(mm);
  }
  parts.sprout.position.y = sproutBase;

  const FALL = 1.9;
  const TIMELINE = { bedrock: 0, clay: 0.45, sand: 0.9, topsoil: 1.35, pebbles: 2.1, seed: 2.5 };
  const DURATION = 5.6;

  /** Drive the assembly. t in seconds from 0; >= DURATION is the rest state. */
  function animate(t) {
    for (const [name, start] of Object.entries(TIMELINE)) {
      const p = ease(seg(t, start, start + 0.95));
      parts[name].position.y = (1 - p) * FALL;
      parts[name].visible = t >= start - 0.001;
    }
    const g = ease(seg(t, 3.5, 5.4));
    parts.sprout.visible = g > 0;
    parts.sprout.scale.set(0.35 + 0.65 * g, Math.max(0.001, g), 0.35 + 0.65 * g);
  }

  return { group, parts, animate, duration: DURATION };
}
