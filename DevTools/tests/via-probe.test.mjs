// Runs DevTools/via-probe.html against the simulated keyboard, so the probe is known to
// work before it is pointed at a real board. Run with `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT as ROOT, FAKE_KEYCHRON, useEdge } from './edge.mjs';

const newPage = useEdge('probe', { initScripts: [{ path: FAKE_KEYCHRON }] });
let server;

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
});

after(() => server?.close());

test('the probe runs all four checks and reports what the simulator does', async () => {
  const page = await newPage();
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
    'Check 4, layout positions: PASS',
  ], await page.locator('#results').innerText());
  await page.close();
});
