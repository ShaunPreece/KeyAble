// The design-review fix D-1, written as a replacement for the app's sendVIA so the test
// suite can check the design before the app changes. Installed only when a test calls
// window.__installCandidateFix() after the page has loaded; the app's own function
// declaration would overwrite an earlier assignment.
//
// Two changes from the app's sendVIA:
// - one request at a time: each is sent only after the previous one has been answered
//   or has timed out;
// - a reply is accepted only if it repeats its request's leading bytes. VIA answers by
//   rewriting the request buffer, so the command and its address (layer, row, column,
//   or a buffer offset) come back unchanged. 0xFF in the first byte is VIA's
//   "unhandled" answer to the same request.
window.__installCandidateFix = () => {
  // Leading bytes each command's reply repeats. Commands not listed repeat only byte 0.
  const ECHO_LENGTH = {
    0x04: 4, 0x05: 6,              // get / set keycode: layer, row, column (+ value)
    0x07: 3, 0x08: 3, 0x09: 2,     // custom value set / get / save: channel, value id
    0x0E: 4, 0x0F: 4,              // macro buffer get / set: offset, size
    0x12: 4, 0x13: 4,              // keymap buffer get / set: offset, size
    0x14: 4, 0x15: 6,              // get / set encoder: layer, encoder, direction (+ value)
  };

  let queue = Promise.resolve();

  function sendOne(bytes, timeoutMs) {
    return new Promise(resolve => {
      // eslint-disable-next-line no-undef
      const device = hidDevice;
      // eslint-disable-next-line no-undef
      const buf = new Uint8Array(REPORT_LEN);
      bytes.forEach((b, i) => { buf[i] = b; });
      const echo = ECHO_LENGTH[bytes[0]] ?? 1;
      const answers = reply =>
        (reply[0] === buf[0] || reply[0] === 0xFF) &&
        buf.subarray(1, echo).every((b, i) => reply[i + 1] === b);

      const finish = value => {
        clearTimeout(timer);
        device.removeEventListener('inputreport', onReport);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      function onReport(ev) {
        const reply = new Uint8Array(ev.data.buffer);
        if (answers(reply)) finish(reply);   // anything else is a stale reply: keep waiting
      }
      device.addEventListener('inputreport', onReport);
      device.sendReport(0x00, buf).catch(() => finish(null));
    });
  }

  window.sendVIA = (bytes, timeoutMs = 2000) => {
    const result = queue.then(() => sendOne(bytes, timeoutMs));
    queue = result.catch(() => {});
    return result;
  };
};
