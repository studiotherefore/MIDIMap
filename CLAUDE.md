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
  tested with a simulated device and the keyboard stand-in (below).
- Live at https://studiotherefore.github.io/MIDIMap/. **GitHub Pages currently
  publishes the branch `claude/gallant-knuth-hvt5w2`, not `main`**: `main` holds
  only an empty initial commit, and PR #1 (that branch → `main`) is still open.
  The repo's default branch is also that claude branch. The PR description says
  to switch Pages to `main` after merging.

## Session 2 (2026-09-27, on the author's Mac)

- Project lives at `~/Desktop/Claude AI/experimental/MIDImap`. The Claude in
  Chrome extension wasn't connected; the app was opened with `open -a "Google Chrome"`.
- No controller was detected (macOS saw no USB or MIDI devices at all), so the
  author asked for a **keyboard stand-in controller**, built on branch
  `feature/keyboard-controller`.
- The only saved mappings (in Chrome, from the live site) were the unchanged defaults.
- The author's controller is an **Arturia MiniLab 3** (appears as 4 inputs: `Minilab3 MIDI`,
  `DIN THRU`, `MCU/HUI`, `ALV`; only `Minilab3 MIDI` sent anything). Recorded out of the box,
  all channel 1: keys = notes; knob 1 = CC74 (absolute, so it's already Speed); fader 1 = CC82;
  mod strip = CC1 (already Tilt); pitch strip = pitch bend, springs back to centre;
  **pads = bank select CC0 + CC32, then a program change** (pad 1 = program 0);
  **main encoder = CC114, relative** (64 ± steps). Both are now supported (below).
  A small CoreMIDI listener (Swift) was used to record this; it lived in the session scratchpad.

## Run and test

- `npm start` serves the app at http://localhost:8000, bound to 127.0.0.1 so
  the key file isn't reachable from the network. ES modules and Web MIDI
  need http://localhost or https, not `file://`. Use Chrome or Edge; Safari
  has no Web MIDI.
- `npm test` (after `npm install` once) runs `tests/smoke.mjs`. It serves the
  app, swaps Google Maps for `tests/google-maps-mock.js`, fakes a MIDI
  device that can be plugged/unplugged (`__plug`), and checks keyboard, MIDI
  learn, the keyboard stand-in, drift/travel, the key file, the startup
  checklist and layout in headless Chromium. Run it before every push. On the
  author's Mac, run it with `CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`
  (no Playwright browser download needed).
- The Google Maps key is **never** committed (the repo is public). Sources, in
  order: `?key=` in the URL, then `config.local.json` next to `index.html`
  (`{"mapsApiKey": "…"}`, git-ignored via `*.local.json`; template in
  `config.example.json`; the test server refuses to serve it), then the
  browser's localStorage (`midimap.apiKey`, set via the in-page panel).
  GitHub Pages has no config file, so the live site still uses the panel.
  Don't ask the author to paste the key into chat.
- The key must allow the Maps JavaScript API and a website restriction for
  every address used, e.g. `https://studiotherefore.github.io/*` and
  `http://localhost:*`.

## Architecture (no build step, plain ES modules)

| File | Role |
|---|---|
| `js/streetview.js` | Engine. Owns the panorama and a requestAnimationFrame loop. State only: `speed` (−10…10), `mode` (`drift` / `travel`), `targetPitch`, `heading`, holds. Knows nothing about keys or MIDI. |
| `js/actions.js` | Action vocabulary and `DEFAULT_BINDINGS`. Types: `trigger` (fires once), `hold` (active while held), `absolute` (follows a 0..1 value). |
| `js/input.js` | `InputRouter`: keyboard and Web MIDI → source ids → actions, plus learn mode. Source ids: `key:<code>`, `midi:cc:<ch or *>:<n>`, `midi:note:<ch or *>:<n>`, `midi:pb:<ch>`, `midi:at:<ch>`, `midi:pc:<ch>:<program>` (program change, trigger actions only; shown 1-based). **Endless knobs:** CC sources in `router.relative` (localStorage `midimap.relative.v1`, included in export) send 64 ± steps and call the action's `nudge(steps)` instead of `set(v)`. Learning a CC onto a knob action listens 350 ms and marks it endless if values hover within 64 ± 8 (never 64) and repeat; the panel's ∞ / ⇥ chip button overrides the guess. Bank select (CC0/32) is ignored during learn because it precedes every program change. One source drives one action; an action can have many sources. `*` channel = any channel (used by defaults). |
| `js/ui.js` | HUD, mapping panel (Learn buttons, export/import JSON), key status. |
| `js/virtual-midi.js` | **Keyboard stand-in controller.** Turns keys into raw MIDI bytes and feeds them to `router.handleMidi(data, { virtual: true })`, the same entry point as hardware, so learn and mappings behave identically. Knobs W/S (CC74), A/D (CC71, slower glide), T/G (CC1 mod wheel), I/K (CC76); pads Z–N (notes 36–41); all channel 1. Knob keys glide while held, Shift = fine. |
| `js/main.js` | Boot, Maps loader, reserved keys (`` ` `` panel, H HUD, F fullscreen, P keyboard controller, Esc), Shift+number saves the current view to a slot, **startup checklist** with plain-language error messages. Stand-in switching: on at startup, off when `router.onDevices` reports hardware, back on when it's unplugged; P flips it until the next plug/unplug. |
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
- **Second kind of black screen: rate-limited contributed photos.** Everything
  loads (checklist green, photographer credit such as "© Bruno Badilescu"
  visible) but the picture is black, because Google answers the photo request
  from `lh3.googleusercontent.com` (member-contributed photospheres) with
  **HTTP 429 Too Many Requests**. It's per internet connection, so the Drift
  studio and repeated reloads count too; a site the browser cached earlier
  can still look fine. The fix: `StreetViewEngine._findPano` asks for
  `StreetViewSource.GOOGLE` (car imagery, tiles from
  `streetviewpixels-pa.googleapis.com`, billed to the key) and falls back to
  `OUTDOOR` only where there's no car imagery. Contributed photos also have no
  links, so travel mode dead-ends on them. Diagnose via the network log: look
  for 429s on googleusercontent. It is *not* zoom (checked: 90% page zoom was a red herring).
- New default bindings go in `DEFAULTS_ADDED` (keyed by version) in
  `actions.js`, and `DEFAULTS_VERSION` gets bumped. Browsers that already
  saved mappings only pick up new defaults through that merge.
- The direction knob (`heading.set`) is **relative**: the view turns by as
  much as the knob moves. An absolute heading jumped on first touch, and in
  drift mode an absolute heading is meaningless anyway.

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

Work on a feature branch and open a pull request. Once PR #1 is merged and
Pages is switched to `main`, a merge into `main` is a deploy. Until then, Pages
publishes `claude/gallant-knuth-hvt5w2` (see Status).
