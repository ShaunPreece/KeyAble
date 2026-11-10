/*
 * token-keycodes.js
 * Source-derived QMK/Keychron token -> 16-bit keycode table.
 *
 * Every value mirrors the pinned firmware sources (docs/KEYBOARD-DATA.txt):
 *   Keychron/qmk_firmware, branch wireless_playground, commit 666862cb8123b64a6b96718d739c6203ad99031f:
 *     quantum/keycodes.h
 *     keyboards/keychron/common/keychron_common.h
 *     keyboards/keychron/common/wireless/wireless.mk (LK_WIRELESS_ENABLE)
 *   qmk/qmk_firmware, commit a738fad372c1e72e10c47f560c8d167d233416ad:
 *     quantum/keycodes.h, for the LM_ and RM_ blocks
 * Local copies sit in ProjectAssets/keychron-firmware-src/, which is not in the
 * repository: fetch the commits above to recreate them.
 *
 * This is model-INDEPENDENT except for the Keychron custom block (QK_KB_0-based),
 * whose absolute values shift with two build flags. See customKeycodes() below.
 */
'use strict';

// Board layer name -> dynamic-keymap layer index, in the CANONICAL 4-layer
// order. Boards with a different enum (5-layer V2 Max / K6 Pro / wired V2)
// MUST pass their own map via opts.layerIndex, or MO() resolves to the wrong
// layer.
const LAYER_INDEX = { MAC_BASE: 0, MAC_FN: 1, WIN_BASE: 2, WIN_FN: 3 };

// ---- Standard QMK keycodes (quantum/keycodes.h) --------------------------
const STD = {};
'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => { STD['KC_' + c] = 0x04 + i; });
['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].forEach((d, i) => { STD['KC_' + d] = 0x1E + i; });
for (let f = 1; f <= 12; f++) STD['KC_F' + f] = 0x3A + (f - 1);
for (let f = 13; f <= 24; f++) STD['KC_F' + f] = 0x68 + (f - 13);
for (let p = 1; p <= 9; p++) STD['KC_P' + p] = 0x59 + (p - 1);
Object.assign(STD, {
  KC_NO:0x0000, KC_TRNS:0x0001, '_______':0x0001,
  KC_ENT:0x28, KC_ESC:0x29, KC_BSPC:0x2A, KC_TAB:0x2B, KC_SPC:0x2C, KC_MINS:0x2D, KC_EQL:0x2E,
  KC_LBRC:0x2F, KC_RBRC:0x30, KC_BSLS:0x31, KC_NUHS:0x32, KC_SCLN:0x33, KC_QUOT:0x34, KC_GRV:0x35,
  KC_COMM:0x36, KC_DOT:0x37, KC_SLSH:0x38, KC_CAPS:0x39,
  // Shifted-symbol alias: KC_TILD = S(KC_GRAVE) = LSFT|KC_GRV = 0x0200|0x35.
  // Source: quantum/keymap_extras/keymap_us.h (pinned commit). Used by the
  // 5-layer boards (V2 Max, K6 Pro, wired V2).
  KC_TILD:0x0235, KC_TILDE:0x0235,
  KC_PSCR:0x46, KC_SCRL:0x47, KC_PAUS:0x48, KC_INS:0x49, KC_HOME:0x4A, KC_PGUP:0x4B, KC_DEL:0x4C,
  KC_END:0x4D, KC_PGDN:0x4E, KC_RGHT:0x4F, KC_LEFT:0x50, KC_DOWN:0x51, KC_UP:0x52, KC_NUM:0x53,
  KC_PSLS:0x54, KC_PAST:0x55, KC_PMNS:0x56, KC_PPLS:0x57, KC_PENT:0x58,
  KC_P0:0x62, KC_PDOT:0x63, KC_NUBS:0x64, KC_APP:0x65,
  // Modifiers, incl. Keychron's Mac aliases that resolve to standard GUI/ALT.
  KC_LCTL:0xE0, KC_LSFT:0xE1, KC_LALT:0xE2, KC_LGUI:0xE3,
  KC_RCTL:0xE4, KC_RSFT:0xE5, KC_RALT:0xE6, KC_RGUI:0xE7,
  KC_LWIN:0xE3, KC_RWIN:0xE7,               // aliases of KC_LEFT_GUI / KC_RIGHT_GUI
  KC_LCMD:0xE3, KC_RCMD:0xE7,               // Mac Command aliases of KC_LEFT_GUI / KC_RIGHT_GUI
  KC_LOPT:0xE2, KC_ROPT:0xE6,               // Mac Option aliases of KC_LEFT_ALT / KC_RIGHT_ALT (wired boards)
  // Consumer / media (basic range).
  KC_MUTE:0x00A8, KC_VOLU:0x00A9, KC_VOLD:0x00AA,
  KC_MNXT:0x00AB, KC_MPRV:0x00AC, KC_MPLY:0x00AE,
  KC_BRIU:0x00BD, KC_BRID:0x00BE,
  KC_MISSION_CONTROL:0x00C1, KC_MCTL:0x00C1,   // macOS Mission Control
  KC_LAUNCHPAD:0x00C2,       KC_LPAD:0x00C2,   // macOS Launchpad
  // Magic.
  NK_TOGG:0x7013,
  // Single-colour backlight (0x7800 block) - White (non-RGB) board variants.
  BL_ON:0x7800, BL_OFF:0x7801, BL_TOGG:0x7802, BL_DOWN:0x7803, BL_UP:0x7804,
  BL_STEP:0x7805, BL_BRTG:0x7806,
  // Single-colour LED matrix (0x7810 block, QK_LED_MATRIX) - mainline QMK, wired White boards.
  LM_ON:0x7810, LM_OFF:0x7811, LM_TOGG:0x7812, LM_NEXT:0x7813, LM_PREV:0x7814,
  LM_BRIU:0x7815, LM_BRID:0x7816, LM_SPDU:0x7817, LM_SPDD:0x7818,
  LM_FLGN:0x7819, LM_FLGP:0x781A,
  // RGB matrix / underglow (0x7820 block) - wireless fork spelling.
  RGB_TOG:0x7820, RGB_MOD:0x7821, RGB_RMOD:0x7822,
  RGB_HUI:0x7823, RGB_HUD:0x7824, RGB_SAI:0x7825, RGB_SAD:0x7826,
  RGB_VAI:0x7827, RGB_VAD:0x7828, RGB_SPI:0x7829, RGB_SPD:0x782A,
  // RGB matrix (0x7840 block, QK_RGB_MATRIX) - mainline QMK spelling (RM_*).
  RM_ON:0x7840, RM_OFF:0x7841, RM_TOGG:0x7842, RM_NEXT:0x7843, RM_PREV:0x7844,
  RM_HUEU:0x7845, RM_HUED:0x7846, RM_SATU:0x7847, RM_SATD:0x7848,
  RM_VALU:0x7849, RM_VALD:0x784A, RM_SPDU:0x784B, RM_SPDD:0x784C,
  RM_FLGN:0x784D, RM_FLGP:0x784E,
});

// ---- Modifier-combo keycodes (QK_MODS): LGUI()/LCTL()/S()/C() etc. ---------
// QK_LCTL 0x0100, QK_LSFT 0x0200, QK_LALT 0x0400, QK_LGUI 0x0800; right +0x1000.
// From quantum/quantum_keycodes.h (pinned). e.g. LGUI(KC_E) = 0x0800 | 0x08.
const MOD_WRAP = {
  LCTL:0x0100, LSFT:0x0200, LALT:0x0400, LGUI:0x0800,
  RCTL:0x1100, RSFT:0x1200, RALT:0x1400, RGUI:0x1800,
  C:0x0100, S:0x0200, A:0x0400, G:0x0800,           // C()=LCTL S()=LSFT A()=LALT G()=LGUI
  LCS:0x0300, LCA:0x0500, LCG:0x0900, LSA:0x0600, LSG:0x0A00, LAG:0x0C00,
  LCSG:0x0B00, LCAG:0x0D00, LSAG:0x0E00, MEH:0x0700, HYPR:0x0F00,
};

// ---- Layer-switch keycodes ------------------------------------------------
const QK_MOMENTARY = 0x5220;                 // MO(layer) = QK_MOMENTARY | (layer & 0x1F)

// ---- Keychron custom keycodes (keychron_common.h, based at QK_KB_0) -------
// The enum order is fixed; only two #ifdef'd lock-screen entries sit between
// KC_CORTANA and BT_HST1. For the V5 Max neither WIN_LOCK_SCREEN_ENABLE nor
// MAC_LOCK_SCREEN_ENABLE is defined, so both collapse and BT_HST1 = QK_KB_0+11.
// Pass {winLock, macLock} true for models that enable them.
const QK_KB_0 = 0x7E00;
function customKeycodes(opts = {}) {
  const t = {};
  let n = QK_KB_0;
  t.KC_LOPTN = n++;          // 0x7E00
  t.KC_ROPTN = n++;
  t.KC_LCMMD = n++;
  t.KC_RCMMD = n++;
  t.KC_MCTRL = n++;
  t.KC_LNPAD = n++;
  t.KC_TASK_VIEW = n; t.KC_TASK = n; n++;
  t.KC_FILE_EXPLORER = n; t.KC_FILE = n; n++;
  t.KC_SCREEN_SHOT = n; t.KC_SNAP = n; n++;
  t.KC_CORTANA = n; t.KC_CTANA = n; n++;
  if (opts.winLock) { t.KC_WIN_LOCK_SCREEN = n; t.KC_WLCK = n; n++; }
  if (opts.macLock) { t.KC_MAC_LOCK_SCREEN = n; t.KC_MLCK = n; n++; }
  t.KC_SIRI = n++;
  // LK_WIRELESS_ENABLE is set for all "Max" wireless boards.
  t.BT_HST1 = n++;
  t.BT_HST2 = n++;
  t.BT_HST3 = n++;
  t.P2P4G = n++;
  t.BAT_LVL = n;
  return t;
}

/*
 * resolveToken(token, opts) -> 16-bit number, or null if unknown.
 * opts.winLock / opts.macLock: Keychron lock-screen build flags (default false).
 * opts.layerIndex: the model's layer enum, name -> index, for MO() (default
 * LAYER_INDEX).
 */
function resolveToken(token, opts = {}) {
  if (token === null || token === undefined) return null;
  token = String(token).trim();
  if (Object.hasOwn(STD, token)) return STD[token];
  const custom = customKeycodes(opts);
  if (Object.hasOwn(custom, token)) return custom[token];
  const mo = token.match(/^MO\(\s*([A-Za-z0-9_]+)\s*\)$/);
  if (mo) {
    const layerMap = opts.layerIndex || LAYER_INDEX;
    const layer = Object.hasOwn(layerMap, mo[1]) ? layerMap[mo[1]] : parseInt(mo[1], 10);
    if (!Number.isNaN(layer)) return QK_MOMENTARY | (layer & 0x1F);
  }
  // Modifier-combo wrapper: LGUI(KC_E), S(KC_GRV), C(KC_A), etc.
  const wrap = token.match(/^([A-Z]+)\(\s*(.+?)\s*\)$/);
  if (wrap && Object.hasOwn(MOD_WRAP, wrap[1])) {
    const inner = resolveToken(wrap[2], opts);
    if (inner !== null) return MOD_WRAP[wrap[1]] | inner;
  }
  return null;
}

module.exports = { resolveToken };
