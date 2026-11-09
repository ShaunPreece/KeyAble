// A simulated Keychron keyboard, installed as navigator.hid before KeyAble loads.
//
// It answers the VIA raw HID commands KeyAble sends, from an in-memory keymap seeded with
// the app's own FACTORY_KEYMAPS for the chosen PID. Replies follow the firmware's
// behaviour: one at a time, in the order the requests arrived, each after a short delay,
// and each written over the request buffer, so a reply repeats its request's leading
// bytes (QMK quantum/via.c answers in place).
//
// Tests reach it through window.__fakeKeychron. The page's `const` tables are global
// lexical bindings, visible here by name once the page's scripts have run.
(() => {
  const PID           = 0x0960;   // Keychron V6 Max ANSI Knob: 4 layers, one encoder
  const LAYER_COUNT   = 4;
  const DEFAULT_LAYER = 2;        // Windows base, so the OS switch reads as Windows
  const MACRO_SLOTS   = 16;
  const MACRO_BYTES   = 1024;
  const REPLY_DELAY_MS = 4;

  const keymap   = new Map();     // "layer,row,col" -> 16-bit keycode
  const encoders = new Map();     // "layer,id,cw"   -> 16-bit keycode
  const macroBuf = new Uint8Array(MACRO_BYTES);
  const lighting = { 1: 128, 2: 1, 3: 128, 4: [0, 255] };   // RGB matrix value ids
  let seeded = false;
  // How the keymap buffer command (0x12) is answered: 'normal'; 'unhandled', as by
  // firmware without it; or 'shifted', laid out one column wider than the app's
  // layout says, as a wrong matrix size would read.
  let bufferMode = 'normal';

  // Seeding waits for the first command, by which time the page's tables exist.
  function seed() {
    if (seeded) return;
    seeded = true;
    // eslint-disable-next-line no-undef
    const model = FACTORY_KEYMAPS[PID];
    model.layers.forEach((layer, l) => {
      for (const [pos, code] of Object.entries(layer)) keymap.set(`${l},${pos}`, code);
    });
    // A layout key at a position the factory data lacks gets its label's keycode on the
    // base layers and KC_TRNS on the Fn layers, so these tests do not depend on that
    // data mismatch, which data-consistency.test.mjs reports on its own.
    // eslint-disable-next-line no-undef
    const layout = KEYCHRON_LAYOUTS[KEYBOARD_DB[PID].layoutId];
    // eslint-disable-next-line no-undef
    const roles = model.roles || DEFAULT_LAYER_ROLES;
    for (const key of layout.keys) {
      for (const l of [roles.mac, roles.win, roles.macFn, roles.winFn]) {
        const id = `${l},${key.row},${key.col}`;
        const isFn = l === roles.macFn || l === roles.winFn;
        // eslint-disable-next-line no-undef
        if (!keymap.has(id)) keymap.set(id, isFn ? 0x0001 : (LABEL_TO_KEYCODE[key.label] ?? 0));
      }
    }
    (model.encoders || []).forEach((list, l) => {
      (list || []).forEach((enc, id) => {
        if (!enc) return;
        encoders.set(`${l},${id},0`, enc.ccw);
        encoders.set(`${l},${id},1`, enc.cw);
      });
    });
  }

  const getKey = (l, r, c) => keymap.get(`${l},${r},${c}`) ?? 0;

  // The keymap as the firmware's flat buffer: big-endian keycodes, layer, row, column.
  function keymapBufferByte(offset) {
    // eslint-disable-next-line no-undef
    const layout = KEYCHRON_LAYOUTS[KEYBOARD_DB[PID].layoutId];
    const cell   = Math.floor(offset / 2);
    const cols = layout.cols + (bufferMode === 'shifted' ? 1 : 0);
    const perLayer = layout.rows * cols;
    const l = Math.floor(cell / perLayer);
    const r = Math.floor((cell % perLayer) / cols);
    const c = cell % cols;
    const code = getKey(l, r, c);
    return offset % 2 === 0 ? (code >> 8) & 0xFF : code & 0xFF;
  }

  // Turn a request buffer into its reply, in place, as via.c does.
  function answer(d) {
    seed();
    const u16 = (hi, lo) => (hi << 8) | lo;
    switch (d[0]) {
      case 0x01: d[1] = 0x00; d[2] = 0x0C; break;                     // protocol version 12
      case 0x04: { const k = getKey(d[1], d[2], d[3]); d[4] = k >> 8; d[5] = k & 0xFF; break; }
      case 0x05: keymap.set(`${d[1]},${d[2]},${d[3]}`, u16(d[4], d[5])); break;
      case 0x06: keymap.clear(); encoders.clear(); seeded = false; seed(); break;
      case 0x07:
        if (d[1] !== 3) { d[0] = 0xFF; break; }
        if (d[2] === 4) lighting[4] = [d[3], d[4]]; else lighting[d[2]] = d[3];
        break;
      case 0x08:
        if (d[1] !== 3) { d[0] = 0xFF; break; }
        if (d[2] === 4) { d[3] = lighting[4][0]; d[4] = lighting[4][1]; }
        else d[3] = lighting[d[2]];
        break;
      case 0x09: if (d[1] !== 3) d[0] = 0xFF; break;
      case 0x0C: d[1] = MACRO_SLOTS; break;
      case 0x0D: d[1] = MACRO_BYTES >> 8; d[2] = MACRO_BYTES & 0xFF; break;
      case 0x0E: { const o = u16(d[1], d[2]); for (let i = 0; i < d[3]; i++) d[4 + i] = macroBuf[o + i] ?? 0; break; }
      case 0x0F: { const o = u16(d[1], d[2]); for (let i = 0; i < d[3]; i++) macroBuf[o + i] = d[4 + i]; break; }
      case 0x11: d[1] = LAYER_COUNT; break;
      case 0x12: if (bufferMode === 'unhandled') { d[0] = 0xFF; break; } {
        const o = u16(d[1], d[2]); for (let i = 0; i < d[3]; i++) d[4 + i] = keymapBufferByte(o + i); break; }
      case 0x14: { const k = encoders.get(`${d[1]},${d[2]},${d[3]}`) ?? 0; d[4] = k >> 8; d[5] = k & 0xFF; break; }
      case 0x15: encoders.set(`${d[1]},${d[2]},${d[3]}`, u16(d[4], d[5])); break;
      case 0xA3: d[1] = DEFAULT_LAYER; break;                          // Keychron: default layer
      default:   d[0] = 0xFF;                                           // id_unhandled
    }
    return d;
  }

  const log = [];          // every request, in arrival order, as plain arrays
  let pending = 0;
  let replyChainEnds = 0;  // time the last queued reply goes out

  class FakeKeychron extends EventTarget {
    constructor() {
      super();
      this.vendorId    = 0x3434;
      this.productId   = PID;
      this.productName = 'Keychron V6 Max';
      this.opened      = false;
      this.collections = [{ usagePage: 0xFF60, usage: 0x61 }];
    }
    async open()   { this.opened = true; }
    async close()  { this.opened = false; }
    async forget() { this.opened = false; }
    async sendReport(_reportId, data) {
      const bytes = new Uint8Array(32);
      bytes.set(new Uint8Array(data.buffer || data, data.byteOffset || 0, Math.min(32, data.byteLength)));
      log.push(Array.from(bytes.slice(0, 6)));
      pending++;
      // One reply at a time, in arrival order, like the firmware's single USB endpoint.
      const now = performance.now();
      replyChainEnds = Math.max(now, replyChainEnds) + REPLY_DELAY_MS;
      setTimeout(() => {
        const reply = answer(bytes);
        const ev = new Event('inputreport');
        Object.defineProperties(ev, {
          data:     { value: new DataView(reply.buffer) },
          device:   { value: this },
          reportId: { value: 0 },
        });
        pending--;
        this.dispatchEvent(ev);
      }, replyChainEnds - now);
    }
  }

  const device = new FakeKeychron();
  const hid = new EventTarget();
  hid.getDevices    = async () => [device];
  hid.requestDevice = async () => [device];
  Object.defineProperty(Navigator.prototype, 'hid', { get: () => hid, configurable: true });

  // Every announcement, in order, so tests can check what a screen reader was told.
  const spoken = [];
  document.addEventListener('DOMContentLoaded', () => {
    const live = document.getElementById('sr-live');
    new MutationObserver(() => { if (live.textContent) spoken.push(live.textContent); })
      .observe(live, { childList: true, characterData: true, subtree: true });
  });

  // No first-run welcome dialog: it would make the page inert.
  try { localStorage.setItem('keyable-v1', '1'); } catch (_) { /* storage blocked */ }

  window.__fakeKeychron = {
    PID,
    device,
    log,
    spoken,
    getKey: (l, r, c) => { seed(); return getKey(l, r, c); },
    setKey: (l, r, c, code) => { seed(); keymap.set(`${l},${r},${c}`, code); },
    getEncoder: (l, id, cw) => { seed(); return encoders.get(`${l},${id},${cw}`) ?? 0; },
    lighting,
    setBufferMode: mode => { bufferMode = mode; },
    // Resolves once no request has been outstanding for `quietMs`.
    whenIdle(quietMs = 100) {
      return new Promise(resolve => {
        let quietSince = performance.now();
        const timer = setInterval(() => {
          if (pending > 0) quietSince = performance.now();
          else if (performance.now() - quietSince >= quietMs) { clearInterval(timer); resolve(); }
        }, 10);
      });
    },
  };
})();
