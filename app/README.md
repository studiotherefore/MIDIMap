# MIDIMap app (Syphon output)

A small Mac app around experiment 3 (effects). Kept entirely separate from Drift.

- **Control window**: the full experiment (panel, mouse, keys, MIDI without prompts).
- **Output**: an invisible window rendering the same scene at exactly **1920×1080**,
  mirrored from the control window 20× a second, published as the Syphon source
  **"MIDIMap"** (app name "Electron"). Frames go to Syphon as GPU shared textures.
  It keeps rendering when nothing is visible, so the feed never freezes.
- **Output menu**: 30 fps (default) or 60 fps. The window title shows the size and
  the frame rate actually being sent.

Start it by double-clicking **MIDIMap.app** in the project folder (a generated
launcher, not in git), or `npm start` in this folder. It serves the project itself
on http://localhost:8765 and reads the Mapillary token from `../config.local.json`.

Receive it in MadMapper (Media → Syphon → "MIDIMap"), Syphon Recorder (ProRes
capture), OBS (Syphon Client source), Resolume, VDMX, TouchDesigner…

Checked on 2026-09-29: 1920×1080 at 30.3 fps and 60.2 fps received by a Syphon
client; the output matched the control window's run, frame, effects and camera.
