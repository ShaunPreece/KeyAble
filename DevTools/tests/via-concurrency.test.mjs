// Checks that KeyAble reads and saves the right keycodes when requests to the keyboard
// overlap, and when it reads whole layers from the keymap buffer. Runs the real app in
// headless Edge against the simulated keyboard in fake-keychron.js. Run with `npm test`
// in DevTools.
// The page's own names, used inside page.evaluate:
/* global HARDWARE_TESTED_BOARDS, KEYBOARD_DB, KEYCHRON_LAYOUTS, CMD_GET_KEY, activeLayout, changedKeysScan,
   currentKeymap, decodeAction, keymapBufferState, lightingState, sendVIA, stepKeys,
   setLightingValue, flushLightingSave */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_URL, FAKE_KEYCHRON, useEdge } from './edge.mjs';

const newPage = useEdge('via', { initScripts: [{ path: FAKE_KEYCHRON }], acceptDownloads: true });

const WIN_BASE = 2;
const WIN_FN   = 3;

// Keys changed on the simulated keyboard before each test, so a correct read has
// something to find. [layer, label, keycode]
const REMAPS = [
  [WIN_BASE, 'B', 0x007F],   // Mute
  [WIN_BASE, 'J', 0x0000],   // Disabled
  [WIN_FN,   'K', 0x0005],   // B
];

// A fresh page with the remaps applied and the keyboard connected. `bufferMode` is
// how the simulated keyboard answers the keymap buffer command; `tested` adds the
// simulated board to the hardware-tested list.
async function connectedPage(bufferMode = 'normal', { tested = false } = {}) {
  const page = await newPage();
  await page.goto(APP_URL);
  await page.evaluate(mode => window.__fakeKeychron.setBufferMode(mode), bufferMode);
  if (tested) await page.evaluate(() => { HARDWARE_TESTED_BOARDS[window.__fakeKeychron.PID] = true; });
  await page.evaluate(remaps => {
    const layout = KEYCHRON_LAYOUTS[KEYBOARD_DB[window.__fakeKeychron.PID].layoutId];
    for (const [layer, label, code] of remaps) {
      const key = layout.keys.find(k => k.label === label);
      window.__fakeKeychron.setKey(layer, key.row, key.col, code);
    }
  }, REMAPS);
  await page.getByRole('button', { name: 'Yes, Re-Connect This Keyboard' }).click();
  await page.locator('#status-text', { hasText: 'Successfully connected' }).waitFor();
  await idle(page);
  return page;
}

const idle = (page, quietMs = 150) => page.evaluate(ms => window.__fakeKeychron.whenIdle(ms), quietMs);

// What each Step 2 entry should say for `layer`, decoded by the app's own
// decodeAction from the simulated keyboard's true codes: idx -> action, defaults left out.
function expectedActions(page, layer, isFn) {
  return page.evaluate(([layer, isFn]) => {
    const f = window.__fakeKeychron;
    const out = {};
    stepKeys.forEach((key, idx) => {
      const code = key.isRotation
        ? f.getEncoder(layer, key.encoderId, key.clockwise ? 1 : 0)
        : f.getKey(layer, key.row, key.col);
      const action = decodeAction(code, key, layer, isFn);
      if (action !== 'Default') out[idx] = action;
    });
    return out;
  }, [layer, isFn]);
}

const step2Actions = page => page.evaluate(() => Object.fromEntries(currentKeymap));

// Leave Step 2 straight after entering it, so its background read is still running.
async function enterAndLeaveStep2(page, leaveWith) {
  await page.keyboard.press('Alt+2');
  await page.keyboard.press(leaveWith);
}

test('control: a Step 2 read on its own matches the keyboard', async () => {
  const page = await connectedPage();
  await page.keyboard.press('Alt+2');
  await idle(page);
  assert.deepEqual(await step2Actions(page), await expectedActions(page, WIN_BASE, false));
  await page.close();
});

test('two requests sent at once each get their own reply', async () => {
  const page = await connectedPage();
  const codes = await page.evaluate(async () => {
    const layout = activeLayout();
    const key = label => layout.keys.find(k => k.label === label);
    const [a, b] = [key('A'), key('B')];
    const [ra, rb] = await Promise.all([
      sendVIA([CMD_GET_KEY, 2, a.row, a.col]),
      sendVIA([CMD_GET_KEY, 2, b.row, b.col]),
    ]);
    const code = r => (r ? (r[4] << 8) | r[5] : null);
    return { a: code(ra), b: code(rb) };
  });
  assert.deepEqual(codes, { a: 0x0004, b: 0x007F }, 'A reads as A, B reads as its Mute remap');
  await page.close();
});

test('ticking and unticking Use with Fn reads back the chosen key', async () => {
  const page = await connectedPage();
  await page.keyboard.press('Alt+2');
  await idle(page);
  const idx = await page.evaluate(() => stepKeys.findIndex(k => k.label === 'D'));
  await page.locator(`#key-list-listbox [role="option"][data-value="${idx}"]`).click();
  const fnBox = page.locator('#use-fn-layer');
  await fnBox.check();
  await idle(page);
  await fnBox.uncheck();
  await idle(page);
  await page.waitForTimeout(200);   // announce() writes the live region after a delay

  const spoken = await page.evaluate(() => window.__fakeKeychron.spoken);
  assert.match(spoken.at(-1), /D is currently set to D\./, `last announcement: ${spoken.at(-1)}`);
  assert.deepEqual(await step2Actions(page), await expectedActions(page, WIN_BASE, false),
    'Step 2 list after the Fn toggles');
  await page.close();
});

// Back up from Step 1 and check the file holds the simulated keyboard's true codes.
async function backupMatchesKeyboard(page) {
  const download = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  await page.locator('#btn-backup').click();
  const progress = page.locator('#backup-progress');
  await progress.filter({ hasText: /Backup (complete|failed)/ }).waitFor({ timeout: 30000 });
  const outcome = await progress.textContent();
  assert.match(outcome, /Backup complete/, outcome);
  const backup = JSON.parse(readFileSync(await (await download).path(), 'utf8'));

  assert.equal(backup.format, 'keyable-settings');
  // The whole matrix of every layer, row by row, empty positions included.
  const truth = await page.evaluate(({ layers, rows, cols }) => {
    const f = window.__fakeKeychron;
    const out = [];
    for (let l = 0; l < layers; l++) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push(f.getKey(l, r, c));
    }
    return out;
  }, backup.shape);

  const wrong = [];
  backup.via.keymap.forEach((code, i) => { if (code !== truth[i]) wrong.push(`position ${i}`); });
  assert.equal(backup.via.keymap.length, truth.length);
  assert.deepEqual(wrong, [], `${wrong.length} keys saved with the wrong code`);
}

test('a backup started during the Step 2 read saves the real keymap', async () => {
  const page = await connectedPage();
  await enterAndLeaveStep2(page, 'Alt+1');
  await backupMatchesKeyboard(page);
  await page.close();
});

// Commands sent since `from` in the simulated keyboard's log, counted by command byte.
const commandsSince = (page, from) => page.evaluate(n =>
  window.__fakeKeychron.log.slice(n).reduce((c, r) => ({ ...c, [r[0]]: (c[r[0]] || 0) + 1 }), {}), from);
const logLength = page => page.evaluate(() => window.__fakeKeychron.log.length);

test('once checked against key-by-key reads, whole layers are read from the keymap buffer', async () => {
  const page = await connectedPage();
  await page.keyboard.press('Alt+2');
  await idle(page);
  assert.equal(await page.evaluate(() => keymapBufferState), 'trusted');
  await page.keyboard.press('Alt+1');
  const from = await logLength(page);
  await backupMatchesKeyboard(page);
  const sent = await commandsSince(page, from);
  assert.equal(sent[0x04], undefined, 'no single-key reads during the backup');
  assert.ok(sent[0x12] > 0, 'the backup read the keymap buffer');
  await page.close();
});

for (const mode of ['unhandled', 'shifted']) {
  test(`a keyboard whose keymap buffer is ${mode} is read key by key`, async () => {
    const page = await connectedPage(mode);
    await page.keyboard.press('Alt+2');
    await idle(page);
    assert.deepEqual(await step2Actions(page), await expectedActions(page, WIN_BASE, false));
    assert.equal(await page.evaluate(() => keymapBufferState), 'unusable');
    await page.keyboard.press('Alt+1');
    await backupMatchesKeyboard(page);
    await page.close();
  });
}

test('Review Changes opened during the Step 2 read lists exactly the changed keys', async () => {
  const page = await connectedPage();
  await enterAndLeaveStep2(page, 'Alt+1');
  await page.locator('#btn-changed-keys').click();
  await page.locator('#changed-keys-panel[open]').waitFor({ timeout: 30000 });

  const listed = await page.evaluate(() =>
    changedKeysScan.rows.map(r => `${r.kind} ${r.key.label}: ${r.action}`).sort());
  const expected = await page.evaluate(() => {
    const f = window.__fakeKeychron;
    const rows = [];
    for (const [kind, layer, isFn] of [['base', 2, false], ['fn', 3, true]]) {
      stepKeys.forEach(key => {
        if (key.label === 'Fn' || key.label === 'Fn2') return;
        const code = key.isRotation
          ? f.getEncoder(layer, key.encoderId, key.clockwise ? 1 : 0)
          : f.getKey(layer, key.row, key.col);
        const action = decodeAction(code, key, layer, isFn);
        if (action !== 'Default') rows.push(`${kind} ${key.label}: ${action}`);
      });
    }
    return rows.sort();
  });
  assert.deepEqual(listed, expected);
  await page.close();
});

test('Lighting opened during the Step 2 read loads the keyboard settings', async () => {
  const page = await connectedPage();
  await enterAndLeaveStep2(page, 'Alt+4');
  await page.locator('#lighting-panel:visible, #lighting-unsupported:visible').first()
    .waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#lighting-panel').isVisible(), true,
    'lighting panel shown, not "does not support lighting"');
  const state = await page.evaluate(() => lightingState);
  assert.deepEqual({ brightness: state.brightness, effect: state.effect }, { brightness: 128, effect: 1 });
  await page.close();
});

// Keychron's current via.c stores lighting on a save only when exactly one value was set
// since the last save, so the section saves before it sets a different value.
test('RGB Lighting saves one value before setting another', async () => {
  const page = await connectedPage();
  await page.keyboard.press('Alt+4');
  await page.locator('#lighting-panel').waitFor({ timeout: 30000 });
  await idle(page);
  const from = await logLength(page);
  await page.evaluate(async () => {
    await setLightingValue(1, [50]);
    await setLightingValue(1, [60]);
    await setLightingValue(2, [3]);
    await flushLightingSave();
  });
  const sent = await page.evaluate(n => window.__fakeKeychron.log.slice(n)
    .filter(r => r[0] === 0x07 || r[0] === 0x09).map(r => (r[0] === 0x07 ? `set ${r[2]}` : 'save')), from);
  assert.deepEqual(sent, ['set 1', 'set 1', 'save', 'set 2', 'save']);
  await page.close();
});

test('an untested board shows the Tell Us How It Went note, and a tested one does not', async () => {
  for (const tested of [false, true]) {
    const page = await connectedPage('normal', { tested });
    const note = page.locator('#untested-note');
    assert.equal(await note.isVisible(), !tested, `note visible when tested is ${tested}`);
    const status = await page.locator('#status-text').textContent();
    assert.equal(status.includes('not yet been tested'), !tested, status);
    if (!tested) await page.getByRole('button', { name: 'Tell Us How It Went' }).waitFor();
    await page.close();
  }
});
