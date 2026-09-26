// HUD overlay and the mapping / settings panel.

import { describeSource, label } from './input.js';
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
  constructor({ engine, router, getLocations, onApiKey, onResetLocations }) {
    this.engine = engine;
    this.router = router;
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

  toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  activity(sourceId, actionId, value) {
    const text = `${describeSource(sourceId)}${value != null ? ` = ${Math.round(value * 127)}` : ''}` +
      (actionId ? ` → ${actionId}` : ' (unmapped)');
    $('#activity').textContent = text;
  }

  renderHud() {
    const e = this.engine;
    const speed = e.speed > 0 ? `+${e.speed}` : `${e.speed}`;
    $('#hud-location').textContent = e.locationName;
    $('#hud-mode').textContent = e.mode.toUpperCase() + (e.paused ? ' · PAUSED' : '');
    $('#hud-speed').textContent = `speed ${speed}`;
    $('#hud-status').textContent = e.status || '';
    const midi = this.router.midiStatus === 'connected' ? `MIDI: ${this.router.midiInputs.join(', ')}` : '';
    $('#hud-midi').textContent = midi;
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

    const tbody = $('#mappings');
    tbody.replaceChildren();
    let group = null;
    for (const action of r.actions.values()) {
      if (action.group !== group) {
        group = action.group;
        tbody.append(el('tr', { class: 'group' }, el('th', { colspan: '3' }, group)));
      }
      const chips = r.sourcesFor(action.id).map((s) =>
        el('span', { class: 'chip' }, describeSource(s),
          el('button', { class: 'x', title: 'Remove', onclick: () => r.unbind(s) }, '×')));
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

  _export() {
    const blob = new Blob([JSON.stringify({ bindings: this.router.bindings, locations: this.getLocations() }, null, 2)],
      { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'midimap-setup.json' });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async _import(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.bindings) this.router.replaceBindings(data.bindings);
      if (data.locations) this.onResetLocations(data.locations);
      this.toast('Setup imported');
    } catch (err) {
      this.toast(`Import failed: ${err.message}`);
    }
  }
}
