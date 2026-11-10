// Reads the two Keychron sources every supported keyboard is checked against, plus the
// app's own tables. Shared by verify-keyboards.mjs and layout-from-firmware.mjs.
//
// - Firmware: the pinned commits in docs/KEYBOARD-DATA.txt, as sparse clones of
//   keyboards/keychron in ProjectAssets/keychron-firmware-src/{keychron-fork,qmk-mainline}.
//   A board's matrix positions come from its info.json or keyboard.json, matched by USB
//   product ID; QMK builds the board's LAYOUT macro from that file, so it is what the
//   compiled keyboard uses. The key at each position is the Windows base layer token in
//   keymap.c, which takes the LAYOUT arguments in the same order.
// - VIA definitions: the files Keychron Launcher and VIA use to read and write keys,
//   from Keychron's fork (via_json folders) and the-via/keyboards (v3/keychron), the
//   latter in ProjectAssets/keychron-firmware-src/via-keyboards.
//
// Fetching a source (Git Bash; MSYS_NO_PATHCONV stops the pattern becoming a Windows path):
//   git init <dir> && cd <dir> && git remote add origin <repo url>
//   MSYS_NO_PATHCONV=1 git sparse-checkout set --no-cone 'keyboards/keychron/'
//   git fetch --depth 1 --filter=blob:none origin <commit> && git checkout FETCH_HEAD
// For via-keyboards the pattern is 'v3/keychron/' and the ref is master. qmk-mainline also
// needs '/quantum/keycodes.h', the source of the keycode values in token-keycodes.js.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveToken } = require('./token-keycodes.js');
const { stripComments, layerBlocks, defines, expandDefines } = require('./keymap-source.js');
const Hjson = require('hjson');
const here   = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const FW   = path.join(ROOT, 'ProjectAssets', 'keychron-firmware-src');
export const APP  = path.join(ROOT, 'Project', 'KeyAble.html');

// ---- The app's tables, read from its source without running it ----
export function appTables(html = readFileSync(APP, 'utf8')) {
  const grab = name => {
    const start = html.indexOf(`const ${name} = {`);
    const end   = html.indexOf('\n};', start);
    if (start < 0 || end < 0) throw new Error(`${name} not found in KeyAble.html`);
    // eslint-disable-next-line no-new-func
    return new Function(`return (${html.slice(start + `const ${name} = `.length, end + 2)});`)();
  };
  return {
    KEYCHRON_LAYOUTS: grab('KEYCHRON_LAYOUTS'),
    KEYBOARD_DB:      grab('KEYBOARD_DB'),
    FACTORY_KEYMAPS:  grab('FACTORY_KEYMAPS'),
    LABEL_TO_KEYCODE: grab('LABEL_TO_KEYCODE'),
  };
}

// Files that exist but could not be parsed, path relative to FW -> parse error. A board
// or VIA definition whose file is listed here is missing from the index, and callers
// report the list.
export const unreadableFiles = new Map();
function readSource(file, parse) {
  if (!existsSync(file)) return null;
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch (err) {
    unreadableFiles.set(path.relative(FW, file).replace(/\\/g, '/'), err.message.split('\n')[0]);
    return null;
  }
}
// QMK reads info.json and keyboard.json as Hjson, so board files in the pinned sources
// with missing or trailing commas still compile; reading them any stricter hides those
// boards. VIA and Keychron Launcher parse definitions as strict JSON, so a VIA file that
// fails JSON.parse is broken for them too.
const readBoardFile = file => readSource(file, Hjson.parse);
const readViaFile   = file => readSource(file, JSON.parse);
const boardDefs = dir => ['info.json', 'keyboard.json'].map(f => readBoardFile(path.join(dir, f))).filter(Boolean);
function walkDirs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory() && name !== 'keymaps') { out.push(p); walkDirs(p, out); }
  }
  return out;
}
function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out); else out.push(p);
  }
  return out;
}

// A plain HID key's code (0x02 to 0xFF), or undefined for layers, Keychron customs,
// lighting and media keys, which are compared by position only.
export function standardCode(token, defs = {}) {
  const code = resolveToken(expandDefines(token, defs));
  return Number.isInteger(code) && code > 0x0001 && code <= 0xFF ? code : undefined;
}

// ---- Firmware boards by product ID ----
// Boards with a custom matrix scan (most wired ones) give their size in config.h, as
// MATRIX_ROWS and MATRIX_COLS or as the pin lists, where every entry, NO_PIN
// included, is one row or column.
function configMatrixSize(dir) {
  const file = path.join(dir, 'config.h');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8').replace(/\\\r?\n/g, ' ');
  const count = name => {
    const n = new RegExp(`#define\\s+MATRIX_${name}\\s+(\\d+)`).exec(text);
    if (n) return Number(n[1]);
    const pins = new RegExp(`#define\\s+MATRIX_${name.slice(0, 3)}_PINS\\s*\\{([^}]*)\\}`).exec(text);
    return pins ? pins[1].split(',').filter(p => p.trim()).length : null;
  };
  const rows = count('ROWS'), cols = count('COLS');
  return rows && cols ? { rows, cols } : null;
}

let firmwareIndex = null;
function indexFirmware() {
  if (firmwareIndex) return firmwareIndex;
  firmwareIndex = new Map();
  for (const repo of ['keychron-fork', 'qmk-mainline']) {
    const kb = path.join(FW, repo, 'keyboards', 'keychron');
    if (!existsSync(kb)) throw new Error(`Firmware not fetched: ${kb}`);
    for (const dir of walkDirs(kb)) {
      const pidText = boardDefs(dir).map(d => d.usb && d.usb.pid).find(Boolean);
      if (!pidText) continue;
      // Layouts can sit in any folder between the board family and the variant
      // (k2_pro/ansi/rgb takes them from k2_pro/ansi); nearer folders win.
      const chain = [];
      for (let d = dir; d.startsWith(kb) && d !== kb; d = path.dirname(d)) chain.unshift(d);
      const layouts = {};
      let matrixSize = null;
      for (const d of chain) {
        for (const def of boardDefs(d)) {
          Object.assign(layouts, def.layouts || {});
          if (def.matrix_size) matrixSize = def.matrix_size;
          else if (def.matrix_pins && def.matrix_pins.rows && def.matrix_pins.cols) {
            matrixSize = { rows: def.matrix_pins.rows.length, cols: def.matrix_pins.cols.length };
          }
        }
        matrixSize = configMatrixSize(d) || matrixSize;
      }
      // Keychron's lock-screen keys, when a board enables them, shift its custom keycodes.
      const lockFlag = name => chain.some(d => {
        const file = path.join(d, 'config.h');
        return existsSync(file) && new RegExp(`^\\s*#define\\s+${name}\\b`, 'm').test(readFileSync(file, 'utf8'));
      });
      const lockOpts = { winLock: lockFlag('WIN_LOCK_SCREEN_ENABLE'), macLock: lockFlag('MAC_LOCK_SCREEN_ENABLE') };
      const pid = parseInt(pidText, 16);
      if (!firmwareIndex.has(pid)) firmwareIndex.set(pid, []);
      firmwareIndex.get(pid).push({ repo, dir, layouts, matrixSize, lockOpts, source: `${repo}/${path.relative(path.join(FW, repo), dir).replace(/\\/g, '/')}` });
    }
  }
  return firmwareIndex;
}

// The source a board's factory data is read from: { source, layouts, matrixSize,
// lockOpts, keymapFile }, or { error }. Wired boards are read from mainline QMK, with its
// default keymap, and Max and Pro boards from Keychron's fork, with its via keymap.
export function firmwareSource(pid) {
  const sources = indexFirmware().get(pid) || [];
  if (!sources.length) return { error: 'NO FIRMWARE SOURCE' };
  const wireless = /_max|_pro/.test(sources.map(s => s.source).join(' '));
  const src = sources.find(s => s.repo === (wireless ? 'keychron-fork' : 'qmk-mainline')) || sources[0];
  const keymapFile = (src.repo === 'keychron-fork' ? ['via', 'default'] : ['default', 'via'])
    .map(k => path.join(src.dir, 'keymaps', k, 'keymap.c')).find(f => existsSync(f));
  if (!keymapFile) return { error: 'NO FIRMWARE KEYMAP', source: src.source };
  return { ...src, keymapFile };
}

// The board's keys in LAYOUT order: { pos, row, col, token, code, x, y, w, h }, or
// { error } naming what is missing.
export function firmwareBoard(pid) {
  const src = firmwareSource(pid);
  if (src.error) return src;
  const { keymapFile } = src;
  const code    = stripComments(readFileSync(keymapFile, 'utf8'));
  const blocks  = layerBlocks(code);
  const defs    = defines(code);
  const winBase = blocks.find(b => /WIN_BASE/.test(b.layer));
  if (!winBase) return { error: 'NO WINDOWS LAYER IN FIRMWARE', source: src.source };
  const { macro, tokens } = winBase;
  const matrix = src.layouts[macro] && src.layouts[macro].layout;
  if (!matrix) return { error: `FIRMWARE LAYOUT ${macro} NOT FOUND`, source: src.source };
  if (matrix.length !== tokens.length) {
    return { error: `${macro} has ${matrix.length} positions but ${winBase.layer} has ${tokens.length} keys`, source: src.source };
  }
  const macBase = blocks.find(b => /MAC_BASE/.test(b.layer));
  const keys = matrix.map((k, i) => ({
    pos: `${k.matrix[0]},${k.matrix[1]}`, row: k.matrix[0], col: k.matrix[1],
    token: tokens[i], macToken: macBase ? macBase.tokens[i] : undefined, code: standardCode(tokens[i], defs),
    x: k.x, y: k.y, w: k.w || 1, h: k.h || 1,
  }));
  return { source: src.source, macro, matrixSize: src.matrixSize, hasEncoder: /encoder_map/.test(code), keys };
}

// ---- VIA definitions by product ID ----
// Matrix keys only: encoders (legend 10 starting "e"), decals and layout options other
// than the default are left out.
function viaKeys(json) {
  const out = []; let y = -1;
  for (const row of json.layouts.keymap) {
    y += 1; let x = 0, w = 1, decal = false;
    for (const item of row) {
      if (typeof item === 'object') { x += item.x || 0; y += item.y || 0; if (item.w) w = item.w; decal = !!item.d; continue; }
      const lines = item.split('\n');
      const option = (lines[3] || '').replace(/\s/g, '');
      const m = lines[0].replace(/\s/g, '').match(/^(\d+),(\d+)$/);
      const encoder = lines[9] && /^e/.test(lines[9]);
      const nonDefault = /^\d+,\d+$/.test(option) && !/,0$/.test(option);
      if (m && !decal && !encoder && !nonDefault) out.push({ pos: `${m[1]},${m[2]}`, x: x + w / 2, y });
      x += w; w = 1; decal = false;
    }
  }
  return out;
}

let viaIndex = null;
export function viaBoards(pid) {
  if (!viaIndex) {
    viaIndex = new Map();
    const roots = [path.join(FW, 'keychron-fork', 'keyboards', 'keychron'), path.join(FW, 'via-keyboards', 'v3', 'keychron')];
    for (const root of roots.filter(existsSync)) {
      for (const f of walkFiles(root).filter(f => f.endsWith('.json') && (/via_json/.test(f) || f.includes('via-keyboards')))) {
        const j = readViaFile(f);
        if (!j || !j.productId || !j.layouts || !j.layouts.keymap) continue;
        const p = parseInt(j.productId, 16);
        if (!viaIndex.has(p)) viaIndex.set(p, []);
        viaIndex.get(p).push({ source: path.relative(FW, f).replace(/\\/g, '/'), matrix: j.matrix, keys: viaKeys(j) });
      }
    }
  }
  return viaIndex.get(pid) || [];
}

// How a VIA definition compares with the firmware: positions only one of them has
// (an encoder press is left out of VIA's list, so firmware-only knob presses are
// expected), and whether the physical reading order of the shared positions matches,
// allowing one key drawn at a different row, such as a tall ISO Enter. `agrees` when
// neither has a position the other lacks, but for the knob press, and the order matches.
export function compareViaWithFirmware(board, via) {
  const fwKeys = board.keys;
  const fwSet = new Set(fwKeys.map(k => k.pos)), viaSet = new Set(via.keys.map(k => k.pos));
  const viaOnly = [...viaSet].filter(p => !fwSet.has(p));
  const fwOnly  = [...fwSet].filter(p => !viaSet.has(p));
  const order = keys => [...keys].sort((a, b) => (a.y - b.y) || (a.x - b.x)).map(k => k.pos);
  const common = new Set([...viaSet].filter(p => fwSet.has(p)));
  const a = order(fwKeys.filter(k => common.has(k.pos)).map(k => ({ pos: k.pos, x: k.x + k.w / 2, y: k.y })));
  const b = order(via.keys.filter(k => common.has(k.pos)));
  const same = (s, t) => s.length === t.length && s.every((p, i) => p === t[i]);
  let sameOrder = same(a, b);
  if (!sameOrder) sameOrder = [...common].some(p => same(a.filter(x => x !== p), b.filter(x => x !== p)));
  const agrees = !viaOnly.length && fwOnly.length <= (board.hasEncoder ? 1 : 0) && sameOrder;
  return { viaOnly, fwOnly, sameOrder, agrees };
}

// ---- Key names ----
// The name the app should give each firmware key, so the verifier and the generator use
// one rule:
// - a plain key (LABEL_TO_KEYCODE) is named by its keycode;
// - any other key takes the name the boards matching their firmware give the same token;
// - a key with nothing on the Windows base layer is named by its Mac base key, as F13
//   to F16 are on the 100% boards;
// - a key with nothing on either base layer takes its name from EMPTY_KEY_NAMES when the
//   board is listed there, and otherwise gets "Unassigned Key (after X)", X being the key
//   before it, because no source says what is printed on it.
const EMPTY = /^(KC_NO|XXXXXXX|_______|KC_TRNS)$/;

// Physical keys that Keychron's firmware leaves empty, by firmware folder and position.
// The wired V3, V6 and Q6 have nothing on the key after Print Screen, in Keychron's own
// branch as well as QMK's. The Max version of each board has the same key in the same
// place holding KC_CTANA on Windows and KC_SIRI on Mac, which is why it is named for them.
const EMPTY_KEY_NAMES = {
  'keychron/v3/': { '0,15': 'Voice Assistant' },
  'keychron/v6/': { '0,15': 'Voice Assistant' },
  'keychron/q6/': { '0,15': 'Voice Assistant' },
};
const emptyKeyName = (board, pos) => {
  const entry = Object.entries(EMPTY_KEY_NAMES).find(([dir]) => board.source && board.source.includes(dir));
  return entry && entry[1][pos];
};

export function keyNaming(tables, boardFor = firmwareBoard) {
  const { KEYCHRON_LAYOUTS, KEYBOARD_DB, LABEL_TO_KEYCODE } = tables;
  const labelOf = {};
  for (const [label, code] of Object.entries(LABEL_TO_KEYCODE)) labelOf[code] ??= label;
  const tokenNames = new Map();
  const conflicts = [];

  // Learn token names only from boards whose positions and plain keys match exactly.
  for (const [pidText, entry] of Object.entries(KEYBOARD_DB)) {
    const layout = KEYCHRON_LAYOUTS[entry.layoutId];
    const board = boardFor(Number(pidText));
    if (!layout || board.error || layout.keys.length !== board.keys.length) continue;
    const fw = new Map(board.keys.map(k => [k.pos, k]));
    const plain = k => (k.code !== undefined && labelOf[k.code]) ||
      (EMPTY.test(k.token) && k.macToken && labelOf[standardCode(k.macToken)]);
    const exact = layout.keys.every(k => {
      const f = fw.get(`${k.row},${k.col}`);
      return f && (!plain(f) || plain(f) === k.label);
    });
    if (!exact) continue;
    for (const k of layout.keys) {
      const f = fw.get(`${k.row},${k.col}`);
      if (plain(f) || EMPTY.test(f.token)) continue;
      const key = `${f.token}${k.isEncoder ? ' encoder' : ''}`;
      if (!tokenNames.has(key)) tokenNames.set(key, k.label);
      else if (tokenNames.get(key) !== k.label) conflicts.push(`${key}: ${tokenNames.get(key)} / ${k.label}`);
    }
  }

  // { label, isEncoder } for key i of the board, or { error }.
  function nameOf(board, i) {
    const k = board.keys[i];
    if (k.code !== undefined && labelOf[k.code]) return { label: labelOf[k.code] };
    if (board.hasEncoder && tokenNames.has(`${k.token} encoder`)) return { label: tokenNames.get(`${k.token} encoder`), isEncoder: true };
    if (tokenNames.has(k.token)) return { label: tokenNames.get(k.token) };
    if (EMPTY.test(k.token)) {
      const mac = k.macToken;
      if (mac && !EMPTY.test(mac)) {
        const code = standardCode(mac);
        if (code !== undefined && labelOf[code]) return { label: labelOf[code] };
        if (tokenNames.has(mac)) return { label: tokenNames.get(mac) };
        return { error: `no name for Mac key ${mac} at (${k.pos})` };
      }
      const printed = emptyKeyName(board, k.pos);
      if (printed) return { label: printed };
      const before = i > 0 ? nameOf(board, i - 1) : null;
      return { label: before && before.label ? `Unassigned Key (after ${before.label})` : 'Unassigned Key' };
    }
    return { error: `no name for ${k.token} at (${k.pos})` };
  }
  return { nameOf, conflicts };
}
