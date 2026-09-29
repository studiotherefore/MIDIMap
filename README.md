# MIDIMap

A prototype for playing Google Street View like an instrument. Number keys move
between places, the camera moves on its own at a speed you set, and a mod wheel
or expression pedal tilts it up and down. Every control can be re-assigned with
**MIDI learn**. It's a standalone experiment for now, and may later become a
module in Drift.

## Run it

**Online (Cloudflare):** open <https://midimap.studiotherefore.workers.dev> in Chrome
or Edge. The key comes from the Worker's `MAPS_API_KEY` secret (see `src/worker.js`);
restrict it to `https://midimap.studiotherefore.workers.dev/*`. Deploy with `npm run deploy`.

**Locally:**

1. Get a **Google Maps JavaScript API** key (Google Cloud Console → APIs & Services →
   enable *Maps JavaScript API* → Credentials → Create API key). Restrict it to
   HTTP referrer `http://localhost:*` so it can't be used elsewhere.
2. Copy `config.example.json` to `config.local.json` and put the key in it.
   The page reads it at startup, so you never have to paste the key. Files
   ending in `.local.json` are git-ignored, so the key never goes into the repo.
   (Alternatively, paste the key into the panel; it's then saved in that browser only.)
3. Serve the folder locally. ES modules and Web MIDI both need `http://localhost`,
   not `file://`:
   ```sh
   npm start
   ```
   (A small Node server, reachable only from this computer, that stops the browser reusing stale copies of edited files.)
4. Open <http://localhost:8000> in **Chrome or Edge**, since Safari has no Web MIDI.

## Controls (defaults)

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
| MIDI program change 0–7 (Arturia MiniLab 3 pads 1–8) | Go to places 1–8 |
| MIDI CC71, channel 1 | Direction (the view turns as far as the knob does; full sweep = 360°) |
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
move a control. The learned input replaces any earlier binding. Actions come in
three kinds:

- **trigger**: fires once. Works from a key, a note-on, or a CC/pad crossing its midpoint.
- **hold**: active while held. Works from a key, a held note, or a CC above its midpoint.
- **absolute**: follows a knob, fader, wheel, pedal, pitch bend or aftertouch.
  Keys and notes are rejected here.

Program changes (what the Arturia MiniLab 3 pads send) can be learned onto
one-shot actions. **Endless knobs** (like the MiniLab 3 main knob, which sends
"a bit more / a bit less" instead of a position) are recognised while learning
and marked ∞ in the panel; click ∞ / ⇥ on a mapping to switch it by hand.

Mappings and saved views persist in the browser. **Export setup** writes them to
a JSON file, so a performance rig can be restored on another machine.

## Structure

```
index.html
css/style.css
js/main.js        boot, Maps loader, reserved keys
js/streetview.js  engine: panorama + per-frame motion (speed, pitch, heading, travel steps)
js/actions.js     action vocabulary + default bindings
js/input.js       keyboard + Web MIDI → sources → actions; learn mode
js/virtual-midi.js keyboard stand-in controller (keys → raw MIDI bytes)
js/ui.js          HUD and mapping panel
js/locations.js   preset places
```

The engine only knows about *state* (speed, pitch target, mode). The input
layer only knows about *actions*. So Drift, OSC, or a sequencer can drive the
engine directly without going through keys or MIDI.

## Tests

`npm install` once, then `npm test`. This runs a headless-browser smoke test
with a simulated Google Maps and a simulated MIDI device that can be plugged
and unplugged (`tests/`). To use an installed Chrome instead of Playwright's
own browser, set `CHROMIUM_PATH` to its executable.

## Notes and limitations

- **Street View is not continuous.** It's a graph of spherical photos about
  5–15 m apart. "Travel" hops from photo to photo, picking the linked panorama
  closest to where the camera faces, so its speed is really a step rate
  (0.9 s at the fastest). "Drift" (rotating in place) is fully smooth. That
  difference in texture is probably the most interesting thing to play with.
- **Tilt is smoothed.** Mod-wheel values are 7-bit, so the view eases toward
  the target rather than stepping. The key and wheel inputs share one target,
  so moving the wheel after using the arrows will jump to the wheel's position.
- **Cost / terms.** Google bills per panorama load (there's a monthly free
  allowance). Their terms forbid caching or re-hosting the imagery and require
  the Google attribution to stay visible. Live projection in a performance is
  generally fine, but recording it for distribution needs a closer read of the
  terms. If this becomes a Drift module, Mapillary (open, CC-BY-SA, has an
  API) is the alternative worth prototyping against.
