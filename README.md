# MIDIMap

Playing street-level imagery like an instrument, for live performance. A
standalone project that may later become a module in Drift.

Three parts, one codebase:

- **The instrument**: Google Street View played with the keyboard or a MIDI
  controller. Number keys move between places, the camera drifts or travels at
  a speed you set, a mod wheel tilts it, and every control can be re-assigned
  with **MIDI learn**.
- **Experiments** on Mapillary's open street imagery: blending two runs of the
  same street, effects on the real pixels, holding the sun in frame, place
  slots, a tempo clock, and presets shared between browsers.
- **The MIDIMap app**: a Mac app that plays experiment 3 and sends the picture
  to MadMapper, Syphon Recorder, OBS and others over **Syphon**.

## Run it

**Online:** <https://midimap.studiotherefore.workers.dev> in Chrome or Edge
(Safari has no Web MIDI). Experiments: `/experiments/mapillary/`,
`/experiments/blend/`, `/experiments/fx/`. Hosted on Cloudflare; keys come from
Worker secrets (see `src/worker.js`). Deploy with `npm run deploy`.

**Locally:**

1. Copy `config.example.json` to `config.local.json` and fill it in (it's
   git-ignored, so keys never go into the repo):
   - `mapsApiKey`: a **Google Maps JavaScript API** key (Google Cloud Console →
     APIs & Services → enable *Maps JavaScript API* → Credentials → Create API
     key), restricted to `http://localhost:8000/*` and the live address.
   - `mapillaryToken`: a Mapillary client token (mapillary.com/dashboard/developers).
   - `presetsKey`: the sync key for shared presets (same value as the Worker's
     `PRESETS_KEY` secret).
2. `npm install` once, then `npm start`: a small server on
   <http://localhost:8000>, reachable only from this computer, that stops the
   browser reusing stale copies of edited files.

**The app (Syphon):** `cd app && npm install` once, then double-click
`MIDIMap.app` in the project folder (or `npm start` in `app/`). See
[app/README.md](app/README.md).

## The instrument: controls (defaults)

| Input | Action |
|---|---|
| `1`–`9`, `0` | Go to a preset location |
| `Shift` + number | Save the current view into that slot |
| `+` / `−` | Speed up / slow down (−10 … +10; negative reverses) |
| `Space` | Pause / resume motion |
| `M` | Switch between **drift** (turns in place) and **travel** (moves along the road) |
| `↑` / `↓` (hold) | Tilt camera up / down |
| `←` / `→` (hold) | Turn left / right |
| MIDI CC1 (mod wheel), CC11 (expression) | Tilt the camera, any channel |
| MIDI CC74, channel 1 | Speed (knob: reverse ← stop → forward) |
| MIDI CC71, channel 1 | Direction (the view turns as far as the knob does; full sweep = 360°) |
| MIDI program change 0–7 (Arturia MiniLab 3 pads 1–8) | Go to places 1–8 |
| `` ` `` | Mapping panel |
| `H` / `F` | Hide HUD / fullscreen |
| `P` | Keyboard controller on / off |

### Keyboard controller (no hardware needed)

When no MIDI controller is connected, letter keys become a pretend one. They
send real MIDI messages, so MIDI learn and mappings behave exactly as they will
on hardware. It switches off by itself when a controller is plugged in and back
on when it's unplugged; `P` flips it by hand.

| Keys | Pretends to be | Starts mapped to |
|---|---|---|
| `W` ↑ / `S` ↓ | knob, CC74 | Speed |
| `A` ← / `D` → | knob, CC71 | Direction |
| `T` ↑ / `G` ↓ | mod wheel, CC1 | Tilt |
| `I` ↑ / `K` ↓ | knob, CC76 | (free for MIDI learn) |
| `Z X C V B N` | pads, notes 36–41 | (free for MIDI learn) |

Hold a knob key to turn the knob (about 1.5 s end to end, 4 s for direction);
it stays where you let go. Hold `Shift` for fine moves. All on channel 1.

### MIDI learn

Open the panel (`` ` ``), click **Learn** next to an action, then press a key or
move a control. The learned input replaces any earlier binding. Actions are
**trigger** (fires once), **hold** (active while held) or **absolute** (follows
a knob, fader, wheel, pedal, pitch bend or aftertouch; keys and notes are
rejected). Program changes can be learned onto one-shot actions. **Endless
knobs** are recognised while learning and marked ∞; click ∞ / ⇥ to switch.
Mappings and saved views persist in the browser; **Export setup** writes them
to a JSON file.

## Experiments

Small, separate studies on [Mapillary](https://www.mapillary.com) imagery
(open, CC-BY-SA; unlike Google's, its pixels can be processed).

1. **Mapillary explorer**: a coverage map, a street viewer, and every other
   capture run of the same spot, with dates, seasons and camera types.
2. **Two-layer blend**: plays a 360° run like a film, with a second layer
   delayed by N frames or taken from another run of the same street; 8 blend
   modes; look straight up at the sky.
3. **Effects** (the current one): everything in 2, plus effects on the real
   pixels (names follow Drift's look engine: brightness, contrast, saturation,
   hue, tint, invert, blur, smear, pixelate, bloom, recall, plus echo, grain,
   posterize, instability), **hold the sun**, **8 place slots**, a **tempo
   clock** that locks photo changes to the beat, **presets** shared through
   Cloudflare, video recording, and a clean projector window.

Experiment 3 keys (all features work without a MIDI controller):

| Keys | Action |
|---|---|
| `Space` · `←` `→` | play / pause · step a frame |
| `↑` `↓` · drag · wheel | look up / horizon · look around · field of view |
| `1`–`8` · `Option`+`1`–`8` | go to a place slot · store the playing photo in it |
| `[` `]` · `R` | previous / next blend mode · reverse |
| `T` · `B` · `−` `=` · `,` `.` | tap tempo · lock to tempo · BPM · steps per beat |
| `S` · `V` · `H` · `F` | hold the sun · record video · hide panel · fullscreen |
| `Shift`+`1`–`9` | presets |

**Shared presets:** a saved preset keeps the effects, blend, camera, playback,
tempo, the current photo and the 8 slots. The list is stored in a Cloudflare
D1 database; anyone can load presets, and saving or deleting needs the sync
key. On this Mac it comes from `config.local.json`; in another browser, click
**Copy sync key** on the Mac's page and paste it into the sync key box once.

## Structure

```
index.html, css/, js/        the instrument (Google Street View)
experiments/lib/             shared Mapillary and preset-sync helpers
experiments/mapillary/       1. explorer
experiments/blend/           2. two-layer blend (renderer.js draws the panoramas)
experiments/fx/              3. effects, slots, tempo, presets (fx.js = effects chain)
src/worker.js                Cloudflare Worker: site files, key file, /api/presets
migrations/                  D1 database schema for presets
app/                         the MIDIMap Mac app (Electron + Syphon)
scripts/serve.mjs            local server (npm start; also used by the app)
tests/                       smoke tests (npm test)
```

The instrument's engine only knows about *state* (speed, pitch target, mode) and
the input layer only about *actions*, so Drift, OSC or a sequencer can drive
the engine directly.

## Tests

`npm install` once, then `npm test`: a headless-browser smoke test of the
instrument (simulated Google Maps and a pluggable simulated MIDI device), the
Worker and the presets API. To use an installed Chrome instead of Playwright's
own browser, set `CHROMIUM_PATH` to its executable. The experiments are checked
by hand in a visible browser.

## Notes and limitations

- **Street View is not continuous.** It's a graph of spherical photos about
  5–15 m apart. "Travel" hops from photo to photo (0.9 s at the fastest);
  "drift" (rotating in place) is fully smooth.
- **Google imagery terms.** Google bills per panorama load (with a monthly free
  allowance), forbids caching or re-hosting the imagery, and requires its
  attribution to stay visible. Mapillary's licence allows caching, which is why
  the experiments use it.
- **Mapillary is slow to deliver photos** (seconds each). The experiments buffer
  30 frames ahead and show the buffer; wait for it before playing.
