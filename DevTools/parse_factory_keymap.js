#!/usr/bin/env node
/*
 * parse_factory_keymap.js: extracts one model's factory keymap from its firmware.
 *
 * Reads a Keychron QMK source PAIR for one model variant:
 *   - info.json   (defines layouts.LAYOUT_xxx.layout = ordered [row,col] list)
 *   - keymap.c    (defines every layer in that same positional order,
 *                  plus encoder_map for the rotary knob)
 *
 * Writes parsed.json beside keymap.c with the factory QMK token at each
 * (row,col) of every layer block. info.json position order equals keymap.c
 * argument order, so the two zip together with no guessing.
 *
 * Each position is emitted with BOTH its raw QMK token (e.g. KC_LOPTN,
 * MO(MAC_FN), _______) AND the 16-bit code CMD_GET_KEY returns, resolved via
 * token-keycodes.js (the model-independent table shared by all models). An
 * unresolved token or a layer whose length differs from the layout is a hard
 * error, and no parsed.json is written, so build-factory-dataset.js never
 * bundles a gap.
 *
 * Usage:  node parse_factory_keymap.js <info.json> <keymap.c> [--winlock] [--maclock]
 *   --winlock / --maclock: set the Keychron lock-screen build flags for this
 *   model (shift the custom-keycode block). Default both off (V5 Max).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { resolveToken } = require('./token-keycodes.js');
const { stripComments, layerBlocks, defines, expandDefines } = require('./keymap-source.js');
const Hjson = require('hjson');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith('--'));
const positional = argv.filter(a => !a.startsWith('--'));
const [infoPath, keymapPath] = positional;
if (!infoPath || !keymapPath) die('usage: node parse_factory_keymap.js <info.json> <keymap.c> [--winlock] [--maclock]');
const lockOpts = { winLock: flags.includes('--winlock'), macLock: flags.includes('--maclock') };

const infoRaw = fs.readFileSync(infoPath, 'utf8');
const keymap  = stripComments(fs.readFileSync(keymapPath, 'utf8'));

// Layer enum order from keymap.c. Boards differ, so the canonical order is never assumed.
function parseLayerEnum(src) {
  const m = src.match(/enum\s+layers\s*\{([^}]*)\}/);
  if (!m) die('could not find `enum layers { ... }` in keymap.c');
  const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const idx = {};
  names.forEach((n, i) => { idx[n] = i; });
  return { names, idx };
}

// encoder_map: [LAYER] = {ENCODER_CCW_CW(ccw, cw), ...}
function extractEncoderMap(src) {
  const mapM = src.match(/encoder_map\s*\[\s*\]\s*\[[^\]]*\]\s*\[\s*2\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!mapM) return null;
  const re = /\[(\w+)\]\s*=\s*\{([\s\S]*?)\}\s*,?/g;
  const out = {};
  let m;
  while ((m = re.exec(mapM[1])) !== null) {
    const encoders = [];
    const er = /ENCODER_CCW_CW\(([^,]+),([^)]+)\)/g;
    let e;
    while ((e = er.exec(m[2])) !== null) {
      encoders.push({ ccw: e[1].trim(), cw: e[2].trim() });
    }
    out[m[1]] = encoders;
  }
  return out;
}

// Layout matrix order from info.json, read as Hjson as QMK reads it: some board files
// have missing or trailing commas.
function parseInfoLayouts(raw) {
  const info = Hjson.parse(raw);
  const layouts = {};
  for (const [name, def] of Object.entries(info.layouts || {})) {
    layouts[name] = (def.layout || []).map(k => k.matrix); // [ [row,col], ... ]
  }
  return { pid: info.usb && info.usb.pid, layouts };
}

// Per-model layer ROLES from the MO() references, independent of layer names.
// The wireless 5-layer boards name their Fn layers MAC_FN1/WIN_FN1/FN2, the wired
// V2 uses _FN1/_FN2/_FN3, and the canonical 4-layer boards use MAC_FN/WIN_FN. In
// all of them the MAC_BASE block reaches Mac's Fn layer via MO(), WIN_BASE reaches
// Windows', and a layer reached from BOTH bases is a shared extra (FN2, preserve-only).
function moTargets(blocks, layerName, idx) {
  const b = blocks.find(x => x.layer === layerName);
  if (!b) die(`no ${layerName} layer block to derive roles from`);
  const set = new Set();
  for (const tok of b.tokens) {
    const m = String(tok).match(/^MO\(\s*([A-Za-z0-9_]+)\s*\)$/);
    if (m && Object.hasOwn(idx, m[1])) set.add(idx[m[1]]);
  }
  return set;
}
function deriveRoles(blocks, idx) {
  if (idx.MAC_BASE === undefined || idx.WIN_BASE === undefined) {
    die('enum has no MAC_BASE / WIN_BASE - cannot derive layer roles');
  }
  const macRefs = moTargets(blocks, 'MAC_BASE', idx);
  const winRefs = moTargets(blocks, 'WIN_BASE', idx);
  const macOnly = [...macRefs].filter(i => !winRefs.has(i));
  const winOnly = [...winRefs].filter(i => !macRefs.has(i));
  const shared  = [...macRefs].filter(i => winRefs.has(i));
  if (macOnly.length !== 1) die(`expected exactly one Mac-only Fn layer, got [${macOnly}]`);
  if (winOnly.length !== 1) die(`expected exactly one Windows-only Fn layer, got [${winOnly}]`);
  if (shared.length > 1)    die(`expected at most one shared Fn layer, got [${shared}]`);
  const roles = { mac: idx.MAC_BASE, win: idx.WIN_BASE, macFn: macOnly[0], winFn: winOnly[0] };
  if (shared.length === 1) roles.fn2 = shared[0];   // shared extra layer (preserve-only)
  return roles;
}

// ===================== run =====================
const { names: layerNames, idx: layerIdx } = parseLayerEnum(keymap);
lockOpts.layerIndex = layerIdx;   // resolve MO() against THIS model's enum
const blocks = layerBlocks(keymap);
const encMap = extractEncoderMap(keymap);
const defs   = defines(keymap);
const { pid, layouts } = parseInfoLayouts(infoRaw);

if (!blocks.length) die('no LAYOUT layer blocks found in keymap.c');
const macro = blocks[0].macro;
if (!blocks.every(b => b.macro === macro)) die('mixed LAYOUT macros across layers: ' + blocks.map(b => b.macro).join(','));

const matrix = layouts[macro];
if (!matrix) die(`info.json has no layout named ${macro} (has: ${Object.keys(layouts).join(', ')})`);

console.log(`# model pid ${pid}  macro ${macro}  positions ${matrix.length}`);
let mismatches = 0;
for (const b of blocks) {
  const ok = b.tokens.length === matrix.length;
  if (!ok) mismatches++;
  console.log(`# layer ${b.layer.padEnd(9)} args ${b.tokens.length}  vs matrix ${matrix.length}  [${ok ? 'OK' : 'MISMATCH'}]`);
}
if (mismatches) die(`${mismatches} layer(s) do not match the ${macro} positions, so keys cannot be placed`);
if (encMap) {
  for (const [layer, encs] of Object.entries(encMap)) {
    console.log(`# encoder ${layer.padEnd(9)} ${encs.map(e => `CCW=${e.ccw} CW=${e.cw}`).join(' | ')}`);
  }
}

// Resolve every token to its 16-bit code; collect any the table cannot resolve.
const unresolved = new Set();
function toCode(token) {
  const code = resolveToken(expandDefines(token, defs), lockOpts);
  if (code === null) unresolved.add(String(token).trim());
  return code;
}

// Per-model layer enum (device indices) + derived roles. The bundler places
// each layer at its REAL device index and ships `roles` so the app can map an
// OS view to the correct layer instead of assuming the canonical 4-layer order.
const roles = deriveRoles(blocks, layerIdx);
console.log(`# layer roles: ${JSON.stringify(roles)}  (${layerNames.length} layers: ${layerNames.join(', ')})`);

// A per-layer (row,col,token,code) dump as JSON, for the bundler and for inspection.
const result = {
  pid, macro, matrixLen: matrix.length, lockOpts,
  layerEnum: { names: layerNames, idx: layerIdx },
  roles,
  layers: {}, encoders: {},
};
for (const b of blocks) {
  result.layers[b.layer] = matrix.map(([row, col], i) => ({ row, col, token: b.tokens[i], code: toCode(b.tokens[i]) }));
}
if (encMap) {
  for (const [layer, encs] of Object.entries(encMap)) {
    result.encoders[layer] = encs.map(e => ({
      ccw: e.ccw, ccwCode: toCode(e.ccw),
      cw: e.cw, cwCode: toCode(e.cw),
    }));
  }
}

if (unresolved.size) {
  die(`${unresolved.size} token(s) had no keycode, which the table needs before bundling: ${[...unresolved].join(', ')}`);
}
fs.writeFileSync(path.join(path.dirname(keymapPath), 'parsed.json'), JSON.stringify(result, null, 1));
console.log('# DONE all layers aligned, 0 unresolved');
