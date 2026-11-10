// A simulated Keychron V6 Max, installed as navigator.hid before KeyAble loads.
//
// Its VIA answers come from the app's own DemoKeyboard, so the browser tests and demo
// mode run the same firmware model. This file adds what tests need on top: replies one
// at a time, in the order the requests arrived, each after a short delay, like the
// firmware's single USB endpoint; a log of every request; and faults in the keymap
// buffer command. It wraps a DemoKeyboard rather than being one, because the app treats
// a DemoKeyboard as demo mode.
//
// Tests reach it through window.__fakeKeychron. The page's top-level `const` and `class`
// declarations are global lexical bindings, visible here by name once the page's
// scripts have run, so the keyboard is built on first use, not when this file runs.
/* global DemoKeyboard, CMD_KEYMAP_GET_BUFFER, VIA_UNHANDLED */
(() => {
  const PID = 0x0960;   // Keychron V6 Max ANSI Knob: 4 layers, one knob, protocol 12
  const REPLY_DELAY_MS = 4;

  // How the keymap buffer command is answered: 'normal'; 'unhandled', as by firmware
  // without it; or 'shifted', laid out one column wider than the app's layout says, as
  // a wrong matrix size would read.
  let bufferMode = 'normal';

  // The keymap buffer read as if each row had one more column than the layout.
  function readShiftedBuffer(kb, d) {
    const { rows, cols } = kb.layout;
    const wide = cols + 1;
    const at = (d[1] << 8) | d[2];
    for (let i = 0; i < d[3]; i++) {
      const cell = (at + i) >> 1;
      const l = Math.floor(cell / (rows * wide));
      const r = Math.floor((cell % (rows * wide)) / wide);
      const index = kb.cell(l, r, cell % wide);
      const code = index < 0 ? 0 : kb.keymap[index];
      d[4 + i] = (at + i) % 2 === 0 ? (code >> 8) & 0xFF : code & 0xFF;
    }
  }

  const log = [];          // every request, in arrival order, as plain arrays
  let pending = 0;
  let replyChainEnds = 0;  // time the last queued reply goes out

  class FakeKeychron extends EventTarget {
    constructor() {
      super();
      // Never opened, so it does not take the computer keyboard's keys as switches.
      this.keyboard    = new DemoKeyboard(PID);
      this.vendorId    = this.keyboard.vendorId;
      this.productId   = PID;
      this.productName = this.keyboard.productName;
      this.opened      = false;
      this.collections = [{ usagePage: 0xFF60, usage: 0x61 }];
    }
    async open()   { this.opened = true; }
    async close()  { this.opened = false; }
    async forget() { this.opened = false; }

    answer(d) {
      if (d[0] !== CMD_KEYMAP_GET_BUFFER || bufferMode === 'normal') return this.keyboard.answer(d);
      if (bufferMode === 'unhandled') d[0] = VIA_UNHANDLED;
      else readShiftedBuffer(this.keyboard, d);
      return d;
    }

    async sendReport(_reportId, data) {
      const bytes = new Uint8Array(32);
      bytes.set(new Uint8Array(data.buffer || data, data.byteOffset || 0, Math.min(32, data.byteLength)));
      log.push(Array.from(bytes.slice(0, 6)));
      pending++;
      const now = performance.now();
      replyChainEnds = Math.max(now, replyChainEnds) + REPLY_DELAY_MS;
      setTimeout(() => {
        const reply = this.answer(bytes);
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

  let device = null;
  const theDevice = () => (device ??= new FakeKeychron());
  const keyboard = () => theDevice().keyboard;

  const hid = new EventTarget();
  hid.getDevices    = async () => [theDevice()];
  hid.requestDevice = async () => [theDevice()];
  Object.defineProperty(Navigator.prototype, 'hid', { get: () => hid, configurable: true });

  // Every announcement, in order, so tests can check what a screen reader was told.
  const spoken = [];
  document.addEventListener('DOMContentLoaded', () => {
    const live = document.getElementById('sr-live');
    new MutationObserver(() => { if (live.textContent) spoken.push(live.textContent); })
      .observe(live, { childList: true, characterData: true, subtree: true });
  });

  // No first-run welcome dialog: it would make the page inert.
  try { localStorage.setItem('keyable-v1', '1'); } catch { /* storage blocked */ }

  window.__fakeKeychron = {
    PID,
    log,
    spoken,
    getKey(l, r, c) {
      const kb = keyboard();
      const index = kb.cell(l, r, c);
      return index < 0 ? 0 : kb.keymap[index];
    },
    setKey(l, r, c, code) {
      const kb = keyboard();
      const index = kb.cell(l, r, c);
      if (index >= 0) kb.keymap[index] = code;
    },
    getEncoder: (l, id, cw) => keyboard().encoders.get(`${l},${id},${cw}`) ?? 0,
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
