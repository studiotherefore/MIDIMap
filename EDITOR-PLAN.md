# MIDIMap editor: build plan

Drafted 2026-10-01 from the mockup the author approved (`mockups/editor.html`,
layout C, served at http://localhost:8000/mockups/editor.html). This is the
plan for turning experiment 3 into the main MIDIMap tool.

**Status, 2026-10-03:** phases 1–7 are built, deployed and committed (each
phase: the author tried it, tests passed, then commit + deploy). Phase 8 is
under way as experiments: experiment 4, the performance recorder, is built and
live; overdub is next. Details of what was built, and the lessons, are in
CLAUDE.md; where to pick up is in HANDOFF.md.

## What the author decided

- **Layout C**: map + layers + blend on the left; the output monitor in the
  middle, flush with the top bar; a tabbed inspector on the right (effects,
  camera, audio, output); the 8 places as pads along the bottom, collapsible.
- **Drift's look, not Drift's layout**: near-black, warm off-white text, one
  amber accent (`#e8a84c`), monospace (SF Mono), lowercase, square corners,
  outline buttons. No faint text: secondary text is `#b8b2a4`, not Drift's
  `#6b675e`.
- **Live only** (no cue → go). The editor and the output are separate: the
  output window (and Syphon in the app) shows the picture only.
- **Tempo lives in the top bar** (beat light, − BPM +, tap, steps per beat,
  lock, clock source), not in a tab.
- **Audio tab**: the kick, plus room for audio tools to come or to adopt from
  other projects (sampler, synth, Drift's sound module, audio input).
- **On/off controls are switches, never sliders.** Choices between two or three
  options are segmented buttons (echo style blend | trails, kick off | 808 | 909,
  30 | 60 fps).
- **Looks sit below the effect controls.**
- **The whole setup saves as a project** (see below).
- **Both sources in one tool**: Mapillary and Google Street View, chosen per
  layer A and per place. Effects Google can't support grey out.

## Advice given with the plan (for the author to confirm)

1. **MIDI belongs in the top bar, not a tab.** A `midi ●` button opens a setup
   panel: connected devices (controller, clock in), the mapping list, learn
   mode (**M**, then click any control, then move a knob), export/import.
   Mappings are kept per **controller profile**, shared by all projects, so
   switching controllers means switching profiles, not redoing projects. A
   project only remembers which profile it uses.
2. **Under the monitor**: three tabs.
   - **this run**: a strip of the whole run (1…2196 photos) showing where you
     are, what's loaded ahead (green) and a loop (amber); click or drag to jump;
     loop in/out (**I** / **O**). Plus facts: date, position, heading, photo
     spacing, how many other runs pass here.
   - **this place**: the playing place's editable name, which pad it's on,
     "store playing photo here", and the credit Mapillary's licence asks for.
   - **sequence**: a placeholder. How sequences are recorded and edited is
     still open; each approach gets its own experiment first (as planned), and
     the one that wins lands in this panel. The run loop is the first small
     step towards it.
3. **Looks are global** (decided 2026-10-01): a library shared by every
   project, like a reverb preset in an audio program or a film look in
   Premiere. Saving or changing a look updates it everywhere (synced through
   Cloudflare, as presets are today). A project keeps the effect values that
   were on when it was saved, not its own copies of looks.

## Projects

A project is one JSON document with a version number:

| Part | Contents |
|---|---|
| places | all banks of 8 (search points or exact photos, either source) |
| layers & blend | layer A source, layer B mode/delay/run, blend mode, mix, dissolve |
| effects | the current effect values (looks themselves are a global library) |
| camera | field of view, pitch, follow, hold the sun, sharp photos |
| tempo | BPM, steps per beat, lock, clock source |
| audio | kick type, volume, offset (and later tools) |
| output | display, fullscreen/window, Syphon on, frame rate |
| midi | the name of the controller profile it uses |

- Stored in Cloudflare D1 (new `projects` table, same key-protected API as
  presets), cached in the browser for offline use; **⌘S** saves; a "saved /
  unsaved" mark in the top bar; export/import as a file (a backup to carry to a
  gig).
- Existing user presets become global looks (their place slots and scene
  settings, if any, can seed a first project); the built-in looks stay built in.

## How it's built

No build step, plain ES modules, as now. A new folder `editor/`, built from
experiment 3's code (copied, so experiment 3 stays frozen):

| Module | Role |
|---|---|
| `state.js` | one state object for everything a project saves, plus change events; undo later |
| `engine.js` | the frame loop: layers → blend → effects → canvas (from experiment 3) |
| `sources/mapillary.js` | runs, buffering, the run strip data (from `experiments/lib`) |
| `sources/streetview.js` | Google's viewer as layer A; look subset via CSS filters, as Drift does |
| `fx.js` | effects (from experiment 3, unchanged) |
| `tempo.js` | internal clock, external MIDI clock, beat prediction (from experiment 3) |
| `audio/kick.js` | the kick (from experiment 3); `audio/` is where later tools go |
| `midi.js` | devices, learn mode on any control, controller profiles |
| `project.js` | save/load/sync/export, versioned schema |
| `output.js` | the output window: open on a chosen display, live switch, mirroring |
| `ui/*.js` | top bar, left column, monitor + run strip, inspector tabs, pads, status bar |

### Output and live

- The editor's monitor and the output window each render from the same state;
  the output follows over `BroadcastChannel` (as now), sent on every change
  rather than 20 times a second, so it never lags a beat.
- **Live (L)**: on = the output follows; off = the output fades to black
  (decided 2026-10-01) while you change things in the editor.
- **Display**: in Chrome, the Window Management API places the output full
  screen on a chosen display (one permission prompt). In the app, a real
  borderless full-screen window on the chosen display, plus Syphon as now.
- **Record (V)** records the *output* (picture + audio), not the editor.

### Street View as a source

- Layer A can be Street View. It hops photo to photo (travel) or turns in place
  (drift), like the instrument, on the tempo grid.
- What works: tempo, places, camera, colour/blur/posterize/tint/grain (CSS
  filters, Drift's approach), output window, Syphon and recording in the app.
- What greys out: echo, recall, bloom-from-pixels, layer B and blending, hold
  the sun (Google's pictures can't be read).
- Cost: each panorama the output window loads is billed by Google; car imagery
  first (the 429 lesson).

## Order of work

Each phase ends with the author trying it, tests passing, and a commit.

1. ✅ **Shell + Mapillary (parity with experiment 3)**: the layout, top bar tempo,
   inspector tabs, left column, pads (collapsible, **P**), switches, keyboard
   map. Everything experiment 3 does works here.
2. ✅ **Output and live**: output window on a chosen display, **L**, record from
   the output; in the app, the full-screen window + Syphon.
3. ✅ **Projects**: save/load/sync/export, ⌘S, saved mark, preset migration.
4. ✅ **MIDI panel**: devices, learn mode on any control (**M**), controller
   profiles.
5. ✅ **Run strip and place details** under the monitor; loop in/out.
6. ✅ **Street View source.**
7. ✅ **Site**: the editor becomes the main page (`/`); the Street View
   instrument moves to `/streetview/`; experiments 1–3 stay, linked from a
   menu. Old addresses keep working.
8. ⏳ **Sequences**: experiments first, then the chosen approach goes into the
   sequence tab.
   - ✅ Experiment 4, **performance recorder** (`experiments/record/`, chosen
     by the author over a step sequencer and a clip launcher): takes as
     beat-timed lanes; play on the beat, loop (whole or in/out), reverse,
     ½×/2×, stretch with the BPM; mute/solo/clear/trim; takes on pads and on
     any learned MIDI press. The author: "the sequencer works well, trim
     works".
   - ⏭ Next: **overdub** (record over a take while it plays, replacing only
     the lanes you touch). Then decide: move the recorder into the editor,
     or try a step sequencer / clip launcher experiment first (takes on pads
     already give a simple clip launcher).

Tests: unlike the experiments, the editor gets automated tests: they live in
`tests/editor/` (Playwright against the real pages; real Mapillary, a
simulated MIDI controller, faked sync, Google mocked), plus the timing checks
(fake MIDI clock, audio probe, recorded-file analysis). `node
tests/editor/run-all.mjs` with the local server running.

## Keys

Existing keys keep their meaning. New ones are marked ★.

| Key | Does |
|---|---|
| Space · ← → | play/pause · step |
| R | forward/backward |
| ↑ ↓ | look up · horizon |
| 1–8 · Option+1–8 | go to a place · store the playing photo there |
| Shift+1–9 | looks |
| [ ] | blend mode |
| T · B · − = · , . | tap · lock · BPM · steps per beat |
| C · K | clock source · kick off/808/909 |
| S · V | hold the sun · record |
| ★ L | live on/off |
| ★ F | output window full screen |
| ★ P | show/hide the places row |
| ★ I · O | loop in · loop out |
| ★ M | MIDI learn mode |
| ★ ⌘S | save the project |
| H | hide the editor panels (monitor only) |
| Esc | close menus, cancel learn |

## Decided / open

- Live off fades to black (decided).
- Place banks (more sets of 8 on the same pads): later (decided).
- The editor lives at `/editor/` until phase 7.
