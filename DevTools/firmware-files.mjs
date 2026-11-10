// Shared by the firmware scripts: downloading Keychron's firmware files, comparing the
// versions in their names, and telling a script run as a command from one imported.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Downloads every file with one of `extensions` linked from the `pages` into `dir`,
// skipping files already there, and calls onFile(file, url, page) for each, downloaded
// or not. Links in the page's HTML have their `&amp;` decoded before they are fetched.
export async function downloadLinkedFiles(pages, dir, extensions, onFile = () => {}) {
  mkdirSync(dir, { recursive: true });
  const linkPattern = new RegExp(`https?://[^"'\\s<>]+?\\.(?:${extensions.join('|')})(?:\\?[^"'\\s<>]*)?`, 'gi');
  for (const page of pages) {
    const html = await (await fetch(page)).text();
    const links = [...new Set((html.match(linkPattern) || []).map(u => u.replace(/&amp;/g, '&')))];
    console.log(`${page}: ${links.length} firmware files`);
    for (const url of links) {
      const file = decodeURIComponent(new URL(url).pathname.split('/').pop());
      const dest = path.join(dir, file);
      if (!existsSync(dest)) {
        const res = await fetch(url);
        if (!res.ok) { console.log(`  FAILED ${res.status} ${file}`); continue; }
        writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      }
      onFile(file, url, page);
    }
  }
}

// Whether version `a` is later than `b`, each an array of numbers, most significant
// first; a missing part counts as 0.
export function versionNewer(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// Whether the module whose `import.meta.url` is given was run with `node <file>`.
export const runAsCommand = moduleUrl =>
  !!process.argv[1] && moduleUrl === pathToFileURL(process.argv[1]).href;
