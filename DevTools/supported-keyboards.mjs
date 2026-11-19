#!/usr/bin/env node
// Writes Help's Supported Keyboards list and the README's model count from KEYBOARD_DB,
// between the GENERATED SUPPORTED KEYBOARDS markers in each file.
//
// Only boards with a layout count: the ones the app can remap and the demo offers. A
// model is a board's name without its variant words (layout, knob and backlight), and
// a revision ("Q1 Version 2", "B6 Pro 2025") is listed under its model. A model with no
// ISO board is marked "ANSI only", and one with no ANSI board "ISO only". Help says JIS
// layouts are not supported, so a JIS board with a layout stops the script.
//
// Usage:
//   node DevTools/supported-keyboards.mjs check
//     says whether Help and the README match KEYBOARD_DB; changes nothing
//   node DevTools/supported-keyboards.mjs write
//     rewrites both lists from KEYBOARD_DB
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, APP, appTables } from './keyboard-sources.mjs';
import { runAsCommand } from './firmware-files.mjs';

const README = path.join(ROOT, 'README.md');
const BEGIN = 'BEGIN GENERATED SUPPORTED KEYBOARDS: DevTools/supported-keyboards.mjs write';
const END   = 'END GENERATED SUPPORTED KEYBOARDS';

// Series in the order Help lists them, and the product lines within a model number. A
// series or line missing here stops the script, so a new one gets a deliberate place.
const SERIES = ['Q', 'V', 'K', 'S', 'C', 'B'];
const LINES  = ['', 'Plus', 'Pro', 'Pro SE', 'Max', 'HE', 'Ultra 8K'];

const VARIANT_WORDS = /( (ANSI|ISO|JIS|Knob|RGB|White|Red|Non-Light))+$/;

// { name, notes } per model, grouped by series in Help's order, and the number of boards.
export function supportedModels({ KEYBOARD_DB, KEYCHRON_LAYOUTS }) {
  const models = new Map();
  let boards = 0;
  for (const entry of Object.values(KEYBOARD_DB)) {
    if (!KEYCHRON_LAYOUTS[entry.layoutId]) continue;
    if (/ JIS\b/.test(entry.name)) throw new Error(`${entry.name} has a layout, but Help says JIS is not supported`);
    boards += 1;
    const full = entry.name.replace(/^Keychron /, '').replace(VARIANT_WORDS, '');
    const version = / Version (\d+)$/.exec(full);
    const base = full.replace(/ Version \d+$/, '').replace(/ 2025$/, '');
    const m = /^([A-Z])(\d+) ?(.*)$/.exec(base);
    if (!m || !SERIES.includes(m[1]) || !LINES.includes(m[3])) throw new Error(`no place in Help for ${base}`);
    if (!models.has(base)) {
      models.set(base, { name: base, series: m[1], number: Number(m[2]), line: m[3], versions: new Set(), langs: new Set() });
    }
    const model = models.get(base);
    model.versions.add(version ? Number(version[1]) : 1);
    for (const lang of ['ANSI', 'ISO']) if (new RegExp(` ${lang}\\b`).test(entry.name)) model.langs.add(lang);
  }
  const sorted = [...models.values()].sort((a, b) => a.number - b.number || LINES.indexOf(a.line) - LINES.indexOf(b.line));
  const series = SERIES.map(s => ({
    series: s,
    models: sorted.filter(m => m.series === s).map(m => {
      const versions = [...m.versions].sort((a, b) => a - b);
      const notes = [];
      if (versions.length > 1) notes.push(`versions ${versions.slice(0, -1).join(', ')} and ${versions.at(-1)}`);
      if (m.langs.size === 1) notes.push(`${[...m.langs][0]} only`);
      return `${versions.length === 1 && versions[0] > 1 ? `${m.name} Version ${versions[0]}` : m.name}${notes.length ? ` (${notes.join('; ')})` : ''}`;
    }),
  })).filter(s => s.models.length);
  return { series, modelCount: models.size, boards };
}

// Words joined by `sep` into lines no longer than `width`, each starting with `indent`.
function wrap(words, width, indent = '', sep = ' ') {
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && indent.length + line.length + sep.length + w.length > width) { lines.push(indent + line); line = w; }
    else line = line ? `${line}${sep}${w}` : w;
  }
  if (line) lines.push(indent + line);
  return lines;
}

function renderHelp({ series, modelCount }) {
  const lines = [
    `        <!-- ${BEGIN} -->`,
    '        <p>',
    ...wrap(`KeyAble works with ${modelCount} Keychron models. Each is supported in its ANSI (US) and ISO (UK and European) layout, with or without the rotary knob where the model has one, except where noted. Japanese JIS layouts are not supported yet.`.split(' '), 92, '          '),
    '        </p>',
  ];
  for (const s of series) {
    lines.push(`        <h4 style="margin-top:1rem">${s.series} series</h4>`,
      '        <ul style="margin:.3rem 0 0 1.25rem;padding:0;line-height:1.55">',
      ...wrap(s.models.map(m => `<li>${m}</li>`), 96, '          ', ''),
      '        </ul>');
  }
  lines.push(`        <!-- ${END} -->`);
  return lines.join('\n') + '\n';
}

function renderReadme({ series, modelCount, boards }) {
  const names = series.map(s => s.series);
  const list = `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
  return [
    `<!-- ${BEGIN} -->`,
    ...wrap(`${modelCount} Keychron models across the ${list} series (${boards} variants once you count each ANSI, ISO, knob, and backlight version separately). The full list is inside the app under Help, "Supported Keyboards".`.split(' '), 88),
    `<!-- ${END} -->`,
  ].join('\n') + '\n';
}

// The file's text with LF line endings, its own line ending, and the span from the line
// holding the BEGIN marker to the end of the line holding the END marker.
function readSpan(file) {
  const raw = readFileSync(file, 'utf8');
  const text = raw.replace(/\r\n/g, '\n');
  const b = text.indexOf(BEGIN), e = text.indexOf(END, b);
  if (b < 0 || e < 0) throw new Error(`${file} has no GENERATED SUPPORTED KEYBOARDS markers`);
  return { text, eol: raw.includes('\r\n') ? '\r\n' : '\n', start: text.lastIndexOf('\n', b) + 1, end: text.indexOf('\n', e) + 1 };
}

// Each file with its current and generated list.
export function supportedKeyboardFiles() {
  const data = supportedModels(appTables());
  return [[APP, renderHelp(data)], [README, renderReadme(data)]].map(([file, wanted]) => {
    const span = readSpan(file);
    return { file, span, wanted, current: span.text.slice(span.start, span.end) };
  });
}

if (runAsCommand(import.meta.url)) {
  const mode = process.argv[2];
  try {
    const files = supportedKeyboardFiles();
    if (mode === 'check') {
      const stale = files.filter(f => f.current !== f.wanted);
      for (const f of files) console.log(`${f.current === f.wanted ? 'up to date' : 'OUT OF DATE'}  ${path.relative(ROOT, f.file)}`);
      process.exitCode = stale.length ? 1 : 0;
    } else if (mode === 'write') {
      for (const { file, span, wanted } of files) {
        writeFileSync(file, (span.text.slice(0, span.start) + wanted + span.text.slice(span.end)).replace(/\n/g, span.eol));
        console.log(`written  ${path.relative(ROOT, file)}`);
      }
    } else {
      console.error('usage: check | write');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}
