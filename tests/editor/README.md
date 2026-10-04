# Editor and experiment browser checks

Playwright scripts written while building the editor (phases 1–8) and
experiment 4. Unlike `tests/smoke.mjs` they load the **real** pages from the
local server, with real Mapillary photos, a simulated MIDI controller and a
faked sync service (so nothing in the shared database is touched).

Run them with the local server going (`npm start`):

```
node tests/editor/run-all.mjs        # the everyday suites, ~15 minutes
node tests/editor/parity.mjs         # or one at a time
```

| Script | Checks |
|---|---|
| parity.mjs | phase 1: keys, mouse, fake MiniLab, learn, looks, output mirroring, recording (42) |
| phase2.mjs | live fade, output window, recording follows the output, mirror latency (13) |
| projects.mjs | phase 3: save/open/new/reload/draft/export/import/rename/delete/offline (22) |
| phase4.mjs | MIDI profiles, learn mode, panel, device switching (37) |
| phase5.mjs | run strip, loop in/out, place details (19) |
| phase6.mjs | Street View with the Google Maps stand-in (23) |
| clock-editor.mjs | external MIDI clock timing (fake pulses) |
| take.mjs, take2.mjs | experiment 4: takes, playback timing, lanes, take loops, pads, MIDI launch (23 + 20) |
| kick-editor.mjs | kick timing with an audio probe; `HEADED=1` for the real display/audio |
| svreal.mjs | real Google Street View in a visible window (a few billed panorama loads) |
| svapp.mjs, apptest.mjs | the Mac app (quit the running app first: one instance only) |
| clock-exp3.mjs, kick-exp3.mjs | the same timing checks against experiment 3 |

Screenshots and recordings go to `tests/editor/output/` (git-ignored).
