#!/usr/bin/env node
// Factory keymaps for the Keychron boards that run ZMK (the B Pro series), read from the
// firmware Keychron ships. firmware-binaries.mjs does the same for the QMK boards.
//
// A ZMK keymap is not a table of keycodes: each key position holds a behavior binding,
// { const char *behavior name, uint32 param1, uint32 param2 }, layer after layer. Keychron's
// VIA support (app/src/launcher/map_keycode.c, generate_via_keymaps) turns each binding
// into the 16-bit code the keyboard then reports over VIA, at the matrix position the
// board's overlay gives that key position. This script repeats that translation, so the
// result is what KeyAble reads from a factory-reset board.
//
// Sources: Keychron/zmk branch keychron_bpro, pinned in docs/KEYBOARD-DATA.txt, as a sparse
// clone in ProjectAssets/keychron-firmware-src/keychron-zmk ('/app/src/launcher/' and
// '/app/boards/shields/keychron/'). Firmware: the .uf2 files in
// ProjectAssets/keychron-firmware-bin/zmk.
//
// Usage:
//   node DevTools/zmk-firmware.mjs fetch <keychron firmware page url> [...]
//     downloads every .uf2 linked from the pages, skipping files already there
//   node DevTools/zmk-firmware.mjs show <uf2 file>
//     prints the decoded keymap, layer by layer, by matrix position
// build-factory-dataset.mjs takes these boards' entries from zmkEntries.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, appTables, hex } from './keyboard-sources.mjs';
import { downloadLinkedFiles, versionNewer, runAsCommand } from './firmware-files.mjs';

const BIN_DIR = path.join(ROOT, 'ProjectAssets', 'keychron-firmware-bin', 'zmk');
const SRC     = path.join(ROOT, 'ProjectAssets', 'keychron-firmware-src', 'keychron-zmk', 'app');
const LAUNCHER = path.join(SRC, 'src', 'launcher');
const SHIELDS  = path.join(SRC, 'boards', 'shields', 'keychron');
const KEYCHRON_VID = 0x3434;

// The overlay holding each board's matrix transform, by USB product ID. The firmware file
// names say which shield a build is (zmk_b6pro_uk_..., zmk_b6pro25_uk_... = b6n).
const ZMK_BOARDS = {
  0x0761: 'b6/us/keychron_b6_us.overlay',
  0x0762: 'b6/uk/keychron_b6_uk.overlay',
  0x076C: 'b6n/uk/keychron_b6_ukn.overlay',
};

// ---- UF2 ----
// 512-byte blocks: magic at 0, target address at 12, payload size at 16, payload at 32.
// The result is the flash image and the address of its first byte, which pointers in it
// are relative to.
function readUf2(file) {
  const u = readFileSync(file);
  const blocks = [];
  let base = Infinity, end = 0;
  for (let o = 0; o + 512 <= u.length; o += 512) {
    if (u.readUInt32LE(o) !== 0x0A324655) continue;
    const addr = u.readUInt32LE(o + 12), size = u.readUInt32LE(o + 16);
    blocks.push([addr, u.subarray(o + 32, o + 32 + size)]);
    base = Math.min(base, addr); end = Math.max(end, addr + size);
  }
  if (!blocks.length) throw new Error(`${file}: not a UF2 file`);
  const image = Buffer.alloc(end - base, 0xFF);
  for (const [addr, data] of blocks) data.copy(image, addr - base);
  return { image, base };
}

// Product IDs next to Keychron's vendor ID: the USB device descriptor.
function imagePids(image) {
  const pids = new Set();
  for (let i = 0; i + 4 <= image.length; i += 2) {
    if (image.readUInt16LE(i) === KEYCHRON_VID) pids.add(image.readUInt16LE(i + 2));
  }
  return [...pids];
}

// ---- Keychron's source ----
// "NAME = 0x1234," entries of an enum, and the names that follow a "NAME = OTHER," start
// one by one, as C numbers them.
export function enumValues(text, known = {}) {
  const values = { ...known };
  let next = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*(?:=\s*([A-Za-z0-9_]+))?\s*,?\s*(?:\/\/.*)?$/.exec(line);
    if (!m) continue;
    const [, name, value] = m;
    if (value === undefined) { if (next !== null) values[name] = next++; continue; }
    const v = /^(0x[0-9A-Fa-f]+|\d+)$/.test(value) ? Number(value) : values[value];
    if (v === undefined) { next = null; continue; }
    values[name] = v;
    next = v + 1;
  }
  return values;
}

// "case A: return B;" pairs in the named function of map_keycode.c, resolved to numbers.
// Throws when the function is missing or has no cases: an empty table would turn every
// key it covers into "no action".
export function returnTable(source, fnName, values) {
  const start = source.indexOf(`uint16_t ${fnName}(`);
  if (start < 0) throw new Error(`${fnName} not found in map_keycode.c`);
  const body = source.slice(start, source.indexOf('\n}', start));
  const table = new Map();
  for (const m of body.matchAll(/case\s+(\w+):\s*return\s+(\w+);/g)) {
    if (!(m[1] in values) || !(m[2] in values)) throw new Error(`${fnName}: unknown name ${m[1]} or ${m[2]}`);
    table.set(values[m[1]], values[m[2]]);
  }
  if (!table.size) throw new Error(`${fnName} in map_keycode.c has no "case A: return B;" entries`);
  return table;
}

// The user_custom bindings generate_via_keymaps knows, as ZMK param1 (modifier bits in the
// top byte, then the keyboard-page usage), each to its Keychron code. Transcribed from
// map_keycode.c, whose cases use ZMK key names; keep in step with it.
const LC = 0x01, LS = 0x02, LG = 0x08;
const kp = (mods, usage) => ((mods << 24) | 0x070000 | usage) >>> 0;
const USER_CUSTOM = [
  [kp(LG, 0x36), 'UC_CMD_CMA'],              // LG(COMMA)
  [kp(0, 0xE2), 'UC_LOPT'],                  // LALT
  [kp(0, 0xE6), 'UC_ROPT'],                  // RALT
  [kp(0, 0xE3), 'UC_LCMD'],                  // LCMD
  [kp(0, 0xE7), 'UC_RCMD'],                  // RCMD
  [kp(LC, 0x50), 'UC_CTRL_LEFT'],            // LC(LEFT)
  [kp(LC, 0x4F), 'UC_CTRL_RIGHT'],           // LC(RIGHT)
  [kp(LC | LG, 0x2C), 'UC_EMOJI_MAC'],       // LC(LG(SPACE))
  [kp(LG, 0x2B), 'UC_TASK_VIEW'],            // LG(TAB)
  [kp(LG | LC, 0x50), 'UC_SWITCH_DESKTOP_LEFT'],
  [kp(LG | LC, 0x4F), 'UC_SWITCH_DESKTOP_RIGHT'],
  [kp(LG, 0x08), 'UC_FILE_EXPLORER'],        // LG(E)
  [kp(LG, 0x0F), 'UC_LOCK'],                 // LG(L)
  [kp(LG, 0x0C), 'UC_SETTINGS'],             // LG(I)
  [kp(LG, 0x37), 'UC_EMOJI_WIN'],            // LG(DOT)
  [kp(LG | LS, 0x21), 'UC_PRNS_MAC'],        // LG(LS(N4))
  [kp(LG | LS, 0x16), 'UC_PRNS_WIN'],        // LG(LS(S))
];
const OUT_BAT = 6;   // dt-bindings/zmk/outputs.h

function keychronTables() {
  const keycodesH = readFileSync(path.join(LAUNCHER, 'keycodes.h'), 'utf8');
  const launcherH = readFileSync(path.join(LAUNCHER, 'launcher.h'), 'utf8');
  const mapC      = readFileSync(path.join(LAUNCHER, 'map_keycode.c'), 'utf8');
  const values = enumValues(launcherH, enumValues(keycodesH));
  for (const name of ['BT_HST1', 'UC_KEYCHRON', 'QK_MOMENTARY', 'KC_MISSION_CONTROL']) {
    if (!(name in values)) throw new Error(`${name} not found in keycodes.h or launcher.h`);
  }
  return {
    v: values,
    consumer: returnTable(mapC, 'KEYCODE2CONSUMER_R', values),
    system:   returnTable(mapC, 'KEYCODE2SYSTEM_R', values),
    userCustom: new Map(USER_CUSTOM.map(([p1, name]) => [p1, values[name]])),
  };
}

// RC(row,col) of every key position in the overlay's default transform, in order.
function overlayPositions(file) {
  const text = readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, '');
  const map = /map\s*=\s*<([^>]*)>/.exec(text);
  if (!map) throw new Error(`${file}: no transform map`);
  const rows = Number(/rows\s*=\s*<(\d+)>/.exec(text)[1]);
  const cols = Number(/columns\s*=\s*<(\d+)>/.exec(text)[1]);
  const positions = [...map[1].matchAll(/RC\((\d+),\s*(\d+)\)/g)].map(m => [Number(m[1]), Number(m[2])]);
  return { rows, cols, positions };
}

// ---- Translation, as generate_via_keymaps does it ----
// Behavior names are matched by prefix in the same order, so "MO" also takes "MOD_TAP"
// bindings, as on the keyboard.
function viaCode(name, p1, p2, T) {
  const { v } = T;
  const starts = prefix => name.startsWith(prefix);
  if (starts('KEY_PRESS')) {
    const usage = p1 & 0xFFFF, page = (p1 >>> 16) & 0xFF, mods = p1 >>> 24;
    if (page === 0x01) return T.system.get(usage) ?? 0;
    if (page === 0x07) return mods ? usage | (modToVia(mods) << 8) : usage;
    if (page === 0x0C) return usage === 0x19E ? v.KC_SCRN_LOCK : (T.consumer.get(usage) ?? 0);
    if (page === 0x09) return usage;
    return 0;
  }
  if (starts('MO'))           return v.QK_MOMENTARY | (p1 & 0x1F);
  if (starts('TO_LAYER'))     return v.QK_TO | (p1 & 0x1F);
  if (starts('TOGGLE_LAYER')) return v.QK_TOGGLE_LAYER | (p1 & 0x1F);
  if (starts('TAPD_LAYER'))   return v.QK_LAYER_TAP_TOGGLE | (p1 & 0x1F);
  if (starts('LAYER_TAP'))    return v.QK_LAYER_TAP | ((p1 & 0x0F) << 8) | (p2 & 0xFF);
  if (starts('TRANS'))        return v.KC_TRANSPARENT;
  if (starts('NONE'))         return 0;
  if (starts('ZM_MA'))        return p1 === 0x770100 ? v.UC_KEYCHRON : v.QK_MACRO | (p1 & 0xFF);
  if (starts('bt_pair0'))     return v.BT_HST1;
  if (starts('bt_pair1'))     return v.BT_HST2;
  if (starts('bt_pair2'))     return v.BT_HST3;
  if (starts('bt_pair3'))     return v.PAIR_24G;
  if (starts('lp_bootloader')) return v.KC_BOOT;
  if (starts('GRAVE_ESCAPE')) return v.QK_GRAVE_ESCAPE;
  if (starts('user_custom'))  return T.userCustom.get(p1) ?? 0;
  if (starts('lp_fn_win'))    return v.QK_MAGIC_TOGGLE_GUI;
  if (starts('OUTPUTS'))      return p1 === OUT_BAT ? v.UC_BATINFO : 0;
  // Sticky layer and sticky key are translated on the keyboard but appear in no factory
  // keymap; one that does stops the script rather than being guessed.
  throw new Error(`behavior ${name} is not handled`);
}

// mod_to_via: ZMK's 8 modifier bits (left four, then right four) to QMK's 5-bit form.
function modToVia(mods) {
  const left = mods & 0x0F, right = mods >> 4;
  if (left) return left;
  if (right) return 0x10 | right;
  return 0;
}

// ---- Finding the keymap in the image ----
// The behavior name a binding's first word points at, or null when it does not point at
// a short identifier.
function behaviorName(image, base, ptr) {
  const at = ptr - base;
  if (at < 0 || at >= image.length) return null;
  let end = at;
  while (end < image.length && end - at < 32 && /[A-Za-z0-9_]/.test(String.fromCharCode(image[end]))) end++;
  return end > at && image[end] === 0 ? image.toString('latin1', at, end) : null;
}

// Every run of `layers` x `count` consecutive bindings is a candidate. The keymap is the
// one whose base layers put the right letters and digits at the overlay's positions;
// `expected` gives those, as [layer, position, code].
function findKeymap(image, base, count, expected, T) {
  const record = i => {
    const name = behaviorName(image, base, image.readUInt32LE(i));
    return name && { name, p1: image.readUInt32LE(i + 4), p2: image.readUInt32LE(i + 8) };
  };
  let best = { offset: -1, layers: 0, matched: 0 };
  for (let start = 0; start + count * 12 <= image.length; start += 4) {
    if (!record(start)) continue;
    let layers = 0;
    while (start + (layers + 1) * count * 12 <= image.length) {
      let ok = true;
      for (let k = 0; k < count && ok; k++) ok = !!record(start + (layers * count + k) * 12);
      if (!ok) break;
      layers++;
    }
    if (layers < 2) continue;
    let matched = 0;
    for (const [l, pos, code] of expected) {
      if (l >= layers) continue;
      const r = record(start + (l * count + pos) * 12);
      try { if (viaCode(r.name, r.p1, r.p2, T) === code) matched++; } catch { /* unhandled: no match */ }
    }
    if (matched > best.matched) best = { offset: start, layers, matched };
  }
  return { ...best, total: expected.length, record };
}

// One firmware file decoded: { pid, file, layers } with layers[l]["row,col"] = VIA code for
// every matrix position the overlay places a key at. Throws when the keymap is not found.
export function decodeFirmware(file, T = keychronTables()) {
  const { image, base } = readUf2(path.join(BIN_DIR, file));
  const pids = imagePids(image).filter(p => p in ZMK_BOARDS);
  if (pids.length !== 1) throw new Error(`${file}: product ID not one of ZMK_BOARDS (${imagePids(image).map(hex).join(', ')})`);
  const pid = pids[0];
  const { rows, cols, positions } = overlayPositions(path.join(SHIELDS, ZMK_BOARDS[pid]));

  // Letters and digits, which every layout has on both base layers, Mac (0) and Windows (2).
  const { KEYCHRON_LAYOUTS, KEYBOARD_DB, LABEL_TO_KEYCODE } = appTables();
  const layout = KEYBOARD_DB[pid] && KEYCHRON_LAYOUTS[KEYBOARD_DB[pid].layoutId];
  if (!layout) throw new Error(`${file}: ${hex(pid)} has no KeyAble layout to find the keymap by`);
  const ref = layout.keys;
  const expected = [];
  for (const key of ref) {
    if (!/^[A-Z0-9]$/.test(key.label)) continue;
    const pos = positions.findIndex(([r, c]) => r === key.row && c === key.col);
    if (pos >= 0) for (const l of [0, 2]) expected.push([l, pos, LABEL_TO_KEYCODE[key.label]]);
  }
  if (expected.length < 40) throw new Error(`${file}: too few known keys to find the keymap by (${expected.length})`);

  const found = findKeymap(image, base, positions.length, expected, T);
  if (found.matched < found.total * 0.95) {
    throw new Error(`${file}: keymap not found (best ${found.matched}/${found.total} letters and digits)`);
  }
  const layers = [];
  for (let l = 0; l < found.layers; l++) {
    const out = {};
    positions.forEach(([r, c], k) => {
      if (r >= rows || c >= cols) return;   // outside the matrix: not reachable over VIA
      const b = found.record(found.offset + (l * positions.length + k) * 12);
      out[`${r},${c}`] = viaCode(b.name, b.p1, b.p2, T);
    });
    layers.push(out);
  }
  return { pid, file, layers };
}

// ---- Commands ----
const versionKey = file => (/_v(\d+(?:\.\d+)*)_(\d+)\.uf2$/i.exec(file) || []).slice(1).join('.').split('.').map(Number);
const newer = (a, b) => versionNewer(versionKey(a), versionKey(b));

function show(file) {
  const { pid, layers } = decodeFirmware(file);
  console.log(`${file}: ${hex(pid)}, ${layers.length} layers`);
  layers.forEach((layer, l) => {
    console.log(`layer ${l}: ` + Object.entries(layer).map(([pos, code]) => `${pos}=${hex(code)}`).join(' '));
  });
}

// Newest firmware per product ID, decoded.
function newestDecoded() {
  const T = keychronTables();
  const newest = new Map();
  for (const file of existsSync(BIN_DIR) ? readdirSync(BIN_DIR).filter(f => f.endsWith('.uf2')) : []) {
    let decoded;
    try { decoded = decodeFirmware(file, T); } catch (err) { console.log(`SKIPPED ${err.message}`); continue; }
    const held = newest.get(decoded.pid);
    if (!held || newer(file, held.file)) newest.set(decoded.pid, decoded);
  }
  return newest;
}

// The factory layers of each ZMK board KeyAble knows, from its newest firmware, as a Map
// of pid to { file, layers }. Reports the keys the board has that its KeyAble layout
// lacks, and any layout key the firmware does not place. These boards have no knob.
export function zmkEntries() {
  const { KEYBOARD_DB, KEYCHRON_LAYOUTS } = appTables();
  const out = new Map();
  for (const { pid, file, layers } of newestDecoded().values()) {
    if (!KEYBOARD_DB[pid]) continue;
    out.set(pid, { file, layers });
    const inLayout = new Set((KEYCHRON_LAYOUTS[KEYBOARD_DB[pid].layoutId]?.keys || []).map(k => `${k.row},${k.col}`));
    const unplaced = [...inLayout].filter(pos => !(pos in layers[0]));
    const extra = Object.keys(layers[0]).filter(pos => !inLayout.has(pos) && layers.some(l => l[pos] > 1));
    if (unplaced.length) console.log(`${hex(pid)}: layout keys the firmware does not place: ${unplaced.join(' ')}`);
    if (extra.length) console.log(`${hex(pid)}: keys missing from the layout: ${extra.join(' ')}`);
  }
  return out;
}

// Run as a command only, so build-factory-dataset.mjs can import from it.
if (runAsCommand(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'fetch' && args.length) await downloadLinkedFiles(args, BIN_DIR, ['uf2']);
  else if (mode === 'show' && args.length) show(args[0]);
  else { console.error('usage: fetch <page url> [...] | show <uf2 file>'); process.exit(1); }
}
