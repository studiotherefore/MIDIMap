// HUD overlay and the mapping / settings panel.

import { describeSource, label } from './input.js';
import { KNOBS, PADS } from './virtual-midi.js';
import { SLOTS } from './locations.js';

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

export class UI {
  constructor({ engine, router, virtual, onToggleVirtual, getLocations, onApiKey, onResetLocations }) {
    this.engine = engine;
    this.router = router;
    this.virtual = virtual;
    this.getLocations = getLocations;
    this.onApiKey = onApiKey;
    this.onResetLocations = onResetLocations;
    this._toastTimer = null;

    $('#panel-toggle').addEventListener('click', () => this.togglePanel());
    $('#panel-close').addEventListener('click', () => this.togglePanel(false));
    $('#api-key-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.onApiKey($('#api-key').value.trim());
    });
    $('#midi-start').addEventListener('click', () => router.startMidi());
    $('#virtual-toggle').addEventListener('click', () => onToggleVirtual());
    this._renderVirtualLayout();
    $('#export').addEventListener('click', () => this._export());
    $('#import').addEventListener('change', (e) => this._import(e.target.files[0]));
    $('#reset-bindings').addEventListener('click', () => {
      if (confirm('Reset all mappings to the defaults?')) router.resetBindings();
    });
    $('#reset-locations').addEventListener('click', () => {
      if (confirm('Forget saved views and restore the preset locations?')) this.onResetLocations();
    });
  }

  togglePanel(force) {
    const panel = $('#panel');
    const open = force ?? panel.hidden;
    panel.hidden = !open;
    if (!open && this.router.learning) this.router.cancelLearn();
    if (open) this.renderPanel();
  }

  toggleHud() {
    $('#hud').classList.toggle('hidden');
  }

  get panelOpen() {
    return !$('#panel').hidden;
  }

  showKeyPrompt(message) {
    $('#api-key').value = '';
    $('#api-key-message').textContent = message || '';
    this.togglePanel(true);
    $('#api-key').focus();
  }

  // state: 'none' | 'checking' | 'ok' | 'fail'
  // source: 'browser' | 'url' | 'file'
  setKeyState(key, state, onForget, source = 'browser') {
    const box = $('#api-key-state');
    box.replaceChildren();
    if (!key) {
      box.textContent = 'No key saved in this browser.';
      $('#api-key').placeholder = 'Google Maps JavaScript API key';
      return;
    }
    const label = { checking: 'checking with Google…', ok: '✓ accepted by Google', fail: '✗ not working — see message below' }[state] || '';
    box.className = state;
    if (source === 'file') {
      // A key typed here would be ignored while the file exists, so don't offer to replace it.
      box.textContent = `Key ending …${key.slice(-4)} from config.local.json in the project folder — ${label}`;
      $('#api-key-form').hidden = true;
      return;
    }
    box.append(`Saved key ending …${key.slice(-4)} — ${label} `,
      el('button', { onclick: onForget }, 'Forget key'));
    $('#api-key').placeholder = 'Paste a new key to replace the saved one';
  }

  toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  activity(sourceId, actionId, value, virtual) {
    const text = `${describeSource(sourceId)}${value != null ? ` = ${Math.round(value * 127)}` : ''}` +
      (actionId ? ` → ${actionId}` : ' (unmapped)') + (virtual ? '  [keyboard]' : '');
    $('#activity').textContent = text;
  }

  renderHud() {
    const e = this.engine;
    const speed = e.speed > 0 ? `+${e.speed}` : `${e.speed}`;
    $('#hud-location').textContent = e.locationName;
    $('#hud-mode').textContent = e.mode.toUpperCase() + (e.paused ? ' · PAUSED' : '');
    $('#hud-speed').textContent = `speed ${speed}`;
    $('#hud-status').textContent = e.status || '';
    const sources = [];
    if (this.router.midiStatus === 'connected') sources.push(this.router.midiInputs.join(', '));
    if (this.virtual.active) sources.push('keyboard controller');
    $('#hud-midi').textContent = sources.length ? `input: ${sources.join(' + ')}` : 'input: keys only';
    $('#learn-banner').hidden = !this.router.learning;
    if (this.router.learning) {
      const a = this.router.actions.get(this.router.learning);
      $('#learn-banner').textContent = `LEARN — move a control or press a key for "${label(a)}"  (Esc to cancel)`;
    }
  }

  renderPanel() {
    this.renderHud();
    if (!this.panelOpen) return;
    const r = this.router;

    $('#midi-status').textContent = r.midiStatus === 'connected' ? `Connected: ${r.midiInputs.join(', ')}` : r.midiStatus;
    $('#midi-start').hidden = r.midiStatus === 'connected';
    $('#virtual-status').textContent = this.virtual.active ? 'On' : 'Off';
    $('#virtual-toggle').textContent = this.virtual.active ? 'Turn off (P)' : 'Turn on (P)';

    const tbody = $('#mappings');
    tbody.replaceChildren();
    let group = null;
    for (const action of r.actions.values()) {
      if (action.group !== group) {
        group = action.group;
        tbody.append(el('tr', { class: 'group' }, el('th', { colspan: '3' }, group)));
      }
      const chips = r.sourcesFor(action.id).map((s) => {
        const endless = r.relative.has(s);
        // Knob actions driven by a CC can be read as a position or as an endless knob.
        const knobType = action.type === 'absolute' && s.startsWith('midi:cc:')
          ? el('button', { class: 'x', title: endless ? 'Endless knob. Click if it is an ordinary knob.' : 'Ordinary knob. Click if it is an endless knob.',
            onclick: () => r.toggleRelative(s) }, endless ? '∞' : '⇥')
          : null;
        return el('span', { class: endless ? 'chip endless' : 'chip' }, describeSource(s), knobType,
          el('button', { class: 'x', title: 'Remove', onclick: () => r.unbind(s) }, '×'));
      });
      const learning = r.learning === action.id;
      tbody.append(el('tr', { class: learning ? 'learning' : '' },
        el('td', {}, label(action), el('span', { class: 'type' }, action.type)),
        el('td', {}, ...(chips.length ? chips : ['—'])),
        el('td', {}, el('button', {
          onclick: () => (learning ? r.cancelLearn() : r.startLearn(action.id)),
        }, learning ? 'Cancel' : 'Learn'))));
    }

    const locs = this.getLocations();
    $('#locations').replaceChildren(...SLOTS.map((s) =>
      el('li', {}, el('b', {}, s), ` ${locs[s]?.name ?? '(empty)'}`, locs[s]?.pano ? el('em', {}, ' saved view') : null)));
  }

  // Cheat sheet for the keyboard stand-in, built from its layout so the two can't disagree.
  _renderVirtualLayout() {
    const key = (code) => el('kbd', {}, code.replace(/^Key/, ''));
    const rows = KNOBS.map((k) => el('tr', {},
      el('td', {}, el('kbd', {}, k.hint)),
      el('td', {}, `knob: ${describeSource(`midi:cc:1:${k.cc}`)}${k.cc === 1 ? ', mod wheel' : ''}`)));
    rows.push(el('tr', {},
      el('td', {}, ...PADS.flatMap((p) => [key(p.key), ' '])),
      el('td', {}, `pads: notes ${PADS[0].note}–${PADS[PADS.length - 1].note} (ch 1)`)));
    $('#virtual-layout').replaceChildren(...rows);
  }

  _export() {
    const blob = new Blob([JSON.stringify({ bindings: this.router.bindings, relative: [...this.router.relative], locations: this.getLocations() }, null, 2)],
      { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'midimap-setup.json' });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async _import(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.bindings) this.router.replaceBindings(data.bindings, data.relative);
      if (data.locations) this.onResetLocations(data.locations);
      this.toast('Setup imported');
    } catch (err) {
      this.toast(`Import failed: ${err.message}`);
    }
  }
}
