import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  ImportResult,
  LibraryEntry,
  LibraryKind,
  DominoApi,
  ReadResult,
  VirtualCameraStatus,
  WriteResult,
} from '@shared/types';
import type { BridgeStatus, StreamAudioFrame } from '@shared/stream';

const api: DominoApi = {
  platform: process.platform,
  /*
   * How this machine can capture what it is playing, decided by the main
   * process at startup. 'pulse-monitor' means the default capture device has
   * been pointed at the desktop's output mix; 'display-loopback' is Chromium's
   * WASAPI loopback via getDisplayMedia; 'none' means neither is available and
   * the renderer should say so rather than capturing a microphone and calling
   * it system audio.
   */
  audioLoopback:
    process.env.DOMINO_AUDIO_LOOPBACK === 'pulse-monitor'
      ? 'pulse-monitor'
      : process.platform === 'linux'
        ? 'none'
        : 'display-loopback',
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  library: {
    list: (kind: LibraryKind): Promise<LibraryEntry[]> => ipcRenderer.invoke('library:list', kind),
    read: (kind: LibraryKind, id: string): Promise<ReadResult> =>
      ipcRenderer.invoke('library:read', kind, id),
    write: (kind: LibraryKind, id: string, content: string): Promise<WriteResult> =>
      ipcRenderer.invoke('library:write', kind, id, content),
    delete: (kind: LibraryKind, id: string): Promise<WriteResult> =>
      ipcRenderer.invoke('library:delete', kind, id),
    rename: (kind: LibraryKind, fromId: string, toId: string): Promise<WriteResult> =>
      ipcRenderer.invoke('library:rename', kind, fromId, toId),
    exists: (kind: LibraryKind, id: string): Promise<boolean> =>
      ipcRenderer.invoke('library:exists', kind, id),
    import: (kind: LibraryKind): Promise<ImportResult> => ipcRenderer.invoke('library:import', kind),
    reveal: (kind: LibraryKind): Promise<void> => ipcRenderer.invoke('library:reveal', kind),
  },

  shadertoy: {
    fetch: (id: string): Promise<{ ok: boolean; shader?: unknown; error?: string }> =>
      ipcRenderer.invoke('shadertoy:fetch', id),
  },

  dialog: {
    openAudioFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:openAudioFile'),
    saveText: (defaultName: string, content: string): Promise<WriteResult> =>
      ipcRenderer.invoke('dialog:saveText', defaultName, content),
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:set', patch),
  },

  virtualCamera: {
    status: (): Promise<VirtualCameraStatus> => ipcRenderer.invoke('vcam:status'),
    start: (
      width: number,
      height: number,
      fps: number,
      name: string,
    ): Promise<VirtualCameraStatus> =>
      ipcRenderer.invoke('vcam:start', width, height, fps, name),
    stop: (): Promise<VirtualCameraStatus> => ipcRenderer.invoke('vcam:stop'),
    register: (unregister = false): Promise<VirtualCameraStatus> =>
      ipcRenderer.invoke('vcam:register', unregister),
    listCameras: (): Promise<string[]> => ipcRenderer.invoke('vcam:listCameras'),
    // `send`, so a frame never makes the render loop wait for the main process.
    sendFrame: (frame: Uint8Array): void => {
      ipcRenderer.send('vcam:frame', frame);
    },
  },

  window: {
    toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:toggleFullscreen'),
    setFullscreen: (v: boolean): Promise<boolean> =>
      ipcRenderer.invoke('window:setFullscreen', v),
    isFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:isFullscreen'),
    setAlwaysOnTop: (v: boolean): Promise<boolean> => ipcRenderer.invoke('window:setAlwaysOnTop', v),
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  },

  stream: {
    bridgeStatus: (): Promise<BridgeStatus> => ipcRenderer.invoke('stream:bridgeStatus'),
    startBridge: (port: number): Promise<BridgeStatus> =>
      ipcRenderer.invoke('stream:startBridge', port),
    stopBridge: (): Promise<BridgeStatus> => ipcRenderer.invoke('stream:stopBridge'),
    // `send`: the render loop never waits on this.
    sendAudio: (frame: StreamAudioFrame): void => {
      ipcRenderer.send('stream:audio', frame);
    },
  },

  splash: {
    // `send`, not `invoke`: startup should never wait on the splash, and there
    // is nothing to hear back.
    stage: (stage: string, fraction?: number): void => {
      ipcRenderer.send('splash:stage', stage, fraction);
    },
    ready: (): void => {
      ipcRenderer.send('app:ready');
    },
  },

  onCommand(cb) {
    const listener = (_e: unknown, command: string, payload?: unknown): void => cb(command, payload);
    ipcRenderer.on('app:command', listener);
    return () => ipcRenderer.off('app:command', listener);
  },
};

contextBridge.exposeInMainWorld('domino', api);
