#!/usr/bin/env node
// Builds FACTORY_KEYMAPS, the factory keymap of every keyboard KeyAble has a layout for,
// and writes it into KeyAble.html between the two GENERATED FACTORY_KEYMAPS markers.
//
// Each entry comes from one of three places, best first:
// - ZMK boards (the B6 Pro): their shipped .uf2 firmware (zmk-firmware.mjs).
// - ZMK Ultra 8K boards: Keychron's ZMK source (zmk-source.mjs), translated as the keyboard
//   translates it for VIA on first boot.
// - QMK boards with a downloaded binary: the shipped codes from the binary, at the
//   positions the source gives (firmware-binaries.mjs). Keychron builds binaries from
//   whatever commit it likes, so they can differ from the pinned source.
// - Every other QMK board: its firmware source (factory-keymap-source.js), found by
//   product ID (keyboard-sources.mjs).
//
// Shape per PID:
//   roles:    { mac, win, macFn, winFn, fn2 }, only when the layer order is not canonical
//   layers:   [ { "row,col": code, ... }, ... ], index = device layer
//   encoders: [ [ { ccw, cw }, ... ], ... ],     index = device layer, then knob
//   reportsNone: [ "layer:row,col", ... ], keys the keyboard reports as 0 until written,
//                though they type their code in layers (Win+H on some Ultra 8K boards)
//
// Usage:
//   node DevTools/build-factory-dataset.mjs check
//     builds the table and lists every entry that differs from the app's; changes nothing
//   node DevTools/build-factory-dataset.mjs write
//     builds the table and writes it into KeyAble.html
// A board whose source cannot be read stops the build, and nothing is written.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { APP, appTables, firmwareSource, hex } from './keyboard-sources.mjs';
import { shippedEntries } from './firmware-binaries.mjs';
import { zmkEntries } from './zmk-firmware.mjs';
import { ultraBoards } from './zmk-source.mjs';

const require = createRequire(import.meta.url);
const { factoryKeymap } = require('./factory-keymap-source.js');

const BEGIN = '// BEGIN GENERATED FACTORY_KEYMAPS\n';
const END   = '// END GENERATED FACTORY_KEYMAPS\n';

// Boards whose own source keymap has the wrong key positions, by product ID: the board
// whose source gives the right ones. Their codes must come from their own binary, since
// the other board's source holds that board's codes (RGB lighting keys on a White one),
// so the build fails if the binary is missing.
const POSITIONS_FROM = {
  0x0A54: 0x0A51,   // K5 Max ISO White: its source keymap is a copy of the ANSI one
};

// Every board's entry, as a Map of pid to { roles, layers, encoders, file }, where `file`
// names the shipped firmware the codes came from (absent for source entries).
function buildEntries() {
  const { KEYBOARD_DB, KEYCHRON_LAYOUTS } = appTables();
  const pids = Object.keys(KEYBOARD_DB).map(Number)
    .filter(pid => KEYCHRON_LAYOUTS[KEYBOARD_DB[pid].layoutId]);

  const fromSource = {};
  const failures = [];
  for (const pid of pids.filter(p => !KEYBOARD_DB[p].firmware)) {
    const src = firmwareSource(POSITIONS_FROM[pid] ?? pid);
    try {
      if (src.error) throw new Error(src.error);
      const layouts = Object.fromEntries(Object.entries(src.layouts)
        .map(([name, def]) => [name, (def.layout || []).map(k => k.matrix)]));
      fromSource[pid] = factoryKeymap(readFileSync(src.keymapFile, 'utf8'), layouts, src.lockOpts);
    } catch (err) {
      failures.push(`${hex(pid)} ${KEYBOARD_DB[pid].name}: ${err.message}${src.source ? ` (${src.source})` : ''}`);
    }
  }
  if (failures.length) throw new Error(`cannot read the factory keymap of:\n  ${failures.join('\n  ')}`);

  const entries = new Map();
  const shipped = shippedEntries(fromSource);
  for (const [pid, entry] of Object.entries(fromSource).map(([p, e]) => [Number(p), e])) {
    const bin = shipped.get(pid);
    if (!bin && POSITIONS_FROM[pid]) {
      throw new Error(`${hex(pid)} ${KEYBOARD_DB[pid].name}: takes its positions from ${hex(POSITIONS_FROM[pid])}, so needs its own binary`);
    }
    entries.set(pid, bin ? { ...entry, layers: bin.layers, file: bin.file } : entry);
  }
  const zmk = zmkEntries();
  for (const pid of pids.filter(p => KEYBOARD_DB[p].firmware === 'zmk')) {
    const fw = zmk.get(pid);
    if (!fw) throw new Error(`${hex(pid)} ${KEYBOARD_DB[pid].name}: no ZMK firmware downloaded for it`);
    entries.set(pid, { roles: null, layers: fw.layers, encoders: fw.layers.map(() => []), file: fw.file });
  }
  const ultra = new Map(ultraBoards().map(b => [b.pid, b]));
  const canonical = r => r.mac === 0 && r.macFn === 1 && r.win === 2 && r.winFn === 3;
  for (const pid of pids.filter(p => KEYBOARD_DB[p].firmware === 'zmk-ultra')) {
    const b = ultra.get(pid);
    if (!b || b.error) throw new Error(`${hex(pid)} ${KEYBOARD_DB[pid].name}: ${b ? b.error : 'not in the ZMK Ultra source'}`);
    entries.set(pid, { roles: canonical(b.roles) ? null : b.roles, layers: b.layers, encoders: b.encoders, reportsNone: b.reportsNone });
  }
  return entries;
}

function renderEntry(pid, e) {
  return (e.file ? `  // Shipped firmware: ${e.file}\n` : '') +
    `  ${hex(pid)}: {\n` +
    (e.roles ? `    roles: ${JSON.stringify(e.roles)},\n` : '') +
    `    layers: [\n${e.layers.map(l => `      ${JSON.stringify(l)},\n`).join('')}    ],\n` +
    `    encoders: [\n${e.encoders.map(k => `      ${JSON.stringify(k)},\n`).join('')}    ],\n` +
    (e.reportsNone?.length ? `    reportsNone: ${JSON.stringify(e.reportsNone)},\n` : '') +
    '  },\n';
}

function renderTable(entries) {
  return BEGIN +
    '// Per-model factory keymaps, keyed by USB product ID. Do not edit by hand: run\n' +
    '// DevTools/build-factory-dataset.mjs write. An entry marked "Shipped firmware" holds the\n' +
    '// codes from that Keychron firmware file; the others come from the firmware source.\n' +
    '// layers[layer]["row,col"] = 16-bit factory code, by DEVICE layer number. Canonical\n' +
    '// 4-layer boards: Mac=0, MacFn=1, Win=2, WinFn=3. Others (5-layer V2 Max, K6 Pro and\n' +
    '// wired V2) carry `roles` {mac,win,macFn,winFn,fn2} giving each layer\'s index; the app\n' +
    '// uses the canonical map when `roles` is absent. `reportsNone` lists, as "layer:row,col",\n' +
    '// keys the keyboard reads back as 0 until written, though they type their code here.\n' +
    'const FACTORY_KEYMAPS = {\n' +
    [...entries.keys()].sort((a, b) => a - b).map(pid => renderEntry(pid, entries.get(pid))).join('') +
    '};\n' + END;
}

// The app's source with LF line endings, and the line ending it has on disk: a Windows
// checkout with core.autocrlf has CRLF.
function readApp() {
  const raw = readFileSync(APP, 'utf8');
  return { html: raw.replace(/\r\n/g, '\n'), eol: raw.includes('\r\n') ? '\r\n' : '\n' };
}

// The app's table text, from the BEGIN marker to the end of the END marker's line.
function tableSpan(html) {
  const start = html.indexOf(BEGIN);
  const end = html.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error(`${APP} has no GENERATED FACTORY_KEYMAPS markers`);
  return { start, end: end + END.length };
}

// Each entry's text in a rendered table, by pid, for comparing entry by entry.
function entryTexts(table) {
  const out = new Map();
  for (const m of table.matchAll(/(?:  \/\/ Shipped firmware: [^\n]*\n)?  (0x[0-9A-F]{4}): \{\n[\s\S]*?\n  \},\n/g)) {
    out.set(Number(m[1]), m[0]);
  }
  return out;
}

function check() {
  const { html } = readApp();
  const { start, end } = tableSpan(html);
  const ours = entryTexts(renderTable(buildEntries()));
  const app = entryTexts(html.slice(start, end));
  const differ = [];
  for (const pid of new Set([...ours.keys(), ...app.keys()])) {
    if (!app.has(pid)) differ.push(`${hex(pid)}: new, not in the app`);
    else if (!ours.has(pid)) differ.push(`${hex(pid)}: in the app, not built`);
    else if (app.get(pid) !== ours.get(pid)) differ.push(`${hex(pid)}: differs`);
  }
  console.log(`${ours.size} entries built; ${differ.length ? `${differ.length} differ from the app:` : 'all match the app'}`);
  differ.forEach(d => console.log(`  ${d}`));
  return differ.length === 0;
}

function write() {
  const { html, eol } = readApp();
  const { start, end } = tableSpan(html);
  const table = renderTable(buildEntries());
  writeFileSync(APP, (html.slice(0, start) + table + html.slice(end)).replace(/\n/g, eol));
  console.log(`FACTORY_KEYMAPS written: ${entryTexts(table).size} entries`);
}

const mode = process.argv[2];
try {
  if (mode === 'check') process.exitCode = check() ? 0 : 1;
  else if (mode === 'write') write();
  else { console.error('usage: check | write'); process.exitCode = 1; }
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exitCode = 1;
}
