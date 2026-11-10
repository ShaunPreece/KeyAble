// Reads a Keychron keymap.c: its layer blocks and its object-like #defines.
// Shared by factory-keymap-source.js and keyboard-sources.mjs.
'use strict';

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
}

// Splits on commas outside parentheses, so MO(MAC_FN) and LT(1, KC_A) stay whole.
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Every `[LAYER] = LAYOUT_xxx( ... )` block of comment-free source, in source order:
// [{ layer, macro, tokens }].
function layerBlocks(src) {
  const blocks = [];
  const re = /\[(\w+)\]\s*=\s*(LAYOUT\w*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    blocks.push({ layer: m[1], macro: m[2], tokens: splitTopLevel(src.slice(re.lastIndex, i - 1)) });
  }
  return blocks;
}

// Board-local object-like #defines (`#define KC_FLXP LGUI(KC_E)`), which override
// header defaults per model. A function-like macro has no space between its name and
// `(`, so it does not match.
function defines(src) {
  const map = {};
  for (const m of src.matchAll(/^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]+(\S.*?)[ \t]*$/gm)) {
    map[m[1]] = m[2].trim();
  }
  return map;
}

// The token after following #defines; the depth limit stops a define cycle.
function expandDefines(token, defs) {
  let t = String(token).trim();
  for (let i = 0; i < 8 && Object.hasOwn(defs, t); i++) t = defs[t].trim();
  return t;
}

module.exports = { stripComments, splitTopLevel, layerBlocks, defines, expandDefines };
