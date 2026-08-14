// Hear With Me — a QR encoder small enough to vendor.
//
// WHY THIS EXISTS: the host is always on a desktop and the guest is always on
// a phone, so the invite's natural path is "point the phone at the screen",
// not "copy a link out of one machine and into another". Every QR library is
// a dependency, and this project has none — so this is the smallest encoder
// that covers a room URL and nothing else:
//
//   - byte mode only (a URL is ASCII; no numeric/alphanumeric optimisation)
//   - error correction level M (the usual default, ~15% recoverable)
//   - versions 1 to 6 only — up to 106 bytes, far more than any room URL, and
//     conveniently the range that needs no version-information blocks
//
// Bigger inputs are rejected rather than silently truncated.

const ECC_M = 0; // level indicator bits used in the format information

// Per version (index 0 = version 1), at level M:
//   total codewords, EC codewords per block, number of blocks.
// Versions 1-6 at level M all have equal-sized blocks, which is why the
// block splitting below has no "group 2" case.
export const VERSIONS = [
  { total: 26, ecPerBlock: 10, blocks: 1 },
  { total: 44, ecPerBlock: 16, blocks: 1 },
  { total: 70, ecPerBlock: 26, blocks: 1 },
  { total: 100, ecPerBlock: 18, blocks: 2 },
  { total: 134, ecPerBlock: 24, blocks: 2 },
  { total: 172, ecPerBlock: 16, blocks: 4 },
];

// Centres of the alignment patterns. Versions 2-6 have exactly two
// coordinates, and the three combinations that collide with a finder
// pattern are skipped, leaving a single alignment pattern.
const ALIGNMENT = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

// ------------------------------------------------------------------ GF(256)
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR field's primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    // poly[0] is the highest-degree coefficient, so multiplying by x keeps a
    // term's index and multiplying by the constant moves it one step down.
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

// Polynomial long division in GF(256): the remainder is the EC block.
function eccBlock(data, ecLength) {
  const gen = generatorPoly(ecLength);
  const rem = new Array(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < ecLength; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// ------------------------------------------------------------------ encode
function toBytes(text) {
  // TextEncoder is everywhere we run; the fallback keeps this usable from a
  // plain script context (and from Node, where the tests live).
  if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
  return Array.from(unescape(encodeURIComponent(text)), (c) => c.charCodeAt(0));
}

function pickVersion(byteLength) {
  for (let v = 0; v < VERSIONS.length; v++) {
    const spec = VERSIONS[v];
    const dataCodewords = spec.total - spec.ecPerBlock * spec.blocks;
    if (byteLength + 2 <= dataCodewords) return v + 1; // 4 mode bits + 8 count bits
  }
  return null;
}

function codewords(bytes, version) {
  const spec = VERSIONS[version - 1];
  const dataCodewords = spec.total - spec.ecPerBlock * spec.blocks;

  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);          // byte mode
  push(bytes.length, 8);    // versions 1-9 use an 8-bit count in byte mode
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCodewords * 8 - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }
  // The two standard pad codewords, alternating.
  for (let i = 0; data.length < dataCodewords; i++) data.push(i % 2 === 0 ? 0xec : 0x11);

  // Split into blocks, then interleave: all first data codewords, all second,
  // and so on, followed by the EC codewords interleaved the same way. This is
  // what spreads a physical smudge across several blocks.
  const perBlock = dataCodewords / spec.blocks;
  const dataBlocks = [];
  const ecBlocks = [];
  for (let b = 0; b < spec.blocks; b++) {
    const block = data.slice(b * perBlock, (b + 1) * perBlock);
    dataBlocks.push(block);
    ecBlocks.push(eccBlock(block, spec.ecPerBlock));
  }

  const out = [];
  for (let i = 0; i < perBlock; i++) for (const block of dataBlocks) out.push(block[i]);
  for (let i = 0; i < spec.ecPerBlock; i++) for (const block of ecBlocks) out.push(block[i]);
  return out;
}

// ----------------------------------------------------------------- placement
function blankMatrix(size) {
  const modules = [];
  const reserved = [];
  for (let y = 0; y < size; y++) {
    modules.push(new Array(size).fill(false));
    reserved.push(new Array(size).fill(false));
  }
  return { modules, reserved };
}

function drawFunctionPatterns(m, size, version) {
  const set = (y, x, dark) => {
    if (y < 0 || x < 0 || y >= size || x >= size) return;
    m.modules[y][x] = dark;
    m.reserved[y][x] = true;
  };

  // Finder patterns plus their separators, at three corners.
  for (const [oy, ox] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const inner = y >= 0 && y <= 6 && x >= 0 && x <= 6;
        const ring = inner && (y === 0 || y === 6 || x === 0 || x === 6);
        const core = inner && y >= 2 && y <= 4 && x >= 2 && x <= 4;
        set(oy + y, ox + x, ring || core);
      }
    }
  }

  // Timing patterns — the alternating row and column that tell a scanner the
  // module pitch.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment patterns, skipping the finder corners.
  const centres = ALIGNMENT[version - 1];
  for (const cy of centres) {
    for (const cx of centres) {
      const nearFinder = (cy === 6 && cx === 6)
        || (cy === 6 && cx === centres[centres.length - 1])
        || (cy === centres[centres.length - 1] && cx === 6);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(cy + dy, cx + dx, Math.max(Math.abs(dy), Math.abs(dx)) !== 1);
        }
      }
    }
  }

  // The format information areas are written after masking, but they must be
  // reserved now so data never lands there. Index 6 is skipped in both loops:
  // those two modules belong to the timing patterns drawn above, and blanking
  // them here would quietly break the pitch reference.
  for (let i = 0; i < 9; i++) { if (i === 6) continue; set(8, i, false); set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  set(size - 8, 8, true); // dark module
}

// The zigzag walk: two-module-wide columns from the right, alternating
// upward and downward, skipping the vertical timing column.
function eachDataModule(size, m, visit) {
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!m.reserved[y][x]) visit(y, x, bit++);
      }
    }
  }
}

function placeData(m, size, bytes) {
  eachDataModule(size, m, (y, x, bit) => {
    const byte = bytes[bit >>> 3];
    m.modules[y][x] = byte === undefined ? false : ((byte >>> (7 - (bit & 7))) & 1) === 1;
  });
}

export const MASKS = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (y, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

function applyMask(m, size, mask) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!m.reserved[y][x] && MASKS[mask](y, x)) m.modules[y][x] = !m.modules[y][x];
    }
  }
}

// BCH(15,5), then XOR with the standard mask so an all-zero format is still
// distinguishable from blank tape.
function formatBits(mask) {
  let value = (ECC_M << 3) | mask;
  let rem = value;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((value << 10) | rem) ^ 0x5412;
}

function drawFormat(m, size, mask) {
  const bits = formatBits(mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  // Copy one: around the top-left finder.
  for (let i = 0; i <= 5; i++) m.modules[8][i] = bit(i);
  m.modules[8][7] = bit(6);
  m.modules[8][8] = bit(7);
  m.modules[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) m.modules[14 - i][8] = bit(i);
  // Copy two: seven modules climbing the column above the bottom-left finder
  // (stopping just below the dark module), then eight running to the right
  // edge along row 8. Fifteen cells, and the dark module is not one of them.
  for (let i = 0; i <= 6; i++) m.modules[size - 1 - i][8] = bit(i);
  for (let i = 7; i <= 14; i++) m.modules[8][size - 15 + i] = bit(i);
  m.modules[size - 8][8] = true; // dark module, never masked
}

// ------------------------------------------------------------------ penalty
function penalty(modules, size) {
  let score = 0;

  const runScore = (line) => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) { run++; continue; }
      if (run >= 5) total += 3 + (run - 5);
      run = 1;
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };

  // Rule 1: runs of five or more.
  for (let i = 0; i < size; i++) {
    score += runScore(modules[i]);
    score += runScore(modules.map((row) => row[i]));
  }
  // Rule 2: 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  // Rule 3: the finder-like 1:1:3:1:1 sequence anywhere else.
  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const matches = (line, at, seq) => seq.every((v, k) => line[at + k] === v);
  for (let i = 0; i < size; i++) {
    const row = modules[i];
    const col = modules.map((r) => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      for (const seq of [pattern, [...pattern].reverse()]) {
        if (matches(row, j, seq)) score += 40;
        if (matches(col, j, seq)) score += 40;
      }
    }
  }
  // Rule 4: overall imbalance between dark and light.
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

// -------------------------------------------------------------------- public
export function matrix(text) {
  const bytes = toBytes(text);
  const version = pickVersion(bytes.length);
  if (!version) throw new Error('qr: text too long for versions 1-6');
  const size = 17 + version * 4;
  const stream = codewords(bytes, version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = blankMatrix(size);
    drawFunctionPatterns(m, size, version);
    placeData(m, size, stream);
    applyMask(m, size, mask);
    drawFormat(m, size, mask);
    const score = penalty(m.modules, size);
    if (!best || score < best.score) best = { score, modules: m.modules, mask, version, size };
  }
  return best;
}

// Returns SVG markup: one path for every dark module, which stays crisp at
// any size and costs nothing to render.
export function svg(text, options) {
  const opts = options || {};
  const quiet = opts.quiet === undefined ? 2 : opts.quiet; // modules of margin
  const { modules, size } = matrix(text);
  const dim = size + quiet * 2;

  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  const light = opts.light || '#E9ECF5';
  const dark = opts.dark || '#070910';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img"${
    opts.label ? ` aria-label="${opts.label}"` : ' aria-hidden="true"'
  }><rect width="${dim}" height="${dim}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

// Exposed for test-qr.js, which reads a finished matrix back into codewords
// — the only way to check placement and masking without a camera.
export const internals = {
  eachDataModule, eccBlock, formatBits, codewords, pickVersion, toBytes, blankMatrix, drawFunctionPatterns,
};
