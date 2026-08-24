// Minimal QR encoder — byte mode, single-block versions 1-4.
// Returns a real, spec-conformant matrix (finder/timing/alignment patterns,
// Reed-Solomon ECC, BCH format info, penalty-scored mask) so the canopy
// plotted from it actually scans.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function genPoly(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gmul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function eccBytes(data, n) {
  const res = new Array(data.length + n).fill(0);
  for (let i = 0; i < data.length; i++) res[i] = data[i];
  const g = genPoly(n);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef === 0) continue;
    for (let j = 0; j < g.length; j++) res[i + j] ^= gmul(g[j], coef);
  }
  return res.slice(data.length);
}

// [data codewords, ec codewords] — single-block configurations only.
const VERSIONS = {
  1: { L: [19, 7], M: [16, 10], Q: [13, 13], H: [9, 17] },
  2: { L: [34, 10], M: [28, 16], Q: [22, 22], H: [16, 28] },
  3: { L: [55, 15], M: [44, 26] },
  4: { L: [80, 20] },
};
const LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const bitLen = (n) => {
  let l = 0;
  while (n !== 0) {
    l++;
    n >>>= 1;
  }
  return l;
};

function formatInfo(levelBits, mask) {
  const data = (levelBits << 3) | mask;
  let d = data << 10;
  while (bitLen(d) - bitLen(0x537) >= 0) d ^= 0x537 << (bitLen(d) - bitLen(0x537));
  return ((data << 10) | d) ^ 0x5412;
}

const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i, j) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

function blank(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function layout(size, version) {
  const m = blank(size);
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => {
    m[r][c] = v;
    reserved[r][c] = true;
  };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const r1 = r0 + r,
          c1 = c0 + c;
        if (r1 < 0 || c1 < 0 || r1 >= size || c1 >= size) continue;
        const edge = r === -1 || r === 7 || c === -1 || c === 7;
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(r1, c1, edge ? 0 : ring || core ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    set(6, i, v);
    set(i, 6, v);
  }

  if (version >= 2) {
    const ac = size - 7; // versions 2-6: one alignment pattern
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const outer = Math.abs(r) === 2 || Math.abs(c) === 2;
        set(ac + r, ac + c, outer || (r === 0 && c === 0) ? 1 : 0);
      }
    }
  }

  // Format-info areas (values written later) + the dark module.
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) set(8, i, 0);
    if (m[i][8] === null) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, 0);
    set(size - 1 - i, 8, 0);
  }
  set(size - 8, 8, 1);

  return { m, reserved };
}

function placeData(m, reserved, bits) {
  const size = m.length;
  let idx = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[r][c]) continue;
        m[r][c] = idx < bits.length ? bits[idx] : 0;
        idx++;
      }
    }
    up = !up;
  }
}

function writeFormat(m, levelBits, mask) {
  const size = m.length;
  const fmt = formatInfo(levelBits, mask);
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    if (i < 6) m[i][8] = bit;
    else if (i < 8) m[i + 1][8] = bit;
    else m[size - 15 + i][8] = bit;
  }
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    if (i < 8) m[8][size - i - 1] = bit;
    else if (i < 9) m[8][15 - i] = bit;
    else m[8][15 - i - 1] = bit;
  }
  m[size - 8][8] = 1;
}

function penalty(m) {
  const size = m.length;
  let score = 0;
  const runScore = (line) => {
    let s = 0,
      run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) s += 3 + (run - 5);
    return s;
  };
  for (let i = 0; i < size; i++) {
    score += runScore(m[i]);
    score += runScore(m.map((row) => row[i]));
  }
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const rpat = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const hasAt = (line, i, p) => p.every((v, k) => line[i + k] === v);
  for (let i = 0; i < size; i++) {
    const row = m[i];
    const col = m.map((r) => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (hasAt(row, j, pat) || hasAt(row, j, rpat)) score += 40;
      if (hasAt(col, j, pat) || hasAt(col, j, rpat)) score += 40;
    }
  }
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/** Encode text as a QR matrix. Returns { size, version, level, mask, modules }
 *  where modules[row][col] is 1 (dark) or 0 (light). */
export function encode(text, level = 'M') {
  const bytes = new TextEncoder().encode(text);
  let version = null,
    caps = null;
  for (const v of [1, 2, 3, 4]) {
    const cfg = VERSIONS[v][level];
    if (!cfg) continue;
    if (bytes.length <= cfg[0] - 2) {
      version = v;
      caps = cfg;
      break;
    }
  }
  if (!version) throw new Error(`qr: "${text}" too long for level ${level} (max version 4)`);

  const [dataCount, ecCount] = caps;
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const cap = dataCount * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  let padEc = true;
  while (data.length < dataCount) {
    data.push(padEc ? 0xec : 0x11);
    padEc = !padEc;
  }

  const codewords = data.concat(eccBytes(data, ecCount));
  const allBits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) allBits.push((cw >> i) & 1);

  const size = version * 4 + 17;
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const { m, reserved } = layout(size, version);
    placeData(m, reserved, allBits);
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (!reserved[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
    writeFormat(m, LEVEL_BITS[level], mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { score, mask, modules: m };
  }
  return { size, version, level, mask: best.mask, modules: best.modules };
}
