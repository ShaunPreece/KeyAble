// Checks that demo mode runs the real flows against the simulated DemoKeyboard: the
// model list, the layer roles, Review Changes, backup, factory reset and lighting.
// Runs the real app in headless Edge. Run with `npm test` in DevTools.
// The page's own names, used inside page.evaluate:
/* global KEYBOARD_DB, KEYCHRON_LAYOUTS, FACTORY_KEYMAPS, BUTTON_ACTIONS, DemoKeyboard,
   activeLayerRoles, activeLayout, deviceLayerCount, executeResetAll, hidDevice,
   inDemoMode, scanChangedKeys, writeKeyCodeOnLayer */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_URL, useEdge } from './edge.mjs';

const V2_MAX_ANSI = 0x0920;   // a five-layer model, so its own role map matters

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
  assert.deepEqual(await rows(), ['base B: Mute', 'fn K: B']);

  await page.evaluate(() => executeResetAll());
  await page.waitForFunction(() => hidDevice.keymap.every((c, i) => c === new DemoKeyboard(hidDevice.productId).keymap[i]));
  assert.deepEqual(await rows(), [], 'factory reset restored every key');
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

test('lighting in demo loads the simulated settings', async () => {
  const page = await demoPage();
  await page.keyboard.press('Alt+4');
  await page.locator('#lighting-panel:visible, #lighting-unsupported:visible').first().waitFor();
  assert.equal(await page.locator('#lighting-panel').isVisible(), true);
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
