#!/usr/bin/env node
/*
 * parse_factory_keymap.js  -  Phase 2 factory-default extractor.
 *
 * Reads a Keychron QMK source PAIR for one model variant:
 *   - info.json   (defines layouts.LAYOUT_xxx.layout = ordered [row,col] list)
 *   - keymap.c    (defines all 4 layers in that same positional order,
 *                  plus encoder_map for the rotary knob)
 *
 * Emits, for every layer (MAC_BASE / MAC_FN / WIN_BASE / WIN_FN), the factory
 * QMK token at each (row,col). This is the deterministic zip the notes call for:
 * info.json position order == keymap.c arg order, so we never guess.
 *
 * Each position is emitted with BOTH its raw QMK token (e.g. KC_LOPTN,
 * MO(MAC_FN), _______) AND the 16-bit code CMD_GET_KEY returns, resolved via
 * token-keycodes.js (the model-independent table shared by all models). Any
 * token the table cannot resolve is a hard error, so the batch never bundles a
 * gap silently.
 *
 * Usage:  node parse_factory_keymap.js <info.json> <keymap.c> [--winlock] [--maclock]
 *   --winlock / --maclock: set the Keychron lock-screen build flags for this
 *   model (shift the custom-keycode block). Default both off (V5 Max).
 */
'use strict';
const fs = require('fs');
const TokenKeycodes = require('./token-keycodes.js');

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

const argv = process.argv.slice(2);
const flags = argv.filter(a => a.startsWith('--'));
const positional = argv.filter(a => !a.startsWith('--'));
const [infoPath, keymapPath] = positional;
if (!infoPath || !keymapPath) die('usage: node parse_factory_keymap.js <info.json> <keymap.c> [--winlock] [--maclock]');
const lockOpts = { winLock: flags.includes('--winlock'), macLock: flags.includes('--maclock') };

const infoRaw   = fs.readFileSync(infoPath, 'utf8');
const keymapRaw = fs.readFileSync(keymapPath, 'utf8');

// --- 1. Layer enum order from keymap.c (do NOT assume the canonical order) ---
function parseLayerEnum(src) {
  const m = src.match(/enum\s+layers\s*\{([^}]*)\}/);
  if (!m) die('could not find `enum layers { ... }` in keymap.c');
  const names = m[1].split(',').map(s => s.replace(/\/\/.*$/gm, '').trim()).filter(Boolean);
  const idx = {};
  names.forEach((n, i) => { idx[n] = i; });
  return { names, idx };
}

// --- 2. Strip C comments so they never pollute the arg split ---
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
}

// --- 3. Paren-aware comma split (so MO(MAC_FN), LT(1,KC_A) stay intact) ---
function splitTopLevel(argsStr) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of argsStr) {
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

// --- 4. Extract each `[LAYER] = LAYOUT_xxx( ... )` block by balancing parens ---
function extractLayerBlocks(src) {
  const clean = stripComments(src);
  const blocks = [];
  const re = /\[(\w+)\]\s*=\s*(LAYOUT\w*)\s*\(/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const layer = m[1], macro = m[2];
    let i = re.lastIndex, depth = 1, start = i;
    for (; i < clean.length && depth > 0; i++) {
      if (clean[i] === '(') depth++;
      else if (clean[i] === ')') depth--;
    }
    const inner = clean.slice(start, i - 1);
    blocks.push({ layer, macro, args: splitTopLevel(inner) });
  }
  return blocks;
}

// --- 5. Extract encoder_map: [LAYER] = {ENCODER_CCW_CW(ccw, cw), ...} ---
function extractEncoderMap(src) {
  const clean = stripComments(src);
  const mapM = clean.match(/encoder_map\s*\[\s*\]\s*\[[^\]]*\]\s*\[\s*2\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!mapM) return null;
  const body = mapM[1];
  const re = /\[(\w+)\]\s*=\s*\{([\s\S]*?)\}\s*,?/g;
  const out = {};
  let m;
  while ((m = re.exec(body)) !== null) {
    const layer = m[1];
    const encoders = [];
    const er = /ENCODER_CCW_CW\(([^,]+),([^)]+)\)/g;
    let e;
    while ((e = er.exec(m[2])) !== null) {
      encoders.push({ ccw: e[1].trim(), cw: e[2].trim() });
    }
    out[layer] = encoders;
  }
  return out;
}

// --- 6. Layout matrix order from info.json ---
function parseInfoLayouts(raw) {
  const info = JSON.parse(raw);
  const layouts = {};
  for (const [name, def] of Object.entries(info.layouts || {})) {
    layouts[name] = (def.layout || []).map(k => k.matrix); // [ [row,col], ... ]
  }
  return { pid: info.usb && info.usb.pid, layouts };
}

// --- 6b. Derive per-model layer ROLES from the MO() references ------------
// Name-independent: the wireless 5-layer boards name their Fn layers MAC_FN1/
// WIN_FN1/FN2, the wired V2 uses _FN1/_FN2/_FN3, and the canonical 4-layer
// boards use MAC_FN/WIN_FN. What is stable across all of them is that the
// MAC_BASE block reaches Mac's Fn layer via MO(), WIN_BASE reaches Windows',
// and any layer reached from BOTH bases is a shared extra (FN2, preserve-only).
function moTargets(blocks, layerName, idx) {
  const b = blocks.find(x => x.layer === layerName);
  if (!b) die(`no ${layerName} layer block to derive roles from`);
  const set = new Set();
  for (const tok of b.args) {
    const m = String(tok).match(/^MO\(\s*([A-Za-z0-9_]+)\s*\)$/);
    if (m && idx.hasOwnProperty(m[1])) set.add(idx[m[1]]);
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
const { names: layerNames, idx: layerIdx } = parseLayerEnum(keymapRaw);
lockOpts.layerIndex = layerIdx;   // resolve MO() against THIS model's enum
const blocks   = extractLayerBlocks(keymapRaw);
const encMap   = extractEncoderMap(keymapRaw);
const { pid, layouts } = parseInfoLayouts(infoRaw);

if (!blocks.length) die('no LAYOUT layer blocks found in keymap.c');
const macro = blocks[0].macro;
if (!blocks.every(b => b.macro === macro)) die('mixed LAYOUT macros across layers: ' + blocks.map(b=>b.macro).join(','));

const matrix = layouts[macro];
if (!matrix) die(`info.json has no layout named ${macro} (has: ${Object.keys(layouts).join(', ')})`);

console.log(`# model pid ${pid}  macro ${macro}  positions ${matrix.length}`);
let problems = 0;
for (const b of blocks) {
  const tag = b.args.length === matrix.length ? 'OK ' : 'MISMATCH';
  if (b.args.length !== matrix.length) problems++;
  console.log(`# layer ${b.layer.padEnd(9)} args ${b.args.length}  vs matrix ${matrix.length}  [${tag}]`);
}
if (encMap) {
  for (const [layer, encs] of Object.entries(encMap)) {
    console.log(`# encoder ${layer.padEnd(9)} ${encs.map(e => `CCW=${e.ccw} CW=${e.cw}`).join(' | ')}`);
  }
}

// Board-local object-like #defines (e.g. `#define KC_FLXP LGUI(KC_E)`), which
// override header defaults per model. Function-like macros (name directly
// followed by `(`) are skipped by requiring whitespace after the name.
function parseDefines(src) {
  const map = {};
  const re = /^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]+(\S.*?)[ \t]*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) map[m[1]] = m[2].trim();
  return map;
}
const defines = parseDefines(stripComments(keymapRaw));
function expandToken(token) {
  let t = String(token).trim();
  for (let i = 0; i < 8 && defines.hasOwnProperty(t); i++) t = defines[t].trim();
  return t;
}

// Resolve every token to its 16-bit code; collect any the table cannot resolve.
const unresolved = new Set();
function toCode(token) {
  const expanded = expandToken(token);
  const code = TokenKeycodes.resolveToken(expanded, lockOpts);
  if (code == null) unresolved.add(String(token).trim());
  return code;
}

// Per-model layer enum (device indices) + derived roles. The bundler places
// each layer at its REAL device index and ships `roles` so the app can map an
// OS view to the correct layer instead of assuming the canonical 4-layer order.
const roles = deriveRoles(blocks, layerIdx);
console.log(`# layer roles: ${JSON.stringify(roles)}  (${layerNames.length} layers: ${layerNames.join(', ')})`);

// Emit a per-layer (row,col,token,code) dump as JSON for inspection/diff.
const result = {
  pid, macro, matrixLen: matrix.length, lockOpts,
  layerEnum: { names: layerNames, idx: layerIdx },
  roles,
  layers: {}, encoders: {},
};
for (const b of blocks) {
  const layer = [];
  for (let i = 0; i < matrix.length; i++) {
    layer.push({ row: matrix[i][0], col: matrix[i][1], token: b.args[i], code: toCode(b.args[i]) });
  }
  result.layers[b.layer] = layer;
}
if (encMap) {
  for (const [layer, encs] of Object.entries(encMap)) {
    result.encoders[layer] = encs.map(e => ({
      ccw: e.ccw, ccwCode: toCode(e.ccw),
      cw: e.cw, cwCode: toCode(e.cw),
    }));
  }
}

fs.writeFileSync(keymapPath.replace(/keymap\.c$/, 'parsed.json'), JSON.stringify(result, null, 1));

if (unresolved.size) {
  console.error(`# UNRESOLVED ${unresolved.size} token(s): ${[...unresolved].join(', ')}`);
  die(`${unresolved.size} token(s) had no keycode (see list above); table needs them before batching`);
}
console.log(problems ? `# DONE with ${problems} MISMATCH layer(s)` : '# DONE all layers aligned, 0 unresolved');
