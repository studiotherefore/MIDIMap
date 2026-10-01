// MIDIMap as a Mac app. Windows:
//   - the editor you see and play (panel, mouse, keys, MIDI);
//   - an off-screen output window rendering the same scene at exactly 1920×1080,
//     mirrored from the editor, published as the Syphon source "MIDIMap";
//   - on request, a full-screen output window on a chosen display (projector).
// Frames go to Syphon as GPU shared textures (no copy through memory).
// The editor talks to this file through preload.cjs (window.midimapApp).
// Kept entirely separate from Drift.

import { app, BrowserWindow, Menu, session, screen, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyphonMetalServer } from 'node-syphon';
import { startServer } from '../scripts/serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8765;                      // fixed, so learned MIDI settings persist between launches
const OUTPUT = { width: 1920, height: 1080 };
const PAGE = `http://localhost:${PORT}/editor/`;
let screenOut = null;                   // the projector window, when open
let measured = 0;
let fps = Number(process.env.MIDIMAP_FPS) === 60 ? 60 : 30; // 30 by default; MIDIMAP_FPS=60 to start at 60
let control;
let output;
let syphon;
let frames = 0;

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  // Allow Web MIDI without a prompt.
  const midi = (permission) => permission === 'midi' || permission === 'midiSysex';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(midi(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => midi(permission));

  await startServer(PORT);
  syphon = new SyphonMetalServer('MIDIMap');

  control = new BrowserWindow({
    width: 1440, height: 900, title: 'MIDIMap', backgroundColor: '#000',
    webPreferences: { backgroundThrottling: false, preload: path.join(HERE, 'preload.cjs') },
  });
  control.loadURL(PAGE);
  control.on('closed', () => app.quit());

  // Off-screen windows render at 1 device pixel per point, so the size is the frame size.
  output = new BrowserWindow({
    show: false, frame: false, enableLargerThanScreen: true,
    width: OUTPUT.width, height: OUTPUT.height,
    webPreferences: { backgroundThrottling: false, offscreen: { useSharedTexture: true } },
  });
  output.webContents.setFrameRate(fps);
  output.loadURL(`${PAGE}?output&app`);
  output.webContents.on('paint', ({ texture }) => {
    if (!texture) return;
    try {
      const info = texture.textureInfo;
      syphon.publishSurfaceHandle(info.handle.ioSurface, info.visibleRect, info.codedSize, false);
      frames++;
      lastSize = `${info.codedSize.width}×${info.codedSize.height}`;
    } finally {
      texture.release();
    }
  });

  buildMenu();
  setInterval(showRate, 2000);
});

// ---- what the editor can ask for (see preload.cjs) ----

const describe = (d) => ({
  id: d.id,
  label: d.label || (d.internal ? 'built-in display' : `display ${d.id}`),
  width: Math.round(d.size.width * d.scaleFactor),
  height: Math.round(d.size.height * d.scaleFactor),
  primary: d.id === screen.getPrimaryDisplay().id,
  current: control && !control.isDestroyed() && d.id === screen.getDisplayMatching(control.getBounds()).id,
});
ipcMain.handle('displays', () => screen.getAllDisplays().map(describe));

ipcMain.handle('open-output', (_e, { display, fullscreen = true } = {}) => {
  const d = screen.getAllDisplays().find((x) => x.id === display) || screen.getPrimaryDisplay();
  const b = d.bounds;
  if (!screenOut || screenOut.isDestroyed()) {
    screenOut = new BrowserWindow({
      x: b.x, y: b.y, width: Math.min(960, b.width), height: Math.min(540, b.height),
      title: 'MIDIMap output', backgroundColor: '#000', frame: !fullscreen,
      webPreferences: { backgroundThrottling: false },
    });
    screenOut.loadURL(`${PAGE}?output&app`);
    screenOut.on('closed', () => {
      screenOut = null;
      if (control && !control.isDestroyed()) control.webContents.send('output-closed');
    });
  } else {
    screenOut.setFullScreen(false);
    screenOut.setBounds({ x: b.x, y: b.y, width: Math.min(960, b.width), height: Math.min(540, b.height) });
  }
  if (fullscreen) screenOut.setFullScreen(true);
  return { ok: true, display: describe(d) };
});
ipcMain.handle('close-output', () => { if (screenOut && !screenOut.isDestroyed()) screenOut.close(); });
ipcMain.handle('toggle-output-fullscreen', () => {
  if (screenOut && !screenOut.isDestroyed()) screenOut.setFullScreen(!screenOut.isFullScreen());
});
ipcMain.handle('syphon', () => ({ fps, measured, size: lastSize }));
ipcMain.handle('set-syphon-fps', (_e, value) => setFps(value === 60 ? 60 : 30));

// Window title shows what's actually being sent: size, target and measured frame rate.
let lastSize = '';
let lastCount = 0;
function showRate() {
  measured = (frames - lastCount) / 2;
  lastCount = frames;
  if (control && !control.isDestroyed()) {
    control.setTitle(`MIDIMap — Syphon "MIDIMap" ${lastSize || '(starting)'} · ${fps} fps target · ${measured.toFixed(1)} sent`);
  }
}

function setFps(value) {
  fps = value;
  output.webContents.setFrameRate(fps);
  buildMenu();
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'Output',
      submenu: [
        { label: 'Syphon source: "MIDIMap", 1920×1080', enabled: false },
        { type: 'separator' },
        { label: '30 fps', type: 'radio', checked: fps === 30, click: () => setFps(30) },
        { label: '60 fps', type: 'radio', checked: fps === 60, click: () => setFps(60) },
        { type: 'separator' },
        { label: 'Reload output', click: () => { output.reload(); screenOut?.reload(); } },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => { control.reload(); output.reload(); screenOut?.reload(); } },
        { role: 'togglefullscreen' },
        { label: 'Developer tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => control.webContents.toggleDevTools() },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

app.on('before-quit', () => {
  try {
    syphon?.dispose();
  } catch {
    /* already gone */
  }
});
