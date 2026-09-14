import { app, BrowserWindow, ipcMain, dialog, session, desktopCapturer, shell } from 'electron';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import type { LibraryKind, ReadResult, WriteResult, AppSettings } from '@shared/types';
import {
  listLibrary,
  readLibrary,
  writeLibrary,
  deleteLibrary,
  renameLibrary,
  libraryExists,
  importIntoLibrary,
  revealLibrary,
} from './library';
import { getSettings, setSettings, flushSettings } from './settings';
import { fetchShadertoy } from './shadertoy';
import * as virtualCamera from './virtualcamera';

const isDev = !app.isPackaged;

/*
 * Chromium flags that make desktop-audio loopback available.
 *
 * The important one is `allow-loopback-in-peer-connection`: without it Chromium
 * refuses to hand out a loopback audio track. The rest widen the set of
 * capture paths Chromium is willing to consider on each platform.
 */
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
app.commandLine.appendSwitch(
  'enable-features',
  'WebRTCAudioProcessing,AudioServiceOutOfProcess',
);
// The renderer does its own smoothing/AGC, so let Chromium hand us raw samples.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

/**
 * Point Chromium's default capture device at the desktop's output mix.
 *
 * Linux has no equivalent of the WASAPI loopback Windows hands us, and
 * Chromium deliberately hides PulseAudio monitor sources from
 * enumerateDevices(), so there is no device the renderer could simply pick.
 * What PulseAudio does honour is PULSE_SOURCE: whatever it names becomes the
 * "default" capture device for this process and its children, the audio
 * service included.
 *
 * @DEFAULT_MONITOR@ is resolved by the server on every stream rather than once
 * at launch, so this keeps following the default sink when the user switches
 * from speakers to headphones mid-session.
 *
 * This only redirects the *default* device. An explicit deviceId still opens
 * the device it names, which is what keeps the Mic button pointed at a real
 * microphone - see AudioEngine.captureMicrophone.
 */
function configureSystemAudioCapture(): void {
  if (process.platform !== 'linux') return;

  // Someone who has set this themselves has a reason, and silently overriding
  // it would break a deliberate routing setup.
  if (process.env.PULSE_SOURCE) {
    process.env.DOMINO_AUDIO_LOOPBACK = 'pulse-monitor';
    return;
  }

  /*
   * Only worth doing when there is actually a PulseAudio or PipeWire server to
   * honour it. On a bare ALSA machine the variable would be ignored and the
   * default device would be a microphone, so the renderer needs to know it
   * cannot promise system audio rather than quietly capturing the room.
   */
  const socket =
    process.env.PULSE_SERVER ??
    (process.env.XDG_RUNTIME_DIR
      ? path.join(process.env.XDG_RUNTIME_DIR, 'pulse', 'native')
      : '');
  if (!socket || (!socket.includes(':') && !existsSync(socket))) return;

  process.env.PULSE_SOURCE = '@DEFAULT_MONITOR@';
  process.env.DOMINO_AUDIO_LOOPBACK = 'pulse-monitor';
}

configureSystemAudioCapture();

/*
 * Allow WebGL to fall back to software rendering.
 *
 * Chromium deprecated the automatic fallback, so without this flag a machine
 * with no usable GPU driver - a VM, an RDP session, a bare CI runner, or a
 * laptop whose driver Chromium has blocklisted - gets no WebGL2 context at all
 * and the app cannot start. With it, those machines run (slowly) instead of
 * showing an error.
 *
 * This does not force software rendering: hardware acceleration is still used
 * whenever it is available, so it costs nothing on a normal desktop.
 */
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let splashTimeout: NodeJS.Timeout | null = null;

/**
 * The splash window.
 *
 * Domino takes a couple of seconds to be useful - it scans the preset library,
 * compiles shaders and brings up a GL context - and an app that shows nothing
 * at all during that reads as one that failed to launch. This appears in the
 * first frames of the process and hands over the moment the renderer says it
 * is actually ready.
 *
 * Suppressed for --selftest and for the test harnesses, which attach to
 * whichever window they find and should not have to guess between two.
 */
function splashEnabled(): boolean {
  return (
    !process.argv.includes('--selftest') &&
    !process.argv.includes('--no-splash') &&
    process.env.DOMINO_NO_SPLASH !== '1'
  );
}

function createSplash(): void {
  if (!splashEnabled()) return;

  splashWindow = new BrowserWindow({
    width: 560,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    center: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/splash.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  splashWindow.once('ready-to-show', () => splashWindow?.show());
  splashWindow.on('closed', () => {
    splashWindow = null;
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void splashWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/splash.html`);
  } else {
    void splashWindow.loadFile(path.join(__dirname, '../renderer/splash.html'));
  }
}

/**
 * Hand over from the splash to the app.
 *
 * Idempotent, because it is reached from two directions: the renderer saying
 * it is ready, and a timeout for when it never does. A splash that outlives a
 * renderer which failed to start would leave the user with nothing but an
 * animation, which is worse than showing them a broken window.
 */
function finishSplash(): void {
  if (splashTimeout) {
    clearTimeout(splashTimeout);
    splashTimeout = null;
  }
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    mainWindow.show();
  }
  if (!splashWindow || splashWindow.isDestroyed()) return;

  const splash = splashWindow;
  splashWindow = null;
  splash.webContents.send('splash:done');
  // Long enough for the fade-out in the splash page to play, short enough that
  // nobody is left looking at two windows.
  setTimeout(() => {
    if (!splash.isDestroyed()) splash.close();
  }, 260);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#05060a',
    title: 'Domino',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The visualizer is the whole point; never let it be throttled offscreen.
      backgroundThrottling: false,
    },
  });

  /*
   * With a splash up, the main window waits for the renderer to report itself
   * ready rather than for first paint - first paint happens long before the
   * library is loaded and the first visual is on screen.
   */
  mainWindow.once('ready-to-show', () => {
    if (!splashWindow) mainWindow?.show();
  });

  if (splashWindow) {
    // Never let a renderer that fails to signal leave the app invisible.
    splashTimeout = setTimeout(finishSplash, 15000);
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  /*
   * The user can leave fullscreen by ways we never hear about directly - the
   * OS chrome, a window-manager shortcut, macOS gestures. Telling the renderer
   * lets it bring its own UI back, instead of stranding the app with hidden
   * controls in a windowed frame.
   */
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('app:command', 'fullscreen-changed', false);
  });
  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('app:command', 'fullscreen-changed', true);
  });

  // Keep navigation inside the app; open any external link in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  if (process.argv.includes('--selftest')) {
    void runSelfTest(mainWindow);
  }
}

/**
 * `Domino.exe --selftest` - verify a packaged build actually works.
 *
 * Packaging changes `app.isPackaged`, which changes where the bundled preset
 * library is looked up, and an asar bundle can omit files a dev run had on
 * disk. Both failures look like an app that starts fine and then has an empty
 * library, so the only way to be sure a release is good is to run the shipped
 * binary and ask it what it found.
 */
async function runSelfTest(win: BrowserWindow): Promise<void> {
  const problems: string[] = [];
  win.webContents.on('console-message', (...args: unknown[]) => {
    const details = args[1] as { level?: string; message?: string } | undefined;
    if (details && typeof details === 'object' && details.level === 'error') {
      problems.push(String(details.message));
    }
  });

  await new Promise<void>((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once('did-finish-load', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 6000));

  try {
    const probe = (await win.webContents.executeJavaScript(`
      (() => {
        const canvas = document.getElementById('canvas');
        return {
          gl: Boolean(canvas && canvas.getContext('webgl2')),
          width: canvas ? canvas.width : 0,
          entries: document.querySelectorAll('.lib-item').length,
          title: document.getElementById('hud-title').textContent,
          fps: document.getElementById('stat-fps').textContent,
          fatal: document.body.innerHTML.includes('could not start'),
        };
      })()
    `)) as {
      gl: boolean;
      width: number;
      entries: number;
      title: string;
      fps: string;
      fatal: boolean;
    };

    if (probe.fatal) problems.push('renderer failed to start');
    if (!probe.gl) problems.push('no WebGL2 context');
    if (probe.width <= 0) problems.push('drawing buffer has no size');
    if (probe.entries <= 0) problems.push('bundled library is empty (resource path wrong?)');
    if (!probe.title || probe.title === 'No visual loaded') problems.push('no visual loaded');
    if (probe.fps.startsWith('--')) problems.push('render loop not running');

    console.log(
      `selftest: packaged=${app.isPackaged} resources=${process.resourcesPath} ` +
        `library=${probe.entries} visual="${probe.title}" fps=${probe.fps}`,
    );

    /*
     * The virtual camera binaries are shipped as extra resources, so packaging
     * can drop them without anything else noticing. Whether the camera is ready
     * to publish depends on the machine and is not a build problem, but the
     * module failing to load in a packaged build always is.
     */
    const camera = virtualCamera.getStatus();
    console.log(
      `selftest: vcam module=${camera.modulePath || '(missing)'} ` +
        `source=${camera.sourcePath || '(none)'} ` +
        `available=${camera.available} registered=${camera.registered}` +
        (camera.error ? ` error="${camera.error}"` : ''),
    );

    /*
     * Only missing files are a build defect. Whether the module *loads* also
     * depends on the machine - it links against Media Foundation, which
     * Windows Server does not install by default - and failing a release
     * because the build agent has no media stack would be wrong.
     */
    if (!camera.modulePath) problems.push('virtual camera module was not packaged');

    /*
     * The media source DLL is a file this build either shipped or did not, so
     * a missing one is unambiguously a packaging defect. Its Linux counterpart
     * is a loopback device node, which belongs to the running kernel rather
     * than to the package - absent on any machine that has not loaded
     * v4l2loopback, and nothing a build could have done about it.
     */
    if (process.platform === 'win32' && !camera.sourcePath) {
      problems.push('virtual camera driver was not packaged');
    }
  } catch (err) {
    problems.push(`probe failed: ${(err as Error).message}`);
  }

  if (problems.length > 0) {
    console.log(`SELFTEST FAILED:\n  ${problems.join('\n  ')}`);
  } else {
    console.log('SELFTEST PASSED');
  }
  app.exit(problems.length === 0 ? 0 : 1);
}

/**
 * Grant media capture without prompting.
 *
 * A visualizer that has to ask permission every launch is useless, and the app
 * is a local desktop binary the user launched deliberately - there is no remote
 * origin that could abuse this.
 */
function installPermissionHandlers(): void {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'fullscreen'];
    callback(allowed.includes(permission));
  });

  ses.setPermissionCheckHandler((_wc, permission) =>
    ['media', 'audioCapture', 'display-capture', 'fullscreen'].includes(permission),
  );

  /*
   * This is what makes "hear everything the computer plays" work on Windows.
   *
   * When the renderer calls getDisplayMedia(), we answer with `audio: 'loopback'`,
   * which is Chromium's WASAPI render-endpoint loopback. The user never sees a
   * source picker, and we get the full output mix rather than one tab or window.
   *
   * A video source still has to be supplied because getDisplayMedia is defined
   * in terms of video; the renderer stops that track immediately, which leaves
   * the audio track running on its own.
   *
   * Linux normally never reaches this handler. PulseAudio and PipeWire publish
   * a `.monitor` input for every output, so the renderer opens one of those
   * through getUserMedia instead - fewer moving parts, and it does not depend
   * on a desktop portal being available. This stays wired up as the fallback
   * for a machine with no sound server publishing monitors.
   */
  ses.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          if (sources.length === 0) {
            callback({});
            return;
          }
          callback({ video: sources[0], audio: 'loopback' });
        })
        .catch(() => callback({}));
    },
    // We answer the request ourselves; don't raise the OS picker.
    { useSystemPicker: false },
  );
}

/* ----------------------------- IPC surface ----------------------------- */

function ok<T extends object>(extra: T): T & { ok: true } {
  return { ok: true, ...extra };
}
function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

const VALID_KINDS: LibraryKind[] = ['shader', 'milk', 'preset'];
function assertKind(kind: unknown): asserts kind is LibraryKind {
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind as LibraryKind)) {
    throw new Error(`Unknown library kind: ${String(kind)}`);
  }
}

function registerIpc(): void {
  ipcMain.handle('library:list', async (_e, kind: unknown) => {
    assertKind(kind);
    return await listLibrary(kind);
  });

  ipcMain.handle('library:read', async (_e, kind: unknown, id: unknown): Promise<ReadResult> => {
    try {
      assertKind(kind);
      const content = await readLibrary(kind, String(id));
      return ok({ content });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    'library:write',
    async (_e, kind: unknown, id: unknown, content: unknown): Promise<WriteResult> => {
      try {
        assertKind(kind);
        if (typeof content !== 'string') throw new Error('content must be a string');
        if (content.length > 8 * 1024 * 1024) throw new Error('content too large');
        const written = await writeLibrary(kind, String(id), content);
        return ok({ path: written });
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle('library:delete', async (_e, kind: unknown, id: unknown): Promise<WriteResult> => {
    try {
      assertKind(kind);
      await deleteLibrary(kind, String(id));
      return ok({});
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    'library:rename',
    async (_e, kind: unknown, fromId: unknown, toId: unknown): Promise<WriteResult> => {
      try {
        assertKind(kind);
        const written = await renameLibrary(kind, String(fromId), String(toId));
        return ok({ path: written });
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle('library:exists', async (_e, kind: unknown, id: unknown): Promise<boolean> => {
    assertKind(kind);
    return await libraryExists(kind, String(id));
  });

  ipcMain.handle('library:import', async (_e, kind: unknown) => {
    try {
      assertKind(kind);
      return await importIntoLibrary(kind);
    } catch (err) {
      return { imported: 0, skipped: 0, ...fail(err) };
    }
  });

  ipcMain.handle('library:reveal', async (_e, kind: unknown) => {
    assertKind(kind);
    await revealLibrary(kind);
  });

  ipcMain.handle('shadertoy:fetch', async (_e, id: unknown) => {
    // The key stays in the main process; the renderer never receives it.
    const settings = await getSettings();
    return await fetchShadertoy(String(id ?? ''), settings.shadertoyApiKey);
  });

  ipcMain.handle('dialog:openAudioFile', async (): Promise<string | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Audio File',
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(
    'dialog:saveText',
    async (_e, defaultName: unknown, content: unknown): Promise<WriteResult> => {
      try {
        if (!mainWindow) throw new Error('no window');
        if (typeof content !== 'string') throw new Error('content must be a string');
        const result = await dialog.showSaveDialog(mainWindow, {
          title: 'Save',
          defaultPath: String(defaultName ?? 'untitled.txt'),
        });
        if (result.canceled || !result.filePath) return { ok: false, error: 'canceled' };
        await fs.writeFile(result.filePath, content, 'utf8');
        return ok({ path: result.filePath });
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle('settings:get', async (): Promise<AppSettings> => await getSettings());
  ipcMain.handle(
    'settings:set',
    async (_e, patch: unknown): Promise<AppSettings> =>
      await setSettings((patch ?? {}) as Partial<AppSettings>),
  );

  ipcMain.handle('window:toggleFullscreen', () => {
    if (!mainWindow) return false;
    const next = !mainWindow.isFullScreen();
    mainWindow.setFullScreen(next);
    return next;
  });
  ipcMain.handle('window:setFullscreen', (_e, v: unknown) => {
    if (!mainWindow) return false;
    const next = Boolean(v);
    if (mainWindow.isFullScreen() !== next) mainWindow.setFullScreen(next);
    return next;
  });
  ipcMain.handle('window:isFullscreen', () => mainWindow?.isFullScreen() ?? false);
  ipcMain.handle('window:setAlwaysOnTop', (_e, v: unknown) => {
    if (!mainWindow) return false;
    const next = Boolean(v);
    mainWindow.setAlwaysOnTop(next);
    return next;
  });
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:close', () => mainWindow?.close());

  ipcMain.on('splash:stage', (_e, stage: unknown, fraction: unknown) => {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    splashWindow.webContents.send(
      'splash:stage',
      String(stage ?? ''),
      typeof fraction === 'number' ? fraction : undefined,
    );
  });
  ipcMain.on('app:ready', () => finishSplash());

  ipcMain.handle('vcam:status', () => virtualCamera.getStatus());
  ipcMain.handle(
    'vcam:start',
    (_e, width: unknown, height: unknown, fps: unknown, name: unknown) =>
      virtualCamera.start(Number(width), Number(height), Number(fps), String(name ?? 'Domino')),
  );
  ipcMain.handle('vcam:stop', () => virtualCamera.stop());
  ipcMain.handle('vcam:register', (_e, unregister: unknown) =>
    virtualCamera.register(Boolean(unregister)),
  );
  ipcMain.handle('vcam:listCameras', () => virtualCamera.listCameras());

  /*
   * `on`, not `handle`: frames arrive thirty times a second and the renderer
   * has nothing to do with the result, so making it await a reply would only
   * add a round trip to every frame.
   */
  ipcMain.on('vcam:frame', (_e, frame: unknown) => {
    if (frame instanceof Uint8Array) virtualCamera.writeFrame(Buffer.from(frame));
  });
}

/* ------------------------------ lifecycle ------------------------------ */

// One instance only: two copies fighting over the loopback tap is never useful.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    createSplash();
    installPermissionHandlers();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // Unpublish the camera first: an entry left in the device list after the
    // app is gone is a camera that shows nothing.
    virtualCamera.shutdown();
    void flushSettings();
  });
}
