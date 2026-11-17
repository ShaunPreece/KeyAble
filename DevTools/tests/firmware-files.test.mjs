// Checks that a downloaded firmware link can only name a file inside the download
// folder. Run with `npm test` in DevTools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkedFileName } from '../firmware-files.mjs';

test('a plain file name is kept, percent-decoded', () => {
  assert.equal(linkedFileName('https://host/fw/k2_pro%20v1.1.bin?x=1'), 'k2_pro v1.1.bin');
});

test('a file name that would leave the download folder is refused', () => {
  for (const url of [
    'https://host/a/..%2F..%2Fx.bin',
    'https://host/a/..%5Cx.bin',
    'https://host/a/C%3Ax.bin',
    'https://host/a/x%00.bin',
    'https://host/a/%2E%2E',
    'https://host/a/',
    'https://host/a/%E0%A4%A.bin',
  ]) assert.equal(linkedFileName(url), null, url);
});
