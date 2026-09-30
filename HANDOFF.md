# Handoff: 2026-09-30

Snapshot at the end of the session that ran from 2026-09-27 to 2026-09-30 on
the author's Mac. CLAUDE.md is the stable reference; this file is the "where
we stopped" note. Replace it at the end of each session.

## State at handoff

Everything is committed on `main`, pushed to GitHub, and deployed to
https://midimap.studiotherefore.workers.dev. `npm test` passes.

| Part | State |
|---|---|
| Instrument (Google Street View, `/`) | Works. Keyboard stand-in controller, MiniLab 3 support (program-change pads, endless main knob), car imagery first (fixes the 429 black screen). Not touched since 2026-09-29. |
| Experiment 1, Mapillary explorer | Done, frozen. |
| Experiment 2, two-layer blend | Done, frozen (1–9, 0 jump to the instrument's presets; pads = blend modes). |
| **Experiment 3, effects** (`/experiments/fx/`) | **Current front line.** Effects on real pixels (Drift look vocabulary), hold the sun, 8 place slots, tempo clock (internal), presets synced through Cloudflare, recording, projector output window. |
| MIDIMap app (`app/`) | Works: control window + Syphon "MIDIMap" 1920×1080 at 30/60 fps. Launch by double-clicking `MIDIMap.app` in the project folder. |
| Preset sync | Live: D1 `midimap-presets`; shared list currently empty (test presets were deleted). The author's Chrome already holds the sync key for the online site. |

## What was built this session (in order)

1. Keyboard stand-in controller for the instrument; MIDI-learn fixes for the
   Arturia MiniLab 3 (program changes, endless encoder). Recorded the MiniLab
   with a CoreMIDI listener: pads = bank select + program change 0–7, main
   knob = CC114 relative, knob 1 = CC74, fader 1 = CC82, mod strip = CC1.
2. Moved hosting from GitHub Pages to Cloudflare (Worker + secrets), with a
   dedicated "MIDIMap" Google key; fixed the rate-limit black screen.
3. Experiments 1–3 on Mapillary (see CLAUDE.md), the effects chain, hold the
   sun, MIDI learn for effects, video recording.
4. The MIDIMap app with Syphon output; mirroring from the control page to
   `?output` pages over BroadcastChannel.
5. Scene presets ("badwater" saved from the author's Chrome), Save preset,
   then preset sync through Cloudflare D1 with a sync key.
6. Place slots (8) and the tempo clock with tap tempo, saved in presets.
7. Fixed: number-key jumps being pulled back to the old place; stale ES
   modules from the old python server (replaced by `scripts/serve.mjs`).

## Decisions the author made

- Keep MIDIMap **entirely separate from Drift** (hosting, secrets, code), but
  reuse Drift's *ideas* (the look vocabulary) where they fit.
- **Keyboard first**; they may switch MIDI controllers, so no MiniLab
  feel-tuning for now.
- Work through **small separate experiments** before deciding how recording
  and editing sequences should work; several recording approaches may each get
  their own experiment.
- Syphon (not NDI) for sending video to MadMapper / Syphon Recorder on the same
  Mac; 1920×1080, 30 fps default, 60 available.
- Web and app stay in parity (one codebase); the app adds Syphon.

## Next steps (in the author's order of interest)

1. **External MIDI clock** for the tempo (the author said it can be a later
   stage; the internal clock is built for it). In experiment 3's `onMidi`,
   handle 0xF8 (24 pulses per beat: derive BPM from pulse spacing, smoothed;
   every 24th pulse is a beat, so set `clock.origin` on it), 0xFA start (reset
   to beat 1 and play), 0xFB continue, 0xFC stop. Add a "clock: internal /
   external" switch and show which is active; keep internal as the fallback
   when pulses stop. Keyboard: a key to toggle clock source. Test with a fake
   pulse stream (the smoke test's fake MIDI device pattern works in a page).
2. **Recording and editing sequences**: the main open question. Run it as a
   series of experiments (new folders, e.g. `experiments/record-*`), one
   approach each, starting from experiment 3's code. Candidates discussed:
   - record what the camera did (run, photo index, yaw/pitch, effect values)
     as keyframes/lanes, then loop, reverse, time-stretch; stores photo ids
     only, so imagery is fetched live;
   - a step sequencer of slots/cuts on the tempo grid;
   - clip launching on pads (a place is a one-moment clip; a recording is a
     longer one), looper-style record/overdub, launch on the beat.
   Ask the author which to try first.
3. **Slot banks** (more than 8 slots): e.g. bank A/B switching, keys 9/0 are
   free for it.
4. **360° vs flat "perspective collisions"**: layer B from a flat-photo run.
5. **Mapillary image cache** on Cloudflare (licence allows it; the CDN is slow)
   → instant replays, later offline "performance packs" for gigs.
6. **Offline render**: redraw a recorded sequence frame by frame at 4K and
   write ProRes (needs item 2 first; the app could pipe frames to ffmpeg).
7. Sound (synth/sampler, "the walk plays itself") from the earlier map
   instrument outline; NDI only if a second computer enters the setup.

## How to pick up

1. Read CLAUDE.md fully, then this file.
2. Start the local server (`npm start`, background) and run
   `CHROMIUM_PATH=… npm test`.
3. Open experiment 3 in a *visible* browser tab to confirm it plays
   (Karl-Marx-Allee loads by default; press Space).
4. Ask the author which next step they want; don't assume.

## Known gaps and cautions

- The experiments have no automated tests; verify in a visible browser.
- MIDI defaults for effects knobs 5–8 and faders 2–4 are guessed Arturia
  numbers, unverified on the hardware.
- Mapillary is slow: wait for "buffered N frames ahead" before judging playback.
- The app's Syphon source is listed under the app name "Electron".
- `MIDIMap.app` (launcher) points at the project folder by absolute path; if
  the folder moves, rebuild it (see app/README.md, "Rebuilding the launcher").
