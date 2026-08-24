// Voxel island: stratified terrain block + tree whose canopy footprint is a
// real QR code. One merged, named mesh per material (OBJ/GLB export stays tidy).
import { encode } from './qr.js';

const V = 0.09;            // voxel edge, metres
const N = 33;              // base grid (QR 25 + 4-voxel grass margin each side)
const OFF = 4;             // QR module (r,c) -> grid (gz, gx) = (r+OFF, c+OFF)

const COLORS = {
  grass_light: 0x93bb61, grass_mid: 0x80a852, grass_deep: 0x6b8c44,
  topsoil_dark: 0x402d20, topsoil_damp: 0x533b26,
  subsoil_sand: 0xcba473, subsoil_clay: 0x9c5b31,
  bedrock_grey: 0x7d878c, bedrock_deep: 0x69747b,
  bark: 0x4b3627, root: 0x5a3a1e,
  stone: 0x8b9497, flower: 0xf6f2e4,
  water: 0x5c93a6, shore: 0xc0a377, path: 0xa88f6a,
  petal: 0xf0c6d4,
  leaf_1: 0xf2c0d0, leaf_2: 0xe7a9bf, leaf_3: 0xf8d7e2, leaf_4: 0xdd94ad,
};

export const SEASONS = {
  cherry: { label: 'Cherry Blossom', leaves: [0xf3c2d2, 0xe6a6bd, 0xf9d9e3, 0xda8fa9], petal: 0xf5d2de },
  summer: { label: 'Summer Green',   leaves: [0x6aa84f, 0x578e41, 0x7cba5d, 0x466f34], petal: 0x8cbf6a },
  ginkgo: { label: 'Golden Ginkgo',  leaves: [0xe9c644, 0xd6ad32, 0xf3da6c, 0xc0942a], petal: 0xe3bd54 },
  pixel:  { label: 'Pixel Mix',      leaves: [0x3f9c8f, 0x6aab4e, 0xe0873c, 0xecc94b], petal: 0xd98f43 },
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
const pick = (r, arr) => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];

// Quadratic bezier helper for the dirt path.
const bez = (t, a, b, c) => {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]];
};

export function buildIsland(THREE, { text, level = 'M', season = 'cherry' } = {}) {
  const qr = encode(text, level);
  if (qr.size !== 25) throw new Error(`qr: expected a 25-module code, got ${qr.size}`);

  const cells = new Map();                 // "x,y,z" -> material name
  const key = (x, y, z) => `${x},${y},${z}`;
  const put = (x, y, z, mat) => cells.set(key(x, y, z), mat);
  const has = (x, y, z) => cells.has(key(x, y, z));

  // ---- pond + shore + path masks (surface features decided first) ----
  const POND = [9, 24], PR = 3.3;
  const pondDist = (x, z) => Math.hypot((x - POND[0]) * 1.05, (z - POND[1]) * 0.9);
  const P0 = [12.5, 26], P1 = [21, 22.5], P2 = [32, 17];
  const pathPts = Array.from({ length: 60 }, (_, i) => bez(i / 59, P0, P1, P2));
  const onPath = (x, z) => pathPts.some((p) => Math.hypot(p[0] - x, p[1] - z) < 1.15);

  // ---- strata ----
  for (let x = 0; x < N; x++) {
    for (let z = 0; z < N; z++) {
      const edge = Math.min(x, z, N - 1 - x, N - 1 - z);
      const pd = pondDist(x, z);

      // surface
      if (pd < PR) {
        put(x, -1, z, 'water');
        if (pd < PR - 1.6) put(x, -2, z, 'water');
      } else if (pd < PR + 1.1) {
        put(x, 0, z, 'shore');
      } else if (onPath(x, z)) {
        put(x, 0, z, 'path');
      } else {
        const r = rnd(x, 7, z);
        put(x, 0, z, r < 0.36 ? 'grass_light' : r < 0.78 ? 'grass_mid' : 'grass_deep');
      }

      // topsoil A horizon
      for (let y = -1; y >= -3; y--)
        if (!has(x, y, z)) put(x, y, z, rnd(x, y, z) < 0.7 ? 'topsoil_dark' : 'topsoil_damp');
      // subsoil B horizon
      for (let y = -4; y >= -6; y--) put(x, y, z, rnd(x, y, z) < 0.9 ? 'subsoil_sand' : 'subsoil_clay');
      for (let y = -7; y >= -9; y--) put(x, y, z, rnd(x, y, z) < 0.9 ? 'subsoil_clay' : 'subsoil_sand');
      // bedrock C horizon — full width up top, tapered and jagged underneath
      for (let y = -10; y >= -15; y--) {
        const step = -10 - y;                           // 0..5
        const need = Math.max(0, (step - 2.6) * 1.5 + rnd(x, y, z) * 2.2 - 0.6);
        if (edge >= need) put(x, y, z, rnd(x, y, z) < 0.62 ? 'bedrock_grey' : 'bedrock_deep');
      }
      // a few hanging shards
      if (edge > 8 && rnd(x, 99, z) > 0.94 && has(x, -15, z)) {
        put(x, -16, z, 'bedrock_deep');
        if (rnd(x, 98, z) > 0.55) put(x, -17, z, 'bedrock_grey');
      }
    }
  }

  // ---- trunk ----
  const CX = OFF + 12, CZ = OFF + 12;                   // 16,16 — canopy centre
  for (let y = 1; y <= 9; y++)
    for (let x = CX - 1; x <= CX + 1; x++)
      for (let z = CZ - 1; z <= CZ + 1; z++) put(x, y, z, 'bark');
  for (let y = 10; y <= 16; y++)
    for (let x = CX - 1; x <= CX + 1; x++)
      for (let z = CZ - 1; z <= CZ + 1; z++) {
        const corner = x !== CX && z !== CZ;
        if (!corner || y < 12) put(x, y, z, 'bark');
      }
  // surface root flare
  for (const [dx, dz] of [[2,0],[-2,0],[0,2],[0,-2],[2,1],[-2,-1],[1,2],[-1,-2],[3,0],[0,-3]])
    put(CX + dx, 1, CZ + dz, 'root');

  // ---- roots: down through topsoil into the subsoil, two reaching the cutaway ----
  const rootRuns = [
    { dir: [1, 0], rate: 0.34 }, { dir: [-1, 0], rate: 0.5 },
    { dir: [0, 1], rate: 0.4 },  { dir: [0, -1], rate: 0.28 },
    { dir: [1, 1], rate: 0.62 }, { dir: [-1, -1], rate: 0.55 },
  ];
  for (const [i, run] of rootRuns.entries()) {
    let x = CX, z = CZ, y = 0;
    for (let s = 1; s <= 17; s++) {
      x += run.dir[0]; z += run.dir[1];
      const drop = -Math.min(8, Math.round(1 + s * run.rate + rnd(x, i, z) * 0.9));
      for (let yy = y; yy >= drop; yy--) {
        if (x < 0 || z < 0 || x >= N || z >= N) break;
        if (has(x, yy, z) && cells.get(key(x, yy, z)).startsWith('grass')) continue;
        if (yy <= 0) put(x, yy, z, 'root');
      }
      y = drop;
      if (s <= 7) put(x + run.dir[1], y, z + run.dir[0], 'root');
      if (rnd(x, i + 50, z) > 0.72) { // small lateral hair
        put(x + run.dir[1], y, z + run.dir[0], 'root');
      }
    }
  }

  // ---- branches ----
  const arms = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  for (const [ax, az] of arms) {
    const diag = ax !== 0 && az !== 0;
    const len = diag ? 4 : 5;
    for (let s = 1; s <= len; s++) {
      const x = CX + ax * s, z = CZ + az * s;
      const y = 14 + Math.round(s * 0.5);
      put(x, y, z, 'bark');
      if (s <= 2) put(x, y - 1, z, 'bark');
    }
  }

  // ---- canopy: exactly the QR's dark modules, domed in section ----
  const canopy = [];
  for (let r = 0; r < 25; r++) {
    for (let c = 0; c < 25; c++) {
      if (!qr.modules[r][c]) continue;
      const rn = Math.min(1, Math.hypot(c - 12, r - 12) / 13.2);
      const jit = rnd(c, 3, r) > 0.62 ? 1 : 0;
      const top = 25 - Math.round(8 * Math.pow(rn, 1.5)) + jit;
      const bot = Math.min(top, 15 + Math.round(3.4 * Math.pow(rn, 1.9)));
      const x = OFF + c, z = OFF + r;
      for (let y = bot; y <= top; y++) {
        const b = 1 + Math.floor(rnd(x, y, z) * 4);
        put(x, y, z, `leaf_${Math.min(4, b)}`);
        canopy.push([x, y, z]);
      }
    }
  }

  // ---- surface decoration ----
  let rocks = 0, flowers = 0, petals = 0;
  for (let x = 0; x < N && (rocks < 14 || flowers < 18 || petals < 26); x++) {
    for (let z = 0; z < N; z++) {
      const below = cells.get(key(x, 0, z)) || '';
      if (!below.startsWith('grass') || has(x, 1, z)) continue;
      const r = rnd(x, 42, z);
      const underTree = Math.hypot(x - CX, z - CZ) < 11;
      if (rocks < 14 && r > 0.988) {
        put(x, 1, z, 'stone');
        if (rnd(x, 43, z) > 0.55) put(x + 1, 1, z, 'stone');
        rocks++;
      } else if (flowers < 18 && r > 0.972) {
        put(x, 1, z, 'flower');
        flowers++;
      } else if (petals < 26 && underTree && r > 0.93) {
        put(x, 1, z, 'petal');
        petals++;
      }
    }
  }

  // ---- merge: one geometry per material, interior faces culled ----
  const buckets = new Map();
  for (const [k, mat] of cells) {
    const [x, y, z] = k.split(',').map(Number);
    let b = buckets.get(mat);
    if (!b) buckets.set(mat, (b = { pos: [], nor: [], uv: [] }));
    const cx = (x - (N - 1) / 2) * V, cy = y * V, cz = (z - (N - 1) / 2) * V;
    for (const f of FACES) {
      if (cells.has(key(x + f.n[0], y + f.n[1], z + f.n[2]))) continue;
      const q = f.v.map((p) => [cx + p[0] * V, cy + p[1] * V, cz + p[2] * V]);
      const uvq = [[0, 0], [1, 0], [1, 1], [0, 1]];
      for (const [a, bb, cc] of [[0, 1, 2], [0, 2, 3]]) {
        for (const idx of [a, bb, cc]) {
          b.pos.push(q[idx][0], q[idx][1], q[idx][2]);
          b.nor.push(f.n[0], f.n[1], f.n[2]);
          b.uv.push(uvq[idx][0], uvq[idx][1]);
        }
      }
    }
  }

  const group = new THREE.Group();
  group.name = 'voxel_island';
  const materials = {};
  for (const [name, b] of buckets) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    const isWater = name === 'water';
    const mat = new THREE.MeshStandardMaterial({
      name,
      color: COLORS[name] ?? 0xcccccc,
      roughness: isWater ? 0.25 : name.startsWith('leaf') ? 0.85 : name.startsWith('bedrock') ? 0.7 : 0.92,
      metalness: isWater ? 0.15 : 0,
      flatShading: true,
    });
    materials[name] = mat;
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    group.add(mesh);
  }

  const setSeason = (name) => {
    const s = SEASONS[name] || SEASONS.cherry;
    s.leaves.forEach((c, i) => materials[`leaf_${i + 1}`]?.color.setHex(c));
    materials.petal?.color.setHex(s.petal);
  };
  setSeason(season);

  return { group, setSeason, qr, faces: [...buckets.values()].reduce((n, b) => n + b.pos.length / 9, 0) };
}
