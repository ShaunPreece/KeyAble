// Checks each board's layer roles (which layer is Mac, Windows, each Fn and Fn2) against
// evidence other than the keymap's layer names, which is what the dataset build derives
// them from. Run with `npm test` in DevTools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { appTables, firmwareSource, hex, APP, FW } from '../keyboard-sources.mjs';

const { KEYBOARD_DB, FACTORY_KEYMAPS } = appTables();
const DEFAULT_LAYER_ROLES = JSON.parse(readFileSync(APP, 'utf8')
  .match(/const DEFAULT_LAYER_ROLES = (\{[^}]*\});/)[1].replace(/(\w+):/g, '"$1":'));

const boards = Object.entries(FACTORY_KEYMAPS).map(([pid, model]) => ({
  pid: Number(pid),
  name: `${hex(Number(pid))} ${KEYBOARD_DB[pid]?.name ?? ''}`.trim(),
  layers: model.layers,
  roles: model.roles || DEFAULT_LAYER_ROLES,
}));

// MO(layer): 0x5220 up in current QMK, 0x5100 up in the older numbering protocol 9
// firmware ships with.
const momentary = layer => [0x5220 | layer, 0x5100 | layer];
const reaches = (layer, target) => Object.values(layer).some(c => momentary(target).includes(c));

// Keychron's own key ranges, where every family puts its Mac Option and Command keys.
const isKeychronKey = c => (c >= 0x5F80 && c <= 0x5FFF) || (c >= 0x7E00 && c <= 0x7FFF);

test("each base layer's Fn key reaches its own OS's Fn layer and not the other's", () => {
  const problems = [];
  for (const { name, layers, roles: r } of boards) {
    if (!reaches(layers[r.mac], r.macFn)) problems.push(`${name}: Mac base does not reach Mac Fn (${r.macFn})`);
    if (!reaches(layers[r.win], r.winFn)) problems.push(`${name}: Windows base does not reach Windows Fn (${r.winFn})`);
    if (reaches(layers[r.mac], r.winFn))  problems.push(`${name}: Mac base reaches Windows Fn (${r.winFn})`);
    if (reaches(layers[r.win], r.macFn))  problems.push(`${name}: Windows base reaches Mac Fn (${r.macFn})`);
    if (r.fn2 !== undefined && ![r.mac, r.win, r.macFn, r.winFn].some(l => reaches(layers[l], r.fn2))) {
      problems.push(`${name}: no layer reaches Fn2 (${r.fn2})`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

// The Windows base has the standard Left Win key (0xE3); the Mac base puts a Keychron
// Option or Command key in the same place. A swapped pair of roles fails this.
test('the Mac base holds a Keychron Mac modifier where the Windows base holds Left Win', () => {
  const problems = [];
  for (const { name, layers, roles: r } of boards) {
    const winKeys = Object.keys(layers[r.win]).filter(pos => layers[r.win][pos] === 0xE3);
    if (!winKeys.some(pos => isKeychronKey(layers[r.mac][pos]))) {
      problems.push(`${name}: Mac base has no Keychron modifier at Left Win (${winKeys.join(' ') || 'none'})`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

// The two layers a board's OS switch (or its OS toggle key, on boards without a switch)
// selects, from the board's own .c file: a separate file from keymap.c, with the layer
// numbers written as literals.
function osSwitchLayers(dir) {
  for (; !/[\\/]keychron$/.test(dir); dir = path.dirname(dir)) {
    for (const file of readdirSync(dir).filter(f => f.endsWith('.c') && f !== 'keymap.c')) {
      const code = readFileSync(path.join(dir, file), 'utf8');
      const sw = code.match(/default_layer_set\(1UL << \(\s*!?active \? (\d+) : (\d+)\)\)/);
      if (sw) return [Number(sw[1]), Number(sw[2])];
      const toggle = [...code.matchAll(/set_single_persistent_default_layer\((\d+)\)/g)].map(m => Number(m[1]));
      if (toggle.length === 2) return toggle;
    }
  }
  return null;
}

// The firmware source is fetched locally and is not part of the repo; ZMK boards
// (B Pro, Ultra 8K) have no QMK source and are covered by the two tests above.
test("the OS switch selects the board's Mac and Windows base layers", { skip: !existsSync(FW) && 'no local firmware source' }, () => {
  const problems = [];
  for (const { pid, name, roles: r } of boards) {
    const src = firmwareSource(pid);
    if (src.error) continue;
    const sw = osSwitchLayers(src.dir);
    if (!sw) problems.push(`${name}: no OS switch code found under ${src.source}`);
    else if ([...sw].sort().join() !== [r.mac, r.win].sort().join()) {
      problems.push(`${name}: switch selects ${sw.join(' and ')}, roles say Mac ${r.mac}, Windows ${r.win}`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});
