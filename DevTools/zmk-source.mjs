#!/usr/bin/env node
// Layouts and factory keymaps for Keychron's Ultra 8K boards, read from Keychron's ZMK
// source. zmk-firmware.mjs reads the B Pro boards from their shipped firmware instead.
//
// Each board is a shield folder, app/boards/shields/keychron_<model>_<ansi|iso|jis>/:
// - .conf: the USB product ID and the keyboard's name.
// - Kconfig.shield: the options the board selects (MAC_VIA_FUNC changes the translation).
// - .overlay: the matrix transform, which places every key position at an RC(row,col).
//   Its last row is the "direct" GPIO driver (row-offset), which holds the slide switches,
//   not keys; the VIA matrix leaves it out (launcher.h: MATRIX_ROWS = ZMK_MATRIX_ROWS - 1).
// - .keymap: the factory layers, each a list of behavior bindings in key position order,
//   plus one sensor binding per layer for the knob.
//
// A binding is translated to the 16-bit code the keyboard reports over VIA exactly as
// generate_launcher_keymaps in app/src/launcher/map_keycode.c does it on first boot: the
// behavior is matched by the start of its devicetree node name, in the same order.
// Names in the keymap are C macros from app/include/dt-bindings/zmk, expanded here by a
// small preprocessor, so nothing is transcribed by hand.
//
// Source: Keychron/zmk branch rtl8762g, pinned in docs/KEYBOARD-DATA.txt, as a sparse clone
// in ProjectAssets/keychron-firmware-src/keychron-zmk-ultra with the patterns
// '/app/src/launcher/' '/app/boards/shields/keychron_*/' '/app/include/dt-bindings/'
// '/app/dts/' '/app/src/keymap.c' (see keyboard-sources.mjs for the clone commands).
//
// Usage:
//   node DevTools/zmk-source.mjs list
//     every board: product ID, name, layers, keys, and any binding it cannot translate
//   node DevTools/zmk-source.mjs show <pid>
//     the decoded layers and knob, by matrix position
//   node DevTools/zmk-source.mjs entry <pid> <layoutId>
//     prints a KEYCHRON_LAYOUTS entry for the board
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, appTables, hex } from './keyboard-sources.mjs';
import { enumValues, returnTable } from './zmk-firmware.mjs';
import { runAsCommand } from './firmware-files.mjs';

const APP_SRC   = path.join(ROOT, 'ProjectAssets', 'keychron-firmware-src', 'keychron-zmk-ultra', 'app');
const SHIELDS   = path.join(APP_SRC, 'boards', 'shields');
const LAUNCHER  = path.join(APP_SRC, 'src', 'launcher');
const BINDINGS  = path.join(APP_SRC, 'include', 'dt-bindings', 'zmk');
const BEHAVIORS = path.join(APP_SRC, 'dts', 'behaviors');

// ---- A small C preprocessor: object and function-like #defines, no conditionals ----
const TOKEN = /[A-Za-z_]\w*|0[xX][0-9A-Fa-f]+|\d+|<<|>>|"[^"]*"|\S/g;
const tokenize = text => text.match(TOKEN) || [];
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');

function readDefines(text, defs = new Map()) {
  const joined = stripComments(text).replace(/\\\r?\n/g, ' ');
  for (const m of joined.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(\(([^)]*)\))?([^\n]*)$/gm)) {
    const params = m[2] ? m[3].split(',').map(s => s.trim()).filter(Boolean) : null;
    defs.set(m[1], { params, body: tokenize(m[4]) });
  }
  return defs;
}

// The tokens with every macro expanded. A macro is not expanded inside its own expansion,
// as in C.
function expand(tokens, defs, disabled = new Set()) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const d = defs.get(t);
    if (!d || disabled.has(t)) { out.push(t); continue; }
    const inner = new Set([...disabled, t]);
    if (!d.params) { out.push(...expand(d.body, defs, inner)); continue; }
    if (tokens[i + 1] !== '(') { out.push(t); continue; }
    const args = [];
    let cur = [], depth = 0, j = i + 1;
    for (; j < tokens.length; j++) {
      const u = tokens[j];
      if (u === '(' && depth++ === 0) continue;
      if (u === ')' && --depth === 0) break;
      if (u === ',' && depth === 1) { args.push(cur); cur = []; continue; }
      cur.push(u);
    }
    if (j >= tokens.length) throw new Error(`unclosed call to ${t}`);
    args.push(cur);
    const subst = new Map(d.params.map((p, k) => [p, expand(args[k] || [], defs, disabled)]));
    out.push(...expand(d.body.flatMap(b => subst.get(b) ?? [b]), defs, inner));
    i = j;
  }
  return out;
}

// An expanded constant expression as an unsigned 32-bit number.
function evaluate(tokens, where) {
  const name = tokens.find(t => /^[A-Za-z_"]/.test(t));
  if (name) throw new Error(`${where}: unknown name ${name}`);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${tokens.join(' ')});`)() >>> 0;
}

// The ZMK headers' defines, which every keymap includes. Read once; callers copy before
// adding their own.
let zmkDefs = null;
function zmkDefines() {
  if (!zmkDefs) {
    zmkDefs = new Map();
    for (const f of readdirSync(BINDINGS).filter(f => f.endsWith('.h'))) readDefines(readFileSync(path.join(BINDINGS, f), 'utf8'), zmkDefs);
  }
  return zmkDefs;
}

// ---- Devicetree ----
// The text between the brace at `open` and its matching brace.
function braceBody(text, open) {
  let depth = 1, j = open + 1;
  for (; j < text.length && depth; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') depth--;
  }
  if (depth) throw new Error('unbalanced braces');
  return text.slice(open + 1, j - 1);
}

// Every labelled node: { labels, name, body }.
function labelledNodes(text) {
  return [...text.matchAll(/((?:[A-Za-z_]\w*\s*:\s*)+)([A-Za-z_][\w,-]*)\s*\{/g)].map(m => ({
    labels: m[1].split(':').map(s => s.trim()).filter(Boolean),
    name: m[2],
    body: braceBody(text, m.index + m[0].length - 1),
  }));
}

// A property's value, `name = <...>, <...>;`, as tokens with the angle brackets and commas
// between groups removed. Null when the body does not set it.
function property(body, name, defs) {
  const m = new RegExp(`(?<![\\w-])${name}\\s*=\\s*([^;]*);`).exec(body);
  if (!m) return null;
  return expand(tokenize(m[1].replace(/>\s*,\s*</g, ' ').replace(/^\s*<|>\s*$/g, '')), defs);
}

const cellsOf = (body, prop) => Number((new RegExp(`#${prop}\\s*=\\s*<(\\d+)>`).exec(body) || [])[1] ?? 0);

// Behaviors by label: { node, cells, sensorCells, body }. ZMK's own, then the keymap's.
function behaviorTable(keymapText) {
  const table = new Map();
  const add = text => {
    for (const n of labelledNodes(text)) {
      const b = { node: n.name, cells: cellsOf(n.body, 'binding-cells'), sensorCells: cellsOf(n.body, 'sensor-binding-cells'), body: n.body };
      for (const l of n.labels) table.set(l, b);
    }
    for (const m of text.matchAll(/ZMK_MACRO\(\s*(\w+)\s*,/g)) table.set(m[1], { node: m[1], cells: 0, sensorCells: 0, body: '' });
  };
  for (const f of readdirSync(BEHAVIORS).filter(f => f.endsWith('.dtsi'))) add(stripComments(readFileSync(path.join(BEHAVIORS, f), 'utf8')));
  add(keymapText);
  return table;
}

// Bindings in expanded tokens: [{ label, dev, p1, p2 }]. A parameter is one token or one
// parenthesised expression, as devicetree cells are.
function parseBindings(tokens, behaviors, where, sensor = false) {
  const items = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '&') { items.push({ ref: tokens[++i] }); continue; }
    if (t !== '(') { items.push({ expr: [t] }); continue; }
    const group = [];
    for (let depth = 0; i < tokens.length; i++) {
      if (tokens[i] === '(') depth++;
      else if (tokens[i] === ')') depth--;
      group.push(tokens[i]);
      if (depth === 0) break;
    }
    items.push({ expr: group });
  }
  const out = [];
  for (let i = 0; i < items.length;) {
    const item = items[i++];
    if (!item.ref) throw new Error(`${where}: a parameter with no behavior before it`);
    const b = behaviors.get(item.ref);
    if (!b) throw new Error(`${where}: unknown behavior &${item.ref}`);
    const params = [];
    for (let k = 0; k < (sensor ? b.sensorCells : b.cells); k++) {
      const p = items[i++];
      if (!p || p.ref) throw new Error(`${where}: &${item.ref} is missing a parameter`);
      params.push(evaluate(p.expr, `${where} &${item.ref}`));
    }
    out.push({ label: item.ref, dev: b.node, p1: params[0] ?? 0, p2: params[1] ?? 0, behavior: b });
  }
  return out;
}

// ---- Keychron's translation (map_keycode.c) ----
// The text of map_keycode.c with each `#if CONFIG_X ... #endif` kept only when the board
// selects X. `#ifdef ENCODER_MAP_ENABLE` blocks are kept, as launcher.h defines it for every
// board. Any other conditional (#else, #elif, nesting, another macro) stops the script,
// because reading it as plain text would keep the wrong branch.
function configured(source, options) {
  const out = source.replace(/^[ \t]*#[ \t]*if[ \t]+CONFIG_(\w+)[ \t]*\r?\n([\s\S]*?)^[ \t]*#[ \t]*endif\b/gm, (_, opt, body) => {
    if (/^[ \t]*#[ \t]*(?:if|elif|else)/m.test(body)) throw new Error(`map_keycode.c: the #if CONFIG_${opt} block holds another conditional`);
    return options.has(opt) ? body : '';
  });
  const left = /^[ \t]*#[ \t]*(?:if(?!def[ \t]+ENCODER_MAP_ENABLE\b)\w*|elif|else)\b.*$/m.exec(out);
  if (left) throw new Error(`map_keycode.c: unhandled conditional "${left[0].trim()}"`);
  return out;
}

// "case X: gen_launcher_keymaps[...] = Y;" pairs inside the branch for one behavior, with
// X read through the ZMK defines and Y through Keychron's keycode enums.
function caseTable(source, dev, defs, values) {
  const start = source.indexOf(`memcmp(behavior_dev, "${dev}"`);
  if (start < 0) throw new Error(`map_keycode.c: no branch for ${dev}`);
  const end = source.indexOf('} else if', start + 1);
  const table = new Map();
  for (const m of source.slice(start, end).matchAll(/case\s+([^:]+?):\s*gen_launcher_keymaps\[\w+\]\[\w+\]\[\w+\]\s*=\s*(\w+);/g)) {
    if (!(m[2] in values)) throw new Error(`map_keycode.c ${dev}: unknown keycode ${m[2]}`);
    table.set(evaluate(expand(tokenize(m[1]), defs), `map_keycode.c ${dev}`), values[m[2]]);
  }
  if (!table.size) throw new Error(`map_keycode.c: the ${dev} branch has no cases`);
  return table;
}

// Everything the translation needs for one set of board options. Built once per set.
const translators = new Map();
function translator(options) {
  const key = [...options].sort().join(' ');
  if (!translators.has(key)) translators.set(key, buildTranslator(options, zmkDefines()));
  return translators.get(key);
}

function buildTranslator(options, defs) {
  const keycodesH = readFileSync(path.join(LAUNCHER, 'keycodes.h'), 'utf8');
  const launcherH = readFileSync(path.join(LAUNCHER, 'launcher.h'), 'utf8');
  const v = enumValues(launcherH, enumValues(keycodesH));
  const mapC = configured(stripComments(readFileSync(path.join(LAUNCHER, 'map_keycode.c'), 'utf8')), options);
  const num = name => evaluate(expand([name], defs), name);
  return {
    v,
    system:   returnTable(mapC, 'KEYCODE2SYSTEM_R', v),
    consumer: returnTable(mapC, 'KEYCODE2CONSUMER_R', v),
    userCustom: caseTable(mapC, 'user_custom', defs, v),
    rgb:        caseTable(mapC, 'rgb_ug', defs, v),
    keychron: new Map([[num('MOD_NKRO'), v.QK_MAGIC_TOGGLE_NKRO], [num('BAT_INFO'), v.UC_BATINFO]]),
    switchLayer: options.has('SOFTWARE_SWITCH_LAYER'),
  };
}

// mod_to_launcher: ZMK's 8 modifier bits (left four, then right four) to the 5-bit form.
function modToLauncher(mods) {
  const left = mods & 0x0F, right = mods >> 4;
  if (left) return left;
  if (right) return 0x10 | right;
  return mods;
}

// One key binding's code, as generate_launcher_keymaps sets it. Behaviors are matched by
// memcmp on the start of the node name, in its order; anything unmatched is KC_NO.
function keyCode(b, T) {
  const { v } = T;
  const is = (prefix, n = prefix.length) => b.dev.startsWith(prefix.slice(0, n));
  if (is('key_press', 9)) {
    const usage = b.p1 & 0xFFFF, page = (b.p1 >>> 16) & 0xFF, mods = b.p1 >>> 24;
    if (page === 0x01) return T.system.get(usage) ?? 0;
    if (page === 0x07) return (usage | (mods ? modToLauncher(mods) << 8 : 0)) & 0xFFFF;
    if (page === 0x0C) return T.consumer.get(usage) ?? 0;
    return 0;
  }
  if (is('momentary_layer')) return v.QK_MOMENTARY | (b.p1 & 0x1F);
  if (is('to_layer'))        return v.QK_TO | (b.p1 & 0x1F);
  if (is('toggle_layer'))    return v.QK_TOGGLE_LAYER | (b.p1 & 0x1F);
  if (is('tapd_layer'))      return v.QK_LAYER_TAP_TOGGLE | (b.p1 & 0x1F);
  // layer_tap, sticky_layer and layer_mod declare a local `layer` that hides the loop's,
  // and mod_tap compares an 8-bit value with 32-bit ZMK codes, so what the keyboard reports
  // for them is not what the source intends. None is in a factory keymap; one that is
  // stops the script rather than being guessed.
  for (const p of ['layer_tap', 'mod_tap', 'sticky_layer']) if (is(p)) throw new Error(`behavior ${b.dev} is not handled`);
  if (is('sticky_key'))      return v.QK_ONE_SHOT_MOD | (b.p1 & 0x1F);
  if (is('transparent'))     return v.KC_TRANSPARENT;
  if (is('none'))            return 0;
  if (is('zm_ma'))           return v.QK_MACRO | (b.p1 & 0xFF);
  if (is('bt_pair_0'))       return v.BT_HST1;
  if (is('bt_pair_1'))       return v.BT_HST2;
  if (is('bt_pair_2'))       return v.BT_HST3;
  if (is('ppt_pair_0'))      return v.PAIR_24G;
  if (is('lp_bootloader'))   return v.KC_BOOT;
  if (is('grave_escape'))    return v.QK_GRAVE_ESCAPE;
  if (is('user_custom'))     return T.userCustom.get(b.p1) ?? 0;
  if (is('layer_mod', 2))    throw new Error(`behavior ${b.dev} is not handled`);
  if (is('rgb_ug'))          return T.rgb.get(b.p1) ?? 0;
  if (is('keychron'))        return T.keychron.get(b.p1) ?? 0;
  if (is('mouse_key_press')) return b.p1 & 0xFFFF;
  if (is('siri'))            return v.UC_SIRI;
  if (is('mac_lock'))        return v.MAC_SCRN_LOCK;
  if (is('lp_fn_win'))       return v.QK_MAGIC_TOGGLE_GUI;
  if (T.switchLayer && is('lp_mo_win')) return v.UC_WIN_LAYER;
  if (T.switchLayer && is('lp_mo_mac')) return v.UC_MAC_LAYER;
  return 0;
}

// The keymaps' `user_custom` is a key press under another name (compatible
// "zmk,behavior-key-press"); the name only picks Keychron's table above. A binding missing
// from that table, such as Win+H for Windows voice typing, reads back over VIA as 0 while
// the key still types it. Returns the code that types the same keys, which the keyboard
// turns back into a key press when it is written, or 0.
function unreportedCode(b, T) {
  if (!b.dev.startsWith('user_custom')) return 0;
  if (!/zmk,behavior-key-press/.test(b.behavior.body)) throw new Error(`&${b.label} is not a key press`);
  return keyCode({ dev: 'key_press', p1: b.p1 }, T);
}

// The knob's codes on one layer, { ccw, cw }, as sensor_layer_init (app/src/keymap.c) splits
// the layer's first sensor binding and generate_launcher_keymaps translates each half.
function knobCodes(binding, behaviors, defs, T, where) {
  let halves;
  if (binding.dev.startsWith('enc_key_press')) {
    halves = [{ dev: 'key_press', p1: binding.p1 }, { dev: 'key_press', p1: binding.p2 }];
  } else {
    const tokens = property(binding.behavior.body, 'bindings', defs);
    if (!tokens) throw new Error(`${where}: sensor behavior &${binding.label} has no bindings`);
    halves = parseBindings(tokens, behaviors, `${where} &${binding.label}`);
    if (halves.length !== 2) throw new Error(`${where}: &${binding.label} has ${halves.length} bindings, not 2`);
  }
  const code = h => {
    if (h.dev.startsWith('rgb_ug') && h.p1 >= 1 && h.p1 <= 10) return 0x7820 + h.p1;
    if (h.dev.startsWith('key_pres')) return (h.p1 & 0xFF0000) === 0x0C0000 ? (T.consumer.get(h.p1 & 0xFFFF) ?? 0) : h.p1 & 0xFF;
    if (h.dev.startsWith('mouse_ke')) return h.p1 & 0xFF;
    return 0;
  };
  return { ccw: code(halves[1]), cw: code(halves[0]) };
}

// ---- Boards ----
// Which device layer does what, { mac, win, macFn, winFn }. The OS slide switch is the first
// position of the switch row, bound on the Mac layer to &mo <Windows layer>, which is why
// Keychron's "get default layer" reply (the highest active layer) gives the OS. Each base
// layer's Fn key is the one momentary-layer key on it. A board with a second Fn layer per
// OS does not fit KeyAble's layer model and is reported.
function layerRoles(kmLayers, positions, switchRow, layers, T) {
  const switchPos = positions.findIndex(([r, c]) => r === switchRow && c === 0);
  const sw = switchPos >= 0 && kmLayers[0].keys[switchPos];
  if (!sw || !sw.dev.startsWith('momentary_layer')) throw new Error('no OS switch bound to a momentary layer on the Mac layer');
  const win = sw.p1;
  const fnOf = l => {
    const targets = new Set(Object.values(layers[l] || {})
      .filter(c => (c & ~0x1F) === T.v.QK_MOMENTARY).map(c => c & 0x1F));
    if (targets.size !== 1) throw new Error(`layer ${l} has ${targets.size} Fn layers, not 1`);
    return [...targets][0];
  };
  const roles = { mac: 0, win, macFn: fnOf(0), winFn: fnOf(win) };
  if (new Set(Object.values(roles)).size !== 4 || layers.length !== 4) {
    throw new Error(`layers do not fit Mac, Mac Fn, Windows, Windows Fn (${layers.length} layers, ${JSON.stringify(roles)})`);
  }
  return roles;
}

function confValue(text, name) {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm').exec(text);
  return m && m[1].replace(/^"|"$/g, '');
}

function readOverlay(file) {
  const text = stripComments(readFileSync(file, 'utf8'));
  const transform = labelledNodes(text).find(n => n.labels.includes('default_transform'));
  if (!transform) throw new Error(`${file}: no default_transform`);
  const rows = Number(/rows\s*=\s*<(\d+)>/.exec(transform.body)[1]);
  const cols = Number(/columns\s*=\s*<(\d+)>/.exec(transform.body)[1]);
  const positions = [.../map\s*=\s*<([^>]*)>/.exec(transform.body)[1].matchAll(/RC\((\d+),\s*(\d+)\)/g)]
    .map(m => [Number(m[1]), Number(m[2])]);
  const direct = /direct\s*\{[^}]*row-offset\s*=\s*<(\d+)>/.exec(text);
  const switchRow = direct ? Number(direct[1]) : null;
  if (switchRow !== rows - 1) throw new Error(`${file}: the switch row is ${switchRow}, not the last row (${rows - 1})`);
  return { rows: rows - 1, cols, positions, switchRow };
}

function readKeymap(file, defs) {
  const raw = stripComments(readFileSync(file, 'utf8'));
  const local = readDefines(raw, new Map(defs));
  const behaviors = behaviorTable(raw);
  const compatible = raw.search(/compatible\s*=\s*"zmk,keymap"/);
  if (compatible < 0) throw new Error(`${file}: no keymap node`);
  const keymap = braceBody(raw, raw.lastIndexOf('{', compatible));
  const layers = [];
  for (const m of keymap.matchAll(/([A-Za-z_]\w*)\s*\{([^{}]*)\}/g)) {
    const bindings = property(m[2], 'bindings', local);
    if (!bindings) continue;
    const sensors = property(m[2], 'sensor-bindings', local);
    layers.push({
      name: m[1],
      keys: parseBindings(bindings, behaviors, `${path.basename(file)} ${m[1]}`),
      knob: sensors && parseBindings(sensors, behaviors, `${path.basename(file)} ${m[1]} sensor`, true)[0],
    });
  }
  return { layers, behaviors, defs: local };
}

// Every Keychron shield on the branch, as { shield, pid, name, options, rows, cols, keys,
// layers, encoders, reportsNone } or { shield, pid, name, error }. keys are the VIA-reachable
// positions in transform order as { row, col, pos }; layers[l]["row,col"] = code, the code
// that types what the key does; encoders[l] = [{ ccw, cw }]. reportsNone lists, as
// "layer:row,col", the keys whose code the keyboard reports as 0 until one is written.
export function ultraBoards() {
  if (!existsSync(SHIELDS)) throw new Error(`${SHIELDS} not found: clone the source first`);
  const defs = zmkDefines();
  const out = [];
  for (const shield of readdirSync(SHIELDS).filter(d => d.startsWith('keychron_')).sort()) {
    const dir = path.join(SHIELDS, shield);
    const conf = readFileSync(path.join(dir, `${shield}.conf`), 'utf8');
    const pid = Number(confValue(conf, 'CONFIG_USB_DEVICE_PID'));
    const name = confValue(conf, 'CONFIG_ZMK_KEYBOARD_NAME');
    const board = { shield, pid, name };
    try {
      const kconfig = readFileSync(path.join(dir, 'Kconfig.shield'), 'utf8');
      const options = new Set([...stripComments(kconfig).matchAll(/^\s*select\s+(\w+)/gm)].map(m => m[1]));
      const T = translator(options);
      const { rows, cols, positions } = readOverlay(path.join(dir, `${shield}.overlay`));
      const km = readKeymap(path.join(dir, `${shield}.keymap`), defs);
      const keys = positions.map(([row, col], pos) => ({ row, col, pos })).filter(k => k.row < rows && k.col < cols);
      const reportsNone = [];
      const layers = km.layers.map((layer, l) => {
        if (layer.keys.length !== positions.length) throw new Error(`${layer.name} has ${layer.keys.length} bindings for ${positions.length} positions`);
        const codes = {};
        for (const k of keys) {
          const pos = `${k.row},${k.col}`;
          try {
            codes[pos] = keyCode(layer.keys[k.pos], T);
            const typed = codes[pos] === 0 && unreportedCode(layer.keys[k.pos], T);
            if (typed) { codes[pos] = typed; reportsNone.push(`${l}:${pos}`); }
          } catch (err) { throw new Error(`${layer.name} position ${k.pos}: ${err.message}`); }
        }
        return codes;
      });
      const roles = layerRoles(km.layers, positions, rows, layers, T);
      // Every shield declares the knob sensor, boards without a knob included; the knob's
      // decoder driver (REALTEK_AON_QDEC) is enabled only on boards that have one. Its press
      // is the one key holding Mute on the Windows layer, whose function row holds F1 to F12
      // (on the Mac layer F10 holds Mute as well).
      const hasKnob = confValue(conf, 'CONFIG_REALTEK_AON_QDEC') === 'y';
      const presses = keys.filter(k => layers[roles.win][`${k.row},${k.col}`] === T.v.KC_AUDIO_MUTE);
      if (hasKnob && presses.length !== 1) throw new Error(`the knob is enabled, but ${presses.length} keys hold Mute on the Windows layer`);
      const knob = hasKnob ? presses[0] : null;
      const encoders = km.layers.map(layer => (knob && layer.knob ? [knobCodes(layer.knob, km.behaviors, km.defs, T, layer.name)] : []));
      Object.assign(board, { options: [...options], rows, cols, keys, layers, encoders, roles, knob, reportsNone });
    } catch (err) {
      board.error = err.message;
    }
    out.push(board);
  }
  return out;
}

// ---- Keychron's VIA definitions ----
// The definition files Keychron keeps next to the launcher code, by product ID, as
// [{ source, keys: Set of "row,col", knobs }]. Two formats occur: VIA's own (productId and
// a KLE keymap, row,col in each legend's first line, a knob as legend 10 starting "e"),
// and the compiled one Keychron Launcher loads (vendorProductId, layouts.keys with row
// and col, a knob as a key with an encoder index `ei`, placed at the knob press). Either
// way a knob press is not among the keys, and alternative layout options are left out.
export function launcherViaDefinitions() {
  const out = new Map();
  for (const file of readdirSync(LAUNCHER).filter(f => f.endsWith('.json')).sort()) {
    const j = JSON.parse(readFileSync(path.join(LAUNCHER, file), 'utf8'));
    let pid, keys = new Set(), knobs = 0;
    if (j.productId && Array.isArray(j.layouts?.keymap)) {
      pid = parseInt(j.productId, 16);
      for (const row of j.layouts.keymap) {
        for (const item of row) {
          if (typeof item !== 'string') continue;
          const lines = item.split('\n');
          const option = (lines[3] || '').replace(/\s/g, '');
          if (/^\d+,\d+$/.test(option) && !/,0$/.test(option)) continue;
          if (lines[9] && /^e/.test(lines[9])) { knobs++; continue; }
          const m = lines[0].replace(/\s/g, '').match(/^(\d+),(\d+)$/);
          if (m) keys.add(`${m[1]},${m[2]}`);
        }
      }
    } else if (j.vendorProductId && Array.isArray(j.layouts?.keys)) {
      pid = j.vendorProductId & 0xFFFF;
      for (const k of j.layouts.keys) {
        if (k.d) continue;
        if (k.ei !== undefined) { knobs++; continue; }
        keys.add(`${k.row},${k.col}`);
      }
    } else {
      continue;
    }
    if (!out.has(pid)) out.set(pid, []);
    out.get(pid).push({ source: `app/src/launcher/${file}`, keys, knobs });
  }
  return out;
}

// ---- Key names ----
// Keychron's own keys, by their name in keycodes.h or launcher.h, named as the app names the
// same key on the QMK boards (the V6 Max calls the Siri / Cortana key "Voice Assistant").
const KEYCHRON_KEY_NAMES = {
  RGB_MODE_FORWARD: 'RGB Mode',
  UC_SIRI: 'Voice Assistant',
  UC_CORTANA: 'Voice Assistant',
  UC_LOCK: 'Lock Screen',
  MAC_SCRN_LOCK: 'Lock Screen',
};

// The layout entry for a board, keys in transform order:
// - a plain key (LABEL_TO_KEYCODE) is named by its Windows code, then by its Mac code;
// - the Fn key, macro keys and Keychron's own keys are named by what they do;
// - two keys with one name, as the two B keys of an Alice layout, are told apart as left
//   and right.
export function ultraLayout(board, { LABEL_TO_KEYCODE }) {
  const labelOf = {};
  for (const [label, code] of Object.entries(LABEL_TO_KEYCODE)) labelOf[code] ??= label;
  const v = translator(new Set(board.options)).v;
  const byCode = {};
  for (const [name, label] of Object.entries(KEYCHRON_KEY_NAMES)) byCode[v[name]] = label;
  const { mac, win, macFn, winFn } = board.roles;
  const at = (l, k) => board.layers[l][`${k.row},${k.col}`];
  const nameOf = code => {
    if (labelOf[code]) return labelOf[code];
    if (code === (v.QK_MOMENTARY | macFn) || code === (v.QK_MOMENTARY | winFn)) return 'Fn';
    if ((code & ~0xFF) === v.QK_MACRO) return `M${code & 0xFF}`;
    return byCode[code];
  };
  const keys = board.keys.map(k => {
    if (k === board.knob) return { label: 'Knob (press)', row: k.row, col: k.col, isEncoder: true };
    const label = nameOf(at(win, k)) || nameOf(at(mac, k));
    if (!label) throw new Error(`${hex(board.pid)}: no name for (${k.row},${k.col}), Windows ${hex(at(win, k))}, Mac ${hex(at(mac, k))}`);
    return { label, row: k.row, col: k.col };
  });
  const byLabel = Map.groupBy(keys, k => k.label);
  for (const [label, same] of byLabel) {
    if (same.length === 1) continue;
    if (same.length > 2) throw new Error(`${hex(board.pid)}: ${same.length} keys named ${label}`);
    same.sort((a, b) => a.col - b.col);
    same[0].label = `${label} (left)`;
    same[1].label = `${label} (right)`;
  }
  return { rows: board.rows, cols: board.cols, keys };
}

// ---- Commands ----
function entry(pid, id) {
  const b = ultraBoards().find(x => x.pid === pid);
  if (!b) throw new Error(`${hex(pid)}: no such board`);
  if (b.error) throw new Error(b.error);
  const layout = ultraLayout(b, appTables());
  const quote = s => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const lines = [
    `  // ${b.name} (${b.shield}). Generated by DevTools/zmk-source.mjs from Keychron/zmk`,
    `  // rtl8762g, app/boards/shields/${b.shield}: positions from the overlay's transform, names`,
    '  // from the factory keymap. The switch row is outside the VIA matrix.',
    `  ${quote(id)}: {`,
    `    rows: ${layout.rows},`,
    `    cols: ${layout.cols},`,
    '    keys: [',
    ...layout.keys.map(k => `      { label: ${quote(k.label)}, row: ${k.row}, col: ${k.col}${k.isEncoder ? ', isEncoder: true' : ''} },`),
    '    ],',
    '  },',
  ];
  console.log(lines.join('\n'));
}

function list() {
  for (const b of ultraBoards()) {
    const head = `${hex(b.pid)} ${b.name} (${b.shield})`;
    console.log(b.error ? `${head}: ERROR ${b.error}` : `${head}: ${b.layers.length} layers, ${b.keys.length} keys, matrix ${b.rows}x${b.cols}`);
  }
}

function show(pid) {
  const b = ultraBoards().find(x => x.pid === pid);
  if (!b) throw new Error(`${hex(pid)}: no such board`);
  if (b.error) throw new Error(b.error);
  console.log(`${hex(pid)} ${b.name}: ${b.layers.length} layers`);
  b.layers.forEach((layer, l) => {
    console.log(`layer ${l}: ` + b.keys.map(k => `${k.row},${k.col}=${hex(layer[`${k.row},${k.col}`])}`).join(' '));
    if (b.encoders[l].length) console.log(`  knob: ccw ${hex(b.encoders[l][0].ccw)}, cw ${hex(b.encoders[l][0].cw)}`);
  });
}

if (runAsCommand(import.meta.url)) {
  const [mode, arg] = process.argv.slice(2);
  try {
    if (mode === 'list') list();
    else if (mode === 'show' && arg) show(Number(arg));
    else if (mode === 'entry' && arg && process.argv[4]) entry(Number(arg), process.argv[4]);
    else { console.error('usage: list | show <pid> | entry <pid> <layoutId>'); process.exitCode = 1; }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}
