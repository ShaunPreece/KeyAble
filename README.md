# KeyAble

KeyAble is an accessible web app for customising Keychron keyboards. With it
you can make any key, or the knob, do something else: a keyboard shortcut, a
media control, a system action, or a macro that runs several actions in one go.
It also gives full control over keyboard RGB lighting.

Keychron's own Launcher web app is very difficult to use with a screen reader.
KeyAble does the same job in a few plain steps: pick a key, pick what it should
do, and hear the change read back before anything is written to the keyboard.
It runs in your web browser and needs nothing installed.

## How to run it

The user guide and the download are on KeyAble's home page:
https://www.slightperception.com/apps/keyable/

KeyAble is a single HTML file with no build step.

1. Open `KeyAble.html` in a browser that supports WebHID, the browser
   feature that lets a web page talk to a keyboard over USB. That means
   Chrome, Edge, Brave, or another Chromium-based browser. Firefox and Safari
   do not support WebHID and will not work. If you have the whole repository, it is
   in the `Project` folder.
2. Connect your Keychron keyboard with a USB cable, and set its connection
   switch to cable mode, not Bluetooth or 2.4GHz.
3. Follow the on-screen steps: connect the keyboard (it is identified
   automatically), choose a key, then choose what it should do.

To test the KeyAble app without a keyboard, choose "Try KeyAble Without a Keyboard
(Demo)" on the first page and pick any model.

Because it is one self-contained file, you can also host it on any static web
server, or just open it from disk. It talks directly to the keyboard from the
browser; nothing is sent anywhere over the internet.

## What it can do

- Change what a key does: another key, a keyboard shortcut, a media control,
  a system action (such as Lock Screen or Copilot), a macro, or nothing.
- Change the knob's press and turn actions, on models that have one.
- Set a separate action for a key held with Fn, so a key can do two jobs.
- Edit the Mac or Windows layout, with keys and modifiers named correctly for
  the side you are editing.
- Choose a key from a list, or by pressing it in Capture Mode.
- Multi-step macros: type text, press keys or shortcuts, use media controls
  and system actions, and pause.
- RGB lighting control, including turning the backlight off to save battery.
- Review every key that differs from factory and reset any of them, reset a
  single key, or reset the whole keyboard.
- Save the keyboard's setup to a file and restore it later.
- Light and dark themes, following your system setting unless you choose.

## Supported keyboards

19 Keychron models across the Q, V, K, and B series (58 variants once you count
each ANSI, ISO, knob, and non-knob version separately). The full list is inside
the app under Help, "Supported Keyboards".

- Tested on real hardware: V5 Max, V6 Max, Q6 Max, and B6 Pro. The others are
  built from Keychron's own firmware data.
- Not supported: JIS (Japanese) layouts, HE (Hall Effect) models, and the
  Ultra 8K models, whose firmware does not use the VIA protocol.

## Reporting a problem

If your keyboard connects but is not recognised, the first page shows its ID
and a Report This Keyboard ID button that starts an email to
shaun@slightperception.com. For anything else, email the same address.

## Making your own version

Everything you need to understand how KeyAble works, add a keyboard, or
build your own remapper is in the `docs/` folder:

- `HOW-IT-WORKS.txt` - a plain-English tour of how the app talks to the
  keyboard and stores remaps.
- `KEYBOARD-DATA.txt` - where the keyboard layout and factory data came from,
  and how to add a model.
- `ACCESSIBILITY.txt` - the accessibility decisions that make it work with
  screen readers, and the ones not to break.
- `QMK_VIA_Keycode_Reference.txt` - the numeric keycodes and VIA protocol
  commands a remapper needs.
- `PARITY.txt` - what KeyAble cannot do yet, and everything Keychron
  Launcher can assign to a key.

When changing the app:

- Check the script after every edit with
  `node DevTools/check-inline-js.js Project/KeyAble.html` (needs Node.js).
- The "can't do yet" list is in two places: section 1 of `docs/PARITY.txt`
  and Help, "What KeyAble Can't Do Yet". When a gap closes, update both.

## Licence

KeyAble is released under the MIT License. See `LICENSE` in the project
root. In short: anyone may use, modify, and share it for any purpose, as long
as the copyright notice and licence text are kept with the code.

Copyright (c) 2026 Shaun Preece.

## Credits and acknowledgements

KeyAble is by Shaun Preece and Steven Scott, and stands on open work by others:

- **QMK firmware** - the open keyboard firmware most Keychron boards run on.
- **ZMK firmware** - the open firmware the B6 Pro runs on, with Keychron's
  VIA support added.
- **VIA** - the open protocol (and configurator) used to read and write key
  assignments over USB.
- **Keychron** - their public QMK firmware and VIA JSON files were the source
  of the keyboard layout and factory-default data. The exact firmware versions
  used, from Keychron's QMK fork and from mainline QMK, are listed in
  `docs/KEYBOARD-DATA.txt`.

Thanks to the QMK, ZMK, and VIA communities for making accessible keyboard remapping possible at all.
