// One board's factory keymap from its QMK firmware source: every layer block and the
// knob map in keymap.c, placed by the LAYOUT macro's matrix order from info.json.
// QMK passes the LAYOUT arguments to the matrix in that same order, so the two zip
// together with no guessing.
//
// Each token becomes the 16-bit code CMD_GET_KEY returns, through token-keycodes.js. A
// token with no code, or a layer whose length differs from the layout, throws, so the
// dataset never holds a gap.
'use strict';
const { resolveToken } = require('./token-keycodes.js');
const { stripComments, layerBlocks, defines, expandDefines } = require('./keymap-source.js');

// Layer enum order from keymap.c. Boards differ, so the canonical order is never assumed.
function parseLayerEnum(src) {
  const m = src.match(/enum\s+layers\s*\{([^}]*)\}/);
  if (!m) throw new Error('no `enum layers { ... }` in keymap.c');
  const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const idx = {};
  names.forEach((n, i) => { idx[n] = i; });
  return { names, idx };
}

// encoder_map: [LAYER] = {ENCODER_CCW_CW(ccw, cw), ...}
function extractEncoderMap(src) {
  const mapM = src.match(/encoder_map\s*\[\s*\]\s*\[[^\]]*\]\s*\[\s*2\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!mapM) return {};
  const re = /\[(\w+)\]\s*=\s*\{([\s\S]*?)\}\s*,?/g;
  const out = {};
  let m;
  while ((m = re.exec(mapM[1])) !== null) {
    out[m[1]] = [...m[2].matchAll(/ENCODER_CCW_CW\(([^,]+),([^)]+)\)/g)]
      .map(e => ({ ccw: e[1].trim(), cw: e[2].trim() }));
  }
  return out;
}

// Layer roles from the MO() references, independent of layer names: the wireless
// 5-layer boards name their Fn layers MAC_FN1/WIN_FN1/FN2, the wired V2 _FN1/_FN2/_FN3,
// and the 4-layer boards MAC_FN/WIN_FN. MAC_BASE reaches Mac's Fn layer, WIN_BASE
// reaches Windows', and a layer reached from both is a shared extra (fn2).
function moTargets(blocks, layerName, idx) {
  const b = blocks.find(x => x.layer === layerName);
  if (!b) throw new Error(`no ${layerName} layer block to derive roles from`);
  const set = new Set();
  for (const tok of b.tokens) {
    const m = String(tok).match(/^MO\(\s*([A-Za-z0-9_]+)\s*\)$/);
    if (m && Object.hasOwn(idx, m[1])) set.add(idx[m[1]]);
  }
  return set;
}
function deriveRoles(blocks, idx) {
  if (idx.MAC_BASE === undefined || idx.WIN_BASE === undefined) {
    throw new Error('enum has no MAC_BASE / WIN_BASE, so layer roles cannot be derived');
  }
  const macRefs = moTargets(blocks, 'MAC_BASE', idx);
  const winRefs = moTargets(blocks, 'WIN_BASE', idx);
  const macOnly = [...macRefs].filter(i => !winRefs.has(i));
  const winOnly = [...winRefs].filter(i => !macRefs.has(i));
  const shared  = [...macRefs].filter(i => winRefs.has(i));
  if (macOnly.length !== 1) throw new Error(`expected one Mac-only Fn layer, got [${macOnly}]`);
  if (winOnly.length !== 1) throw new Error(`expected one Windows-only Fn layer, got [${winOnly}]`);
  if (shared.length > 1)    throw new Error(`expected at most one shared Fn layer, got [${shared}]`);
  const roles = { mac: idx.MAC_BASE, win: idx.WIN_BASE, macFn: macOnly[0], winFn: winOnly[0] };
  if (shared.length === 1) roles.fn2 = shared[0];
  return roles;
}

// `keymapSource` is keymap.c's text; `layouts` maps each LAYOUT macro name to its
// [row, col] list; `lockOpts` is { winLock, macLock }, the board's lock-screen build
// flags, which shift Keychron's own keycodes.
// Returns { layers, encoders, roles }: layers[l]["row,col"] and encoders[l][knob] =
// { ccw, cw } at each layer's device index, and roles only when the layer order is not
// the canonical Mac, Mac Fn, Windows, Windows Fn (null otherwise).
function factoryKeymap(keymapSource, layouts, lockOpts = {}) {
  const src = stripComments(keymapSource);
  const { names, idx } = parseLayerEnum(src);
  const blocks = layerBlocks(src);
  const defs = defines(src);
  if (!blocks.length) throw new Error('no LAYOUT layer blocks in keymap.c');
  const macro = blocks[0].macro;
  if (!blocks.every(b => b.macro === macro)) throw new Error(`mixed LAYOUT macros: ${blocks.map(b => b.macro).join(', ')}`);
  const matrix = layouts[macro];
  if (!matrix) throw new Error(`no layout named ${macro} (has: ${Object.keys(layouts).join(', ')})`);
  for (const b of blocks) {
    if (b.tokens.length !== matrix.length) {
      throw new Error(`${b.layer} has ${b.tokens.length} keys but ${macro} has ${matrix.length} positions`);
    }
    if (idx[b.layer] === undefined) throw new Error(`layer ${b.layer} is not in the layer enum`);
  }

  const opts = { ...lockOpts, layerIndex: idx };   // MO() resolves against this board's enum
  const unresolved = new Set();
  const toCode = token => {
    const code = resolveToken(expandDefines(token, defs), opts);
    if (code === null) unresolved.add(String(token).trim());
    return code;
  };

  const layers = names.map(() => ({}));
  for (const b of blocks) {
    matrix.forEach(([row, col], i) => { layers[idx[b.layer]][`${row},${col}`] = toCode(b.tokens[i]); });
  }
  const encoders = names.map(() => []);
  for (const [name, encs] of Object.entries(extractEncoderMap(src))) {
    if (idx[name] === undefined) throw new Error(`knob map layer ${name} is not in the layer enum`);
    encoders[idx[name]] = encs.map(e => ({ ccw: toCode(e.ccw), cw: toCode(e.cw) }));
  }
  if (unresolved.size) throw new Error(`no keycode for ${[...unresolved].join(', ')}`);

  const roles = deriveRoles(blocks, idx);
  const canonical = names.length === 4 && roles.mac === 0 && roles.macFn === 1 &&
    roles.win === 2 && roles.winFn === 3 && roles.fn2 === undefined;
  return { layers, encoders, roles: canonical ? null : roles };
}

module.exports = { factoryKeymap };
