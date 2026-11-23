// Checks that demo mode runs the real flows against the simulated DemoKeyboard: the
// model list, the layer roles, Review Changes, backup, factory reset and lighting.
// Runs the real app in headless Edge. Run with `npm test` in DevTools.
// The page's own names, used inside page.evaluate:
/* global KEYBOARD_DB, KEYCHRON_LAYOUTS, FACTORY_KEYMAPS, BUTTON_ACTIONS, DemoKeyboard,
   activeLayerRoles, activeLayout, deviceLayerCount, executeResetAll, hidDevice:writable,
   sendVIA, CMD_GET_PROTOCOL, CMD_GET_KEY, CMD_KEYMAP_GET_BUFFER, VIA_UNHANDLED,
   inDemoMode, scanChangedKeys, captureSession, writeKeyCodeOnLayer, restoreFileChosen,
   macroKeycode, offeredSystemKeys, codeName, LIST_STEP_TYPES, writeTarget:writable,
   readKeyCodeOnLayer, decodeAction, layerActionChanged, resetValueForLayer,
   CMD_DYNAMIC_KEYMAP_RESET, DemoAnalogMatrix, analogTravelAt */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_URL, useEdge } from './edge.mjs';

const V2_MAX_ANSI = 0x0920;   // a five-layer model, so its own role map matters
const V6_MAX_ANSI = 0x0960;   // protocol 12 RGB: Keychron settings and Keychron lighting
const K2_PRO_ANSI = 0x0220;   // protocol 9 firmware: the oldest keycode numbering and lighting commands
const K2_PRO_ANSI_WHITE = 0x0223;
const V1_ANSI = 0x0310;       // protocol 11 firmware: Keychron keys from 0x7F00
const Q1_V1_ANSI = 0x0100;    // AVR firmware, read from its .hex file: protocol 11 numbering
// ZMK firmware: protocol 12, but its own list of Keychron keys. Original and 2025 boards.
const B_PRO_BOARDS = [0x0711, 0x0712, 0x071A, 0x071B, 0x0761, 0x0762, 0x076B, 0x076C];
const V6_ULTRA_ANSI = 0x0C60; // Ultra 8K ZMK: 0x7E18 is Siri here, where the B6 Pro has its Keychron key
const V6_ULTRA_ISO = 0x0C61;  // its Windows voice key is Cortana (0x7E19)
const K2_HE_ANSI = 0x0E20;    // HE: the analog matrix, without Keychron's settings or lighting

const newPage = useEdge('demo', { acceptDownloads: true });

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

test('a factory reset the keyboard does not handle is reported as failed', async () => {
  const page = await demoPage();
  await page.evaluate(() => {
    const answer = hidDevice.answer.bind(hidDevice);
    hidDevice.answer = d => {
      if (d[0] === CMD_DYNAMIC_KEYMAP_RESET) { d[0] = VIA_UNHANDLED; return d; }
      return answer(d);
    };
  });
  await page.evaluate(() => executeResetAll());
  assert.match(await page.locator('#reset-progress').textContent(),
    /^Reset failed\. This keyboard does not accept a reset from KeyAble\..*Fn \+ J \+ Z/);
  await page.close();
});

test('a factory reset with no reply is checked against the keys themselves', async () => {
  const page = await demoPage();
  await page.evaluate(async () => {
    const R = activeLayerRoles();
    await writeKeyCodeOnLayer(R.win, activeLayout().keys.find(k => k.label === 'B'), 0x007F);
    const send = hidDevice.sendReport.bind(hidDevice);
    hidDevice.sendReport = async (id, data) => {   // the reset is lost: no reply, nothing reset
      if (data[0] !== CMD_DYNAMIC_KEYMAP_RESET) await send(id, data);
    };
  });
  await page.evaluate(() => executeResetAll());
  assert.match(await page.locator('#reset-progress').textContent(), /^Reset failed\. 1 key still changed\./);
  await page.close();
});

test('Review Changes says the keyboard could not be read when a layer read fails', async () => {
  const page = await demoPage();
  await page.evaluate(() => {
    const answer = hidDevice.answer.bind(hidDevice);
    hidDevice.answer = d => {   // every keymap read unhandled, as from firmware that stopped answering
      if (d[0] === CMD_GET_KEY || d[0] === CMD_KEYMAP_GET_BUFFER) { d[0] = VIA_UNHANDLED; return d; }
      return answer(d);
    };
  });
  await page.locator('#btn-changed-keys').click();
  await page.locator('#changed-keys-heading', { hasText: 'Could not read your keyboard.' }).waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#btn-changed-reset-all').isVisible(), false);
  await page.close();
});

test('the Macro tab opens for a key set to a macro past the keyboard\'s slots', async () => {
  const page = await demoPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.evaluate(async () => {
    const key = activeLayout().keys.find(k => k.label === 'H');
    const R = activeLayerRoles();
    for (const layer of [R.win, R.mac]) await writeKeyCodeOnLayer(layer, key, macroKeycode(20));   // macro 21; the demo has 16 slots
  });
  await startCapture(page);
  await page.keyboard.press('KeyH');
  await page.locator('#h-key-selected', { hasText: 'H' }).waitFor();
  await page.locator('#btn-remap-key').click();
  await page.locator('#at-text').click();
  await page.locator('#text-slot-info', { hasText: 'Using macro slot 1 of 16' }).waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

// A key bound to an empty macro, as Keychron's M1 to M5 keys are, keeps its slot.
test('a new macro skips an empty slot that another key plays', async () => {
  const page = await demoPage();
  await page.evaluate(async () => {
    const key = activeLayout().keys.find(k => k.label === 'J');
    await writeKeyCodeOnLayer(activeLayerRoles().mac, key, macroKeycode(0));   // macro 1, empty
  });
  await startCapture(page);
  await page.keyboard.press('KeyH');
  await page.locator('#h-key-selected', { hasText: 'H' }).waitFor();
  await page.locator('#btn-remap-key').click();
  await page.locator('#at-text').click();
  await page.locator('#text-slot-info', { hasText: 'Using macro slot 2 of 16' }).waitFor();
  await page.close();
});

// Every B Pro board: Fn+1 is Bluetooth 1 in Keychron's ZMK list, not the QMK boards'.
for (const pid of B_PRO_BOARDS) {
  test(`the ZMK B Pro ${pid.toString(16)} names its own Keychron keys and starts with no changes`, async () => {
    const page = await demoPage(pid);
    await page.keyboard.press('Alt+2');   // Review Changes scans the Step 2 key list
    const out = await page.evaluate(async () => {
      const one = activeLayout().keys.find(k => k.label === '1');
      const fn1 = FACTORY_KEYMAPS[hidDevice.productId].layers[activeLayerRoles().winFn][`${one.row},${one.col}`];
      const scan = await scanChangedKeys();
      return { fn1: codeName(fn1), changes: scan.rows.length };
    });
    assert.deepEqual(out, { fn1: 'Bluetooth 1', changes: 0 });
    await page.close();
  });
}

test('the V6 Ultra names its own Keychron keys, has its knob, and starts with no changes', async () => {
  const page = await demoPage(V6_ULTRA_ANSI);
  await page.keyboard.press('Alt+2');   // Review Changes scans the Step 2 key list
  const out = await page.evaluate(async () => {
    const { mac } = activeLayerRoles();
    const model = FACTORY_KEYMAPS[hidDevice.productId];
    const scan = await scanChangedKeys();
    return {
      siri: codeName(model.layers[mac]['0,15']),
      knob: model.encoders[mac][0],
      changes: scan.rows.length,
    };
  });
  assert.deepEqual(out, { siri: 'Siri', knob: { ccw: 0x00AA, cw: 0x00A9 }, changes: 0 });
  await page.close();
});

test('the V6 Ultra ISO voice key is factory as Cortana, and resets to Cortana', async () => {
  const page = await demoPage(V6_ULTRA_ISO);
  await page.keyboard.press('Alt+2');
  const out = await page.evaluate(async () => {
    const { win } = activeLayerRoles();
    const key = activeLayout().keys.find(k => k.row === 0 && k.col === 15);
    const read = await readKeyCodeOnLayer(win, key);
    const scan = await scanChangedKeys();
    return {
      read,
      shown: decodeAction(read, key, win),
      changed: await layerActionChanged(win, key),
      reset: codeName(resetValueForLayer(win, key)),
      changes: scan.rows.length,
    };
  });
  assert.deepEqual(out, { read: 0x7E19, shown: 'Default', changed: false, reset: 'Cortana', changes: 0 });
  await page.close();
});

test('the Q1 version 1 names its Keychron keys in its own numbering and starts with no changes', async () => {
  const page = await demoPage(Q1_V1_ANSI);
  await page.keyboard.press('Alt+2');   // Review Changes scans the Step 2 key list
  const out = await page.evaluate(async () => {
    const mac = activeLayerRoles().mac;
    const leftOption = FACTORY_KEYMAPS[hidDevice.productId].layers[mac]['5,1'];
    const scan = await scanChangedKeys();
    return { protocol: hidDevice.protocolVersion, leftOption: codeName(leftOption), changes: scan.rows.length };
  });
  assert.deepEqual(out, { protocol: 0x000B, leftOption: 'Left Option', changes: 0 });
  await page.close();
});

test('a request queued for one keyboard is not sent to the next one connected', async () => {
  const page = await demoPage();
  const replies = await page.evaluate(async () => {
    const first = hidDevice;
    const second = new DemoKeyboard(first.productId);
    await second.open();
    const queued = sendVIA([CMD_GET_PROTOCOL]);
    hidDevice = second;   // swapped before the request is sent
    const next = sendVIA([CMD_GET_PROTOCOL]);
    const out = [await queued, await next].map(r => r !== null);
    hidDevice = first;
    await second.close();
    return out;
  });
  assert.deepEqual(replies, [false, true]);
  await page.close();
});

// Back up the demo keyboard and return the file's contents.
async function demoBackup(page) {
  const download = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('#btn-backup').click();
  const file = await download;
  assert.match(file.suggestedFilename(), /^keyable-demo-/);
  return JSON.parse(readFileSync(await file.path(), 'utf8'));
}

// Choose `data` as the restore file, check the summary, confirm, and return the result.
async function demoRestore(page, data, summary) {
  await page.evaluate(d => restoreFileChosen({ target: { files: [new File([JSON.stringify(d)], 'backup.json')] } }), data);
  const shown = page.locator('#restore-file-summary');
  await shown.filter({ hasText: 'File:' }).waitFor();
  if (summary) assert.match(await shown.textContent(), summary);
  await page.locator('#btn-confirm-restore').click();
  const progress = page.locator('#backup-progress');
  await progress.filter({ hasText: /Restore (complete|failed)/ }).waitFor({ timeout: 30000 });
  return progress.textContent();
}

test('a demo backup saves the whole keyboard in the shared format', async () => {
  const page = await demoPage(V6_MAX_ANSI);
  await page.evaluate(async () => {
    const key = activeLayout().keys.find(k => k.label === 'J');
    await writeKeyCodeOnLayer(activeLayerRoles().win, key, 0x0000);
  });
  const backup = await demoBackup(page);
  const truth = await page.evaluate(() => ({
    keymap: Array.from(hidDevice.keymap),
    layers: hidDevice.layerCount,
    rows: activeLayout().rows,
    cols: activeLayout().cols,
    leds: activeLayout().keys.length,
  }));
  assert.equal(backup.format, 'keyable-settings');
  assert.equal(backup.version, 1);
  assert.equal(backup.keyboard.pid, V6_MAX_ANSI);
  assert.equal(backup.keyboard.firmware.versionReply, 'v1.0.0 demo');
  assert.equal(backup.keyboard.firmware.bcdDevice, null);
  assert.deepEqual(backup.shape, { layers: truth.layers, rows: truth.rows, cols: truth.cols, encoders: 1 });
  assert.deepEqual(backup.via.keymap, truth.keymap);
  assert.equal(backup.via.encoders.length, truth.layers);
  assert.deepEqual([backup.via.macros.count, backup.via.macros.size], [16, 1024]);
  assert.deepEqual(backup.via.lighting.map(e => [e.channel, e.value]), [[3, 1], [3, 2], [3, 3], [3, 4]]);
  assert.ok(!('effectCount' in backup.via), 'the effect count is left out: reading it changes the board');
  assert.deepEqual(backup.keychron.debounce, [0, 5]);
  assert.equal(backup.keychronRgb.ledCount, truth.leds);
  assert.equal(backup.keychronRgb.perKeyColours.length, 6 * truth.leds);
  await page.close();
});

// The demo keyboard's state that a restore should bring back, and a cell to hold a
// Keychron key: { a, effect, brightness, debounce, colour, macro, keychronCell }.
const demoState = page => page.evaluate(() => {
  const kb = hidDevice;
  const win = activeLayerRoles().win;
  const cell = label => { const k = activeLayout().keys.find(key => key.label === label); return kb.cell(win, k.row, k.col); };
  return {
    a: kb.keymap[cell('A')], keychronKey: kb.keymap[cell('F5')],
    brightness: kb.lighting[1], effect: kb.lighting[2],
    debounce: kb.keychron.debounce, colour: kb.keychronRgb.colours[0], macro: kb.macros[0],
    cells: { a: cell('A'), keychronKey: cell('F5') },
  };
});

// Change everything demoState reads, as if the user had since changed their setup.
const changeDemoBoard = page => page.evaluate(() => {
  const kb = hidDevice;
  const win = activeLayerRoles().win;
  const cell = label => { const k = activeLayout().keys.find(key => key.label === label); return kb.cell(win, k.row, k.col); };
  kb.keymap[cell('A')] = 0x0005;
  kb.lighting[1] = 10;
  kb.lighting[2] = 7;
  kb.keychron.debounce = [1, 9];
  kb.keychronRgb.colours[0] = 77;
  kb.macros[0] = 0x41;
});

test('a restore onto the firmware that saved it puts everything back', async () => {
  const page = await demoPage(V6_MAX_ANSI);
  const backup = await demoBackup(page);
  const before = await demoState(page);
  backup.via.keymap[before.cells.keychronKey] = 0x7E04;   // Mission Control, a Keychron key
  await changeDemoBoard(page);

  const result = await demoRestore(page, backup, /It holds keys, the knob, macros, lighting, Keychron settings and Keychron lighting\.$/);
  assert.equal(result, 'Restore complete. Your keyboard now matches the backup file.');
  const after = await demoState(page);
  assert.equal(after.a, before.a);
  assert.equal(after.keychronKey, 0x7E04, 'a Keychron key restores onto the same firmware');
  assert.deepEqual([after.brightness, after.effect], [before.brightness, before.effect]);
  assert.deepEqual(after.debounce, before.debounce);
  assert.equal(after.colour, before.colour);
  assert.equal(after.macro, before.macro);
  await page.close();
});

test('a restore onto other firmware leaves Keychron keys and lighting effects alone', async () => {
  const page = await demoPage(V6_MAX_ANSI);
  const backup = await demoBackup(page);
  const before = await demoState(page);
  backup.keyboard.firmware.versionReply = 'v0.9.0 2025-01-01-00:00:00';
  backup.via.keymap[before.cells.keychronKey] = 0x7E04;
  await changeDemoBoard(page);

  const result = await demoRestore(page, backup, /firmware is not the one that saved it/);
  assert.match(result, /One key set to Keychron's own keys was left as it is/);
  assert.match(result, /The lighting effect was left as it is/);
  const after = await demoState(page);
  assert.equal(after.keychronKey, before.keychronKey, 'the Keychron key was not written');
  assert.equal(after.effect, 7, 'the effect was not written');
  assert.equal(after.a, before.a, 'ordinary keys still restore');
  assert.equal(after.brightness, before.brightness);
  assert.deepEqual(after.debounce, before.debounce);
  await page.close();
});

test('a backup from KeyAble 1.3 or earlier is refused', async () => {
  const page = await demoPage(V6_MAX_ANSI);
  await page.evaluate(pid => restoreFileChosen({ target: { files: [new File([JSON.stringify({
    format: 'keyable-keymap', version: 1, keyboard: { pid }, layers: {}, encoders: [],
  })], 'old.json')] } }), V6_MAX_ANSI);
  await page.locator('#status-text', { hasText: 'KeyAble 1.3 or earlier' }).waitFor();
  assert.match(await page.locator('#status-text').textContent(), /cannot be restored by this version\./);
  await page.close();
});

test('the Reset button shows for a key chosen by Capture Mode', async () => {
  const page = await demoPage();
  await page.evaluate(async () => {
    const key = activeLayout().keys.find(k => k.label === 'H');
    await writeKeyCodeOnLayer(activeLayerRoles().winFn, key, 0x0005);   // Fn+H types B
  });
  await startCapture(page);
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

// Starts Capture Mode on a demo page and waits for its first matrix reads, so the
// keys that started it are released and a test's press is not taken as one of them.
async function startCapture(page) {
  await page.keyboard.press('Alt+2');
  await page.locator('#btn-capture').click();
  await page.locator('#capture-box:visible').waitFor();
  await page.waitForFunction(() => captureSession && captureSession.polls > 2 && captureSession.ignored.size === 0);
}

// Presses and releases the demo keyboard's switches for the named layout keys,
// together, with no keydown: as a key that types nothing would.
async function tapSwitches(page, ...labels) {
  await page.evaluate(names => {
    const at = names.map(name => {
      const key = activeLayout().keys.find(k => k.label === name);
      return `${key.row},${key.col}`;
    });
    at.forEach(a => hidDevice.setSwitch(a, true));
    at.forEach(a => hidDevice.setSwitch(a, false));
  }, labels);
}

test('Capture Mode selects a key by its switch, whatever the key types', async () => {
  const page = await demoPage(V6_MAX_ANSI);
  await page.evaluate(async () => {
    const key = activeLayout().keys.find(k => k.label === 'Right Win/Cmd');
    await writeKeyCodeOnLayer(activeLayerRoles().win, key, 0x0005);   // types B
  });
  await startCapture(page);
  await tapSwitches(page, 'Right Win/Cmd');
  await page.locator('#h-key-selected', { hasText: 'Right Win' }).waitFor();
  await page.close();
});

test('Capture Mode turns away Fn and two keys pressed together', async () => {
  const page = await demoPage(V6_MAX_ANSI);
  await startCapture(page);
  await tapSwitches(page, 'Fn');
  await page.locator('#sr-live', { hasText: 'Fn keys cannot be remapped.' }).waitFor();
  await tapSwitches(page, 'A', 'S');
  await page.locator('#sr-live', { hasText: 'More than one key was pressed.' }).waitFor();
  await tapSwitches(page, 'Fn', 'A');
  await page.locator('#sr-live', { hasText: 'Fn and another key were pressed together.' }).waitFor();
  assert.equal(await page.locator('#capture-box').isVisible(), true);
  await page.close();
});

test('Capture Mode finds a remapped knob turn by the code it now sends', async () => {
  const page = await demoPage(V6_MAX_ANSI);
  await page.evaluate(async () => {
    const cw = { isRotation: true, encoderId: 0, clockwise: true };
    await writeKeyCodeOnLayer(activeLayerRoles().win, cw, 0x00AB);   // Next Track, a key the board does not have
  });
  await startCapture(page);
  await page.keyboard.press('MediaTrackNext');
  await page.locator('#h-key-selected', { hasText: /Turn Clockwise/ }).waitFor();
  await page.close();
});

test('Capture Mode finds a knob turn on its factory volume code', async () => {
  const page = await demoPage(V6_MAX_ANSI);
  await startCapture(page);
  await page.keyboard.press('AudioVolumeDown');
  await page.locator('#h-key-selected', { hasText: /Turn Anti-clockwise/ }).waitFor();
  await page.close();
});

test('one Escape in Capture Mode selects nothing, and a second ends it', async () => {
  const page = await demoPage(V6_MAX_ANSI);
  await startCapture(page);
  await page.keyboard.press('Escape');
  await page.locator('#sr-live', { hasText: 'Press Escape again quickly' }).waitFor();
  await page.waitForTimeout(150);   // several matrix polls: the Escape switch is seen and released
  assert.equal(await page.locator('#key-selected-section').isVisible(), false);
  await page.keyboard.press('Escape');
  await page.locator('#sr-live', { hasText: 'Capture mode ended. No key was selected.' }).waitFor();
  await page.close();
});

test('Capture Mode says so when the keyboard does not report its switches', async () => {
  const page = await demoPage(V6_MAX_ANSI);
  await page.evaluate(() => { hidDevice.matrixAnswered = false; });
  await page.keyboard.press('Alt+2');
  await page.locator('#btn-capture').click();
  await page.locator('#sr-live', { hasText: 'Capture Mode is not available' }).waitFor();
  assert.equal(await page.locator('#capture-box').isVisible(), false);
  await page.close();
});

test('Capture Mode reads the older switch matrix layout of protocol 9 and 11 boards', async () => {
  for (const pid of [K2_PRO_ANSI, V1_ANSI]) {
    const page = await demoPage(pid);
    await startCapture(page);
    await page.keyboard.press('KeyH');
    await page.locator('#h-key-selected', { hasText: 'H' }).waitFor();
    await page.close();
  }
});

// - Keyboard Settings -

async function settingsPage(pid) {
  const page = await demoPage(pid);
  await page.keyboard.press('Alt+5');
  await page.locator('#setting-actuation:visible, #setting-debounce:visible').first().waitFor();
  return page;
}

const shownSettings = page => page.evaluate(() =>
  ['setting-actuation', 'setting-debounce', 'setting-split-debounce', 'setting-polling', 'setting-sleep']
    .filter(id => !document.getElementById(id).hidden));

test('Keyboard Settings asks for a keyboard when none is connected', async () => {
  const page = await newPage();
  await page.goto(APP_URL);
  await page.keyboard.press('Alt+5');
  await page.locator('#settings-not-connected:visible').waitFor();
  assert.deepEqual(await shownSettings(page), []);
  await page.close();
});

test('a board with no settings has no Step 1 hint, and Keyboard Settings says so', async () => {
  const page = await demoPage(K2_PRO_ANSI);
  assert.equal(await page.locator('#settings-hint').isVisible(), false);
  await page.keyboard.press('Alt+5');
  await page.locator('#settings-status-text', { hasText: "This keyboard's firmware has no settings KeyAble can change." }).waitFor();
  assert.deepEqual(await shownSettings(page), []);
  await page.close();
});

test('a Max board offers debounce and sleep times, and applies debounce', async () => {
  const page = await demoPage(V6_MAX_ANSI);
  assert.equal((await page.locator('#settings-hint').textContent()).trim(),
    "You can change this keyboard's debounce and wireless sleep times in Keyboard Settings (Alt+5).");
  await page.keyboard.press('Alt+5');
  await page.locator('#setting-debounce:visible').waitFor();
  assert.deepEqual(await shownSettings(page), ['setting-debounce', 'setting-sleep']);
  assert.equal(await page.locator('#debounce-now').textContent(), "Now 5 milliseconds (Keychron's usual).");

  await page.locator('#debounce-ms').fill('12');
  await page.locator('#btn-apply-debounce').click();
  await page.locator('#sr-live', { hasText: 'Debounce set to 12 milliseconds.' }).waitFor();
  assert.deepEqual(await page.evaluate(() => hidDevice.keychron.debounce), [0, 12]);
  assert.equal(await page.locator('#debounce-now').textContent(), 'Now 12 milliseconds.');
  await page.close();
});

test('debounce outside 0 to 255 is refused at the field', async () => {
  const page = await settingsPage(V6_MAX_ANSI);
  await page.locator('#debounce-ms').fill('300');
  await page.locator('#btn-apply-debounce').click();
  await page.locator('#debounce-error:visible', { hasText: 'from 0 to 255' }).waitFor();
  assert.equal(await page.locator('#debounce-ms').getAttribute('aria-invalid'), 'true');
  assert.deepEqual(await page.evaluate(() => hidDevice.keychron.debounce), [0, 5]);
  await page.close();
});

test('debounce of 0 or above 50 asks first; Cancel leaves it, Apply Anyway writes it', async () => {
  const page = await settingsPage(V6_MAX_ANSI);
  await page.locator('#debounce-ms').fill('0');
  await page.locator('#btn-apply-debounce').click();
  await page.locator('#debounce-confirm[open]').waitFor();
  assert.match(await page.locator('#debounce-confirm-desc').textContent(), /turns debounce off/);
  await page.locator('#btn-debounce-cancel').click();
  await page.locator('#sr-live', { hasText: 'Debounce not changed.' }).waitFor();
  assert.deepEqual(await page.evaluate(() => hidDevice.keychron.debounce), [0, 5]);

  await page.locator('#debounce-ms').fill('80');
  await page.locator('#btn-apply-debounce').click();
  await page.locator('#debounce-confirm[open]').waitFor();
  await page.locator('#btn-debounce-confirm').click();
  await page.locator('#sr-live', { hasText: 'Debounce set to 80 milliseconds.' }).waitFor();
  assert.deepEqual(await page.evaluate(() => hidDevice.keychron.debounce), [0, 80]);
  await page.close();
});

test('sleep times apply, and a refusal says so and keeps the times', async () => {
  const page = await settingsPage(V6_MAX_ANSI);
  assert.equal(await page.locator('#sleep-now').textContent(),
    'Now the backlight turns off after 10 minutes, and the keyboard sleeps after 2 hours.');
  await page.locator('#sleep-backlight').selectOption('300');
  await page.locator('#sleep-keyboard').selectOption('3600');
  await page.locator('#btn-apply-sleep').click();
  await page.locator('#sr-live', { hasText: 'Sleep times set.' }).waitFor();
  assert.deepEqual(await page.evaluate(() => hidDevice.keychron.wirelessSleep), [0x2C, 0x01, 0x10, 0x0E]);

  await page.evaluate(() => {   // the firmware refuses, as it does under 5 or 60 seconds
    const answer = hidDevice.answerKeychronMisc.bind(hidDevice);
    hidDevice.answerKeychronMisc = d => { if (d[1] === 0x0C) d[2] = 1; else answer(d); };
  });
  await page.locator('#sleep-backlight').selectOption('30');
  await page.locator('#btn-apply-sleep').click();
  await page.locator('#sr-live', { hasText: 'Could not set the sleep times.' }).waitFor();
  assert.equal(await page.locator('#sleep-backlight').inputValue(), '300');
  await page.close();
});

test('an Ultra 8K board offers its debounce, polling rate and sleep times, and applies the polling rate', async () => {
  const page = await demoPage(V6_ULTRA_ISO);
  assert.equal((await page.locator('#settings-hint').textContent()).trim(),
    "You can change this keyboard's debounce, polling rate and wireless sleep times in Keyboard Settings (Alt+5).");
  await page.keyboard.press('Alt+5');
  await page.locator('#setting-polling:visible').waitFor();
  assert.deepEqual(await shownSettings(page), ['setting-split-debounce', 'setting-polling', 'setting-sleep']);
  assert.equal(await page.locator('#polling-now').textContent(),
    'Now 1000 times a second by cable and 1000 times a second on 2.4 GHz. Bluetooth always uses 125.');
  assert.deepEqual(await page.locator('#polling-cable option').allTextContents(), [
    '125 times a second', '250 times a second', '500 times a second', "1000 times a second (Keychron's usual)",
    '2000 times a second', '4000 times a second', '8000 times a second']);

  await page.locator('#polling-cable').selectOption('0');
  await page.locator('#btn-apply-polling').click();
  await page.locator('#sr-live', { hasText: 'Polling rate set to 8000 times a second by cable and 1000 on 2.4 GHz.' }).waitFor();
  assert.deepEqual(await page.evaluate(() => hidDevice.keychronUltra.polling), [0, 3]);
  assert.equal(await page.locator('#polling-cable').inputValue(), '0');

  await page.locator('#sleep-backlight').selectOption('300');
  await page.locator('#btn-apply-sleep').click();
  await page.locator('#sr-live', { hasText: 'Sleep times set.' }).waitFor();
  assert.deepEqual(await page.evaluate(() => hidDevice.keychronUltra.wirelessSleep), [0x2C, 0x01, 0x20, 0x1C]);
  await page.close();
});

test('an Ultra 8K board sets press and release debounce, and refuses a release time of 0 at the field', async () => {
  const page = await demoPage(V6_ULTRA_ISO);
  await page.keyboard.press('Alt+5');
  await page.locator('#setting-split-debounce:visible').waitFor();
  assert.equal(await page.locator('#split-debounce-now').textContent(), 'Now press 0 milliseconds and release 50 milliseconds.');

  await page.locator('#debounce-release').fill('0');
  await page.locator('#btn-apply-split-debounce').click();
  await page.locator('#debounce-release-error:visible', { hasText: 'from 1 to 50' }).waitFor();
  assert.equal(await page.locator('#debounce-release').getAttribute('aria-invalid'), 'true');
  assert.deepEqual(await page.evaluate(() => hidDevice.keychronUltra.debounce), [0, 50]);

  await page.locator('#debounce-press').fill('5');
  await page.locator('#debounce-release').fill('15');
  await page.locator('#btn-apply-split-debounce').click();
  await page.locator('#sr-live', { hasText: 'Debounce set to press 5 milliseconds and release 15 milliseconds.' }).waitFor();
  assert.deepEqual(await page.evaluate(() => hidDevice.keychronUltra.debounce), [5, 15]);
  assert.equal(await page.locator('#debounce-release').getAttribute('aria-invalid'), null);
  await page.close();
});

test("Reset All Settings asks first, lists only what changes, and returns each to Keychron's usual", async () => {
  const page = await demoPage(V6_ULTRA_ISO);
  await page.keyboard.press('Alt+5');
  await page.locator('#setting-polling:visible').waitFor();
  await page.locator('#btn-reset-settings').click();
  await page.locator('#sr-live', { hasText: "Every setting is already at Keychron's usual." }).waitFor();

  await page.evaluate(() => {
    hidDevice.keychronUltra.polling = [0, 1];
    hidDevice.keychronUltra.debounce = [5, 15];
  });
  await page.keyboard.press('Alt+1');
  await page.keyboard.press('Alt+5');   // a visit re-reads the settings
  await page.locator('#split-debounce-now', { hasText: 'press 5 milliseconds' }).waitFor();
  await page.locator('#btn-reset-settings').click();
  await page.locator('#settings-reset-confirm[open]').waitFor();
  assert.equal(await page.locator('#settings-reset-confirm-desc').textContent(),
    "This sets each of these to Keychron's usual. Debounce: press 0 milliseconds and release 50 milliseconds. " +
    'Polling rate: 1000 times a second.');
  await page.locator('#btn-settings-reset-cancel').click();
  await page.locator('#sr-live', { hasText: 'Settings not changed.' }).waitFor();
  assert.deepEqual(await page.evaluate(() => hidDevice.keychronUltra.polling), [0, 1]);

  await page.locator('#btn-reset-settings').click();
  await page.locator('#btn-settings-reset-confirm').click();
  await page.locator('#sr-live', { hasText: "Keyboard settings reset to Keychron's usual." }).waitFor();
  assert.deepEqual(await page.evaluate(() => ({ polling: hidDevice.keychronUltra.polling, debounce: hidDevice.keychronUltra.debounce })),
    { polling: [3, 3], debounce: [0, 50] });
  assert.equal(await page.locator('#split-debounce-now').textContent(), 'Now press 0 milliseconds and release 50 milliseconds.');
  await page.close();
});

test('an HE board sets one actuation point for every key, replacing keys with their own', async () => {
  const page = await demoPage(K2_HE_ANSI);
  assert.equal((await page.locator('#settings-hint').textContent()).trim(),
    "You can change this keyboard's actuation point in Keyboard Settings (Alt+5).");
  await page.evaluate(() => {   // as if Keychron's Launcher had given one key its own point
    const a = hidDevice.analog;
    DemoAnalogMatrix.setTravel(a.profiles[0], a.keyAt(2, 1), { mode: 1, point: 5, sens: 4, releaseSens: 4 });
  });
  await page.keyboard.press('Alt+5');
  await page.locator('#setting-actuation:visible').waitFor();
  assert.deepEqual(await shownSettings(page), ['setting-actuation']);
  const now = await page.locator('#actuation-now').textContent();
  assert.match(now, /^Now 2\.0 millimetres \(Keychron's usual\)\. This changes profile 1 of 3/);
  assert.match(now, /1 key has its own settings/);

  const slider = page.locator('#actuation-point');
  await slider.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  assert.equal(await slider.getAttribute('aria-valuetext'), '3.0 millimetres');
  await page.locator('#btn-apply-actuation').click();
  await page.locator('#sr-live', { hasText: 'Actuation point set to 3.0 millimetres on every key.' }).waitFor();

  const board = await page.evaluate(() => {
    const a = hidDevice.analog, p = a.profiles[0];
    return { whole: analogTravelAt(p, 0), key: analogTravelAt(p, a.keyAt(2, 1)) };
  });
  assert.deepEqual(board.whole, { mode: 1, point: 30, sens: 4, releaseSens: 4 });
  assert.deepEqual(board.key, { mode: 0, point: 0, sens: 0, releaseSens: 0 }, 'the key follows the whole keyboard again');
  assert.doesNotMatch(await page.locator('#actuation-now').textContent(), /own settings/);
  await page.close();
});

test('an HE profile with Rapid Trigger keeps it when the actuation point changes', async () => {
  const page = await demoPage(K2_HE_ANSI);
  await page.evaluate(() => { hidDevice.analog.current = 1; });
  await page.keyboard.press('Alt+5');
  await page.locator('#setting-actuation:visible').waitFor();
  assert.match(await page.locator('#actuation-now').textContent(), /profile 2 of 3.*Rapid Trigger is on/);
  await page.locator('#actuation-point').focus();
  await page.keyboard.press('ArrowLeft');
  await page.locator('#btn-apply-actuation').click();
  await page.locator('#sr-live', { hasText: 'Actuation point set to 1.9 millimetres' }).waitFor();
  assert.deepEqual(await page.evaluate(() => analogTravelAt(hidDevice.analog.profiles[1], 0)),
    { mode: 2, point: 19, sens: 4, releaseSens: 4 });
  assert.equal(await page.evaluate(() => analogTravelAt(hidDevice.analog.profiles[0], 0).point), 20,
    'other profiles are left alone');
  await page.close();
});

test('the depth test follows F and says how deep each press went', async () => {
  const page = await settingsPage(K2_HE_ANSI);
  // The heading takes focus once the page shows, which would end the test at once.
  await page.waitForFunction(() => document.activeElement.id === 'h-settings');
  await page.locator('#btn-depth-test').click();
  await page.waitForFunction(() => document.activeElement.id === 'depth-scratch');
  const press = async tenths => {
    await page.evaluate(t => {
      const f = activeLayout().keys.find(k => k.label === 'F');
      hidDevice.analog.travel.set(`${f.row},${f.col}`, t);
    }, tenths);
    await page.waitForTimeout(150);
  };

  await press(25);
  await press(0);
  await page.locator('#sr-live', { hasText: 'Deepest 2.5 millimetres. At 2.0 millimetres, this press types.' }).waitFor();
  await press(12);
  await press(0);
  await page.locator('#sr-live', { hasText: 'Deepest 1.2 millimetres. At 2.0 millimetres, this press does not type.' }).waitFor();

  await page.keyboard.press('Escape');
  await page.locator('#sr-live', { hasText: 'Depth test ended.' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-depth-test');
  assert.equal(await page.locator('#depth-area').isVisible(), false);
  await page.close();
});
