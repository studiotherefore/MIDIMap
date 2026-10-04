# MIDIMap: notes for Claude

Read this first, then `HANDOFF.md` (the latest session's snapshot and next steps).

## What this is

MIDIMap plays street-level imagery like an instrument, for live performance. It
may become a module in the author's larger project, **Drift** (at
`~/Desktop/Claude AI/Drift`), but is **kept entirely separate from Drift**: its
own Cloudflare Worker, secrets, database, tools and code. Never edit Drift's
files or config; reading Drift for ideas is fine.

Three parts, one codebase:

1. **The instrument** (`streetview/index.html` since phase 7, with `js/` and
   `css/` still at the root, shared with the editor): Google Street View,
   MIDI learn, keyboard stand-in controller, Arturia MiniLab 3 support. Web only.
2. **Experiments** (`experiments/`): a series of small, separate studies on
   Mapillary imagery (open, CC-BY-SA, pixels readable). The author is using
   them to decide how recording and editing sequences should work. Current
   front line: **experiment 3, effects** (`experiments/fx/`).
3. **The MIDIMap app** (`app/`): a small Electron app that opens the editor
   (since phase 2; experiment 3 before) and publishes a Syphon source
   "MIDIMap" at 1920×1080 (30 or 60 fps).
4. **The editor** (`editor/`, at `/editor/`): the main tool being built from
   experiment 3, following `EDITOR-PLAN.md` (layout C from
   `mockups/editor.html`, Drift's look). Phases 1 (layout + Mapillary, parity
   with experiment 3), 2 (live, output window, app), 3 (projects), 4
   (MIDI panel, controller profiles), 5 (run strip, loop, place details),
   6 (Street View as a source) and 7 (site: the editor is the front page)
   are done; 8 (sequences, via experiments first) is next.

## The author and how to work with them

- Artist and professor (new media, performance, philosophy); builds software
  for live performance but is not a conventional developer.
- **They prefer to stay out of the terminal.** Run commands yourself, explain
  results in plain language, and when they must click something (GitHub,
  Google Cloud, Cloudflare, Mapillary), give click-by-click steps.
- **Keyboard first**: every feature must work from the computer keyboard with
  no MIDI controller. They may switch controllers; MIDI mappings are extras on
  top (prefer MIDI learn over hard-coded CC numbers). List new keys in the
  page's controls table.
- Never ask them to paste keys or tokens into chat; use the key file and the
  page's own fields.
- They like being shown evidence: measure and verify in a real browser, then
  report what was checked. They commit/push only when asked (pushing is fine
  when they say so).

## Where things live

| What | Where |
|---|---|
| Project folder | `~/Desktop/Claude AI/experimental/MIDImap` |
| GitHub (public, backup only) | https://github.com/studiotherefore/MIDIMap, single branch `main` (default) |
| Live site | https://midimap.studiotherefore.workers.dev (Cloudflare Worker `midimap`, account studiotherefore@gmail.com). `/` forwards to `/editor/` (root `index.html`, keeps `?…`); the instrument is at `/streetview/` |
| Experiments online | `/experiments/mapillary/`, `/experiments/blend/`, `/experiments/fx/` |
| Local server | `npm start` → http://localhost:8000 (127.0.0.1 only, `Cache-Control: no-cache`) |
| The app | double-click `MIDIMap.app` in the project folder (git-ignored AppleScript launcher) or `npm start` in `app/`; serves itself on 127.0.0.1:8765 |
| Keys (never committed) | `config.local.json`: `mapsApiKey` (Google, a dedicated "MIDIMap" key), `mapillaryToken`, `presetsKey` (preset sync). Template: `config.example.json` |
| Cloudflare secrets | `MAPS_API_KEY`, `MAPILLARY_TOKEN`, `PRESETS_KEY` (`npx wrangler secret put NAME`, pipe the value from the key file; never print it) |
| Presets database | Cloudflare D1 `midimap-presets` (binding `DB`): tables `presets` (looks) and `projects` (editor, migration 0002), schema in `migrations/` |

GitHub Pages is retired (2026-09-28); GitHub is only the backup.

## Run, test, deploy, push

- **Serve**: `npm start` (scripts/serve.mjs). ES modules and Web MIDI need
  http://localhost, not `file://`. Chrome or Edge (Safari has no Web MIDI).
- **Test**: `npm test` (tests/smoke.mjs, headless Chromium). On the author's
  Mac: `CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test`.
  Covers the instrument (with a Google Maps mock and a pluggable fake MIDI
  device), the Worker, the key file and the presets API (with an in-memory
  D1). **The experiments have no automated tests**: verify them in a
  *visible* browser (see lessons).
- **Deploy**: `npm run deploy` (wrangler, installed in this folder) publishes the
  working folder to Cloudflare. Run the tests and commit first. `.assetsignore`
  keeps everything but the site files off the web; after changing it, check
  with `WRANGLER_LOG=debug npx wrangler deploy --dry-run` ("Ignoring asset"
  lines: wrangler's "Read N files" count is taken *before* the ignore list).
  New files can take ~10–60 s to appear after a deploy.
- **Push**: only when the author asks. Git on the author's Mac has no stored
  GitHub login; push with
  `git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main`.
  Before pushing, confirm no key from `config.local.json` is in any commit
  (`git grep -F <value> $(git rev-list --all)`, without printing the value).
- **Database**: `npx wrangler d1 migrations apply midimap-presets --remote`.

## Architecture

No build step; plain ES modules everywhere.

### The instrument (Google Street View)

| File | Role |
|---|---|
| `js/streetview.js` | Engine. Panorama + requestAnimationFrame loop. State only: `speed` (−10…10), `mode` (`drift` / `travel`), `targetPitch`, `heading`, holds; `nudge*` for endless knobs. `_findPano` asks for Google car imagery first, contributed photos only as a fallback. Knows nothing about keys or MIDI. |
| `js/actions.js` | Action vocabulary and `DEFAULT_BINDINGS`. Types: `trigger`, `hold`, `absolute` (0..1, optional `nudge(steps)`). New defaults go in `DEFAULTS_ADDED` (keyed by version) and bump `DEFAULTS_VERSION`, so browsers with saved mappings pick them up once. |
| `js/input.js` | `InputRouter`: keyboard and Web MIDI → source ids → actions, plus learn mode. Sources: `key:<code>`, `midi:cc:<ch or *>:<n>`, `midi:note:…`, `midi:pb:<ch>`, `midi:at:<ch>`, `midi:pc:<ch>:<program>`. Endless knobs (64 ± steps) are detected during learn and stored in `router.relative`. Bank select is ignored during learn. |
| `js/ui.js` | HUD, mapping panel (Learn, ∞/⇥ endless toggle, export/import JSON), key status. |
| `js/virtual-midi.js` | Keyboard stand-in controller: keys → raw MIDI into `router.handleMidi(…, { virtual: true })`. On when no controller is connected; **P** toggles. |
| `js/main.js` | Boot, Maps loader, reserved keys (`` ` `` panel, H, F, P, Esc), Shift+number saves a view, startup checklist with plain-language errors. Key sources: `?key=`, then `config.local.json`, then localStorage. |
| `js/locations.js` | Preset places for slots 1–9, 0 (also used by experiments for names). |

### Experiments (Mapillary)

Each experiment is a separate folder; once the author moves on, earlier ones
stay frozen (experiment 3 started as a copy of 2).

- `experiments/lib/mapillary.js`: token, Graph API with retries, geometry,
  `imagesNearFromTiles` (use the coverage tiles for "what's here"), `Run`
  (a sequence's ids, details fetched 50 at a time; runs can have 2000+ photos).
- `experiments/lib/presets-sync.js`: the shared presets client (see below).
- **1. Mapillary explorer** (`experiments/mapillary/`): MapLibre coverage map
  + MapillaryJS viewer + capture details and every other run within 15 m.
- **2. Two-layer blend** (`experiments/blend/`): plays a 360° run like a film;
  layer B = same run delayed N frames, or another 360° run matched by
  location; 8 blend modes; look straight up at the sky. `renderer.js`
  (WebGL2 `PanoBlend`) draws equirectangular panoramas itself, each turned by
  its `computed_compass_angle` (image centre = that direction); it can render
  to an off-screen target. Keys 1–9, 0 jump to the instrument's presets.
- **3. Effects** (`experiments/fx/`), the current front line:
  - Everything from 2, plus `fx.js`: scene → echo/feedback (ping-pong,
    zoom/rotate, blend or trails) → bloom (¼ size) → final grade. Parameter
    names and units follow **Drift's look destinations** (brightness, contrast,
    saturation, hue, invert, blur, pixelate, smear, tint + colour, bloom,
    recall, recall_depth; see Drift's LOOK-HANDOFF.md §A) plus echo*, grain,
    posterize, instability. Recall is a real ring of 15 half-size frames (one
    per 2 s).
  - **Hold the sun**: finds the brightest compact spot in each photo's upper
    half (256×128 readback) and eases the camera onto it.
  - **Place slots**: 8 (one bank). A slot is a search point `{name, lat, lng}`
    (nearest playable 360° run) or an exact photo `{…, sequence, image}`.
    1–8 go, Option+1–8 store the playing photo, click a name to rename;
    pads (program changes 0–7) go to slots. localStorage `midimap.fx.slots.v1`.
  - **Tempo**: internal clock (`clock.origin`, `S.bpm`, `S.stepsPerBeat` ∈
    ¼, ½, 1, 2, 4). With `S.tempo` on, photo steps land exactly on the grid; a
    step whose photos aren't ready is skipped, never delayed. T tap, B lock,
    − = BPM, , . steps per beat, beat light. Measured 500 ms ±1 at 120 BPM.
  - **External MIDI clock** (C, or the Clock menu; choice kept in localStorage
    `midimap.fx.clock.v1`): `onClock` follows 0xF8 pulses (BPM from the
    spacing over 2 beats, shown only on a change ≥ 0.2; every 24th pulse sets
    `clock.origin`); locked to tempo, photo steps happen *on pulses*
    (every 24 / stepsPerBeat), so tempo changes apply at once. Start = beat 1 +
    play, Stop = pause (song position freezes, pulses still measure BPM),
    Continue, song position (0xF2). First input that pulses wins. No pulse for
    500 ms → internal clock carries on at the last BPM. BPM field/Tap/−=
    are locked while following. Space while the device is stopped plays on the
    internal grid at the device's tempo. `window.blend.onMidi(bytes, t, {id,
    name})` feeds a fake clock; verified with Playwright at 130/90 BPM: steps
    exact to 0.1 ms.
  - **Reference kick** (`kick.js`; K cycles off → 808 → 909): synthesised
    (Web Audio, no samples), one per beat while playing; turning it on turns
    tempo lock on. A worker ticks the scheduler every 25 ms (page timers slow
    when hidden); `beatAfter(t)` predicts beats from the pulses while an
    external clock runs, else from the grid. `audioTime()` maps via
    `getOutputTimestamp` (already the *heard* time: don't subtract latency
    again, that bug silently skipped every kick at 173 ms latency). Two voices:
    speakers at beat + PICTURE_MS (30) + `offset` (room alignment, ± 250 ms),
    and a recording voice into `stream` at REC_LEAD_MS (30) early, since the
    recorded file put sound ~30 ms late. Measured in a real Chrome window
    (muted): kicks 5–8 ms after the internal step (the screen shows it ~1 frame
    later), recorded file kick vs cut −12…+18 ms. Volume/offset: localStorage
    `midimap.fx.kick.v1`, MIDI-learnable (`extras` in the learn code). Only the
    control window sounds; recordings (V) include it. Play (Space) now starts
    on the next grid step rather than with an immediate off-beat step.
  - **Presets**: 6 built-in looks + "badwater" (a full scene) + user presets.
    A preset = look values, optional `scene` {`settings` (blend, camera,
    playback, tempo keys: `SCENE_KEYS`), `photo` {sequence, image}, `runB`},
    optional `slots` (the 8 slots). Shift+1–9 apply.
  - **Preset sync**: user presets live in D1 via `/api/presets` (see Worker).
    The local servers serve `presetsKey` from the key file, so localhost:8000
    and the app can write; other browsers paste the key once ("Copy sync key"
    on the Mac → paste box; stored in localStorage `midimap.syncKey.v1`).
    Lists refresh every 30 s and on returning to the tab. Presets saved without
    a key stay local (dashed) and upload once a key exists; a cached copy
    covers offline.
  - **MIDI**: fixed MiniLab mapping (mod strip = look up, knobs 1–4 = mix /
    delay / dissolve / speed (BPM when locked), main knob = turn, pitch strip =
    glance, fader 1 = field of view, pads = slots, keys = step a frame while
    paused) plus MIDI learn for every effect (localStorage
    `midimap.fx.learn.v1`; guessed defaults for knobs 5–8 and faders 2–4).
  - **Record** (V): `canvas.captureStream(60)` + MediaRecorder → H.264 MP4 of
    the picture alone, saved to Downloads.
  - **Mirroring**: the control page broadcasts its state on
    `BroadcastChannel('midimap-fx')` at 20 Hz (`MIRROR_KEYS`, look, run,
    index). A `?output` page hides all UI and follows it: the browser's
    "Open output window" (projector) and the app's Syphon output. Anything
    that changes the picture must be mirrored.

### The editor (`editor/`; read `EDITOR-PLAN.md`)

- Copies of experiment 3's `app.js`, `fx.js`, `kick.js` and experiment 2's
  `renderer.js` (so the experiments stay frozen); imports `experiments/lib/`
  and `js/locations.js`. Same localStorage keys as experiment 3 (slots,
  learn, kick, clock, presets), so settings carry over.
- Layout C: map + layer A/B + blend (left), monitor flush under the top bar
  + transport + "this run / this place / sequence" (centre), inspector tabs
  effects / camera / audio / output / keys (right), places as pads (bottom,
  P folds), status bar (status messages, clock status, MIDI). Tempo lives in
  the top bar. H = picture only; `?output` = picture only (mirrored).
- Design rules from the author: Drift's look (near-black, `#e8a84c` amber,
  SF Mono, lowercase, square corners, outline buttons) but no faint text;
  on/off = switches (`.sw`), two/three-way choices = segmented buttons
  (`.seg`), never sliders; looks below the effect controls; looks are a
  global library (projects will keep only current values); live off fades to
  black (phase 2); place banks later.
- Lessons: going to a place must not rebuild the pads (a rebuild swallowed the
  double-click that renames); number boxes and menus blur after a change so
  keys reach the editor again.
- Phase 2: **live (L)** fades the output to black and back (`S.live`
  mirrored; `uFade` in fx.js FINAL, `FADE_S` 0.6 s); the editor's monitor
  keeps the picture (dimmed, "not live" badge) except while recording, so a
  recording = the output. Mirroring is on its own channel `midimap-editor`,
  posted every 50 ms *and* at once when photo/run/live changes (measured
  0–25 ms editor → output window). Output window: display list from the
  Window Management API (asks once) or, in the app, `window.midimapApp`
  (`app/preload.cjs`: displays, openOutput {display, fullscreen},
  closeOutput, toggleOutputFullscreen, syphon, setSyphonFps). F = output full
  screen if open. `?output&app` = the app's own output windows (no hints).
  Photos are decoded off the main thread (`img.decode()` before "ready") and
  the sun is looked for once per photo only while hold-the-sun is on: before
  that, a photo arriving could stall a frame (one 91 ms output lag, one
  swallowed step); after, 6–15 ms in four runs.
  Equal side panes (`--side` 360px); sliders are a thin line + small square.
  Untested by machine: full screen on a second display (needs a real gesture
  and a second screen); the author's Roland video output appears as a
  mirror, not a separate display.
- Phase 3, **projects** (`editor/project.js` + the projects section at the
  end of `editor/app.js`): a versioned JSON document (`PROJECT_VERSION`,
  `migrate()`): places, layers, effect values, camera, playback (photo,
  slot), tempo + clock, audio, output, midi profile name. Stored in D1 table
  `projects` via `/api/projects` (same rules and sync key as presets; the
  Worker's `COLLECTIONS`; 200 kB max), cached in localStorage, saved locally
  when offline/no key and uploaded later. The open project + unsaved draft
  live in `midimap.editor.current.v1`, written every second and on
  `pagehide`. "Unsaved" = `fingerprint()` differs (ignores the playing
  photo). Top bar: project ▾ (menu: list, save as, rename, new, export,
  import), save, saved mark; ⌘S / ⇧⌘S. Jumps take a ticket (`nav`) so the
  last one asked for wins (New then Open used to race). 22 checks with a
  faked sync service.
- Phase 4, **MIDI** (`editor/midi.js` + the MIDI sections of `editor/app.js`):
  the fixed MiniLab mapping and experiment 3's learn list became one
  **controller profile** (`MINILAB()`; old learned knobs merged in on first
  run). Binding = `{ src: 'cc|note|pc:<ch|*>:<n|*>' | 'pb:<ch>', to: control
  id, mode: abs|rel|press, range? }`; the most specific match wins (a learned
  key beats "any key steps"). `controls` (built by `buildControls()`, ~60):
  range / toggle / trigger / choice / turn / glance; `[data-learn]` marks them
  on screen. Learn mode **M**: capture-phase click arms a control (it is not
  operated), next message binds (source leaves other controls, control keeps
  one source); an endless knob is spotted from the next values (all 58–70 →
  `rel`). Panel (midi ▾): devices with activity lights, last message,
  profile select/new/duplicate/rename/delete/export/import, "use with
  connected controller" (profile.devices; a newly plugged controller brings
  its profile), mapping list with ⇥/∞/● and ×, learn buttons for controls
  not on screen. Profiles sync via `/api/midi` (D1 `midi_profiles`,
  migration 0003; `ProjectStore` is reused with options). A project stores
  only the profile name. 37 checks with fake devices and a fake sync service.
- Phase 5, **run strip and loop**: `S.loop/loopIn/loopOut` (indexes; mirrored;
  cleared by a new run; projects store them as photo ids). `nextIndex()` wraps
  inside the loop in either direction; `advance`, `prefetch` and `buffered`
  use it, so photos past the wrap load early. Keys I / O / Shift+I; buttons
  and a switch in the transport; all three MIDI-learnable. "this run":
  `#strip` canvas (red = here, green = loaded ahead, amber = loop; click or
  drag to jump; `ensure` while dragging, `prefetch` on release), loop length
  in photos and metres (`runMetres`), facts (date, position, heading,
  spacing, other runs within 20 m). "this place": rename the current pad,
  store the playing photo on any pad, captured date/time, photographer and
  camera (Graph API `creator,make,model,camera_type`, once per photo, only
  while the tab shows; "none" hidden), licence, other dates, mapillary.com
  link. After a jump the facts say "loading this part of the run…" until the
  details arrive. 19 checks on real Mapillary.
- Phase 6, **Street View as layer A** (`editor/streetview.js`, built on the
  instrument's `js/streetview.js` engine with `speed = 0` so the editor drives
  it): G or the layer A buttons switch source (starting where the Mapillary
  photo is, facing the same way). Google loads only on first use (billed per
  panorama). Travel = `hop()` on the tempo grid / speed, skipped (never
  queued) while a hop loads or < 0.9 s since the last; drift = turning at
  speed × 3°/s; turn knob, look up, field of view (zoom), glance drive the
  view; dragging the viewer is adopted. Effects = CSS filters + SVG posterize
  + tint/grain/fade overlays (`SV_EFFECTS`); the rest, layer B, blend, hold
  the sun and recording are greyed out or explained. Places can be Street
  View (`source: 'sv'`, pano + pov); projects keep `layers.source` and
  `streetview`; the output follows (`sv` in the mirror, eased). The key must
  allow each address: http://localhost:8765/* was missing for the app
  (RefererNotAllowedMapError, shown in plain words). Fixed in the engine:
  a status arriving before its listeners were set (affected the instrument
  too). Panels under the picture are wrapped so they can't stop the frame
  loop. 23 checks with the Maps stand-in + a real run on localhost:8000.
- Phase 7, **site**: root `index.html` forwards to `editor/` (meta refresh +
  `location.replace`, works on both servers without Worker changes); the
  instrument's page moved to `streetview/index.html` (`../css`, `../js`;
  `KEY_FILE` is now `/config.local.json`, it was relative). The editor's
  wordmark opens a site menu (links open in a new tab so a running editor and
  its output keep going); the instrument and experiments 1–3 link back
  ("← editor"). `tests/smoke.mjs` serves folders' index.html, opens the
  instrument at `/streetview/` and checks the forward. The Google key allows
  http://localhost:8000/*, http://localhost:8765/* (added 2026-10-03 for the
  app) and the live site.
- Verified 2026-10-01 with Playwright: 42 parity checks (keys, mouse, fake
  MiniLab, learn, looks with a faked API, output mirroring, recording), the
  clock and kick timing tests.

### Cloudflare Worker (`src/worker.js`)

Serves the site files (`[assets]`, `.assetsignore`), answers
`/config.local.json` from `MAPS_API_KEY` and `MAPILLARY_TOKEN` (**never**
`PRESETS_KEY`), and `/api/presets`, `/api/projects`, `/api/midi` (the
`COLLECTIONS` table: one D1 table each): GET public; PUT/DELETE need header
`x-midimap-key` = `PRESETS_KEY` (constant-time compare); CORS only for
http://localhost:8000 and :8765.

### The app (`app/`, see app/README.md)

Electron 44 + node-syphon 1.5, own `node_modules` (not the web project's).
Control window = experiment 3. An off-screen window
(`offscreen.useSharedTexture`, sized 1920×1080 in points, since off-screen
renders 1 px per point) loads `?output`; each `paint` texture's
`textureInfo.handle.ioSurface` goes to `SyphonMetalServer.publishSurfaceHandle`.
Output menu: 30/60 fps (`MIDIMAP_FPS=60` at launch). MIDI permissions are
granted without prompts. Verified with a node-syphon client: 1920×1080 at 30.3
and 60.2 fps; output state matched the control window.

**Web/app parity is automatic**: the app loads the same experiment files from
the project folder, so every experiment feature lands in both. App-only:
Syphon, fixed 1920×1080 output, no MIDI prompts, no background freezing. The
instrument (Google Street View) is web-only.

## Lessons learned (don't regress these)

Google Street View (the instrument):

- **Google overwrites the viewer container's inline style** (`position:
  relative`). The viewer must sit inside a wrapper (`#stage` fixed full-screen,
  `#pano` 100%×100%) or it collapses to 0 px: a black screen. The mock
  reproduces this and the tests check the size.
- **Second kind of black screen: rate-limited contributed photos.** The
  checklist is green and a photographer credit shows, but Google answers
  `lh3.googleusercontent.com` photo requests with HTTP 429 (per internet
  connection; Drift's studio counts too). Hence car imagery first
  (`StreetViewSource.GOOGLE`, tiles from `streetviewpixels-pa.googleapis.com`).
  Diagnose with the network log. Page zoom was a red herring.
- `keyboardShortcuts: false` on the panorama, or Street View reacts to arrows.
- `status_changed` may not fire between panoramas; also listen to `pano_changed`.
- Google reports key errors only in the console; `main.js` puts them on screen.
  Keep failures visible: the author won't open DevTools.
- Street View is a graph of photos 5–15 m apart; travel hops at most one step
  per 0.9 s; drift (rotating in place) is smooth.
- The direction knob is relative (an absolute heading jumped on first touch).

Mapillary (the experiments):

- **Pixels are readable** (`access-control-allow-origin: *`), so real shaders,
  blending and feedback work. That's why Drift's look vocabulary is
  re-implemented as shaders here (Drift couldn't do echo on Google).
- The search API returns an arbitrary *sample* of a bbox and fails
  intermittently (500/503): use the coverage tiles' `image` layer via
  `querySourceFeatures` for "what's here"; use the API for details, with retries.
- **The image CDN is slow and uneven**: 1–13 s per 1024-px photo, 4–50 s per
  2048-px. Hence 1024 px by default, 30 frames buffered ahead, buffer shown.
- Prefer runs of 20+ photos when jumping; a lone 360° photo can't play.
- After moving the map, wait for its `idle` event before searching tiles.
  A timer that re-centred the map on the playing photo once pulled every jump
  back to the old place: follow only when the photo *changes*.
- Several instrument presets have no 360° coverage (Pripyat, Nathan Road,
  Monument Valley); the experiment-3 default slots are places that do.

Browsers, testing and tools:

- **A hidden or background tab gets 0 fps**: maps and viewers never finish
  loading, rAF never fires. Verify in a *visible* tab. With Claude in Chrome,
  bring the tab to the front (Control_Chrome `switch_to_tab`) and switch the
  author back to their own tab afterwards. The built-in Browser pane may be
  hidden too (check `document.visibilityState`).
- Chrome caches ES modules aggressively: that's why `scripts/serve.mjs` sends
  `Cache-Control: no-cache` (python's http.server served stale modules).
  Hard-reload (Cmd+Shift+R) a test tab after edits if in doubt.
- Key events: dispatch on `document.body`, not `window` (the page's handler
  calls `e.target.closest`). Claude in Chrome's named "period" key didn't
  reach the page; typing "." did.
- Chrome blocks JavaScript from AppleScript by default; don't ask the author to
  change that. To read another tab's experiment state, listen on the
  BroadcastChannel from a tab on the same origin.
- Chrome asks MIDI permission even without sysex; that DevTools notice is harmless.

## Next steps (the author's direction as of 2026-09-30)

See `HANDOFF.md` for detail. In short: external MIDI clock for the tempo
(built 2026-09-29; still to try with a real device); then **recording and editing sequences** as a series of experiments (one
approach each); slot banks; 360° vs flat "perspective collisions"; a Mapillary
image cache on Cloudflare (the licence allows it) leading to offline
performance packs; an offline 4K/ProRes render once sequences exist; sound
(synth/sampler) later.
