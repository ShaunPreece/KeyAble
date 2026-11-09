#!/usr/bin/env node
// Checks the app's factory keymaps against the firmware Keychron actually ships, which
// can differ from the pinned source: Keychron releases binaries from whatever commit they
// build, and the source moves on after a release.
//
// A QMK binary holds the factory keymap as keymaps[layer][row][col], uint16 little-endian,
// with KC_NO (0) wherever the matrix has no key, and the knob map as
// encoder_map[layer][knob][2], stored { clockwise, anti-clockwise }. Neither table has a
// symbol, so each is found by searching for the shape our data predicts and scoring every
// offset; a table that does not match well is reported as not found, never guessed.
// The binary's USB device descriptor (vendor 0x3434) gives the product ID it is for.
//
// Usage:
//   node DevTools/firmware-binaries.mjs fetch <keychron firmware page url> [...]
//     downloads every .bin linked from the pages into ProjectAssets/keychron-firmware-bin,
//     skipping files already there, and records each one's PIDs in manifest.json
//   node DevTools/firmware-binaries.mjs check [--details]
//     compares FACTORY_KEYMAPS with the newest binary for each PID
//   node DevTools/firmware-binaries.mjs apply
//     rewrites FACTORY_KEYMAPS in KeyAble.html with the shipped codes, so run it after
//     pasting entries from build-factory-dataset.js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, APP, appTables, firmwareBoard } from './keyboard-sources.mjs';

const BIN_DIR  = path.join(ROOT, 'ProjectAssets', 'keychron-firmware-bin');
const MANIFEST = path.join(BIN_DIR, 'manifest.json');
const KEYCHRON_VID = 0x3434;
const hex = n => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

// Every product ID in the binary's USB device descriptors: bLength 0x12, type 0x01,
// then idVendor and idProduct at offsets 8 and 10.
export function descriptorPids(bin) {
  const pids = new Set();
  for (let i = 0; i + 18 <= bin.length; i++) {
    if (bin[i] === 0x12 && bin[i + 1] === 0x01 && bin.readUInt16LE(i + 8) === KEYCHRON_VID) {
      pids.add(bin.readUInt16LE(i + 10));
    }
  }
  return [...pids];
}

// The firmware version in a Keychron file name ("v5_max_ansi_encoder_v1.1.1_2504221451.bin"),
// as numbers for sorting, then the build stamp; files without one sort first.
function versionKey(file) {
  const m = /_v(\d+(?:\.\d+)*)(?:_(\d+))?\.bin$/i.exec(file);
  return m ? [...m[1].split('.').map(Number), Number(m[2] || 0)] : [];
}
const newer = (a, b) => {
  const x = versionKey(a), y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

async function fetchPages(urls) {
  mkdirSync(BIN_DIR, { recursive: true });
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  for (const page of urls) {
    const html = await (await fetch(page)).text();
    const links = [...new Set(html.match(/https?:\/\/[^"'\s<>]+?\.bin(?:\?[^"'\s<>]*)?/gi) || [])]
      .map(u => u.replace(/&amp;/g, '&'));
    console.log(`${page}: ${links.length} binaries`);
    for (const url of links) {
      const file = decodeURIComponent(new URL(url).pathname.split('/').pop());
      const dest = path.join(BIN_DIR, file);
      if (!existsSync(dest)) {
        const res = await fetch(url);
        if (!res.ok) { console.log(`  FAILED ${res.status} ${file}`); continue; }
        writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      }
      manifest[file] = { url, page, pids: descriptorPids(readFileSync(dest)).map(hex) };
    }
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}

// The table of layers x cells words in `bin` laid out like `expected` (an array of layers
// of cells words), as { offset, plainMatched, plainTotal }. Only plain HID keys
// (0x04 to 0xE7) are scored: lighting and Keychron keys are what binaries renumber, and
// letters, digits and modifiers are what identify the table. Layer 0 is scored at every
// even offset, then the full table at the best few.
export function findTable(bin, expected) {
  const cells = expected[0].length;
  const words = expected.length * cells;
  const plain = [];
  expected.forEach((layer, l) => layer.forEach((v, i) => { if (v >= 0x04 && v <= 0xE7) plain.push([l * cells + i, v]); }));
  const plain0 = plain.filter(([i]) => i < cells);
  const scoreAt = (off, list) => list.reduce((s, [i, v]) => s + (bin.readUInt16LE(off + i * 2) === v ? 1 : 0), 0);
  const candidates = [];
  for (let off = 0; off + words * 2 <= bin.length; off += 2) {
    const s = scoreAt(off, plain0);
    if (s >= plain0.length * 0.6) candidates.push([s, off]);
  }
  candidates.sort((a, b) => b[0] - a[0]);
  let best = { offset: -1, plainMatched: 0, plainTotal: plain.length };
  for (const [, off] of candidates.slice(0, 8)) {
    const m = scoreAt(off, plain);
    if (m > best.plainMatched) best = { offset: off, plainMatched: m, plainTotal: plain.length };
  }
  return best;
}

// The newest downloaded binary for each PID, by the version in its file name.
function newestBinaries() {
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  const newestFor = new Map();
  for (const [file, entry] of Object.entries(manifest)) {
    for (const p of entry.pids.map(Number)) if (!newestFor.has(p) || newer(file, newestFor.get(p))) newestFor.set(p, file);
  }
  return newestFor;
}

// One board's factory keymap as shipped: { file, layers } with layers[l]["row,col"] for
// every position in FACTORY_KEYMAPS, plus `diffs` against it and `extra`, the matrix
// positions outside our layout that hold a key in the binary. Or { error }.
function shipped(pid, fk, file) {
  const board = firmwareBoard(pid);
  if (!board.matrixSize) return { error: 'NO MATRIX SIZE' };
  const { rows, cols } = board.matrixSize;
  const bin = readFileSync(path.join(BIN_DIR, file));
  const expected = fk.layers.map(layer => {
    const a = new Array(rows * cols).fill(0);
    for (const [pos, code] of Object.entries(layer)) { const [r, c] = pos.split(',').map(Number); a[r * cols + c] = code; }
    return a;
  });
  const found = findTable(bin, expected);
  if (found.plainMatched < found.plainTotal * 0.95) {
    return { error: `TABLE NOT FOUND (best ${found.plainMatched}/${found.plainTotal} plain keys)` };
  }
  const read = (l, r, c) => bin.readUInt16LE(found.offset + ((l * rows + r) * cols + c) * 2);
  const diffs = [], extra = [];
  const layers = fk.layers.map((layer, l) => {
    const out = {};
    for (const [pos, ours] of Object.entries(layer)) {
      const [r, c] = pos.split(',').map(Number);
      out[pos] = read(l, r, c);
      if (out[pos] !== ours) diffs.push(`layer ${l} (${pos}) ours ${hex(ours)} shipped ${hex(out[pos])}`);
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (!(`${r},${c}` in layer) && read(l, r, c) !== 0) extra.push(`layer ${l} (${r},${c}) holds ${hex(read(l, r, c))}`);
    }
    return out;
  });
  const enc = fk.encoders.flatMap(e => e.flatMap(x => [x.cw, x.ccw]));
  if (enc.length) {
    const needle = Buffer.alloc(enc.length * 2);
    enc.forEach((v, i) => needle.writeUInt16LE(v, i * 2));
    if (bin.indexOf(needle) < 0) diffs.push('knob map not found as ours');
  }
  return { file, layers, diffs, extra };
}

function boardsWithBinaries(each) {
  const newestFor = newestBinaries();
  const { KEYBOARD_DB, KEYCHRON_LAYOUTS, FACTORY_KEYMAPS } = appTables();
  for (const pidText of Object.keys(KEYBOARD_DB).sort((a, b) => a - b)) {
    const pid = Number(pidText), entry = KEYBOARD_DB[pid], fk = FACTORY_KEYMAPS[pid];
    if (!fk || !KEYCHRON_LAYOUTS[entry.layoutId]) continue;
    const file = newestFor.get(pid);
    each(pid, `${hex(pid)} ${entry.name}`, file ? shipped(pid, fk, file) : { error: 'NO BINARY' });
  }
}

function check(details) {
  const counts = {};
  boardsWithBinaries((pid, label, s) => {
    const verdict = s.error ? s.error.split(' (')[0] : s.extra.length ? 'KEYS OUTSIDE LAYOUT' : s.diffs.length ? 'DIFFERS' : 'MATCHES';
    counts[verdict] = (counts[verdict] || 0) + 1;
    const note = s.error ? s.error.slice(verdict.length).trim() : `${s.file}${s.diffs.length ? `; ${s.diffs.length} differences` : ''}${s.extra.length ? `; ${s.extra.length} keys outside the layout` : ''}`;
    console.log(`${verdict.padEnd(20)} ${label}${note ? ` (${note.replace(/^\(|\)$/g, '')})` : ''}`);
    if (details && !s.error) for (const d of [...s.diffs, ...s.extra]) console.log(`    - ${d}`);
  });
  console.log('');
  for (const [v, n] of Object.entries(counts)) console.log(`${v}: ${n}`);
}

// Rewrites each FACTORY_KEYMAPS entry that has a binary with the shipped codes, marked with
// the file they came from. Positions, roles and knob maps are left as they are: a board
// whose knob map differs, or whose binary holds keys outside our layout, is not touched.
function apply() {
  let html = readFileSync(APP, 'utf8');
  const start = html.indexOf('const FACTORY_KEYMAPS = {\n');
  const end = html.indexOf('\n};', start);
  let table = html.slice(start, end);
  let changed = 0;
  boardsWithBinaries((pid, label, s) => {
    if (s.error) return;
    if (s.extra.length || s.diffs.includes('knob map not found as ours')) { console.log(`SKIPPED ${label}: needs a look (check --details)`); return; }
    // An entry is "  0xPPPP: {", an optional roles line, "    layers: [", one line per layer.
    const opening = `  ${hex(pid)}: {\n`;
    let from = table.indexOf(opening);
    if (from < 0) throw new Error(`${label}: entry not found in FACTORY_KEYMAPS`);
    let to = from + opening.length;
    if (table.startsWith('    roles:', to)) to = table.indexOf('\n', to) + 1;
    if (!table.startsWith('    layers: [\n', to)) throw new Error(`${label}: unexpected entry layout`);
    const kept = table.slice(from, to + '    layers: [\n'.length);
    to += '    layers: [\n'.length;
    while (table.startsWith('      {', to)) to = table.indexOf('\n', to) + 1;
    const note = /\n {2}\/\/ Shipped firmware: [^\n]*\n$/.exec(table.slice(0, from));
    if (note) from -= note[0].length - 1;
    const layerLines = s.layers.map(l => `      ${JSON.stringify(l)},\n`).join('');
    const replacement = `  // Shipped firmware: ${s.file}\n${kept}${layerLines}`;
    if (table.slice(from, to) !== replacement) changed++;
    table = table.slice(0, from) + replacement + table.slice(to);
  });
  html = html.slice(0, start) + table + html.slice(end);
  writeFileSync(APP, html);
  console.log(`${changed} entries rewritten from shipped firmware`);
}

// Run as a command only, so other scripts can import findTable and descriptorPids.
const [mode, ...args] = process.argv.slice(2);
if (!process.argv[1] || import.meta.url !== pathToFileURL(process.argv[1]).href) { /* imported */ }
else if (mode === 'fetch' && args.length) await fetchPages(args);
else if (mode === 'check') check(args.includes('--details'));
else if (mode === 'apply') apply();
else { console.error('usage: fetch <page url> [...] | check [--details] | apply'); process.exit(1); }
