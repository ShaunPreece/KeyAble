// Shared setup for the browser tests. Each test file runs headless Edge in its own
// profile folder, keyable-tests-profile-<name>, deleted after the file's tests and
// also by run-tests.ps1, in case a run is killed.
import { after } from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT     = path.resolve(here, '../..');
export const APP_URL       = pathToFileURL(path.join(REPO_ROOT, 'Project/KeyAble.html')).href;
export const FAKE_KEYCHRON = path.join(here, 'fake-keychron.js');

// Returns a function that opens a new page in this file's Edge, launching it on first
// use. A launch in a before() hook is not enough: node:test does not wait for one
// top-level before() hook to finish before running the next.
// `initScripts` are Playwright init scripts, run in every page before the app loads.
export function useEdge(name, { initScripts = [], acceptDownloads = false } = {}) {
  const profile = path.join(tmpdir(), `keyable-tests-profile-${name}`);
  let launching = null;
  const launch = async () => {
    rmSync(profile, { recursive: true, force: true });
    const context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, acceptDownloads });
    for (const script of initScripts) await context.addInitScript(script);
    return context;
  };
  after(async () => {
    if (launching) await (await launching).close();
    rmSync(profile, { recursive: true, force: true });
  });
  return async () => (await (launching ??= launch())).newPage();
}
