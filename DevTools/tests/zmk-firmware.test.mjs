// Checks that reading Keychron's ZMK translation tables fails loudly rather than
// producing an empty table. Run with `npm test` in DevTools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { returnTable } from '../zmk-firmware.mjs';

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
