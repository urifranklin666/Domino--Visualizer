import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * Shared scaffolding for the two virtual camera backends.
 *
 * Windows and Linux publish a camera by entirely different means - a COM media
 * source hosted by the Frame Server, against a kernel loopback device - but
 * both are a native module on disk plus a one-time setup step the user has to
 * authorise, so those two problems are solved once here.
 */

export interface NativeResult {
  ok: boolean;
  error?: string;
}

/** What the user has to arrange before a camera can exist on this machine. */
export interface SetupState {
  /** The camera can be published right now. */
  ready: boolean;
  /** Where the camera comes from - a registered DLL, a loopback node. */
  path: string;
  /**
   * The setup in place belongs to this copy of Domino.
   *
   * Only Windows can be wrong about this, because registration records a path
   * and an older install left registered keeps being the driver Windows loads.
   * Linux has nothing equivalent - the device belongs to the kernel - so its
   * backend reports this as true whenever it is ready at all.
   */
  isThisBuild: boolean;
  /** Button text for the setup step, or '' when there is nothing to offer. */
  action: string;
  /** Tooltip saying what that button will actually run. */
  hint: string;
  /** Why the camera is not ready yet, phrased for this platform. */
  note: string;
}

/**
 * One platform's way of being a webcam.
 *
 * Everything platform-specific lives behind this. The facade in
 * virtualcamera.ts owns the bookkeeping both share - frame counts, the
 * requested format, the last error - so a backend only has to answer for the
 * machine it is running on.
 */
export interface VirtualCameraBackend {
  /** Load the native module. False when this machine cannot run the feature. */
  load(): boolean;
  /** Why load() failed, or '' when it did not. */
  loadError(): string;
  /** The native module file, whether or not it can be loaded here. */
  modulePath(): string;
  /** The driver or device the camera comes from; '' when there is none. */
  sourcePath(): string;
  setup(): SetupState;
  /** Run the setup step, or undo it. Prompts for rights where they are needed. */
  provision(unregister: boolean): NativeResult;
  start(width: number, height: number, fps: number, name: string): NativeResult;
  stop(): void;
  writeFrame(frame: Buffer): NativeResult;
  /** Every capture device an application can see, for confirming ours appeared. */
  listCameras(): string[];
  /**
   * What the camera is called in other applications.
   *
   * Windows takes the name it is given. Linux cannot: the card label belongs to
   * the kernel module and is fixed when it loads, so the backend reports what
   * the device is really called rather than what was asked for.
   */
  publishedName(): string;
}

/**
 * Candidate locations for a native file, covering dev runs and the packaged
 * app. Same reasoning as the preset library: guessing one path wrong shows up
 * as a feature that silently does nothing.
 */
function nativeCandidates(fileName: string): string[] {
  return app.isPackaged
    ? [
        path.join(process.resourcesPath, 'native', fileName),
        path.join(process.resourcesPath, fileName),
      ]
    : [
        path.resolve(__dirname, '../../native/build/Release', fileName),
        path.resolve(process.cwd(), 'native/build/Release', fileName),
        path.join(app.getAppPath(), 'native/build/Release', fileName),
      ];
}

export function findNative(fileName: string): string {
  for (const candidate of nativeCandidates(fileName)) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

const digestCache = new Map<string, string>();

/**
 * Content hash of a file, cached against its size and modification time.
 *
 * Cheap enough to call on every status poll: the DLL is under 200KB, and the
 * cache means it is normally not read at all.
 */
function digestOf(file: string): string {
  try {
    const stat = statSync(file);
    const key = `${path.resolve(file).toLowerCase()}:${stat.size}:${stat.mtimeMs}`;
    const cached = digestCache.get(key);
    if (cached) return cached;

    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    digestCache.set(key, digest);
    return digest;
  } catch {
    return '';
  }
}

/**
 * Are these the same binary?
 *
 * Compared by content rather than by path on purpose. The same build
 * legitimately lives at different paths - a developer run and the packaged copy
 * beside it, say. What actually breaks a camera is a *different* build being
 * registered, because an older DLL cannot read the current channel and the
 * camera opens to black.
 */
export function sameBinary(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()) return true;
  const left = digestOf(a);
  return left !== '' && left === digestOf(b);
}
