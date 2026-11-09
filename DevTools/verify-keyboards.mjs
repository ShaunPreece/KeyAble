#!/usr/bin/env node
// Checks every keyboard KeyAble supports against that keyboard's own firmware: each key
// in the app's layout must sit at a matrix position the firmware defines and carry the
// name keyNaming gives the firmware key there, and every firmware key must be in the
// layout. It also checks the factory dataset covers the same positions with the same
// codes, and that Keychron's VIA definition for the board agrees with the firmware.
// Sources and naming rules: keyboard-sources.mjs.
//
// VERIFIED needs the app to match the firmware AND a VIA definition to agree with it.
// FIRMWARE ONLY: the app matches the firmware and no VIA definition exists.
//
// Usage: node DevTools/verify-keyboards.mjs [--details]
// Exit code 1 when any keyboard with a layout is not VERIFIED or FIRMWARE ONLY, or
// when two matching boards name a key differently.
import { appTables, firmwareBoard, viaBoards, compareViaWithFirmware, keyNaming } from './keyboard-sources.mjs';

const DETAILS = process.argv.includes('--details');
const tables = appTables();
const { KEYCHRON_LAYOUTS, KEYBOARD_DB, FACTORY_KEYMAPS } = tables;
const { nameOf, conflicts } = keyNaming(tables);
const hex = n => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

function layoutProblems(layout, board) {
  const problems = [];
  // The app reads whole layers from the firmware's keymap buffer by these numbers, so
  // a wrong size reads every key from the wrong place.
  const size = board.matrixSize;
  if (!size) problems.push('the firmware declares no matrix size');
  else if (layout.rows !== size.rows || layout.cols !== size.cols) {
    problems.push(`matrix is ${layout.rows}x${layout.cols} in the app, ${size.rows}x${size.cols} in the firmware`);
  }
  const index = new Map(board.keys.map((k, i) => [k.pos, i]));
  const appAt = new Set(layout.keys.map(k => `${k.row},${k.col}`));
  for (const k of layout.keys) {
    const pos = `${k.row},${k.col}`;
    if (!index.has(pos)) { problems.push(`${k.label} at (${pos}): the firmware has no key there`); continue; }
    const want = nameOf(board, index.get(pos));
    if (want.error) problems.push(`${k.label} at (${pos}): ${want.error}`);
    else if (want.label !== k.label) problems.push(`${k.label} at (${pos}): the firmware key there is ${want.label}`);
    else if (!!want.isEncoder !== !!k.isEncoder) problems.push(`${k.label} at (${pos}): knob flag differs from the firmware`);
  }
  board.keys.forEach((f, i) => {
    if (appAt.has(f.pos)) return;
    const want = nameOf(board, i);
    problems.push(`(${f.pos}) is ${want.label || f.token} in the firmware, but no key in the app's layout uses it`);
  });
  return problems;
}

function datasetNote(pid, board) {
  const model = FACTORY_KEYMAPS[pid];
  if (!model) return 'no factory dataset';
  const win = model.layers[(model.roles && model.roles.win) ?? 2];
  const dsSet = new Set(Object.keys(win)), fwSet = new Set(board.keys.map(k => k.pos));
  const extra = [...dsSet].filter(p => !fwSet.has(p)).length;
  const missing = [...fwSet].filter(p => !dsSet.has(p)).length;
  const codes = board.keys.filter(k => k.code !== undefined && win[k.pos] !== undefined && win[k.pos] !== k.code).length;
  return extra || missing || codes ? `factory dataset differs: ${extra} extra, ${missing} missing, ${codes} codes` : null;
}

const results = [];
for (const [pidText, entry] of Object.entries(KEYBOARD_DB)) {
  const pid = Number(pidText);
  const layout = KEYCHRON_LAYOUTS[entry.layoutId];
  const r = { pid, name: entry.name, layoutId: entry.layoutId, problems: [], notes: [] };
  results.push(r);
  if (!layout) { r.verdict = 'NO LAYOUT IN APP'; continue; }
  const board = firmwareBoard(pid);
  r.source = board.source;
  if (board.error) { r.verdict = board.error; continue; }

  r.problems = layoutProblems(layout, board);
  const ds = datasetNote(pid, board);
  if (ds) r.notes.push(ds);

  const vias = viaBoards(pid);
  let viaAgrees = vias.length > 0;
  for (const v of vias) {
    const c = compareViaWithFirmware(board.keys, v);
    if (c.viaOnly.length || c.fwOnly.length > (board.hasEncoder ? 1 : 0) || !c.sameOrder) {
      viaAgrees = false;
      r.notes.push(`VIA ${v.source} disagrees with the firmware: VIA-only ${c.viaOnly.join(' ') || 'none'}, ` +
        `firmware-only ${c.fwOnly.join(' ') || 'none'}${c.sameOrder ? '' : ', physical order differs'}`);
    }
  }
  if (!vias.length) r.notes.push('no VIA definition');

  if (r.problems.length) r.verdict = 'LAYOUT WRONG';
  else if (!vias.length) r.verdict = 'FIRMWARE ONLY';
  else r.verdict = viaAgrees ? 'VERIFIED' : 'SOURCES DISAGREE';
}

results.sort((a, b) => a.verdict.localeCompare(b.verdict) || a.pid - b.pid);
const counts = {};
for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
console.log(`KeyAble keyboards checked against their own firmware and VIA definitions: ${results.length}`);
for (const [v, n] of Object.entries(counts)) console.log(`  ${v}: ${n}`);
for (const c of conflicts) console.log(`  NAMING CONFLICT between matching boards: ${c}`);
console.log('');
for (const r of results) {
  console.log(`${r.verdict.padEnd(16)} ${hex(r.pid)} ${r.name} [${r.layoutId}]` +
    (r.problems.length ? `, ${r.problems.length} problems` : '') + (r.notes.length ? `; ${r.notes.join('; ')}` : ''));
  if (DETAILS && r.source) console.log(`    source: ${r.source}`);
  if (DETAILS) for (const p of r.problems) console.log(`    - ${p}`);
}
process.exitCode = conflicts.length ||
  results.some(r => !['VERIFIED', 'FIRMWARE ONLY', 'NO LAYOUT IN APP'].includes(r.verdict)) ? 1 : 0;
