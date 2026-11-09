// Checks that the app's data tables agree with each other. Loads KeyAble in headless
// Edge only to read its inline tables; no keyboard is involved. Run with `npm test`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { APP_URL, useEdge } from './edge.mjs';
import { ROOT, appTables } from '../keyboard-sources.mjs';

const newPage = useEdge('data');
let page;

before(async () => {
  page = await newPage();
  await page.goto(APP_URL);
});

test('every key in a model\'s layout has a factory keycode at the same matrix position', async () => {
  const problems = await page.evaluate(() => {
    const out = [];
    for (const [pid, entry] of Object.entries(KEYBOARD_DB)) {
      const model  = FACTORY_KEYMAPS[pid];
      const layout = KEYCHRON_LAYOUTS[entry.layoutId];
      if (!model || !layout) continue;
      const winBase = model.layers[(model.roles || DEFAULT_LAYER_ROLES).win];
      const missing = layout.keys
        .filter(k => winBase[`${k.row},${k.col}`] === undefined)
        .map(k => `${k.label} (${k.row},${k.col})`);
      if (missing.length) out.push(`${entry.name} [${entry.layoutId}]: ${missing.join(', ')}`);
    }
    return out;
  });
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

// A key sitting at a real but WRONG position is invisible to the check above: the
// position exists in the factory data, it just holds another key. On the Windows base
// layer every standard key holds its own keycode, so the label must match.
test('every standard key in a layout holds its own keycode in the factory data', async () => {
  const problems = await page.evaluate(() => {
    const out = [];
    for (const [pid, entry] of Object.entries(KEYBOARD_DB)) {
      const model  = FACTORY_KEYMAPS[pid];
      const layout = KEYCHRON_LAYOUTS[entry.layoutId];
      if (!model || !layout) continue;
      const winBase = model.layers[(model.roles || DEFAULT_LAYER_ROLES).win];
      const wrong = [];
      for (const k of layout.keys) {
        const expected = LABEL_TO_KEYCODE[k.label];
        const actual   = winBase[`${k.row},${k.col}`];
        // KC_NO, KC_TRNS and Keychron's own codes (0x7E00 up) say nothing about position:
        // a key such as F13 may simply be unassigned on the Windows layer.
        if (expected === undefined || actual === undefined || actual === expected) continue;
        if (actual <= 0x0001 || actual >= 0x7E00) continue;
        wrong.push(`${k.label} (${k.row},${k.col}) holds ${KEYCODE_TO_LABEL[actual] ?? hex4(actual)}`);
      }
      if (wrong.length) out.push(`${entry.name} [${entry.layoutId}]: ${wrong.join(', ')}`);
    }
    return out;
  });
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

// Backups store keycodes by key order, and validateBackup accepts a backup whose layoutId and
// key count match. A backup made before a key moved holds the keycode from its old position,
// so the key must be listed in its layout's keysMovedIn under a version after the release,
// which makes restore leave it alone.
test('every key moved since the last release is listed in keysMovedIn', () => {
  const tag = execFileSync('git', ['tag', '--sort=-v:refname'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')[0].trim();
  assert.ok(tag, 'no release tag found');
  const released = appTables(execFileSync('git', ['show', `${tag}:Project/KeyAble.html`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).KEYCHRON_LAYOUTS;
  const parts = v => v.replace(/^v/, '').split('.').map(Number);
  const later = version => {
    const a = parts(version);
    const b = parts(tag);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return false;
  };
  const current = appTables().KEYCHRON_LAYOUTS;
  const problems = [];
  for (const [id, layout] of Object.entries(current)) {
    const old = released[id];
    if (!old || old.keys.length !== layout.keys.length) continue;
    const declared = Object.entries(layout.keysMovedIn || {})
      .filter(([version]) => later(version)).flatMap(([, labels]) => labels);
    const moved = layout.keys
      .map((k, i) => [k, old.keys[i]])
      .filter(([k, o]) => (k.row !== o.row || k.col !== o.col) && !declared.includes(k.label))
      .map(([k, o]) => `${k.label} (${o.row},${o.col}) to (${k.row},${k.col})`);
    if (moved.length) problems.push(`${id}: ${moved.join(', ')}`);
  }
  assert.deepEqual(problems, [], `\nKeys moved since ${tag}, not in keysMovedIn:\n${problems.join('\n')}`);
});
