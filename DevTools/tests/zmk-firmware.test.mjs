// Checks that reading Keychron's ZMK translation tables fails loudly rather than
// producing an empty table, and how ZMK layouts name their keys. Run with `npm test` in
// DevTools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { returnTable, zmkLayout } from '../zmk-firmware.mjs';

const values = { C_VOL_UP: 0xE9, KC_VOLU: 0x80 };

test('a translation function is read into a table of codes', () => {
  const source = 'uint16_t KEYCODE2CONSUMER_R(uint16_t k) {\n  switch (k) {\n    case C_VOL_UP: return KC_VOLU;\n  }\n}\n';
  assert.deepEqual([...returnTable(source, 'KEYCODE2CONSUMER_R', values)], [[0xE9, 0x80]]);
});

test('a translation function missing from the source throws', () => {
  const source = 'uint16_t KEYCODE2CONSUMER(uint16_t k) {\n  switch (k) {\n    case C_VOL_UP: return KC_VOLU;\n  }\n}\n';
  assert.throws(() => returnTable(source, 'KEYCODE2CONSUMER_R', values), /not found/);
});

test('a translation function with no cases throws', () => {
  const source = 'uint16_t KEYCODE2CONSUMER_R(uint16_t k) {\n  return lookup(k);\n}\n';
  assert.throws(() => returnTable(source, 'KEYCODE2CONSUMER_R', values), /no "case A: return B;" entries/);
});

// Two B keys, as on an Alice layout: the B Pro boards scatter matrix columns, so the
// left key can have the higher column.
test('two keys with one name are left and right in transform order, not by column', () => {
  const board = {
    pid: 0x0711, rows: 2, cols: 4, roles: { mac: 0, macFn: 1, win: 2, winFn: 3 }, knob: null,
    keys: [{ row: 0, col: 3 }, { row: 1, col: 0 }],
    layers: [{}, {}, { '0,3': 0x05, '1,0': 0x05 }, {}],
  };
  const { keys } = zmkLayout(board, { QK_MOMENTARY: 0x5220, QK_MACRO: 0x7700 }, { LABEL_TO_KEYCODE: { B: 0x05 } });
  assert.deepEqual(keys.map(k => k.label), ['B (left)', 'B (right)']);
});
