// Checks that demo mode runs the real flows against the simulated DemoKeyboard: the
// model list, the layer roles, Review Changes, backup, factory reset and lighting.
// Runs the real app in headless Edge. Run with `npm test` in DevTools.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here    = path.dirname(fileURLToPath(import.meta.url));
const APP_URL = pathToFileURL(path.resolve(here, '../../Project/KeyAble.html')).href;
// Owned by this run and deleted in after(); the runner script deletes it too.
const PROFILE = path.join(tmpdir(), 'keyable-tests-profile-demo');

const V2_MAX_ANSI = 0x0920;   // a five-layer model, so its own role map matters

let context;

before(async () => {
  rmSync(PROFILE, { recursive: true, force: true });
  context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge', headless: true, acceptDownloads: true,
  });
  // No first-run welcome dialog: it would make the page inert.
  await context.addInitScript(() => { try { localStorage.setItem('keyable-v1', '1'); } catch (_) { /* blocked */ } });
});

after(async () => {
  await context?.close();
  rmSync(PROFILE, { recursive: true, force: true });
});

async function demoPage(pid = V2_MAX_ANSI) {
  const page = await context.newPage();
  await page.goto(APP_URL);
  await page.getByRole('button', { name: 'Try KeyAble Without a Keyboard (Demo)' }).click();
  await page.locator(`#model-listbox [role="option"][data-value="${pid}"]`).click();
  await page.locator('#btn-load-layout').click();
  await page.locator('#status-text', { hasText: 'Demo mode.' }).waitFor();
  await page.locator('#kbd-os-mode', { hasText: 'Windows' }).waitFor();
  return page;
}

test('the demo list offers every model that has a layout, once each', async () => {
  const page = await context.newPage();
  await page.goto(APP_URL);
  const { offered, expected } = await page.evaluate(() => ({
    offered: Array.from(document.querySelectorAll('#model-listbox [role="option"]'), o => Number(o.dataset.value)).sort(),
    expected: Object.entries(KEYBOARD_DB)
      .filter(([, e]) => KEYCHRON_LAYOUTS[e.layoutId]).map(([pid]) => Number(pid)).sort(),
  }));
  assert.deepEqual(offered, expected);
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
  const rows = () => page.evaluate(async () => {
    stepKeys = getStepKeys(activeLayout());
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
  await page.locator('#reset-progress', { hasText: /reset|Reset/ }).waitFor();
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
