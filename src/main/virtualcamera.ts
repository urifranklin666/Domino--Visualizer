import type { VirtualCameraStatus } from '@shared/types';
import { LinuxBackend } from './vcam-linux';
import type { VirtualCameraBackend } from './vcam-support';
import { WindowsBackend } from './vcam-windows';

/**
 * Main-process side of the virtual camera.
 *
 * The native addon lives here rather than in the renderer because loading a
 * .node module in a renderer would mean turning off the sandbox for the sake
 * of one feature. Frames arrive over IPC instead, already packed as NV12 by
 * the GPU, so the main process only forwards a buffer.
 *
 * Two platforms publish a camera by completely different means - a Media
 * Foundation source hosted by the Windows Frame Server, or a v4l2loopback node
 * on Linux - and this file is what they have in common: the requested format,
 * the frame count, the last error worth showing, and a status shape the
 * renderer can rely on whichever machine it is running on.
 */

function chooseBackend(): VirtualCameraBackend | null {
  if (process.platform === 'win32') return new WindowsBackend();
  if (process.platform === 'linux') return new LinuxBackend();
  return null;
}

const backend = chooseBackend();
const unsupported =
  'The virtual camera is not available on this platform. It needs Media ' +
  'Foundation on Windows or v4l2loopback on Linux.';

let loaded = false;
let running = false;
let width = 1280;
let height = 720;
let fps = 30;
let framesWritten = 0;
let lastError = '';

/** Load the native module once, on the first call that actually needs it. */
function ready(): VirtualCameraBackend | null {
  if (!backend) return null;
  if (!loaded) {
    loaded = true;
    backend.load();
  }
  return backend;
}

export function sourceDllPath(): string {
  return ready()?.sourcePath() ?? '';
}

/**
 * The native module file, whether or not it can be loaded here.
 *
 * Separate from `available` on purpose: a missing file is a packaging defect,
 * while a file that will not load may simply be a machine without the pieces
 * the feature depends on - the Media Foundation feature on Windows Server, or
 * a kernel with no v4l2loopback built for it.
 */
export function modulePath(): string {
  return backend?.modulePath() ?? '';
}

export function getStatus(): VirtualCameraStatus {
  const native = ready();
  if (!native) {
    return {
      available: false,
      registered: false,
      registeredIsThisBuild: false,
      running: false,
      width,
      height,
      fps,
      framesWritten: 0,
      registeredPath: '',
      sourcePath: '',
      modulePath: '',
      setupAction: '',
      setupHint: '',
      setupNote: unsupported,
      publishedName: '',
      error: unsupported,
    };
  }

  const loadError = native.loadError();
  const setup = native.setup();

  return {
    available: loadError === '' && native.modulePath() !== '',
    registered: setup.ready,
    registeredIsThisBuild: setup.ready && setup.isThisBuild,
    running,
    width,
    height,
    fps,
    framesWritten,
    registeredPath: setup.path,
    sourcePath: native.sourcePath(),
    modulePath: native.modulePath(),
    setupAction: setup.action,
    setupHint: setup.hint,
    setupNote: setup.note,
    publishedName: native.publishedName(),
    error: lastError || loadError,
  };
}

export function start(
  requestedWidth: number,
  requestedHeight: number,
  requestedFps: number,
  name: string,
): VirtualCameraStatus {
  const native = ready();
  lastError = '';
  if (!native) {
    lastError = unsupported;
    return getStatus();
  }

  // Both backends need even dimensions: NV12 stores one chroma sample per 2x2
  // block, so an odd width or height has no valid layout at all.
  width = Math.max(2, Math.floor(requestedWidth / 2) * 2);
  height = Math.max(2, Math.floor(requestedHeight / 2) * 2);
  fps = Math.max(1, Math.min(60, Math.round(requestedFps)));

  const result = native.start(width, height, fps, name || 'Domino');
  running = result.ok;
  framesWritten = 0;
  if (!result.ok) lastError = result.error ?? 'The virtual camera would not start.';
  return getStatus();
}

export function stop(): VirtualCameraStatus {
  ready()?.stop();
  running = false;
  return getStatus();
}

/**
 * Forward one NV12 frame.
 *
 * Deliberately quiet on failure: this runs thirty times a second, and a
 * per-frame error dialog would be unusable. The first failure is kept for the
 * status panel and the rest are dropped.
 */
export function writeFrame(frame: Buffer): void {
  const native = ready();
  if (!native || !running) return;

  const result = native.writeFrame(frame);
  if (result.ok) {
    framesWritten++;
  } else if (!lastError) {
    lastError = result.error ?? 'A frame could not be published.';
  }
}

/**
 * Do whatever this machine needs before a camera can exist, or undo it.
 *
 * A deliberate, user-initiated step on both platforms, because on both it
 * changes something outside Domino: a machine-wide COM registration on
 * Windows, a loaded kernel module on Linux. An app that quietly asks for
 * administrator rights the first time it runs has earned suspicion.
 */
export function register(unregister = false): VirtualCameraStatus {
  const native = ready();
  lastError = '';
  if (!native) {
    lastError = unsupported;
    return getStatus();
  }

  // Let go of the device first: on Linux we would otherwise be holding open
  // the very node we are about to ask the kernel to delete.
  if (unregister && running) {
    native.stop();
    running = false;
  }

  const result = native.provision(unregister);
  // An empty error is a prompt the user dismissed, which is a decision rather
  // than a failure and should not leave a complaint on screen.
  if (!result.ok && result.error) lastError = result.error;
  return getStatus();
}

export function listCameras(): string[] {
  return ready()?.listCameras() ?? [];
}

/** Stop publishing when the app quits, so no camera is left behind. */
export function shutdown(): void {
  if (running) stop();
}
