# MIDIMap

A prototype for playing Google Street View like an instrument. Number keys move
between places, the camera moves on its own at a speed you set, and a mod wheel
or expression pedal tilts it up and down. Every control can be re-assigned with
**MIDI learn**. It's a standalone experiment for now, and may later become a
module in Drift.

## Run it

**Online (GitHub Pages):** open <https://studiotherefore.github.io/MIDIMap/> in Chrome
or Edge. Restrict the API key's HTTP referrer to `https://studiotherefore.github.io/*`.

**Locally:**

1. Get a **Google Maps JavaScript API** key (Google Cloud Console → APIs & Services →
   enable *Maps JavaScript API* → Credentials → Create API key). Restrict it to
   HTTP referrer `http://localhost:*` so it can't be used elsewhere.
2. Serve the folder locally. ES modules and Web MIDI both need `http://localhost`,
   not `file://`:
   ```sh
   python3 -m http.server 8000
   ```
3. Open <http://localhost:8000> in **Chrome or Edge**, since Safari has no Web MIDI.
   Paste the key into the panel when it asks. The key is saved in that browser
   only and never goes into the repo.

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
| `` ` `` | Mapping panel |
| `H` / `F` | Hide HUD / fullscreen |

### MIDI learn

Open the panel (`` ` ``), click **Learn** next to an action, then press a key or
move a control. The learned input replaces any earlier binding. Actions come in
three kinds:

- **trigger**: fires once. Works from a key, a note-on, or a CC/pad crossing its midpoint.
- **hold**: active while held. Works from a key, a held note, or a CC above its midpoint.
- **absolute**: follows a knob, fader, wheel, pedal, pitch bend or aftertouch.
  Keys and notes are rejected here.

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
js/ui.js          HUD and mapping panel
js/locations.js   preset places
```

The engine only knows about *state* (speed, pitch target, mode). The input
layer only knows about *actions*. So Drift, OSC, or a sequencer can drive the
engine directly without going through keys or MIDI.

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
