import { DEFAULT_SETTINGS, type AppSettings, type LibraryEntry, type LibraryKind } from '@shared/types';
import { AudioEngine } from './audio/AudioEngine';
import { CameraSource } from './video/CameraSource';
import type { AudioFrame } from './audio/types';
import { AudioTexture } from './gl/AudioTexture';
import { Framebuffer } from './gl/Framebuffer';
import { GLContext } from './gl/GLContext';
import { PostProcessor } from './gl/PostProcessor';
import { VirtualCameraOutput } from './video/VirtualCameraOutput';
import type { ShaderError } from './gl/Program';
import { FullscreenQuad } from './gl/Quad';
import { MilkdropEngine } from './milkdrop/MilkdropEngine';
import { parseMilk, serializeMilk } from './milkdrop/MilkParser';
import { clonePreset, createEmptyPreset, type MilkPreset } from './milkdrop/PresetModel';
import {
  buildProject,
  createEmptyPassDoc,
  parseShaderProject,
  passLabel,
  serializeShaderProject,
  PASS_ORDER,
  type ShaderProjectDoc,
} from './shadertoy/ShaderDocument';
import { ShadertoyRuntime, type PassId } from './shadertoy/ShadertoyRuntime';
import {
  convertShadertoy,
  parseShadertoyId,
  withAttribution,
  type ShadertoyShader,
} from './shadertoy/ShadertoyImport';
import { ShaderPassBar } from './ui/ShaderPassBar';
import { DisplayPanel } from './ui/DisplayPanel';
import { StreamPanel } from './ui/StreamPanel';
import { ObsClient } from './obs/ObsClient';
import { ObsDirector } from './obs/ObsDirector';
import { summarizeFrame, type BridgeStatus, type ObsRule } from '@shared/stream';
import { CodeEditor, type EditorDocument } from './ui/Editor';
import { FpsCounter, Toast, el, on } from './ui/dom';
import { LibraryPanel, LibraryTabs } from './ui/LibraryPanel';
import {
  confirmAction,
  promptText,
  showContextMenu,
  validateLibraryName,
} from './ui/Modal';
import { ParamPanel } from './ui/ParamPanel';
import './styles/main.css';

type Mode = 'shader' | 'milk';

/** Editor document ids for a MilkDrop preset. */
const MILK_DOCS = {
  warp: 'milk:warp',
  comp: 'milk:comp',
  perFrame: 'milk:per_frame',
  perPixel: 'milk:per_pixel',
  init: 'milk:per_frame_init',
} as const;

/** Editor document ids for a shader: one per pass, plus the Common tab. */
const SHADER_COMMON_DOC = 'shader:common';
const shaderPassDocId = (id: PassId): string => `shader:pass:${id}`;
const passIdFromDoc = (docId: string): PassId | 'common' | null => {
  if (docId === SHADER_COMMON_DOC) return 'common';
  const match = /^shader:pass:(Image|A|B|C|D)$/.exec(docId);
  return match ? (match[1] as PassId) : null;
};

class Domino {
  private canvas = el<HTMLCanvasElement>('canvas');
  private glctx: GLContext;
  private quad: FullscreenQuad;
  private audio = new AudioEngine();
  private camera!: CameraSource;
  private audioTexture: AudioTexture;
  private shadertoy: ShadertoyRuntime;
  private milkdrop: MilkdropEngine;
  private post: PostProcessor;
  /** Built the first time the virtual camera is switched on, not before. */
  private vcamOut: VirtualCameraOutput | null = null;
  private vcamRunning = false;
  /**
   * Engines render here rather than straight to the screen, so the post stage
   * has float headroom to tone-map from. Without an HDR intermediate every
   * value above 1.0 would already be clipped before we could roll it off.
   */
  private sceneTarget: Framebuffer;

  private library = new LibraryPanel(el('library'), el<HTMLInputElement>('library-search'));
  private tabs: LibraryTabs;
  private params = new ParamPanel(el('inspector-body'));
  private display!: DisplayPanel;
  private stream!: StreamPanel;
  private obs = new ObsClient();
  private director = new ObsDirector(this.obs);
  /** Pages on the browser-source feed; frames are only summarised while there are some. */
  private bridgeClients = 0;
  private lastBridgeSendMs = 0;
  private editor = new CodeEditor(el('editor-host'), el('editor-tabs'));
  private toast = new Toast(el('toast'));
  private fps = new FpsCounter();

  private mode: Mode = 'milk';
  private settings!: AppSettings;

  /** The working copy the editor and parameter panel mutate. */
  private currentPreset: MilkPreset | null = null;
  /** Editable pass model for the loaded shader. */
  private shaderDoc: ShaderProjectDoc | null = null;
  /** Lines the Common tab contributes, for mapping compile errors back. */
  private commonLineCount = 0;
  private passBar!: ShaderPassBar;
  private currentEntry: LibraryEntry | null = null;
  private entriesByKind = new Map<LibraryKind, LibraryEntry[]>();

  private mouse = { x: 0, y: 0, clickX: 0, clickY: 0, down: false };
  private startTime = performance.now() / 1000;
  private frameIndex = 0;
  private lastAutoSwitch = 0;
  private chromeHidden = false;
  private immersive = false;
  private running = true;
  private cursorTimer: number | null = null;
  private flashTimer: number | null = null;

  constructor() {
    this.glctx = new GLContext(this.canvas);
    this.quad = new FullscreenQuad(this.glctx.gl);
    this.audioTexture = new AudioTexture(this.glctx.gl);
    this.camera = new CameraSource(this.glctx.gl);
    this.shadertoy = new ShadertoyRuntime(this.glctx);
    this.milkdrop = new MilkdropEngine(this.glctx, this.quad);
    this.post = new PostProcessor(this.glctx, this.quad);
    this.sceneTarget = new Framebuffer(this.glctx, {
      width: Math.max(this.glctx.width, 1),
      height: Math.max(this.glctx.height, 1),
      hdr: true,
      filter: 'linear',
    });

    this.tabs = new LibraryTabs(document.querySelector('.tabs')!, {
      onChange: (kind) => void this.switchLibrary(kind),
    });

    this.passBar = new ShaderPassBar(el('editor-channels'), {
      onChannelChange: (passId, index, source) => {
        const pass = this.shaderDoc?.passes.find((p) => p.id === passId);
        if (!pass) return;
        pass.channels[index] = source;
        // Channel bindings are structural, so recompile immediately rather
        // than waiting for Apply - there is no half-typed state to protect.
        this.applyEdits();
        this.refreshPassBar();
      },
      onAddPass: (id) => this.addShaderPass(id),
      onRemovePass: (id) => this.removeShaderPass(id),
      onToggleCommon: (enabled) => this.toggleCommonTab(enabled),
    });
  }

  async start(): Promise<void> {
    const stage = window.domino.splash.stage;
    stage('reading settings', 0.15);
    this.settings = await window.domino.settings.get();
    this.display = new DisplayPanel(el('display-body'), this.settings);
    this.stream = new StreamPanel(el('stream-body'), this.settings);
    this.applySettingsToUi();

    stage('building the interface', 0.3);
    this.wireLibrary();
    this.wireInspector();
    this.wireStream();
    this.wireTransport();
    this.wireEditor();
    this.wireStage();
    this.wireHotkeys();

    stage('scanning the preset library', 0.5);
    await this.refreshLibrary('milk');
    await this.refreshLibrary('shader');
    await this.switchLibrary('milk');

    stage('compiling shaders', 0.75);

    // Restore whatever was on screen last session, or fall back to something.
    const last = this.settings.lastVisual;
    const restored = last ? this.findEntry(last.kind, last.id) : null;
    if (restored) {
      // Go through switchLibrary rather than setting entries directly, so the
      // tab, list and search placeholder all end up consistent.
      await this.switchLibrary(restored.kind);
      await this.load(restored, false);
    } else {
      await this.loadFirstAvailable();
    }

    this.glctx.onContextLost(() => {
      this.running = false;
      this.toast.show('Graphics context lost. Reopen the window to recover.', 'error');
    });

    // The window can leave fullscreen without us asking (OS chrome, window
    // manager shortcut), so follow it rather than stranding hidden controls.
    window.domino.onCommand((command, payload) => {
      if (command === 'fullscreen-changed' && payload === false && this.immersive) {
        this.setImmersive(false);
      }
      if (command === 'bridge-status' && payload && typeof payload === 'object') {
        this.onBridgeStatus(payload as BridgeStatus);
      }
    });

    // Restore the camera if it was on last session.
    if (this.settings.cameraEnabled) void this.syncCamera();

    stage('ready', 0.95);
    requestAnimationFrame(this.frame);

    /*
     * Tell the main process only once something has actually been drawn. The
     * splash is there to cover the gap before the first frame, so handing over
     * any earlier would show an empty window for exactly the period it exists
     * to hide.
     */
    requestAnimationFrame(() => requestAnimationFrame(() => window.domino.splash.ready()));
  }

  /* ------------------------------ library ------------------------------ */

  private async refreshLibrary(kind: LibraryKind): Promise<void> {
    const entries = await window.domino.library.list(kind);
    this.entriesByKind.set(kind, entries);
  }

  private findEntry(kind: LibraryKind, id: string): LibraryEntry | null {
    return this.entriesByKind.get(kind)?.find((entry) => entry.id === id) ?? null;
  }

  private async switchLibrary(kind: LibraryKind): Promise<void> {
    this.tabs.select(kind);
    const search = el<HTMLInputElement>('library-search');
    search.placeholder = kind === 'milk' ? 'Search presets…' : 'Search shaders…';
    this.library.setEntries(this.entriesByKind.get(kind) ?? []);
    if (this.currentEntry?.kind === kind) this.library.setActive(this.currentEntry.id);
  }

  private async loadFirstAvailable(): Promise<void> {
    for (const kind of ['milk', 'shader'] as LibraryKind[]) {
      const entries = this.entriesByKind.get(kind) ?? [];
      if (entries.length > 0) {
        await this.switchLibrary(kind);
        await this.load(entries[0], false);
        return;
      }
    }
    this.toast.show('No presets found. Use Import to add some.', 'error');
  }

  private wireLibrary(): void {
    this.library.onSelect = (entry) => void this.load(entry, true);

    this.library.onContextMenu = (entry, x, y) => {
      showContextMenu(x, y, [
        { label: 'Load', action: () => void this.load(entry, true) },
        {
          label: entry.builtin ? 'Save a copy as…' : 'Rename…',
          action: () => void this.renameEntry(entry),
        },
        { label: 'Duplicate…', action: () => void this.duplicateEntry(entry) },
        {
          label: entry.builtin ? 'Delete (bundled)' : 'Delete…',
          action: () => void this.deleteEntry(entry),
          danger: !entry.builtin,
          disabled: entry.builtin,
        },
      ]);
    };

    on(el('btn-import'), 'click', (event) => {
      // Shaders can come from a file or straight off shadertoy.com, so offer
      // both rather than making the link path a hidden feature.
      if (this.tabs.kind === 'shader') {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        showContextMenu(rect.left, rect.top - 78, [
          { label: 'From Shadertoy link…', action: () => void this.importFromShadertoy() },
          { label: 'From files…', action: () => void this.importFiles('shader') },
        ]);
        return;
      }
      void this.importFiles(this.tabs.kind);
    });

    on(el('btn-reveal'), 'click', () => void window.domino.library.reveal(this.tabs.kind));

    on(el('btn-new'), 'click', () => {
      if (this.tabs.kind === 'milk') {
        this.currentPreset = createEmptyPreset('New Preset');
        this.currentEntry = null;
        this.mode = 'milk';
        this.applyMilkPreset(this.currentPreset, false);
      } else {
        this.currentEntry = null;
        this.mode = 'shader';
        this.loadShaderSource(STARTER_SHADER, 'New Shader');
      }
      this.openEditor();
    });
  }

  /* ----------------------------- inspector ------------------------------ */

  private wireInspector(): void {
    const tabs = [...el('inspector-tabs').querySelectorAll<HTMLButtonElement>('.itab')];
    const bodies: Record<string, HTMLElement> = {
      preset: el('inspector-body'),
      display: el('display-body'),
      stream: el('stream-body'),
    };

    for (const tab of tabs) {
      on(tab, 'click', () => {
        const panel = tab.dataset.panel ?? 'preset';
        for (const other of tabs) other.classList.toggle('is-active', other === tab);
        for (const [name, node] of Object.entries(bodies)) node.hidden = name !== panel;
        // Reset means different things per tab, so relabel it - and the
        // stream tab has nothing it would sensibly reset.
        el('btn-reset-params').textContent = panel === 'display' ? 'Defaults' : 'Reset';
        el('btn-reset-params').hidden = panel === 'stream';
      });
    }

    this.display.render();
    this.display.onChange = (patch) => this.applyDisplayPatch(patch);
    this.display.onReset = () => this.resetDisplaySettings();
    this.display.onVirtualCamera = (on) => void this.setVirtualCamera(on);
    this.display.onVirtualCameraRegister = (off) => {
      void window.domino.virtualCamera.register(off).then((status) => {
        this.display.virtualCameraStatus = status;
        this.display.render();
      });
    };
    void this.refreshVirtualCameraStatus();
  }

  /* ------------------------------- stream ------------------------------- */

  /**
   * The Stream tab: OBS over obs-websocket, and the browser-source feed.
   *
   * Both are restored from settings at startup, so a machine set up once
   * comes back the same way next launch - OBS may not be open yet, and the
   * client keeps retrying until it is.
   */
  private wireStream(): void {
    const panel = this.stream;
    panel.render();

    this.obs.onStatus((status) => {
      const wasConnected = panel.obsStatus.state === 'connected';
      panel.obsStatus = status;
      panel.refreshStatus();
      // Fresh connection: fetch the names the rule fields offer.
      if (status.state === 'connected' && !wasConnected) void this.refreshObsCatalog();
    });

    panel.onChange = (patch) => {
      Object.assign(this.settings, patch);
      void window.domino.settings.set(patch);
      // Connection details changed under a live connection: reconnect with them.
      if (
        this.settings.obsEnabled &&
        (patch.obsHost !== undefined || patch.obsPort !== undefined || patch.obsPassword !== undefined)
      ) {
        this.setObsEnabled(true);
      }
      if (patch.bridgePort !== undefined && this.settings.bridgeEnabled) {
        void this.setBridgeEnabled(true);
      }
      panel.refreshStatus();
    };
    panel.onRulesChange = (rules) => this.applyRules(rules);
    panel.onObsEnabled = (on) => this.setObsEnabled(on);
    panel.onBridgeEnabled = (on) => void this.setBridgeEnabled(on);
    panel.onRefreshCatalog = () => void this.refreshObsCatalog();
    panel.onLookup = (kind, name) => void this.lookupObs(kind, name);
    panel.onCopyUrl = (url) => {
      void navigator.clipboard.writeText(url).then(
        () => this.toast.show(`Copied ${url}`),
        () => this.toast.show(url),
      );
    };

    this.director.setRules(this.settings.obsRules);
    if (this.settings.obsEnabled) this.setObsEnabled(true);
    if (this.settings.bridgeEnabled) void this.setBridgeEnabled(true);
  }

  private applyRules(rules: ObsRule[]): void {
    this.settings.obsRules = rules;
    this.director.setRules(rules);
    void window.domino.settings.set({ obsRules: rules });
  }

  private setObsEnabled(on: boolean): void {
    this.settings.obsEnabled = on;
    void window.domino.settings.set({ obsEnabled: on });
    if (on) {
      this.obs.connect(
        this.settings.obsHost || '127.0.0.1',
        Number(this.settings.obsPort) || 4455,
        this.settings.obsPassword,
      );
    } else {
      this.obs.disconnect();
    }
  }

  /** Everything the rule fields can offer, in one go. Best effort throughout. */
  private async refreshObsCatalog(): Promise<void> {
    const panel = this.stream;
    if (!this.obs.connected) return;
    try {
      const [scenes, inputs, hotkeys] = await Promise.all([
        this.obs.listScenes(),
        this.obs.listInputs(),
        this.obs.listHotkeys(),
      ]);
      panel.catalog.scenes = scenes;
      // Scenes carry filters too, so they belong in the source list as well.
      panel.catalog.inputs = [...inputs, ...scenes];
      panel.catalog.hotkeys = hotkeys;
      panel.catalog.filters.clear();
      panel.catalog.items.clear();
      this.director.setScenes(scenes);

      // Detail for whatever the rules already point at.
      const sources = new Set<string>();
      const sceneNames = new Set<string>();
      for (const rule of this.settings.obsRules) {
        if (rule.action === 'item-pulse' && rule.scene) sceneNames.add(rule.scene);
        else if (rule.source) sources.add(rule.source);
      }
      await Promise.all([
        ...[...sources].map((s) => this.lookupObs('filters', s, false)),
        ...[...sceneNames].map((s) => this.lookupObs('items', s, false)),
      ]);
      panel.renderRules();
    } catch (err) {
      this.toast.show(`OBS: ${(err as Error).message}`, 'error');
    }
  }

  private async lookupObs(kind: 'filters' | 'items', name: string, render = true): Promise<void> {
    const panel = this.stream;
    if (!this.obs.connected || !name) return;
    try {
      if (kind === 'filters') {
        panel.catalog.filters.set(name, await this.obs.listFilters(name));
      } else {
        panel.catalog.items.set(name, (await this.obs.listSceneItems(name)).map((i) => i.source));
      }
      if (render) panel.renderRules();
    } catch {
      /* a name OBS does not know; the field keeps what was typed */
    }
  }

  private async setBridgeEnabled(on: boolean): Promise<void> {
    this.settings.bridgeEnabled = on;
    void window.domino.settings.set({ bridgeEnabled: on });
    // A port change arrives as "enable" again, so always stop first.
    await window.domino.stream.stopBridge();
    const status = on
      ? await window.domino.stream.startBridge(Number(this.settings.bridgePort) || 4477)
      : await window.domino.stream.bridgeStatus();
    this.onBridgeStatus(status);
  }

  private onBridgeStatus(status: BridgeStatus): void {
    this.bridgeClients = status.running ? status.clients : 0;
    this.stream.bridgeStatus = status;
    this.stream.refreshStatus();
  }

  /**
   * Feed this frame's analysis to OBS and to the browser-source pages.
   *
   * Cheap when nothing is listening: the director returns at once without a
   * connection, and the summary is only built while a page is connected.
   */
  private driveStream(audio: AudioFrame, nowMs: number): void {
    this.director.tick(audio, nowMs);
    if (this.bridgeClients > 0 && nowMs - this.lastBridgeSendMs >= 33) {
      this.lastBridgeSendMs = nowMs;
      window.domino.stream.sendAudio(summarizeFrame(audio));
    }
  }

  /**
   * Turn the webcam output on or off.
   *
   * The GPU side is built on first use rather than at startup: it holds two
   * render targets and a set of readback buffers, and most sessions never
   * publish a camera at all.
   */
  private async setVirtualCamera(on: boolean): Promise<void> {
    this.settings.virtualCameraEnabled = on;
    void window.domino.settings.set({ virtualCameraEnabled: on });

    if (!on) {
      this.vcamRunning = false;
      await window.domino.virtualCamera.stop();
      await this.refreshVirtualCameraStatus();
      return;
    }

    const [width, height] = this.virtualCameraSize();
    const fps = Number(this.settings.virtualCameraFps) || 30;

    if (!this.vcamOut) {
      this.vcamOut = new VirtualCameraOutput(this.glctx, this.quad, width, height, fps);
    } else {
      this.vcamOut.setFormat(width, height, fps);
    }

    const status = await window.domino.virtualCamera.start(
      width,
      height,
      fps,
      this.settings.virtualCameraName || 'Domino Visualizer',
    );
    // Only start pushing frames if the device actually came up; otherwise we
    // would be filling shared memory nothing is reading.
    this.vcamRunning = status.running;
    this.display.virtualCameraStatus = status;
    this.display.render();
  }

  /** Parse the "WIDTHxHEIGHT" setting, falling back to 720p if it is junk. */
  private virtualCameraSize(): [number, number] {
    const match = /^(\d+)x(\d+)$/.exec(String(this.settings.virtualCameraSize ?? ''));
    if (!match) return [1280, 720];
    return [Number(match[1]), Number(match[2])];
  }

  private async refreshVirtualCameraStatus(): Promise<void> {
    this.display.virtualCameraStatus = await window.domino.virtualCamera.status();
    this.display.render();
  }

  /**
   * Apply a display-settings change immediately and persist it.
   * These are user-level, not preset-level, so they never touch the preset.
   */
  private applyDisplayPatch(patch: Partial<AppSettings>): void {
    Object.assign(this.settings, patch);

    this.post.setSettings({
      brightness: this.settings.brightness,
      contrast: this.settings.contrast,
      saturation: this.settings.saturation,
      gamma: this.settings.gamma,
      toneMap: this.settings.toneMap,
      vignette: this.settings.vignette,
    });

    if (patch.meshX !== undefined || patch.meshY !== undefined) {
      this.milkdrop.setMeshSize(this.settings.meshX, this.settings.meshY);
    }
    if (patch.blendSeconds !== undefined) {
      this.milkdrop.options.blendSeconds = this.settings.blendSeconds;
    }
    if (patch.showFps !== undefined) {
      el('hud').style.display = this.settings.showFps ? '' : 'none';
    }
    if (patch.cameraEnabled !== undefined || patch.cameraDeviceId !== undefined) {
      void this.syncCamera();
    }
    if (patch.virtualCameraSize !== undefined || patch.virtualCameraFps !== undefined) {
      // The media type is negotiated once when the device is opened, so a size
      // change has to republish the camera rather than quietly send frames of
      // the wrong shape - which the media source would drop.
      if (this.settings.virtualCameraEnabled) void this.setVirtualCamera(true);
    }

    void window.domino.settings.set(patch);
  }

  /**
   * Bring the camera in line with the settings.
   *
   * Device changes restart the stream, so this both starts and stops rather
   * than having separate paths that could disagree about the current state.
   */
  private async syncCamera(): Promise<void> {
    const want = this.settings.cameraEnabled;

    if (!want) {
      this.camera.stop();
      return;
    }

    try {
      await this.camera.start(this.settings.cameraDeviceId || undefined);
      const status = this.camera.getStatus();
      this.toast.show(`Camera on: ${status.label} (${status.width}x${status.height})`);

      // Labels are blank until permission has been granted, so the device list
      // is only worth populating after a successful start.
      this.display.cameraDevices = (await this.camera.listDevices()).map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
      }));
      this.display.render();
    } catch (err) {
      this.settings.cameraEnabled = false;
      void window.domino.settings.set({ cameraEnabled: false });
      this.display.setSettings(this.settings);
      this.display.render();
      this.toast.show(`Camera failed: ${(err as Error).message}`, 'error');
    }
  }

  private async resetDisplaySettings(): Promise<void> {
    const defaults: Partial<AppSettings> = {
      brightness: DEFAULT_SETTINGS.brightness,
      contrast: DEFAULT_SETTINGS.contrast,
      saturation: DEFAULT_SETTINGS.saturation,
      gamma: DEFAULT_SETTINGS.gamma,
      toneMap: DEFAULT_SETTINGS.toneMap,
      vignette: DEFAULT_SETTINGS.vignette,
      renderScale: DEFAULT_SETTINGS.renderScale,
      meshX: DEFAULT_SETTINGS.meshX,
      meshY: DEFAULT_SETTINGS.meshY,
      blendSeconds: DEFAULT_SETTINGS.blendSeconds,
      autoPlaySeconds: DEFAULT_SETTINGS.autoPlaySeconds,
      showFps: DEFAULT_SETTINGS.showFps,
    };
    this.applyDisplayPatch(defaults);
    this.display.setSettings(this.settings);
    this.toast.show('Display settings restored to defaults.');
  }

  /** Copy files into the library with the OS picker. */
  private async importFiles(kind: LibraryKind): Promise<void> {
    const result = await window.domino.library.import(kind);
    if (!result.ok) {
      this.toast.show(`Import failed: ${result.error}`, 'error');
      return;
    }
    await this.refreshLibrary(kind);
    await this.switchLibrary(kind);
    this.toast.show(
      result.imported === 0
        ? 'Nothing imported.'
        : `Imported ${result.imported} file${result.imported === 1 ? '' : 's'}.`,
    );
  }

  /* --------------------------- Shadertoy import -------------------------- */

  /**
   * Paste a shadertoy.com link and get the shader, with its passes, Common tab
   * and channel bindings all wired up.
   *
   * Shadertoy's API needs a free key, so the first import asks for one. That is
   * a one-off; it is stored in settings and reused after that.
   */
  private async importFromShadertoy(): Promise<void> {
    if (!(await this.ensureShadertoyKey())) return;

    const link = await promptText({
      title: 'Import from Shadertoy',
      label: 'Shader link or ID',
      placeholder: 'https://www.shadertoy.com/view/XsXXDn',
      confirmLabel: 'Import',
      validate: (value) =>
        parseShadertoyId(value) ? null : 'That does not look like a Shadertoy link or ID.',
    });
    if (link === null) return;

    const id = parseShadertoyId(link);
    if (!id) return;

    this.toast.show('Fetching from Shadertoy…');
    const response = await window.domino.shadertoy.fetch(id);

    if (!response.ok || !response.shader) {
      this.toast.show(response.error ?? 'Could not fetch that shader.', 'error');
      // A rejected key is worth offering to fix immediately rather than making
      // the user hunt through settings for it.
      if (/api key/i.test(response.error ?? '')) {
        if (await this.promptShadertoyKey(true)) void this.importFromShadertoy();
      }
      return;
    }

    const converted = convertShadertoy(response.shader as ShadertoyShader);
    if (converted.doc.passes.length === 0) {
      this.toast.show('That shader had no passes Domino can render.', 'error');
      return;
    }

    this.shaderDoc = withAttribution(converted);
    this.currentEntry = null;
    this.mode = 'shader';
    this.compileShaderDoc(converted.name, [...converted.warnings, ...converted.skipped]);
    this.flashPreset();
    this.openEditor();

    const notes = converted.warnings.length + converted.skipped.length;
    this.toast.show(
      notes === 0
        ? `Imported "${converted.name}" by ${converted.info.username ?? 'unknown'}.`
        : `Imported "${converted.name}" with ${notes} note${notes === 1 ? '' : 's'} - see the editor.`,
      notes === 0 ? 'info' : 'error',
    );
  }

  /** Returns true when a key is available (already stored, or just entered). */
  private async ensureShadertoyKey(): Promise<boolean> {
    if (this.settings.shadertoyApiKey.trim()) return true;
    return await this.promptShadertoyKey(false);
  }

  private async promptShadertoyKey(replacing: boolean): Promise<boolean> {
    const key = await promptText({
      title: replacing ? 'Shadertoy API key rejected' : 'Shadertoy API key needed',
      label: 'API key',
      value: replacing ? '' : this.settings.shadertoyApiKey,
      placeholder: 'paste your key here',
      confirmLabel: 'Save key',
      validate: (value) =>
        value.trim().length >= 6 ? null : 'Paste the key from shadertoy.com/howto#q2.',
    });
    if (key === null) {
      this.toast.show(
        'Importing by link needs a free Shadertoy API key. Get one at shadertoy.com/howto#q2 ' +
          '(App Settings on your Shadertoy profile), then try again.',
        'error',
      );
      return false;
    }
    this.settings.shadertoyApiKey = key.trim();
    await window.domino.settings.set({ shadertoyApiKey: key.trim() });
    return true;
  }

  /* ------------------------------ loading ------------------------------- */

  private async load(entry: LibraryEntry, blend: boolean): Promise<void> {
    const result = await window.domino.library.read(entry.kind, entry.id);
    if (!result.ok || result.content === undefined) {
      this.toast.show(`Could not read ${entry.name}: ${result.error}`, 'error');
      return;
    }

    this.currentEntry = entry;
    this.library.setActive(entry.id);

    if (entry.kind === 'milk') {
      const preset = parseMilk(result.content, entry.name);
      this.currentPreset = preset;
      this.mode = 'milk';
      this.applyMilkPreset(preset, blend);
    } else {
      this.mode = 'shader';
      this.loadShaderSource(result.content, entry.name);
    }

    this.lastAutoSwitch = this.now();
    this.flashPreset();
    void window.domino.settings.set({ lastVisual: { kind: entry.kind, id: entry.id } });
  }

  private applyMilkPreset(preset: MilkPreset, blend: boolean): void {
    const result = this.milkdrop.loadPreset(preset, this.now(), blend);
    el('hud-title').textContent = preset.name;
    this.params.setPreset(preset, result);
    this.shaderDoc = null;
    this.passBar.hide();
    this.syncEditorDocuments();

    const problems = [...result.shaderErrors, ...result.equationErrors];
    if (problems.length > 0) {
      this.setEditorStatus(problems[0], 'error');
      this.showEditorErrors(problems);
    } else {
      this.setEditorStatus('Preset loaded', 'ok');
      this.showEditorErrors([]);
    }
  }

  /** Load a shader source file into the editable pass model, then compile. */
  private loadShaderSource(source: string, name: string): void {
    const parsed = parseShaderProject(source);
    this.shaderDoc = parsed.doc;
    this.compileShaderDoc(name, parsed.warnings);
  }

  /**
   * Compile the current pass model.
   *
   * Errors are routed to the tab they belong to. Because the Common tab is
   * prepended to every pass, a line at or below `commonLineCount` came from
   * Common, and anything above it needs that offset subtracted to land on the
   * right line of the pass's own code.
   */
  private compileShaderDoc(name: string, extraWarnings: string[] = []): void {
    const doc = this.shaderDoc;
    if (!doc) return;

    const built = buildProject(doc, name);
    this.commonLineCount = built.commonLineCount;
    const diagnostics = this.shadertoy.compile(built.project);

    el('hud-title').textContent = name;
    this.params.showMessage(
      'Parameters are available for MilkDrop presets.\n\nFor shaders, edit the code directly (Edit, or press E).',
    );
    this.syncEditorDocuments();

    // Start from a clean slate so markers from the previous compile clear.
    this.editor.clearErrors(SHADER_COMMON_DOC);
    for (const pass of doc.passes) {
      this.editor.clearErrors(shaderPassDocId(pass.id));
      this.editor.markTabError(shaderPassDocId(pass.id), false);
    }
    this.editor.markTabError(SHADER_COMMON_DOC, false);

    if (diagnostics.ok) {
      this.shadertoy.reset();
      const passCount = doc.passes.length;
      this.setEditorStatus(
        passCount > 1 ? `Compiled - ${passCount} passes` : 'Compiled',
        'ok',
      );
      this.showEditorErrors([...extraWarnings]);
      this.refreshPassBar();
      return;
    }

    const summary: string[] = [];
    const commonErrors: ShaderError[] = [];
    const perPass = new Map<PassId, ShaderError[]>();

    for (const [passId, errors] of diagnostics.errorsByPass) {
      for (const error of errors) {
        if (this.commonLineCount > 0 && error.line <= this.commonLineCount) {
          commonErrors.push(error);
          summary.push(`Common - line ${error.line}: ${error.message}`);
        } else {
          const line = Math.max(1, error.line - this.commonLineCount);
          const list = perPass.get(passId as PassId) ?? [];
          list.push({ ...error, line });
          perPass.set(passId as PassId, list);
          summary.push(`${passLabel(passId as PassId)} - line ${line}: ${error.message}`);
        }
      }
    }

    if (commonErrors.length > 0) {
      this.editor.setErrors(SHADER_COMMON_DOC, commonErrors);
      this.editor.markTabError(SHADER_COMMON_DOC, true);
    }
    for (const [passId, errors] of perPass) {
      this.editor.setErrors(shaderPassDocId(passId), errors);
      this.editor.markTabError(shaderPassDocId(passId), true);
    }

    this.setEditorStatus(summary[0] ?? 'Compile failed', 'error');
    this.showEditorErrors([...summary, ...extraWarnings]);
    this.toast.show(`Shader error - ${summary[0] ?? diagnostics.message}`, 'error');
    this.refreshPassBar();
  }

  private refreshPassBar(): void {
    if (this.mode !== 'shader' || !this.shaderDoc) {
      this.passBar.hide();
      return;
    }
    const active = passIdFromDoc(this.editor.activeDocumentId ?? '');
    this.passBar.render(this.shaderDoc, active);
  }

  /* -------------------------- pass management --------------------------- */

  private addShaderPass(id: PassId): void {
    if (!this.shaderDoc || this.shaderDoc.passes.some((p) => p.id === id)) return;

    this.shaderDoc.passes.push(
      createEmptyPassDoc(id, STARTER_BUFFER_PASS.replace(/__ID__/g, String(id))),
    );
    this.shaderDoc.passes.sort(
      (a, b) => PASS_ORDER.indexOf(a.id) - PASS_ORDER.indexOf(b.id),
    );

    this.applyEdits();
    this.editor.activate(shaderPassDocId(id));
    this.refreshPassBar();
    this.toast.show(`Added ${passLabel(id)}. It reads its own previous frame by default.`);
  }

  private removeShaderPass(id: PassId): void {
    if (!this.shaderDoc || id === 'Image') return;
    this.shaderDoc.passes = this.shaderDoc.passes.filter((p) => p.id !== id);

    // Anything still pointing at the removed buffer would sample a texture
    // that no longer exists, so clear those bindings rather than leave them.
    for (const pass of this.shaderDoc.passes) {
      pass.channels = pass.channels.map((channel) =>
        channel.type === 'buffer' && channel.buffer === id ? { type: 'none' as const } : channel,
      );
    }

    this.applyEdits();
    this.editor.activate(shaderPassDocId('Image'));
    this.refreshPassBar();
    this.toast.show(`Removed ${passLabel(id)}.`);
  }

  private toggleCommonTab(enabled: boolean): void {
    if (!this.shaderDoc) return;
    if (enabled) {
      if (!this.shaderDoc.common.trim()) this.shaderDoc.common = STARTER_COMMON;
      this.applyEdits();
      this.editor.activate(SHADER_COMMON_DOC);
    } else {
      this.shaderDoc.common = '';
      this.applyEdits();
      this.editor.activate(shaderPassDocId(this.shaderDoc.passes[0]?.id ?? 'Image'));
    }
    this.refreshPassBar();
  }

  /* ------------------------------- editor ------------------------------- */

  private syncEditorDocuments(): void {
    const documents: EditorDocument[] = [];

    if (this.mode === 'shader' && this.shaderDoc) {
      // Mirror Shadertoy's tab order: Common first, then buffers, then Image.
      if (this.shaderDoc.common.trim()) {
        documents.push({
          id: SHADER_COMMON_DOC,
          label: 'Common',
          language: 'glsl',
          value: this.shaderDoc.common,
        });
      }
      for (const pass of this.shaderDoc.passes) {
        documents.push({
          id: shaderPassDocId(pass.id),
          label: passLabel(pass.id),
          language: 'glsl',
          value: pass.source,
        });
      }
    } else if (this.currentPreset) {
      const preset = this.currentPreset;
      documents.push(
        { id: MILK_DOCS.perFrame, label: 'per_frame', language: 'eel', value: preset.perFrame },
        { id: MILK_DOCS.perPixel, label: 'per_pixel', language: 'eel', value: preset.perPixel },
        { id: MILK_DOCS.init, label: 'per_frame_init', language: 'eel', value: preset.perFrameInit },
        { id: MILK_DOCS.warp, label: 'warp shader', language: 'glsl', value: preset.warpShader },
        { id: MILK_DOCS.comp, label: 'comp shader', language: 'glsl', value: preset.compShader },
      );
    }

    this.editor.setDocuments(documents, this.editor.activeDocumentId ?? documents[0]?.id);
  }

  private wireEditor(): void {
    this.editor.onApply = () => this.applyEdits();
    this.editor.onSave = () => void this.save();
    this.editor.onSaveAs = () => void this.saveAs();
    this.editor.onActivate = () => this.refreshPassBar();

    this.editor.onChange = (id, value) => {
      // Keep the in-memory model current so Save writes what is on screen even
      // if the user never hits Apply.
      const passId = passIdFromDoc(id);
      if (passId !== null && this.shaderDoc) {
        if (passId === 'common') {
          this.shaderDoc.common = value;
        } else {
          const pass = this.shaderDoc.passes.find((p) => p.id === passId);
          if (pass) pass.source = value;
        }
      } else if (this.currentPreset) {
        const preset = this.currentPreset;
        if (id === MILK_DOCS.perFrame) preset.perFrame = value;
        else if (id === MILK_DOCS.perPixel) preset.perPixel = value;
        else if (id === MILK_DOCS.init) preset.perFrameInit = value;
        else if (id === MILK_DOCS.warp) preset.warpShader = value;
        else if (id === MILK_DOCS.comp) preset.compShader = value;
      }
      this.setEditorStatus('Modified - Ctrl+Enter to apply', 'idle');
    };

    on(el('btn-apply'), 'click', () => this.applyEdits());
    on(el('btn-save'), 'click', () => void this.save());
    on(el('btn-save-as'), 'click', () => void this.saveAs());
    on(el('btn-close-editor'), 'click', () => this.closeEditor());
    on(el('btn-edit'), 'click', () => this.toggleEditor());

    this.params.onChange = () => {
      // Reloading is the honest way to apply a parameter change: base values
      // feed per_frame_init and the equation scope, so they only take effect on
      // a fresh runtime. Blending is off here so dragging a slider is immediate.
      if (this.currentPreset) {
        this.milkdrop.loadPreset(this.currentPreset, this.now(), false);
      }
    };

    on(el('btn-reset-params'), 'click', () => {
      if (!this.currentEntry || this.mode !== 'milk') return;
      void this.load(this.currentEntry, false);
      this.toast.show('Parameters reset to the saved preset.');
    });
  }

  private applyEdits(): void {
    if (this.mode === 'shader') {
      if (!this.shaderDoc) return;
      // Pull the latest text out of every open tab before compiling.
      if (this.shaderDoc.common.trim()) {
        this.shaderDoc.common = this.editor.getValue(SHADER_COMMON_DOC) || this.shaderDoc.common;
      }
      for (const pass of this.shaderDoc.passes) {
        const value = this.editor.getValue(shaderPassDocId(pass.id));
        if (value) pass.source = value;
      }
      this.compileShaderDoc(this.currentEntry?.name ?? 'Shader');
      return;
    }
    if (!this.currentPreset) return;

    const preset = this.currentPreset;
    preset.perFrame = this.editor.getValue(MILK_DOCS.perFrame);
    preset.perPixel = this.editor.getValue(MILK_DOCS.perPixel);
    preset.perFrameInit = this.editor.getValue(MILK_DOCS.init);
    preset.warpShader = this.editor.getValue(MILK_DOCS.warp);
    preset.compShader = this.editor.getValue(MILK_DOCS.comp);
    this.applyMilkPreset(preset, false);
  }

  private get currentKind(): LibraryKind {
    return this.mode === 'milk' ? 'milk' : 'shader';
  }

  private extensionFor(kind: LibraryKind): string {
    return kind === 'milk' ? '.milk' : '.glsl';
  }

  /** The bytes that would be written for the current visual. */
  private serializeCurrent(kind: LibraryKind): string {
    // Serialising from the model, not the visible tab, is what preserves
    // buffers, the Common block and every channel binding in the saved file.
    if (kind === 'milk') return serializeMilk(this.currentPreset ?? createEmptyPreset());
    return this.shaderDoc ? serializeShaderProject(this.shaderDoc) : '';
  }

  /**
   * Save over the current file.
   *
   * Falls through to Save As when there is nowhere safe to write: a brand-new
   * visual has no file yet, and a bundled one must be forked rather than
   * overwritten so the shipped library stays pristine.
   */
  private async save(): Promise<void> {
    if (!this.currentEntry || this.currentEntry.builtin) {
      await this.saveAs();
      return;
    }
    await this.writeToLibrary(this.currentKind, this.currentEntry.id, 'Saved');
  }

  /** Prompt for a name, then write. This is how a visual gets named. */
  private async saveAs(): Promise<void> {
    const kind = this.currentKind;
    const extension = this.extensionFor(kind);

    const suggested = this.currentEntry?.builtin
      ? `${this.currentEntry.name} (my version)`
      : (this.currentEntry?.name ?? (kind === 'milk' ? 'My Preset' : 'My Shader'));

    const name = await promptText({
      title: kind === 'milk' ? 'Name this preset' : 'Name this shader',
      label: 'Name',
      value: suggested,
      placeholder: kind === 'milk' ? 'My Preset' : 'My Shader',
      confirmLabel: 'Save',
      validate: validateLibraryName,
    });
    if (name === null) return;

    const id = `${name}${extension}`;
    if (await window.domino.library.exists(kind, id)) {
      const replace = await confirmAction({
        title: `Replace "${name}"?`,
        body: 'Something in your library already has that name. Saving will overwrite it.',
        confirmLabel: 'Replace',
        danger: true,
      });
      if (!replace) return;
    }

    await this.writeToLibrary(kind, id, `Saved as "${name}"`);
  }

  private async writeToLibrary(
    kind: LibraryKind,
    id: string,
    successMessage: string,
  ): Promise<void> {
    const result = await window.domino.library.write(kind, id, this.serializeCurrent(kind));
    if (!result.ok) {
      this.toast.show(`Save failed: ${result.error}`, 'error');
      this.setEditorStatus(`Save failed: ${result.error}`, 'error');
      return;
    }

    await this.refreshLibrary(kind);
    if (this.tabs.kind === kind) await this.switchLibrary(kind);

    const saved = this.findEntry(kind, id);
    if (saved) {
      this.currentEntry = saved;
      this.library.setActive(saved.id);
      el('hud-title').textContent = saved.name;
      if (this.currentPreset) this.currentPreset.name = saved.name;
      void window.domino.settings.set({ lastVisual: { kind, id } });
    }

    this.toast.show(successMessage);
    this.setEditorStatus('Saved', 'ok');
  }

  /* -------------------------- library management ------------------------- */

  private async renameEntry(entry: LibraryEntry): Promise<void> {
    const extension = this.extensionFor(entry.kind);
    const name = await promptText({
      title: entry.builtin ? `Copy "${entry.name}" as` : `Rename "${entry.name}"`,
      label: 'Name',
      value: entry.name,
      confirmLabel: entry.builtin ? 'Create copy' : 'Rename',
      validate: validateLibraryName,
    });
    if (name === null || name === entry.name) return;

    // Renames stay in the same folder, so a preset imported into a subfolder
    // does not silently jump to the library root.
    const folder = entry.group ? `${entry.group}/` : '';
    const toId = `${folder}${name}${extension}`;

    if (await window.domino.library.exists(entry.kind, toId)) {
      this.toast.show(`"${name}" already exists.`, 'error');
      return;
    }

    const result = await window.domino.library.rename(entry.kind, entry.id, toId);
    if (!result.ok) {
      this.toast.show(`Rename failed: ${result.error}`, 'error');
      return;
    }

    await this.refreshLibrary(entry.kind);
    await this.switchLibrary(entry.kind);

    const renamed = this.findEntry(entry.kind, toId);
    if (renamed && this.currentEntry?.id === entry.id) {
      this.currentEntry = renamed;
      this.library.setActive(renamed.id);
      el('hud-title').textContent = renamed.name;
      if (this.currentPreset) this.currentPreset.name = renamed.name;
      void window.domino.settings.set({ lastVisual: { kind: entry.kind, id: toId } });
    }
    this.toast.show(entry.builtin ? `Created "${name}"` : `Renamed to "${name}"`);
  }

  private async duplicateEntry(entry: LibraryEntry): Promise<void> {
    const read = await window.domino.library.read(entry.kind, entry.id);
    if (!read.ok || read.content === undefined) {
      this.toast.show(`Could not read ${entry.name}`, 'error');
      return;
    }

    const name = await promptText({
      title: `Duplicate "${entry.name}"`,
      label: 'Name',
      value: `${entry.name} copy`,
      confirmLabel: 'Duplicate',
      validate: validateLibraryName,
    });
    if (name === null) return;

    const folder = entry.group ? `${entry.group}/` : '';
    const toId = `${folder}${name}${this.extensionFor(entry.kind)}`;
    if (await window.domino.library.exists(entry.kind, toId)) {
      this.toast.show(`"${name}" already exists.`, 'error');
      return;
    }

    const result = await window.domino.library.write(entry.kind, toId, read.content);
    if (!result.ok) {
      this.toast.show(`Duplicate failed: ${result.error}`, 'error');
      return;
    }
    await this.refreshLibrary(entry.kind);
    await this.switchLibrary(entry.kind);
    this.toast.show(`Created "${name}"`);
  }

  private async deleteEntry(entry: LibraryEntry): Promise<void> {
    if (entry.builtin) {
      this.toast.show('Bundled visuals cannot be deleted. Duplicate it instead.', 'error');
      return;
    }
    const confirmed = await confirmAction({
      title: `Delete "${entry.name}"?`,
      body: 'This removes the file from your library. It cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;

    const result = await window.domino.library.delete(entry.kind, entry.id);
    if (!result.ok) {
      this.toast.show(`Delete failed: ${result.error}`, 'error');
      return;
    }

    await this.refreshLibrary(entry.kind);
    await this.switchLibrary(entry.kind);

    // A user file can shadow a bundled one of the same name; if so, deleting it
    // reveals the original rather than removing the entry entirely.
    const revealed = this.findEntry(entry.kind, entry.id);
    this.toast.show(
      revealed ? `Deleted your copy - the bundled "${entry.name}" is back.` : `Deleted "${entry.name}"`,
    );

    if (this.currentEntry?.id === entry.id) {
      if (revealed) await this.load(revealed, false);
      else this.currentEntry = null;
    }
  }

  private toggleEditor(): void {
    const panel = el('editor-panel');
    if (panel.hidden) this.openEditor();
    else this.closeEditor();
  }

  private openEditor(): void {
    el('editor-panel').hidden = false;
    this.syncEditorDocuments();
    this.editor.layout();
    this.editor.focus();
  }

  private closeEditor(): void {
    el('editor-panel').hidden = true;
    this.canvas.focus();
  }

  private setEditorStatus(text: string, kind: 'ok' | 'error' | 'idle'): void {
    const node = el('editor-status');
    node.textContent = text;
    node.classList.toggle('is-ok', kind === 'ok');
    node.classList.toggle('is-error', kind === 'error');
  }

  private showEditorErrors(lines: string[]): void {
    const host = el('editor-errors');
    host.replaceChildren();
    if (lines.length === 0) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    for (const line of lines.slice(0, 30)) {
      const row = document.createElement('div');
      row.className = 'err-line';
      row.textContent = line;
      host.appendChild(row);
    }
  }

  /* ----------------------------- transport ------------------------------ */

  private wireTransport(): void {
    const listenButton = el<HTMLButtonElement>('btn-listen');

    on(listenButton, 'click', async () => {
      try {
        await this.audio.captureSystemAudio();
        this.toast.show('Listening to everything this computer plays.');
      } catch (err) {
        // The fallback worth suggesting is not the same on both platforms:
        // Windows needs a third-party loopback device, while on Linux the
        // monitor inputs are already sitting in the Mic button's device list.
        const fallback =
          window.domino.platform === 'linux'
            ? 'Try the Mic button and pick a "Monitor of ..." input.'
            : 'Try the Mic button with a loopback device such as VB-Cable or Stereo Mix.';
        this.toast.show(
          `System audio capture failed: ${(err as Error).message}. ${fallback}`,
          'error',
        );
      }
    });

    on(el('btn-mic'), 'click', async () => {
      try {
        await this.audio.captureMicrophone();
        this.toast.show('Listening to the microphone.');
      } catch (err) {
        this.toast.show(`Microphone failed: ${(err as Error).message}`, 'error');
      }
    });

    on(el('btn-file'), 'click', async () => {
      const path = await window.domino.dialog.openAudioFile();
      if (!path) return;
      try {
        // Electron serves local files through the file: protocol; encode the
        // path so spaces and non-ASCII characters survive the URL round trip.
        const url = `file:///${path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')}`;
        await this.audio.playFile(url, path.split(/[\\/]/).pop() ?? 'Audio file');
        this.toast.show(`Playing ${path.split(/[\\/]/).pop()}`);
      } catch (err) {
        this.toast.show(`Could not play that file: ${(err as Error).message}`, 'error');
      }
    });

    on(el('btn-stop'), 'click', () => {
      this.audio.stop();
      this.toast.show('Audio input stopped.');
    });

    this.audio.onStatus((status) => {
      el('stat-src').textContent = status.active ? status.label : 'no input';
      const listening = status.kind === 'loopback' && status.active;
      listenButton.classList.toggle('is-live', listening);
      listenButton.textContent = listening ? 'Listening' : 'System Audio';
      listenButton.title = listening
        ? 'Capturing everything this computer plays'
        : 'Capture everything this computer plays';
    });

    this.bindSlider('ctl-sensitivity', 'out-sensitivity', 2, (value) => {
      this.settings.sensitivity = value;
      void window.domino.settings.set({ sensitivity: value });
    });
    this.bindSlider('ctl-gain', 'out-gain', 1, (value) => {
      this.audio.setOptions({ gain: value });
      void window.domino.settings.set({ gain: value });
    });
    this.bindSlider('ctl-smoothing', 'out-smoothing', 2, (value) => {
      this.audio.setOptions({ smoothing: value });
      void window.domino.settings.set({ smoothing: value });
    });
    this.bindSlider('ctl-beat', 'out-beat', 2, (value) => {
      this.audio.setOptions({ beatSensitivity: value });
      void window.domino.settings.set({ beatSensitivity: value });
    });

    const autoplay = el<HTMLInputElement>('ctl-autoplay');
    on(autoplay, 'change', () => {
      this.settings.autoPlay = autoplay.checked;
      void window.domino.settings.set({ autoPlay: autoplay.checked });
    });

    on(el('btn-random'), 'click', () => this.shuffle());
    on(el('btn-fullscreen'), 'click', () => void this.toggleImmersive());
  }

  private bindSlider(
    inputId: string,
    outputId: string,
    decimals: number,
    apply: (value: number) => void,
  ): void {
    const input = el<HTMLInputElement>(inputId);
    const output = el(outputId);
    const update = (): void => {
      const value = parseFloat(input.value);
      output.textContent = value.toFixed(decimals);
      apply(value);
    };
    on(input, 'input', update);
    output.textContent = parseFloat(input.value).toFixed(decimals);
  }

  private applySettingsToUi(): void {
    const s = this.settings;
    const set = (id: string, value: number): void => {
      el<HTMLInputElement>(id).value = String(value);
    };
    set('ctl-sensitivity', s.sensitivity);
    set('ctl-gain', s.gain);
    set('ctl-smoothing', s.smoothing);
    set('ctl-beat', s.beatSensitivity);
    el<HTMLInputElement>('ctl-autoplay').checked = s.autoPlay;

    el('out-sensitivity').textContent = s.sensitivity.toFixed(2);
    el('out-gain').textContent = s.gain.toFixed(1);
    el('out-smoothing').textContent = s.smoothing.toFixed(2);
    el('out-beat').textContent = s.beatSensitivity.toFixed(2);

    this.audio.setOptions({
      gain: s.gain,
      smoothing: s.smoothing,
      beatSensitivity: s.beatSensitivity,
      fftSize: s.fftSize,
    });
    this.milkdrop.options.blendSeconds = s.blendSeconds;
    this.milkdrop.setMeshSize(s.meshX, s.meshY);

    this.post.setSettings({
      brightness: s.brightness,
      contrast: s.contrast,
      saturation: s.saturation,
      gamma: s.gamma,
      toneMap: s.toneMap,
      vignette: s.vignette,
    });
    el('hud').style.display = s.showFps ? '' : 'none';
  }

  private shuffle(): void {
    const entry = this.library.random();
    if (entry) void this.load(entry, true);
  }

  /* ------------------------------- stage -------------------------------- */

  private wireStage(): void {
    on(this.canvas, 'pointermove', (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = this.canvas.width / Math.max(rect.width, 1);
      this.mouse.x = (event.clientX - rect.left) * dpr;
      // Shadertoy's origin is bottom-left, the DOM's is top-left.
      this.mouse.y = (rect.height - (event.clientY - rect.top)) * dpr;
    });

    // Any pointer activity anywhere brings the cursor back and restarts the
    // idle countdown.
    window.addEventListener('pointermove', () => {
      if (this.immersive) this.armCursorHide();
    });
    on(this.canvas, 'pointerdown', (event) => {
      this.mouse.down = true;
      this.mouse.clickX = this.mouse.x;
      this.mouse.clickY = this.mouse.y;
      this.canvas.setPointerCapture(event.pointerId);
    });
    on(this.canvas, 'pointerup', () => {
      this.mouse.down = false;
    });
    on(this.canvas, 'dblclick', () => void this.toggleImmersive());
  }

  private wireHotkeys(): void {
    window.addEventListener('keydown', (event) => {
      // Never steal keys from the editor or the search box.
      //
      // The target is not always an element - a key event dispatched at the
      // window (or arriving with nothing focused) has no `closest`, so the
      // instanceof guard is load-bearing, not defensive noise.
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.closest('.editor-host') !== null);

      if (event.key === 'Escape') {
        if (!el('editor-panel').hidden) this.closeEditor();
        else if (this.immersive) void this.setImmersive(false);
        else if (this.chromeHidden) this.setChromeHidden(false);
        return;
      }
      // Monaco owns Ctrl+S / Ctrl+Shift+S while the editor has focus, so these
      // only apply outside it - otherwise both handlers would fire and save
      // twice.
      if (typing) return;

      if ((event.ctrlKey || event.metaKey) && (event.key === 'S' || event.key === 's')) {
        event.preventDefault();
        // Naming a visual should not require opening the code panel first.
        if (event.shiftKey) void this.saveAs();
        else void this.save();
        return;
      }

      switch (event.key) {
        case ' ':
          event.preventDefault();
          this.shuffle();
          break;
        case 'ArrowRight':
          event.preventDefault();
          this.library.step(1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          this.library.step(-1);
          break;
        case 'e':
        case 'E':
          this.toggleEditor();
          break;
        case 'f':
        case 'F':
          void this.toggleImmersive();
          break;
        case 'h':
        case 'H':
          this.setChromeHidden(!this.chromeHidden);
          break;
        case 'i':
        case 'I':
          this.flashPreset();
          break;
        case 'c':
        case 'C': {
          const next = !this.settings.cameraEnabled;
          this.settings.cameraEnabled = next;
          void window.domino.settings.set({ cameraEnabled: next });
          this.display.setSettings(this.settings);
          void this.syncCamera();
          break;
        }
        default:
          break;
      }
    });
  }

  private setChromeHidden(hidden: boolean): void {
    this.chromeHidden = hidden;
    // The class lives on <body> because the transport sits outside .app, and
    // .app has to reclaim its row or "fullscreen" leaves a black band.
    document.body.classList.toggle('chrome-hidden', hidden);
    el('hud').classList.toggle('is-faded', hidden);
    el('meters').classList.toggle('is-faded', hidden);
    if (!hidden) this.showCursor();
    // The canvas element changes size, so the drawing buffer must follow.
    requestAnimationFrame(() => this.syncCanvasSize());
  }

  /**
   * Immersive mode: OS fullscreen with no interface at all, which is what
   * "make the whole visualizer fullscreen" actually means. Plain fullscreen
   * would just make the panels bigger.
   */
  private async setImmersive(on: boolean): Promise<void> {
    this.immersive = on;
    this.setChromeHidden(on);
    await window.domino.window.setFullscreen(on);
    if (on) {
      this.flashPreset();
      this.armCursorHide();
    } else {
      this.showCursor();
    }
  }

  private async toggleImmersive(): Promise<void> {
    await this.setImmersive(!this.immersive);
  }

  /* --------------------------- cursor & flash --------------------------- */

  private showCursor(): void {
    document.body.classList.remove('cursor-hidden');
    if (this.cursorTimer !== null) {
      window.clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
    }
  }

  /** Hide the pointer after a few idle seconds, but only when immersive. */
  private armCursorHide(): void {
    this.showCursor();
    if (!this.immersive) return;
    this.cursorTimer = window.setTimeout(() => {
      if (this.immersive) document.body.classList.add('cursor-hidden');
    }, 2500);
  }

  /**
   * Show the visual's name briefly. In immersive mode this is the only
   * indication of what is playing, so it fires on every preset change.
   */
  private flashPreset(): void {
    const name = this.currentEntry?.name ?? this.currentPreset?.name ?? 'Untitled';
    el('preset-flash-name').textContent = name;
    el('preset-flash-kind').textContent =
      this.mode === 'milk' ? 'MilkDrop Preset' : 'Shader';

    const node = el('preset-flash');
    node.classList.add('is-visible');
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      node.classList.remove('is-visible');
      this.flashTimer = null;
    }, 2600);
  }

  /* ------------------------------ the loop ------------------------------ */

  private now(): number {
    return performance.now() / 1000 - this.startTime;
  }

  private frame = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    const fps = this.fps.tick();
    const time = this.now();

    this.syncCanvasSize();

    const audio = this.audio.analyse();
    this.audioTexture.update(audio);
    this.camera.update();
    this.driveStream(audio, time * 1000);

    const gl = this.glctx.gl;
    const width = this.glctx.width;
    const height = this.glctx.height;

    // Engines draw into the HDR scene buffer, never straight to the screen, so
    // the post stage can tone-map values above 1.0 instead of seeing them
    // pre-clipped.
    this.sceneTarget.bind();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.mode === 'shader') {
      this.shadertoy.render(
        {
          audio,
          audioTexture: this.audioTexture.texture,
          cameraTexture: this.camera.texture,
          cameraWidth: this.camera.getStatus().width,
          cameraHeight: this.camera.getStatus().height,
          cameraMirror: this.settings?.cameraMirror ?? true,
          mouse: this.mouse,
          sensitivity: this.settings?.sensitivity ?? 1,
          sampleRate: 44100,
          fps,
        },
        this.sceneTarget.fbo,
      );
    } else {
      this.milkdrop.render(
        {
          audio,
          time,
          fps,
          frame: this.frameIndex,
          width,
          height,
        },
        this.sceneTarget.fbo,
      );
    }

    this.post.render(this.sceneTarget.texture, width, height, null);
    this.publishCameraFrame(time * 1000);

    this.updateHud(audio, fps);
    this.maybeAutoSwitch(time);
    this.frameIndex++;
  };

  /**
   * Send the current frame to the virtual camera, if it is on.
   *
   * The frame is graded a second time at the camera's own resolution rather
   * than copied off the screen, so the output keeps its shape no matter what
   * size the window is - including while the panels are open.
   */
  private publishCameraFrame(nowMs: number): void {
    const out = this.vcamOut;
    if (!out || !this.vcamRunning) return;

    if (out.shouldCapture(nowMs)) {
      const status = out.getStatus();
      this.post.render(this.sceneTarget.texture, status.width, status.height, out.sourceFbo);
      out.capture(nowMs);
    }

    // Readback runs a frame or two behind the capture that started it, so
    // collecting is a separate step rather than part of capture().
    const frame = out.poll();
    if (frame) window.domino.virtualCamera.sendFrame(frame);
  }

  /** Keep the drawing buffer and all render targets matched to the canvas. */
  private syncCanvasSize(): void {
    if (!this.glctx.resize(this.settings?.renderScale ?? 1)) return;
    const { width, height } = this.glctx;
    this.shadertoy.resize(width, height);
    this.milkdrop.resize(width, height);
    this.sceneTarget.resize(width, height);
  }

  private updateHud(audio: AudioFrame, fps: number): void {
    // The HUD is DOM, so it is only worth touching a few times a second.
    if (this.frameIndex % 6 !== 0) return;

    el('stat-fps').textContent = `${fps.toFixed(0)} fps`;
    el('stat-bpm').textContent =
      audio.bpm > 0 && audio.bpmConfidence > 0.08 ? `${audio.bpm.toFixed(0)} bpm` : '-- bpm';

    const scale = (value: number): string => `${Math.min(Math.max(value, 0), 3) * 14 + 3}px`;
    el('meter-bass').style.height = scale(audio.bass);
    el('meter-mid').style.height = scale(audio.mid);
    el('meter-treb').style.height = scale(audio.treb);
    el('beat-dot').classList.toggle('is-hit', audio.beatPulse > 0.35);
  }

  private maybeAutoSwitch(time: number): void {
    if (!this.settings?.autoPlay) return;
    if (time - this.lastAutoSwitch < (this.settings.autoPlaySeconds || 30)) return;
    this.lastAutoSwitch = time;
    this.shuffle();
  }
}

/** Body used when a new feedback buffer is added. */
const STARTER_BUFFER_PASS = `// Buffer __ID__ - a feedback pass.
//
// iChannel0 is bound to this buffer's own previous frame, so whatever you
// write here persists and can be read back next frame. That is what makes
// trails, fluid advection and reaction-diffusion possible.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;

    vec3 prev = texture(iChannel0, uv).rgb * 0.96;

    float d = length(uv - vec2(0.5));
    prev += vec3(0.4, 0.7, 1.0) * exp(-d * 24.0) * (0.02 + iBassAtt * 0.06);

    fragColor = vec4(prev, 1.0);
}
`;

/** Body used when the Common tab is first added. */
const STARTER_COMMON = `// Common - prepended to every pass.
// Put shared helpers, constants and structs here.

float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
}
`;

/** Shown when the user creates a new shader - a working starting point. */
const STARTER_SHADER = `// Domino shader. Shadertoy-compatible.
//
// Audio comes in two ways:
//   texture(iChannel0, vec2(x, 0.25)).r  -> spectrum at position x
//   texture(iChannel0, vec2(x, 0.75)).r  -> waveform, 0..1
// or use the analysed values directly: iBass, iMid, iTreb, iBeatPulse, iBPM.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y);

    float energy = iBass * 0.6 + iMid * 0.3 + iTreb * 0.1;
    float r = length(uv);
    float a = atan(uv.y, uv.x);

    float rings = sin(r * 12.0 - iTime * 2.0 + energy * 4.0);
    float rays = sin(a * 8.0 + iTime * 0.7);

    vec3 color = 0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + iTime * 0.4 + r * 3.0);
    color *= smoothstep(0.0, 0.6, rings * 0.5 + 0.5) * (0.4 + energy * 0.8);
    color += vec3(0.3, 0.6, 1.0) * rays * 0.08 * iTrebAtt;
    color += iBeatPulse * 0.25 * exp(-r * 2.5);

    fragColor = vec4(color, 1.0);
}
`;

/* -------------------------------- boot --------------------------------- */

async function boot(): Promise<void> {
  try {
    const app = new Domino();
    await app.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    document.body.innerHTML = `
      <div style="padding:48px;font:14px/1.6 system-ui;color:#e6e9f2">
        <h1 style="color:#ff6b7a;font-size:18px;margin:0 0 12px">Domino could not start</h1>
        <pre style="white-space:pre-wrap;color:#8a91a8">${escapeHtml(message)}</pre>
      </div>`;
    console.error(err);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

void boot();
