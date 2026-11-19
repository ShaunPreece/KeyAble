// Checks that Help's Supported Keyboards list and the README's model count match
// KEYBOARD_DB. Run with `npm test` in DevTools; fix with supported-keyboards.mjs write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { supportedKeyboardFiles } from '../supported-keyboards.mjs';

test("Help's Supported Keyboards list and the README count match KEYBOARD_DB", () => {
  const stale = supportedKeyboardFiles().filter(f => f.current !== f.wanted).map(f => path.basename(f.file));
  assert.deepEqual(stale, [], 'run: node DevTools/supported-keyboards.mjs write');
});
