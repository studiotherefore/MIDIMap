// Street View engine: owns the panorama and a per-frame motion loop.
// Everything musical (speed, pitch, turning) is expressed as state here;
// the input layer only sets that state, so the engine can be driven by
// keys, MIDI, OSC, or another module (e.g. Drift) without changes.

const SPEED_MIN = -10;
const SPEED_MAX = 10;
const DRIFT_DEG_PER_LEVEL = 3;   // drift mode: degrees/second per speed level
const TRAVEL_BASE_SECONDS = 8;   // travel mode: seconds per step at speed 1
const TRAVEL_MIN_SECONDS = 0.9;  // never step faster than this (tiles need time to load)
const STEP_TIMEOUT_MS = 4000;    // give up waiting for a panorama to arrive
const PITCH_LIMIT = 85;
const PITCH_KEY_RATE = 45;       // degrees/second while a pitch key is held
const TURN_KEY_RATE = 60;        // degrees/second while a turn key is held
const PITCH_SMOOTHING = 6;       // higher = snappier response to pitch targets
const HEADING_SMOOTHING = 2.5;   // how quickly travel mode re-aligns to the road

const wrap360 = (a) => ((a % 360) + 360) % 360;
const angleDiff = (a, b) => ((a - b + 540) % 360) - 180; // signed, -180..180
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class StreetViewEngine {
  constructor(container, { onChange } = {}) {
    this.container = container;
    this.onChange = onChange || (() => {});
    this.ready = false;

    this.mode = 'drift';
    this.speed = 3;
    this.paused = false;
    this.heading = 0;
    this.pitch = 0;
    this.targetPitch = 0;
    this.alignHeading = null;   // travel mode: road direction to settle toward
    this.hold = { pitchUp: false, pitchDown: false, turnLeft: false, turnRight: false };
    this.locationName = '—';
    this.status = 'Waiting for Google Maps…';

    this._stepClock = 0;
    this._stepping = false;
    this._stepTimer = null;
    this._lastPov = null;
    this._lastFrame = 0;
  }

  async init() {
    const { StreetViewPanorama, StreetViewService } = await google.maps.importLibrary('streetView');
    this._svc = new StreetViewService();
    this.pano = new StreetViewPanorama(this.container, {
      disableDefaultUI: true,
      keyboardShortcuts: false,   // otherwise Street View also reacts to arrow keys
      clickToGo: true,
      linksControl: false,
      showRoadLabels: false,
      motionTracking: false,
      motionTrackingControl: false,
      visible: true,
    });

    // If the performer drags with the mouse, adopt that view instead of fighting it.
    this.pano.addListener('pov_changed', () => {
      const pov = this.pano.getPov();
      const last = this._lastPov;
      if (!last || Math.abs(angleDiff(pov.heading, last.heading)) > 0.01 || Math.abs(pov.pitch - last.pitch) > 0.01) {
        this.heading = wrap360(pov.heading);
        this.pitch = this.targetPitch = pov.pitch;
        this.alignHeading = null;
      }
    });
    this.pano.addListener('pano_changed', () => this._endStep());
    this.pano.addListener('status_changed', () => {
      const s = this.pano.getStatus();
      if (s !== 'OK') this._setStatus(`Street View: ${s}`);
    });

    this.ready = true;
    this._setStatus('Ready — press a number key');
    requestAnimationFrame((t) => this._frame(t));
  }

  // ---- actions -------------------------------------------------------------

  async goto(loc) {
    if (!this.ready || !loc) return;
    this.locationName = loc.name || 'Unnamed';
    this._setStatus(`Going to ${this.locationName}…`);
    if (loc.mode) this.mode = loc.mode;
    this.heading = wrap360(loc.heading ?? 0);
    this.pitch = this.targetPitch = loc.pitch ?? 0;
    this.alignHeading = null;
    this._stepClock = 0;

    try {
      let panoId = loc.pano;
      if (!panoId) {
        const { data } = await this._svc.getPanorama({
          location: { lat: loc.lat, lng: loc.lng },
          radius: 1000,
          preference: google.maps.StreetViewPreference.NEAREST,
          sources: [google.maps.StreetViewSource.OUTDOOR],
        });
        panoId = data.location.pano;
      }
      this.pano.setPano(panoId);
      this._applyPov(true);
      this._setStatus('');
    } catch (err) {
      this._setStatus(`No Street View near ${this.locationName}`);
      console.warn(err);
    }
  }

  changeSpeed(delta) {
    this.speed = clamp(this.speed + delta, SPEED_MIN, SPEED_MAX);
    this._emit();
  }

  setSpeedNormalized(v) {
    // 0..1 -> -10..10, with a small dead zone around the middle so a knob can find "stop"
    const raw = v * (SPEED_MAX - SPEED_MIN) + SPEED_MIN;
    this.speed = Math.abs(raw) < 0.6 ? 0 : Math.round(raw * 10) / 10;
    this._emit();
  }

  setPitchNormalized(v) {
    this.targetPitch = (v * 2 - 1) * 80;
  }

  setHeadingNormalized(v) {
    this.heading = wrap360(v * 360);
    this.alignHeading = null;
  }

  setHold(name, on) {
    this.hold[name] = on;
    if (on && (name === 'turnLeft' || name === 'turnRight')) this.alignHeading = null;
  }

  togglePause() {
    this.paused = !this.paused;
    this._emit();
  }

  toggleMode() {
    this.mode = this.mode === 'drift' ? 'travel' : 'drift';
    this.alignHeading = null;
    this._stepClock = 0;
    this._emit();
  }

  snapshot() {
    if (!this.ready) return null;
    const pos = this.pano.getPosition();
    const desc = this.pano.getLocation()?.description;
    return {
      name: desc || this.locationName || 'Saved view',
      pano: this.pano.getPano(),
      lat: pos?.lat(),
      lng: pos?.lng(),
      heading: Math.round(this.heading),
      pitch: Math.round(this.targetPitch),
      mode: this.mode,
    };
  }

  // ---- motion loop ---------------------------------------------------------

  _frame(t) {
    const dt = this._lastFrame ? Math.min((t - this._lastFrame) / 1000, 0.1) : 0;
    this._lastFrame = t;

    // Pitch: keys nudge the target; the view eases toward it (smooths 7-bit MIDI steps too).
    const pitchDir = (this.hold.pitchUp ? 1 : 0) - (this.hold.pitchDown ? 1 : 0);
    if (pitchDir) this.targetPitch = clamp(this.targetPitch + pitchDir * PITCH_KEY_RATE * dt, -PITCH_LIMIT, PITCH_LIMIT);
    this.pitch += (this.targetPitch - this.pitch) * (1 - Math.exp(-dt * PITCH_SMOOTHING));

    const turnDir = (this.hold.turnRight ? 1 : 0) - (this.hold.turnLeft ? 1 : 0);
    if (turnDir) this.heading = wrap360(this.heading + turnDir * TURN_KEY_RATE * dt);

    if (!this.paused && this.speed !== 0) {
      if (this.mode === 'drift') {
        this.heading = wrap360(this.heading + this.speed * DRIFT_DEG_PER_LEVEL * dt);
      } else {
        this._stepClock += dt;
        const interval = Math.max(TRAVEL_MIN_SECONDS, TRAVEL_BASE_SECONDS / Math.abs(this.speed));
        if (this._stepClock >= interval && !this._stepping) {
          this._stepClock = 0;
          this._step(this.speed > 0 ? 1 : -1);
        }
      }
    }

    if (this.mode === 'travel' && this.alignHeading !== null && !turnDir) {
      const d = angleDiff(this.alignHeading, this.heading);
      this.heading = wrap360(this.heading + d * (1 - Math.exp(-dt * HEADING_SMOOTHING)));
      if (Math.abs(d) < 0.2) this.alignHeading = null;
    }

    this._applyPov(false);
    requestAnimationFrame((tt) => this._frame(tt));
  }

  _step(direction) {
    const links = (this.pano.getLinks() || []).filter(Boolean);
    if (!links.length) {
      this._setStatus('Dead end — no linked panoramas');
      return;
    }
    const want = direction > 0 ? this.heading : wrap360(this.heading + 180);
    let best = links[0];
    for (const l of links) {
      if (Math.abs(angleDiff(l.heading, want)) < Math.abs(angleDiff(best.heading, want))) best = l;
    }
    this._stepping = true;
    clearTimeout(this._stepTimer);
    this._stepTimer = setTimeout(() => this._endStep(), STEP_TIMEOUT_MS);
    // Keep the camera facing forward along the road, even when reversing.
    this.alignHeading = direction > 0 ? best.heading : wrap360(best.heading + 180);
    this.pano.setPano(best.pano);
    if (this.status) this._setStatus('');
  }

  _endStep() {
    this._stepping = false;
    clearTimeout(this._stepTimer);
  }

  _applyPov(force) {
    if (!this.ready) return;
    const pov = { heading: this.heading, pitch: this.pitch };
    const last = this._lastPov;
    if (force || !last || Math.abs(angleDiff(pov.heading, last.heading)) > 0.005 || Math.abs(pov.pitch - last.pitch) > 0.005) {
      this._lastPov = pov;
      this.pano.setPov(pov);
    }
  }

  _setStatus(s) {
    this.status = s;
    this._emit();
  }

  _emit() {
    this.onChange(this);
  }
}
