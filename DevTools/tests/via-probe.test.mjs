// Runs DevTools/via-probe.html against the simulated keyboard, so the probe is known to
// work before it is pointed at a real board. Run with `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here    = path.dirname(fileURLToPath(import.meta.url));
const ROOT    = path.resolve(here, '../..');
const FAKE    = path.join(here, 'fake-keychron.js');
const PROFILE = path.join(tmpdir(), 'keyable-tests-profile-probe');

let server;
let context;

before(async () => {
  // The probe fetches the app's source, which a file:// page cannot do.
  server = createServer(async (req, res) => {
    try {
      const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(ROOT)) throw new Error('outside the repo');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await rm(PROFILE, { recursive: true, force: true });
  context = await chromium.launchPersistentContext(PROFILE, { channel: 'msedge', headless: true });
  await context.addInitScript({ path: FAKE });
});

after(async () => {
  await context?.close();
  server?.close();
  await rm(PROFILE, { recursive: true, force: true });
});

test('the probe runs all four checks and reports what the simulator does', async () => {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/DevTools/via-probe.html`);
  // The simulator seeds itself from the app's tables, which the probe page lacks.
  await page.evaluate(async () => {
    Object.assign(window, await loadTables(), {
      DEFAULT_LAYER_ROLES: { mac: 0, macFn: 1, win: 2, winFn: 3 },
      LABEL_TO_KEYCODE: {},
    });
  });
  await page.getByRole('button', { name: 'Connect Keyboard' }).click();
  await page.locator('#status', { hasText: 'Connected' }).waitFor();
  await page.getByRole('button', { name: 'Run All Checks' }).click();
  await page.locator('#status', { hasText: /^(Done|Stopped)/ }).waitFor({ timeout: 60000 });

  const headings = await page.locator('#results h3').allTextContents();
  assert.deepEqual(headings, [
    'Check 1, two reads at once: FAIL',           // the simulator answers as firmware does
    'Check 2, replies repeat their request: PASS',
    'Check 3, whole-layer read: PASS',
    'Check 4, layout positions: FAIL',            // V6 Max ANSI: Right Shift and Numpad 0
  ], await page.locator('#results').innerText());
  await page.close();
});
