// Checks that demo mode runs the real flows against the simulated DemoKeyboard: the
// model list, the layer roles, Review Changes, backup, factory reset and lighting.
// Runs the real app in headless Edge. Run with `npm test` in DevTools.
// The page's own names, used inside page.evaluate:
/* global KEYBOARD_DB, KEYCHRON_LAYOUTS, FACTORY_KEYMAPS, BUTTON_ACTIONS, DemoKeyboard,
   activeLayerRoles, activeLayout, deviceLayerCount, executeResetAll, hidDevice,
   inDemoMode, scanChangedKeys, writeKeyCodeOnLayer, restoreKeymapFileChosen,
   macroKeycode, offeredSystemKeys, codeName, LIST_STEP_TYPES, writeTarget:writable */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_URL, useEdge } from './edge.mjs';

const V2_MAX_ANSI = 0x0920;   // a five-layer model, so its own role map matters
const V6_MAX_ANSI = 0x0960;   // Right Shift and Numpad 0 moved in 1.3 (keysMovedIn)
const K2_PRO_ANSI = 0x0220;   // protocol 9 firmware: the oldest keycode numbering and lighting commands
const K2_PRO_ANSI_WHITE = 0x0223;
const V1_ANSI = 0x0310;       // protocol 11 firmware: Keychron keys from 0x7F00
const B6_PRO_ISO = 0x0762;    // ZMK firmware: protocol 12, but its own list of Keychron keys

// No first-run welcome dialog: it would make the page inert.
const skipWelcome = () => { try { localStorage.setItem('keyable-v1', '1'); } catch { /* blocked */ } };
const newPage = useEdge('demo', { initScripts: [skipWelcome], acceptDownloads: true });

async function demoPage(pid = V2_MAX_ANSI) {
  const page = await newPage();
  await page.goto(APP_URL);
  await page.getByRole('button', { name: 'Try KeyAble Without a Keyboard (Demo)' }).click();
  await page.locator(`#model-listbox [role="option"][data-value="${pid}"]`).click();
  await page.locator('#btn-load-layout').click();
  await page.locator('#status-text', { hasText: 'Demo mode.' }).waitFor();
  await page.locator('#kbd-os-mode', { hasText: 'Windows' }).waitFor();
  return page;
}

test('the demo list offers every model that has a layout, once each', async () => {
  const page = await newPage();
  await page.goto(APP_URL);
  const { offered, expected } = await page.evaluate(() => ({
    offered: Array.from(document.querySelectorAll('#model-listbox [role="option"]'), o => Number(o.dataset.value)).sort(),
    expected: Object.entries(KEYBOARD_DB)
      .filter(([, e]) => KEYCHRON_LAYOUTS[e.layoutId]).map(([pid]) => Number(pid)).sort(),
  }));
  assert.deepEqual(offered, expected);
  await page.close();
});

// Buttons wired by addEventListener in their own init code rather than by data-action.
const SCRIPT_WIRED_BUTTONS = ['theme-toggle', 'btn-add-step', 'at-single', 'at-shortcut',
  'at-media', 'at-system', 'at-text', 'at-disable'];

test('every button has an action, and no element has an inline handler', async () => {
  const page = await newPage();
  await page.goto(APP_URL);
  const problems = await page.evaluate(wired => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) {
        if (attr.startsWith('on')) out.push(`${el.id || el.tagName} has inline ${attr}`);
      }
    }
    for (const btn of document.querySelectorAll('button')) {
      const name = btn.dataset.action;
      if (name && !(name in BUTTON_ACTIONS)) out.push(`${btn.id || btn.textContent.trim()}: no action ${name}`);
      if (!name && !wired.includes(btn.id)) out.push(`${btn.id || btn.textContent.trim()}: no data-action`);
    }
    return out;
  }, SCRIPT_WIRED_BUTTONS);
  assert.deepEqual(problems, []);
  await page.close();
});

test('a demo model uses its own factory data and layer roles', async () => {
  const page = await demoPage();
  const state = await page.evaluate(pid => ({
    roles: activeLayerRoles(),
    expected: FACTORY_KEYMAPS[pid].roles,
    layers: deviceLayerCount,
    demo: inDemoMode(),
  }), V2_MAX_ANSI);
  assert.deepEqual(state.roles, state.expected);
  assert.equal(state.layers, 5);
  assert.equal(state.demo, true);
  await page.close();
});

test('macros and Mission Control follow the keycode numbering of the firmware', async () => {
  const codes = async pid => {
    const page = await demoPage(pid);
    const out = await page.evaluate(() => {
      writeTarget = 'mac';   // names and macro steps follow the layout being edited
      const mc = offeredSystemKeys('mac').find(k => k.label === 'Mission Control');
      return {
        macro: macroKeycode(2),
        macroName: codeName(macroKeycode(2)),
        missionControl: mc && mc.code,
        missionControlName: mc && codeName(mc.code),
        inMacroSteps: LIST_STEP_TYPES.system.items().some(k => k.label === 'Mission Control'),
      };
    });
    await page.close();
    return out;
  };
  const macro3 = { macroName: 'Types Text (macro 3)', missionControlName: 'Mission Control' };
  assert.deepEqual(await codes(V2_MAX_ANSI),
    { ...macro3, macro: 0x7702, missionControl: 0x00C1, inMacroSteps: true });
  assert.deepEqual(await codes(V1_ANSI),
    { ...macro3, macro: 0x7702, missionControl: 0x7F00, inMacroSteps: false });
  assert.deepEqual(await codes(K2_PRO_ANSI),
    { ...macro3, macro: 0x5F14, missionControl: 0x5F84, inMacroSteps: false });
});

test('lighting on protocol 9 firmware works on RGB boards and is unsupported on White ones', async () => {
  const lighting = async pid => {
    const page = await demoPage(pid);
    await page.keyboard.press('Alt+4');
    await page.locator('#lighting-panel:visible, #lighting-unsupported:visible').first().waitFor();
    if (!await page.locator('#lighting-panel').isVisible()) { await page.close(); return 'unsupported'; }
    const slider = page.locator('#lighting-brightness');
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => hidDevice.lighting[1] !== 128);
    await page.close();
    return 'works';
  };
  assert.equal(await lighting(K2_PRO_ANSI), 'works');
  assert.equal(await lighting(K2_PRO_ANSI_WHITE), 'unsupported');
});

test('Review Changes in demo finds base and Fn changes, and factory reset clears them', async () => {
  const page = await demoPage();
  await page.keyboard.press('Alt+2');   // Review Changes scans the Step 2 key list
  const rows = () => page.evaluate(async () => {
    const scan = await scanChangedKeys();
    return scan.rows.map(r => `${r.kind} ${r.key.label}: ${r.action}`).sort();
  });
  assert.deepEqual(await rows(), [], 'a new demo keyboard is at its factory defaults');

  await page.evaluate(async () => {
    const R = activeLayerRoles();
    const key = label => activeLayout().keys.find(k => k.label === label);
    await writeKeyCodeOnLayer(R.win, key('B'), 0x007F);     // Mute
    await writeKeyCodeOnLayer(R.winFn, key('K'), 0x0005);   // B
  });
  assert.deepEqual(await rows(), ['base B: Mute / Unmute', 'fn K: B']);

  await page.evaluate(() => executeResetAll());
  await page.waitForFunction(() => hidDevice.keymap.every((c, i) => c === new DemoKeyboard(hidDevice.productId).keymap[i]));
  assert.deepEqual(await rows(), [], 'factory reset restored every key');
  await page.close();
});

test('the ZMK B6 Pro names its own Keychron keys and starts with no changes', async () => {
  const page = await demoPage(B6_PRO_ISO);
  await page.keyboard.press('Alt+2');   // Review Changes scans the Step 2 key list
  const out = await page.evaluate(async () => {
    const winFn = activeLayerRoles().winFn;
    const fn1 = FACTORY_KEYMAPS[hidDevice.productId].layers[winFn]['7,1'];   // Fn+1
    const scan = await scanChangedKeys();
    return { fn1: codeName(fn1), changes: scan.rows.length };
  });
  assert.deepEqual(out, { fn1: 'Bluetooth 1', changes: 0 });
  await page.close();
});

test('a demo backup saves the simulated keyboard\'s keymap', async () => {
  const page = await demoPage();
  await page.evaluate(async () => {
    const key = activeLayout().keys.find(k => k.label === 'J');
    await writeKeyCodeOnLayer(activeLayerRoles().win, key, 0x0000);
  });
  const download = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('#btn-backup').click();
  const file = await download;
  assert.match(file.suggestedFilename(), /^keyable-demo-/);
  const backup = JSON.parse(readFileSync(await file.path(), 'utf8'));
  const truth = await page.evaluate(() => {
    const keys = activeLayout().keys;
    const out = {};
    for (let l = 0; l < hidDevice.layerCount; l++) {
      out[l] = keys.map(k => hidDevice.keymap[hidDevice.cell(l, k.row, k.col)]);
    }
    return out;
  });
  assert.deepEqual(backup.layers, truth);
  await page.close();
});

test('restoring a backup from before a key moved leaves that key alone', async () => {
  const page = await demoPage(V6_MAX_ANSI);
  const download = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('#btn-backup').click();
  const backup = JSON.parse(readFileSync(await (await download).path(), 'utf8'));

  const cells = () => page.evaluate(() => {
    const win = activeLayerRoles().win;
    const cell = label => {
      const k = activeLayout().keys.find(key => key.label === label);
      return hidDevice.keymap[hidDevice.cell(win, k.row, k.col)];
    };
    return { rightShift: cell('Right Shift'), numpad0: cell('Numpad 0'), a: cell('A') };
  });
  const before = await cells();

  // A 1.2 backup read Right Shift and Numpad 0 from empty positions, so holds no key.
  await page.evaluate(old => {
    const keys = activeLayout().keys;
    const at = label => keys.findIndex(k => k.label === label);
    old.appVersion = '1.2';
    for (const codes of Object.values(old.layers)) {
      codes[at('Right Shift')] = 0;
      codes[at('Numpad 0')] = 0;
    }
    old.layers[String(activeLayerRoles().win)][at('A')] = 0x0005;   // B: the rest is restored
    restoreKeymapFileChosen({ target: { files: [new File([JSON.stringify(old)], 'old.json')] } });
  }, backup);
  await page.locator('#restore-file-summary', { hasText: 'without Right Shift and Numpad 0' }).waitFor();
  await page.locator('#btn-confirm-restore').click();
  await page.locator('#backup-progress', { hasText: 'Restore complete.' }).waitFor({ timeout: 30000 });
  assert.match(await page.locator('#backup-progress').textContent(),
    /If you remap Right Shift or Numpad 0, make a new backup so it includes them\./);

  const after = await cells();
  assert.notEqual(before.rightShift, 0);
  assert.equal(after.rightShift, before.rightShift, 'Right Shift was left as it was');
  assert.equal(after.numpad0, before.numpad0, 'Numpad 0 was left as it was');
  assert.equal(after.a, 0x0005, 'the other keys were restored');
  await page.close();
});

test('the Reset button shows for a key chosen by Capture Mode', async () => {
  const page = await demoPage();
  await page.evaluate(async () => {
    const key = activeLayout().keys.find(k => k.label === 'H');
    await writeKeyCodeOnLayer(activeLayerRoles().winFn, key, 0x0005);   // Fn+H types B
  });
  await page.keyboard.press('Alt+2');
  await page.locator('#btn-capture').click();
  await page.locator('#capture-box:visible').waitFor();
  await page.keyboard.press('KeyH');
  await page.locator('#h-key-selected', { hasText: 'H' }).waitFor();
  assert.equal(await page.locator('#btn-reset-key').isVisible(), true);
  await page.close();
});

test('a lighting slider the keyboard does not accept goes back and says so', async () => {
  const page = await demoPage();
  await page.keyboard.press('Alt+4');
  await page.locator('#lighting-panel:visible').waitFor();
  const slider = page.locator('#lighting-brightness');
  const before = await slider.inputValue();
  await page.evaluate(() => { hidDevice.lightingChannel = 0xEE; });   // every lighting set unhandled
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await page.locator('#sr-live', { hasText: 'Could not change brightness.' }).waitFor();
  assert.equal(await slider.inputValue(), before);
  await page.close();
});

test('lighting in demo loads the simulated settings', async () => {
  const page = await demoPage();
  await page.keyboard.press('Alt+4');
  await page.locator('#lighting-panel:visible, #lighting-unsupported:visible').first().waitFor();
  assert.equal(await page.locator('#lighting-panel').isVisible(), true);
  await page.close();
});

test('RGB Turn Off selects the Off effect and Turn On puts the effect back', async () => {
  const page = await demoPage();
  await page.keyboard.press('Alt+4');
  await page.locator('#lighting-panel:visible').waitFor();
  const toggle = page.locator('#btn-lighting-toggle');
  const lighting = () => page.evaluate(() => ({ brightness: hidDevice.lighting[1], effect: hidDevice.lighting[2] }));

  await toggle.click();
  await page.locator('#sr-live', { hasText: 'RGB lighting turned off.' }).waitFor();
  assert.deepEqual(await lighting(), { brightness: 128, effect: 0 });

  // Leaving and coming back reads effect 0 with brightness above 0 as off.
  await page.keyboard.press('Alt+1');
  await page.keyboard.press('Alt+4');
  await page.locator('#lighting-status', { hasText: 'RGB lighting is currently off.' }).waitFor();
  assert.equal((await toggle.textContent()).trim(), 'Turn RGB lighting On');

  await toggle.click();
  await page.locator('#sr-live', { hasText: 'Effect: Solid colour.' }).waitFor();
  assert.deepEqual(await lighting(), { brightness: 128, effect: 1 });
  await page.close();
});

test('Capture Mode starts without a script error', async () => {
  const page = await demoPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.keyboard.press('Alt+2');
  await page.locator('#btn-capture').click();
  await page.locator('#capture-box:visible').waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});
