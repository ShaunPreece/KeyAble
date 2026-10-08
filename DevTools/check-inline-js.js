// Extracts inline <script> blocks from an HTML file and syntax-checks each
// with the V8 parser (vm.Script), reporting the source line of any error.
const fs = require('fs');
const vm = require('vm');

const target = process.argv[2];
if (!target) { console.error('usage: node check-inline-js.js <file.html>'); process.exit(2); }

const html = fs.readFileSync(target, 'utf8');
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m, idx = 0, failures = 0, checked = 0;

while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  // Skip external scripts (src=...) and non-JS types (e.g. application/json)
  if (/\bsrc\s*=/.test(attrs)) continue;
  if (/\btype\s*=/.test(attrs) && !/\btype\s*=\s*["']?(text\/javascript|module|application\/javascript)["']?/i.test(attrs)) continue;

  idx++;
  const code = m[2];
  // Line number where this block's content starts in the HTML
  const startLine = html.slice(0, m.index + m[0].indexOf(code)).split('\n').length;
  checked++;
  try {
    new vm.Script(code, { filename: `${target}#script${idx}` });
    console.log(`OK   block ${idx} (starts HTML line ${startLine}, ${code.split('\n').length} lines)`);
  } catch (e) {
    failures++;
    console.error(`FAIL block ${idx} (starts HTML line ${startLine}): ${e.message}`);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 3).join('\n'));
  }
}

console.log(`\n${checked} inline JS block(s) checked, ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
