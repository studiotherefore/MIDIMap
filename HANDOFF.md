# Handoff: 2026-10-03

Snapshot at the end of the session that ran 2026-09-29 → 2026-10-03 on the
author's Mac. CLAUDE.md is the stable reference (architecture, lessons);
EDITOR-PLAN.md is the editor's design and phase list; this file is "where we
stopped". Replace it at the end of each session.

## State at handoff

Everything is committed on `main`, pushed to GitHub, and deployed to
https://midimap.studiotherefore.workers.dev. `npm test` passes, and so does
`node tests/editor/run-all.mjs` (all 9 editor suites).

| Part | Where | State |
|---|---|---|
| **Editor** (main tool) | `/` → `/editor/` | Phases 1–7 of EDITOR-PLAN.md built: layout C in Drift's look; Mapillary or Google Street View as layer A; effects; tempo with external MIDI clock and a reference kick; live fade; output window; projects; MIDI controller profiles + learn mode; run strip + loop; place details. |
| **Experiment 4, performance recorder** | `/experiments/record/` | Built and live (phase 8, first approach). The author: "the sequencer works well, trim works". **Next: overdub.** |
| Street View instrument | `/streetview/` | Unchanged apart from the move; works with the real key. |
| Experiments 1–3 | `/experiments/mapillary/`, `/blend/`, `/fx/` | Frozen; each links back to the editor. |
| MIDIMap Mac app | `MIDIMap.app` in the project folder | Opens the editor; Syphon "MIDIMap" 1920×1080 at 30/60 fps; full-screen output on a chosen display; Street View works in it (key allows localhost:8765 since 2026-10-03). |
| Sync (Cloudflare D1 `midimap-presets`) | `/api/presets`, `/api/projects`, `/api/midi` | Tables `presets`, `projects`, `midi_profiles` (migrations 0001–0003 applied remotely). |

## What was built this session (in order)

1. **External MIDI clock** for experiment 3's tempo (C), then a **reference
   kick** (K: off / 808 / 909), timed against the picture and recordings.
2. Mockups → the author chose **layout C**, Drift's look, live-only output,
   looks as a global library, live off = fade to black (`mockups/editor.html`).
3. The **editor**, in seven phases, each tried by the author, tested,
   committed and deployed:
   1. layout + Mapillary (parity with experiment 3)
   2. live (L), output window on a display, the app opens the editor
   3. projects (⌘S, synced, export/import, unsaved draft kept)
   4. MIDI panel, learn mode (M) on any control, controller profiles
   5. run strip, loop in/out (I/O), place details (photographer credit)
   6. Google Street View as layer A (G)
   7. the editor is the front page; the instrument moved to `/streetview/`
4. **Experiment 4, performance recorder**: Q record a take, W play from the
   next beat, loop (whole or in/out), reverse, ½×/2×, BPM stretch, lanes
   (mute/solo/clear), trim, takes on pads and on any learned MIDI press.
5. The editor's browser checks moved into the project: `tests/editor/`.

## Decisions the author made (keep to them)

- **Keyboard first**; MIDI on top via learn; mappings belong to a controller
  profile, not a project.
- **Drift's look, not its layout**, and no faint text. On/off = switches,
  choices = segmented buttons, never sliders for on/off. Sliders are quiet.
- **Live only** (no cue/go). Live off **fades to black**.
- **Looks are global** (like reverb presets); projects keep current values.
- **Sequences: experiments first**, one approach each. The author picked the
  performance recorder first; it works; **overdub is the next step**.
- Place **banks**: later.
- The author commits/deploys only when they say so (they usually do, at the
  end of each piece); pushing to GitHub likewise.

## Next: overdub (start here)

Goal: while a take plays, record over it, replacing only what you touch, so a
take can be built up in passes (e.g. play the route, then overdub the effects,
then the camera).

A starting design (check it with the author before building; keep it in
`experiments/record/`):

- **Shift+Q** (and a button, MIDI-learnable) starts overdub while a take is
  playing; Shift+Q again (or W) stops it. If nothing plays, it starts the take
  and overdubs from its first beat.
- During overdub, playback keeps applying the take. A lane becomes **"punched
  in"** the moment the performer changes something in it (detect: the live
  value differs from what playback last applied for that key). From then on,
  playback stops applying that lane and the performer's values are recorded
  into it at take-relative beats, round the loop if it loops.
- Stopping merges: for each punched lane, the take's old changes between
  punch-in and the stop (per pass, across loop wraps) are replaced by the new
  ones; untouched lanes are unchanged. Show punched lanes in red on the
  timeline while recording.
- **Undo** the last overdub (one level is enough to start): keep the take as
  it was before, e.g. ⌘Z or an "undo overdub" button.
- Test it the way `tests/editor/take.mjs` / `take2.mjs` do: record a route,
  overdub a knob (fake MiniLab) during a loop, then check that the route is
  unchanged, the knob lane has the new values, and undo restores it.

After overdub, ask the author whether the recorder moves into the editor's
sequence tab, or whether to try a step sequencer / clip launcher experiment
first (takes on pads already make a simple clip launcher).

## How to pick up

1. Read CLAUDE.md fully, then this file (and EDITOR-PLAN.md when touching the
   editor).
2. Start the local server in the background (`npm start`) and run
   `CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test`.
3. Open `/experiments/record/` (and `/editor/`) to check they play; the
   Browser pane is often hidden, so use headless Playwright with the
   installed Chrome (see `tests/editor/`) and show the author screenshots.
4. Then start on overdub (above), after confirming the design with the author.

## Known gaps and cautions

- **Untried with real hardware:** the external MIDI clock (only fake pulses),
  full screen on a second display (the author's Roland video output shows up
  as a mirror, not a separate display), the kick by ear (timing was measured
  with the sound muted).
- The app's Syphon output only sends frames when the picture changes (a still
  Street View sends none; Syphon keeps the last frame).
- Street View can't be recorded in the browser (Google's picture can't be
  captured); record its Syphon output instead. Each panorama load is billed.
- Experiment 4 is a copy of the editor: changes to the editor don't reach it
  (and the other way round) until the recorder moves into the editor.
- A running app keeps old code: ⌘R (or restart) after changes.
- Deploys upload every untracked folder that isn't in `.assetsignore` (the
  author's screenshots went public once). Check `git status` first.
