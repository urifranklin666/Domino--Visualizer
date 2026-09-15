/**
 * Shared types crossing the main <-> renderer boundary.
 * Keep this file dependency-free so both sides can import it.
 */

import type { BridgeStatus, ObsRule, StreamAudioFrame } from './stream';

export type LibraryKind = 'shader' | 'milk' | 'preset';

export interface LibraryEntry {
  /** Stable id: the path relative to the library root, using forward slashes. */
  id: string;
  /** Display name (basename without extension). */
  name: string;
  /** Absolute path on disk. */
  path: string;
  kind: LibraryKind;
  /** Folder path relative to the root, '' for top level. Used for grouping in the UI. */
  group: string;
  /** True when the file lives in the app's bundled resources rather than user data. */
  builtin: boolean;
  sizeBytes: number;
  modifiedMs: number;
}

export interface ReadResult {
  ok: boolean;
  content?: string;
  error?: string;
}

export interface WriteResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface ImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  error?: string;
}

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

/** Persisted user settings. */
export interface AppSettings {
  sensitivity: number;
  smoothing: number;
  fftSize: number;
  gain: number;
  beatSensitivity: number;

  /* Image / display stage */
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  toneMap: boolean;
  vignette: number;

  renderScale: number;
  targetFps: number;
  meshX: number;
  meshY: number;
  autoPlay: boolean;
  autoPlaySeconds: number;
  blendSeconds: number;
  showFps: boolean;
  lastSource: 'loopback' | 'microphone' | 'device' | 'file' | 'none';
  lastVisual: { kind: LibraryKind; id: string } | null;
  /**
   * Free key from https://www.shadertoy.com/howto#q2, needed to import by link.
   * Stored locally in settings.json and only ever sent to shadertoy.com.
   */
  shadertoyApiKey: string;

  /* Camera input */
  cameraEnabled: boolean;
  cameraDeviceId: string;
  cameraMirror: boolean;

  /* Camera output: Domino published as a webcam */
  virtualCameraEnabled: boolean;
  /** "WIDTHxHEIGHT". Fixed for the session - consumers negotiate it once. */
  virtualCameraSize: string;
  virtualCameraFps: number;
  /** What the device is called in other applications. */
  virtualCameraName: string;

  /* OBS: drive scenes, filters and hotkeys from the music over obs-websocket */
  obsEnabled: boolean;
  obsHost: string;
  obsPort: number;
  /** obs-websocket server password. Stored locally, only ever sent to that host. */
  obsPassword: string;
  obsRules: ObsRule[];

  /* Browser source: a local feed any OBS Browser Source can read the audio from */
  bridgeEnabled: boolean;
  bridgePort: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  sensitivity: 1.0,
  smoothing: 0.72,
  fftSize: 2048,
  gain: 1.0,
  beatSensitivity: 1.0,

  // Defaults chosen so a typical preset lands at a comfortable level rather
  // than clipping. See PostProcessor for why tone mapping is on by default.
  brightness: 0.85,
  contrast: 1.0,
  saturation: 1.0,
  gamma: 1.0,
  toneMap: true,
  vignette: 0.12,

  renderScale: 1.0,
  targetFps: 60,
  meshX: 48,
  meshY: 36,
  autoPlay: false,
  autoPlaySeconds: 30,
  blendSeconds: 2.7,
  showFps: true,
  lastSource: 'none',
  lastVisual: null,
  shadertoyApiKey: '',
  cameraEnabled: false,
  cameraDeviceId: '',
  cameraMirror: true,

  virtualCameraEnabled: false,
  virtualCameraSize: '1280x720',
  virtualCameraFps: 30,
  virtualCameraName: 'Domino Visualizer',

  obsEnabled: false,
  obsHost: '127.0.0.1',
  obsPort: 4455,
  obsPassword: '',
  obsRules: [],

  bridgeEnabled: false,
  bridgePort: 4477,
};

/**
 * What the main process knows about the virtual camera.
 *
 * Deliberately platform-neutral. Windows publishes a camera through a Media
 * Foundation source registered machine-wide, Linux through a v4l2loopback
 * device, and the renderer should not have to know which - so the fields below
 * describe the *state* both share and the strings the panel needs come ready
 * written from whichever backend is in use.
 */
export interface VirtualCameraStatus {
  /** The native module compiled and loaded on this machine. */
  available: boolean;
  /**
   * There is somewhere to publish: a registered media source on Windows, a
   * free loopback device on Linux.
   */
  registered: boolean;
  running: boolean;
  width: number;
  height: number;
  fps: number;
  framesWritten: number;
  registeredPath: string;
  /**
   * The setup in place belongs to this copy of Domino.
   *
   * Only Windows can be wrong about this: registration records a path, and a
   * stale one loads an older DLL that opens to a black camera. A Linux
   * loopback device belongs to the running kernel and has no such failure
   * mode, so that backend reports true whenever it is ready.
   */
  registeredIsThisBuild: boolean;
  /** The driver or device the camera comes from; empty when there is none. */
  sourcePath: string;
  /** The native module on disk; empty when it was not packaged. */
  modulePath: string;
  /**
   * Button text for the one-time setup step, or '' when there is nothing the
   * user can usefully press - registering the driver on Windows, loading the
   * kernel module on Linux.
   */
  setupAction: string;
  /** Tooltip saying what that button will actually run. */
  setupHint: string;
  /** Why the camera is not ready yet, phrased for this platform. */
  setupNote: string;
  /**
   * What the camera is actually called in other applications.
   *
   * Not always the name in settings. A Linux loopback device carries the card
   * label the kernel module was loaded with, which Domino cannot change from
   * here, so the setting is advisory on that platform and this is the truth.
   */
  publishedName: string;
  error: string;
}

/** The API surface exposed on `window.domino` by the preload script. */
export interface DominoApi {
  platform: NodeJS.Platform;
  /**
   * How this machine captures what it is playing.
   *
   * 'display-loopback' is Chromium's WASAPI loopback, answered through
   * getDisplayMedia. 'pulse-monitor' is Linux, where the default capture device
   * has been pointed at the desktop output mix instead. 'none' means neither
   * is available here.
   */
  audioLoopback: 'display-loopback' | 'pulse-monitor' | 'none';
  versions: { electron: string; chrome: string; node: string };

  library: {
    list(kind: LibraryKind): Promise<LibraryEntry[]>;
    read(kind: LibraryKind, id: string): Promise<ReadResult>;
    write(kind: LibraryKind, id: string, content: string): Promise<WriteResult>;
    delete(kind: LibraryKind, id: string): Promise<WriteResult>;
    /** Renames within the library. Renaming a builtin forks it into user space. */
    rename(kind: LibraryKind, fromId: string, toId: string): Promise<WriteResult>;
    /** True when the id is already taken by a user or builtin file. */
    exists(kind: LibraryKind, id: string): Promise<boolean>;
    /** Opens a folder picker and copies matching files into the user library. */
    import(kind: LibraryKind): Promise<ImportResult>;
    /** Reveals the user library folder in the OS file manager. */
    reveal(kind: LibraryKind): Promise<void>;
  };

  /** Fetches a shader from shadertoy.com by id, using the stored API key. */
  shadertoy: {
    fetch(id: string): Promise<{ ok: boolean; shader?: unknown; error?: string }>;
  };

  dialog: {
    openAudioFile(): Promise<string | null>;
    saveText(defaultName: string, content: string): Promise<WriteResult>;
  };

  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
  };

  window: {
    toggleFullscreen(): Promise<boolean>;
    setFullscreen(v: boolean): Promise<boolean>;
    isFullscreen(): Promise<boolean>;
    setAlwaysOnTop(v: boolean): Promise<boolean>;
    minimize(): Promise<void>;
    close(): Promise<void>;
  };

  /** Publishes the visualiser as a webcam other applications can select. */
  virtualCamera: {
    status(): Promise<VirtualCameraStatus>;
    start(width: number, height: number, fps: number, name: string): Promise<VirtualCameraStatus>;
    stop(): Promise<VirtualCameraStatus>;
    /**
     * Runs the one-time setup step, prompting for elevated rights: registering
     * the media source on Windows, loading v4l2loopback on Linux.
     */
    register(unregister?: boolean): Promise<VirtualCameraStatus>;
    /** Every capture device the OS can see, for confirming ours appeared. */
    listCameras(): Promise<string[]>;
    /** Fire-and-forget: one NV12 frame, already packed by the GPU. */
    sendFrame(frame: Uint8Array): void;
  };

  /** The browser-source audio feed, served by the main process. */
  stream: {
    bridgeStatus(): Promise<BridgeStatus>;
    startBridge(port: number): Promise<BridgeStatus>;
    stopBridge(): Promise<BridgeStatus>;
    /** Fire-and-forget: one summarised audio frame for whoever is listening. */
    sendAudio(frame: StreamAudioFrame): void;
  };

  /** Progress reporting for the startup splash, which the main process owns. */
  splash: {
    stage(stage: string, fraction?: number): void;
    ready(): void;
  };

  /** Fires when the main process asks the renderer to do something (menu, hotkey). */
  onCommand(cb: (command: string, payload?: unknown) => void): () => void;
}
