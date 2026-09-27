# MIDIMap: notes for Claude

## What this is

A prototype that plays Google Street View like an instrument. Number keys jump
between places, the camera moves on its own at a set speed, a mod wheel or
expression pedal tilts it, and every control is re-assignable by MIDI learn.
It's a standalone experiment that may become a module in the author's larger
live-performance project, **Drift**.

The author is an artist and professor (new media, performance, philosophy) who
builds software for live performance but is not a conventional developer.
**They prefer to stay out of the terminal.** Run commands yourself, explain
results in plain language, and when they must do something (GitHub or Google
Cloud settings), give click-by-click steps.

## Status (end of the first session)

- The first version works in Chrome with a real key: locations, drift, speed,
  and tilt have been confirmed by the author.
- **Not yet tried with a physical MIDI controller.** MIDI learn has only been
  tested with a simulated device. That's the natural next step.
- Live at https://studiotherefore.github.io/MIDIMap/ (GitHub Pages, served from `main`).

## Run and test

- `npm start` serves the app at http://localhost:8000. ES modules and Web MIDI
  need http://localhost or https, not `file://`. Use Chrome or Edge; Safari
  has no Web MIDI.
- `npm test` (after `npm install` once) runs `tests/smoke.mjs`. It serves the
  app, swaps Google Maps for `tests/google-maps-mock.js`, fakes a MIDI
  device, and checks keyboard, MIDI learn, drift/travel, the startup
  checklist and layout in headless Chromium. Run it before every push.
- The Google Maps key is **never** committed. It lives in the browser's
  localStorage (`midimap.apiKey`), entered via the in-page panel or
  `?key=` in the URL. Don't ask the author to paste it into chat.
- The key must allow the Maps JavaScript API and a website restriction for
  every address used, e.g. `https://studiotherefore.github.io/*` and
  `http://localhost:*`.

## Architecture (no build step, plain ES modules)

| File | Role |
|---|---|
| `js/streetview.js` | Engine. Owns the panorama and a requestAnimationFrame loop. State only: `speed` (−10…10), `mode` (`drift` / `travel`), `targetPitch`, `heading`, holds. Knows nothing about keys or MIDI. |
| `js/actions.js` | Action vocabulary and `DEFAULT_BINDINGS`. Types: `trigger` (fires once), `hold` (active while held), `absolute` (follows a 0..1 value). |
| `js/input.js` | `InputRouter`: keyboard and Web MIDI → source ids → actions, plus learn mode. Source ids: `key:<code>`, `midi:cc:<ch or *>:<n>`, `midi:note:<ch or *>:<n>`, `midi:pb:<ch>`, `midi:at:<ch>`. One source drives one action; an action can have many sources. `*` channel = any channel (used by defaults). |
| `js/ui.js` | HUD, mapping panel (Learn buttons, export/import JSON), key status. |
| `js/main.js` | Boot, Maps loader, reserved keys (`` ` `` panel, H HUD, F fullscreen, Esc), Shift+number saves the current view to a slot, **startup checklist** with plain-language error messages. |
| `js/locations.js` | Presets for slots 1–9, 0. User overrides are kept in localStorage. |

The engine/input split is deliberate: Drift, OSC or a sequencer should be able
to drive the engine directly.

## Lessons learned (don't regress these)

- **Google overwrites the container's inline style** with `position: relative`.
  The viewer must sit inside a wrapper (`#stage` is fixed full-screen,
  `#pano` is 100%×100%). Otherwise it collapses to 0px and the screen is
  black even though everything "loaded". The mock reproduces this, and the
  smoke test checks the viewer size.
- Set `keyboardShortcuts: false` on the panorama, or Street View also reacts
  to the arrow keys.
- `status_changed` may not fire when the status stays `OK` between panoramas.
  `_showPano` also listens to `pano_changed`.
- Google reports the reason a key failed (`RefererNotAllowedMapError` etc.)
  only in the console. `main.js` wraps `console.error` to put it on screen.
  Keep failures visible, because the author can't be expected to open DevTools.
- Street View is a graph of photos about 5–15 m apart, not continuous space.
  Travel mode hops between linked panoramas, at most one step per 0.9 s.
  Drift (rotating in place) is smooth.
- Chrome asks MIDI permission even without sysex; the DevTools
  "deprecated feature" notice about it is harmless.

## Open questions and next steps

1. **Try a real controller.** Check MIDI learn with the author's hardware and
   watch what it actually sends (the panel shows the last message).
2. Ask which motion feels right: smooth drift or stepped travel.
3. Per-binding range and invert (e.g. a mod wheel resting at 0 = horizon
   rather than looking down), plus soft takeover when keys and a knob share a
   parameter.
4. Crossfade between locations instead of hard cuts.
5. Mapillary (open, CC-BY-SA) as an alternative imagery source, especially
   for Drift. Google's terms forbid caching imagery and require its
   attribution to stay visible.

## Git

Work on a feature branch and open a pull request into `main`. GitHub Pages
publishes `main`, so a merge is a deploy.
