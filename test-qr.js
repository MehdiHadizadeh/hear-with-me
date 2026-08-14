// Tests for the vendored QR encoder (public/qr.js).
//
// A QR code is only "correct" if a camera can read it, and there is no camera
// here — so this checks the three layers that could be wrong independently:
//
//   1. the Reed-Solomon step, against the published ISO worked example
//   2. the format information, against the published bit strings for level M
//   3. placement and masking, by reading the finished matrix back out and
//      comparing it to the codewords that went in
//
// Plus the fixed patterns a scanner locks onto before it decodes anything.
import * as QR from './public/qr.js';

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${label}`); return; }
  failed++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
}

const hex = (arr) => Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join(' ');

// ---------------------------------------------------------------------------
console.log('\nreed-solomon');

// ISO/IEC 18004's own worked example: "01234567" in version 1-M. These are its
// sixteen data codewords, and the ten error-correction codewords it must
// produce. If this passes, the Galois field arithmetic and the generator
// polynomial are both right.
const ISO_DATA = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
const ISO_EC = [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55];
const ec = QR.internals.eccBlock(ISO_DATA, 10);
check('version 1-M worked example produces the published EC codewords',
  hex(ec) === hex(ISO_EC), `got      ${hex(ec)}\n       expected ${hex(ISO_EC)}`);

// ---------------------------------------------------------------------------
console.log('\nformat information');

// The published 15-bit format strings for error correction level M, masks 0-7.
const FORMAT_M = [
  '101010000010010', '101000100100101', '101111001111100', '101101101001011',
  '100010111111001', '100000011001110', '100111110010111', '100101010100000',
];
FORMAT_M.forEach((expected, mask) => {
  const got = QR.internals.formatBits(mask).toString(2).padStart(15, '0');
  check(`mask ${mask} format bits`, got === expected, `got ${got}, expected ${expected}`);
});

// ---------------------------------------------------------------------------
console.log('\nfixed patterns');

const sample = QR.matrix('https://hear-with-me.example/r/7K3QFD');
const { modules, size, version, mask } = sample;
console.log(`  (version ${version}, ${size}x${size}, mask ${mask})`);

function finderOk(oy, ox) {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const ring = y === 0 || y === 6 || x === 0 || x === 6;
      const core = y >= 2 && y <= 4 && x >= 2 && x <= 4;
      if (modules[oy + y][ox + x] !== (ring || core)) return false;
    }
  }
  return true;
}
check('top-left finder pattern', finderOk(0, 0));
check('top-right finder pattern', finderOk(0, size - 7));
check('bottom-left finder pattern', finderOk(size - 7, 0));

let timingOk = true;
for (let i = 8; i < size - 8; i++) {
  if (modules[6][i] !== (i % 2 === 0)) timingOk = false;
  if (modules[i][6] !== (i % 2 === 0)) timingOk = false;
}
check('both timing patterns alternate', timingOk);
check('the dark module is dark', modules[size - 8][8] === true);

// Versions 2 and up carry one alignment pattern — a 5x5 target whose centre is
// the second coordinate in the version's table (22 for version 3).
if (version >= 2) {
  const centre = [6, 18, 22, 26, 30, 34][version - 1];
  let alignOk = true;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const expected = Math.max(Math.abs(dy), Math.abs(dx)) !== 1;
      if (modules[centre + dy][centre + dx] !== expected) alignOk = false;
    }
  }
  check(`alignment pattern at (${centre}, ${centre})`, alignOk);
}

// A separator is a light ring around each finder; if masking leaked into the
// function patterns this is the first thing that breaks.
let separatorOk = true;
for (let i = 0; i < 8; i++) {
  if (modules[7][i] || modules[i][7]) separatorOk = false;
  if (modules[7][size - 1 - i] || modules[size - 1 - i][7]) separatorOk = false;
}
check('finder separators stayed light', separatorOk);

// ---------------------------------------------------------------------------
console.log('\nplacement and masking (read back)');

// Rebuild the function-pattern map for this version, undo the mask, then walk
// the same zigzag the encoder used and reassemble the codewords. This is the
// closest thing to pointing a scanner at it: a wrong zigzag, a wrong mask or a
// clobbered reserved cell all show up as different bytes.
function readBack(text) {
  const built = QR.matrix(text);
  const m = QR.internals.blankMatrix(built.size);
  QR.internals.drawFunctionPatterns(m, built.size, built.version);

  const unmasked = built.modules.map((row) => row.slice());
  for (let y = 0; y < built.size; y++) {
    for (let x = 0; x < built.size; x++) {
      if (!m.reserved[y][x] && QR.MASKS[built.mask](y, x)) unmasked[y][x] = !unmasked[y][x];
    }
  }

  const bits = [];
  QR.internals.eachDataModule(built.size, m, (y, x) => bits.push(unmasked[y][x] ? 1 : 0));
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    bytes.push(byte);
  }
  const expected = QR.internals.codewords(QR.internals.toBytes(text), built.version);
  return { got: bytes.slice(0, expected.length), expected, version: built.version };
}

for (const text of [
  'https://hear-with-me.example/r/7K3QFD',          // the real case
  'http://localhost:3000/r/ABC123',
  'x',                                       // smallest version
  'https://a-fairly-long-tunnel-hostname.trycloudflare.com/r/7K3QFD?x=1',
  'A'.repeat(106),                           // the largest input we accept
]) {
  const { got, expected, version } = readBack(text);
  const label = text.length > 28 ? `${text.slice(0, 25)}...` : text;
  check(`"${label}" (v${version}) reads back byte-for-byte`,
    hex(got) === hex(expected), `got      ${hex(got)}\n       expected ${hex(expected)}`);
}

// ---------------------------------------------------------------------------
console.log('\nlimits');

check('106 bytes still encodes', (() => { try { QR.matrix('A'.repeat(106)); return true; } catch (e) { return false; } })());
check('107 bytes is refused rather than truncated',
  (() => { try { QR.matrix('A'.repeat(107)); return false; } catch (e) { return true; } })());

const svg = QR.svg('https://hear-with-me.example/r/7K3QFD', { label: 'test' });
check('svg output is a single self-contained element',
  svg.startsWith('<svg') && svg.endsWith('</svg>') && !svg.includes('http://www.w3.org/1999/xlink'));
check('svg carries the accessible label', svg.includes('aria-label="test"'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
