// Checks that the app's data tables agree with each other. Loads KeyAble in headless
// Edge only to read its inline tables; no keyboard is involved. Run with `npm test`.
// The page's own names, used inside page.evaluate:
/* global KEYBOARD_DB, KEYCHRON_LAYOUTS, FACTORY_KEYMAPS, DEFAULT_LAYER_ROLES,
   LABEL_TO_KEYCODE, KEYCODE_TO_LABEL */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { APP_URL, useEdge } from './edge.mjs';
import { hex } from '../keyboard-sources.mjs';

const newPage = useEdge('data');

// Every model with both a layout and factory data: its name, layoutId, layout keys and
// Windows base layer, plus the app's label and keycode maps.
let boards;
let labelToCode;
let codeToLabel;

before(async () => {
  const page = await newPage();
  await page.goto(APP_URL);
  ({ boards, labelToCode, codeToLabel } = await page.evaluate(() => ({
    boards: Object.entries(KEYBOARD_DB)
      .filter(([pid, entry]) => FACTORY_KEYMAPS[pid] && KEYCHRON_LAYOUTS[entry.layoutId])
      .map(([pid, entry]) => {
        const model = FACTORY_KEYMAPS[pid];
        return {
          name: `${entry.name} [${entry.layoutId}]`,
          keys: KEYCHRON_LAYOUTS[entry.layoutId].keys,
          winBase: model.layers[(model.roles || DEFAULT_LAYER_ROLES).win],
        };
      }),
    labelToCode: LABEL_TO_KEYCODE,
    codeToLabel: KEYCODE_TO_LABEL,
  })));
  await page.close();
});

test("every key in a model's layout has a factory keycode at the same matrix position", () => {
  const problems = [];
  for (const board of boards) {
    const missing = board.keys
      .filter(k => board.winBase[`${k.row},${k.col}`] === undefined)
      .map(k => `${k.label} (${k.row},${k.col})`);
    if (missing.length) problems.push(`${board.name}: ${missing.join(', ')}`);
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

// A key sitting at a real but WRONG position is invisible to the check above: the
// position exists in the factory data, it just holds another key. On the Windows base
// layer every standard key holds its own keycode, so the label must match.
test('every standard key in a layout holds its own keycode in the factory data', () => {
  const problems = [];
  for (const board of boards) {
    const wrong = [];
    for (const k of board.keys) {
      const expected = labelToCode[k.label];
      const actual   = board.winBase[`${k.row},${k.col}`];
      // KC_NO, KC_TRNS and Keychron's own codes (0x7E00 up) say nothing about position:
      // a key such as F13 may simply be unassigned on the Windows layer.
      if (expected === undefined || actual === undefined || actual === expected) continue;
      if (actual <= 0x0001 || actual >= 0x7E00) continue;
      // HID gives the ISO # key two codes, Backslash (0x31) and Non-US Hash (0x32), and the
      // K2 Pro and K6 Pro ISO firmware sends 0x31 from it.
      if (k.label === 'Non-US Hash' && actual === 0x0031) continue;
      wrong.push(`${k.label} (${k.row},${k.col}) holds ${codeToLabel[actual] ?? hex(actual)}`);
    }
    if (wrong.length) problems.push(`${board.name}: ${wrong.join(', ')}`);
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});
