import type { AppSettings, VirtualCameraStatus } from '@shared/types';

/**
 * The Display tab: image controls plus render quality.
 *
 * These are deliberately separate from the preset parameter panel. Preset
 * values belong to the preset and get saved with it; these belong to the user's
 * screen and persist across every visual. Mixing them would mean a preset could
 * silently change the user's brightness.
 */

interface ControlSpec {
  key: keyof AppSettings;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  help?: string;
  /** Present the value as a percentage rather than a raw number. */
  percent?: boolean;
}

interface ToggleSpec {
  key: keyof AppSettings;
  label: string;
  group: string;
  help?: string;
}

const CONTROLS: ControlSpec[] = [
  {
    key: 'brightness',
    label: 'Brightness',
    group: 'Image',
    min: 0.1,
    max: 2.5,
    step: 0.01,
    decimals: 2,
    help: 'Exposure applied before tone mapping. Lower this first if a preset is too hot.',
  },
  {
    key: 'contrast',
    label: 'Contrast',
    group: 'Image',
    min: 0.4,
    max: 2,
    step: 0.01,
    decimals: 2,
  },
  {
    key: 'saturation',
    label: 'Saturation',
    group: 'Image',
    min: 0,
    max: 2,
    step: 0.01,
    decimals: 2,
    help: '0 is black and white, 1 is unchanged.',
  },
  {
    key: 'gamma',
    label: 'Gamma',
    group: 'Image',
    min: 0.5,
    max: 2.2,
    step: 0.01,
    decimals: 2,
    help: 'Midtone trim applied after tone mapping.',
  },
  {
    key: 'vignette',
    label: 'Vignette',
    group: 'Image',
    min: 0,
    max: 1,
    step: 0.01,
    decimals: 2,
    help: 'Darkens the corners, which keeps attention on the centre.',
  },
  {
    key: 'renderScale',
    label: 'Render Scale',
    group: 'Quality',
    min: 0.5,
    max: 2,
    step: 0.05,
    decimals: 2,
    percent: true,
    help: 'Below 100% trades sharpness for frame rate. Above 100% supersamples.',
  },
  {
    key: 'meshX',
    label: 'Warp Mesh X',
    group: 'Quality',
    min: 8,
    max: 128,
    step: 1,
    decimals: 0,
    help: 'MilkDrop grid resolution. Higher is smoother motion but more CPU work in per-pixel equations.',
  },
  {
    key: 'meshY',
    label: 'Warp Mesh Y',
    group: 'Quality',
    min: 6,
    max: 96,
    step: 1,
    decimals: 0,
  },
  {
    key: 'blendSeconds',
    label: 'Preset Blend',
    group: 'Playback',
    min: 0,
    max: 10,
    step: 0.1,
    decimals: 1,
    help: 'Crossfade length when switching MilkDrop presets. 0 cuts instantly.',
  },
  {
    key: 'autoPlaySeconds',
    label: 'Auto Interval',
    group: 'Playback',
    min: 5,
    max: 300,
    step: 1,
    decimals: 0,
    help: 'Seconds between automatic preset changes when Auto is on.',
  },
];

const TOGGLES: ToggleSpec[] = [
  {
    key: 'cameraEnabled',
    label: 'Webcam Input',
    group: 'Camera',
    help: 'Turns the camera on so shaders can sample it. Bind an iChannel to Webcam in the editor.',
  },
  {
    key: 'cameraMirror',
    label: 'Mirror',
    group: 'Camera',
    help: 'Selfie view. Shaders read this as iCameraMirror; the dominoCamera() helper applies it for you.',
  },
  {
    key: 'toneMap',
    label: 'Filmic Tone Map',
    group: 'Image',
    help: 'Rolls bright areas off smoothly instead of clipping them to white. Turn off for the raw, harder MilkDrop look.',
  },
  {
    key: 'showFps',
    label: 'Show Stats',
    group: 'Playback',
    help: 'Frame rate, tempo and input readout in the corner.',
  },
];

const GROUP_ORDER = ['Image', 'Camera', 'Virtual Camera', 'Quality', 'Playback'];

/**
 * Groups whose contents are built by hand rather than from the tables above.
 *
 * Without this a group made purely of custom controls is treated as empty and
 * skipped entirely, which is how the virtual camera section came to exist in
 * code and not on screen.
 */
const CUSTOM_GROUPS = new Set(['Virtual Camera']);

const VCAM_SIZES = ['640x480', '1280x720', '1920x1080'];
const VCAM_RATES = [24, 30, 60];

export class DisplayPanel {
  private host: HTMLElement;
  private settings: AppSettings;
  private rows = new Map<string, { input: HTMLInputElement; value: HTMLElement }>();

  onChange: ((patch: Partial<AppSettings>) => void) | null = null;
  onReset: (() => void) | null = null;
  /** Devices offered in the camera picker. Empty until permission is granted. */
  cameraDevices: Array<{ deviceId: string; label: string }> = [];
  /** Latest word from the main process; null until the first status query. */
  virtualCameraStatus: VirtualCameraStatus | null = null;
  onVirtualCamera: ((on: boolean) => void) | null = null;
  onVirtualCameraRegister: ((unregister: boolean) => void) | null = null;

  constructor(host: HTMLElement, settings: AppSettings) {
    this.host = host;
    this.settings = settings;
  }

  setSettings(settings: AppSettings): void {
    this.settings = settings;
    this.refresh();
  }

  render(): void {
    this.rows.clear();
    this.host.replaceChildren();
    const fragment = document.createDocumentFragment();

    for (const group of GROUP_ORDER) {
      const controls = CONTROLS.filter((c) => c.group === group);
      const toggles = TOGGLES.filter((t) => t.group === group);
      if (controls.length === 0 && toggles.length === 0 && !CUSTOM_GROUPS.has(group)) {
        continue;
      }

      const section = document.createElement('div');
      section.className = 'param-group';

      const title = document.createElement('div');
      title.className = 'param-group-title';
      title.textContent = group;
      section.appendChild(title);

      for (const spec of controls) section.appendChild(this.buildSlider(spec));
      for (const spec of toggles) section.appendChild(this.buildToggle(spec));
      if (group === 'Camera') section.appendChild(this.buildCameraPicker());
      if (group === 'Virtual Camera') this.buildVirtualCamera(section);

      fragment.appendChild(section);
    }

    const reset = document.createElement('button');
    reset.className = 'btn btn-ghost';
    reset.style.marginTop = '16px';
    reset.style.width = '100%';
    reset.textContent = 'Reset display settings';
    reset.addEventListener('click', () => this.onReset?.());
    fragment.appendChild(reset);

    this.host.appendChild(fragment);
  }

  /**
   * Publishing Domino as a webcam.
   *
   * Built by hand rather than from the toggle table because most of what
   * matters here is live state - whether the driver is registered, whether
   * anything is actually being sent - and a plain settings checkbox would hide
   * the one thing a user needs to know when it does not work.
   */
  private buildVirtualCamera(section: HTMLElement): void {
    const status = this.virtualCameraStatus;

    const row = document.createElement('label');
    row.className = 'param param-toggle';

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = 'Publish as Webcam';
    label.title =
      'Makes Domino selectable as a camera in Zoom, Discord, Meet and anything ' +
      'else that takes a webcam. The camera exists while this is on, so switch ' +
      'it on before opening the call app.';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(this.settings.virtualCameraEnabled);
    input.disabled = !status?.available || !status?.registered || !status?.registeredIsThisBuild;
    input.addEventListener('change', () => this.onVirtualCamera?.(input.checked));

    row.append(label, input);
    section.appendChild(row);

    section.appendChild(
      this.buildChoice('Size', VCAM_SIZES, String(this.settings.virtualCameraSize), (v) =>
        this.onChange?.({ virtualCameraSize: v }),
      ),
    );
    section.appendChild(
      this.buildChoice(
        'Frame Rate',
        VCAM_RATES.map((r) => String(r)),
        String(this.settings.virtualCameraFps),
        (v) => this.onChange?.({ virtualCameraFps: Number(v) }),
      ),
    );

    /*
     * The setup step, offered only when it is the thing standing in the way -
     * or, once it is done, as the way to leave the machine clean again.
     *
     * The label and tooltip come from the main process rather than from here.
     * What this button does is genuinely different per platform - regsvr32
     * under UAC on Windows, modprobe under pkexec on Linux - and a renderer
     * that tried to word that itself would be guessing at the state of a
     * machine it cannot see.
     */
    const needsSetup = Boolean(status?.available) &&
      (!status!.registered || !status!.registeredIsThisBuild);
    // Removing it while frames are going out would pull the device away from
    // whatever is watching, so it is only offered once publishing has stopped.
    const canUndo = Boolean(status?.registered && status.registeredIsThisBuild && !status.running);

    if (status?.setupAction && (needsSetup || canUndo)) {
      const button = document.createElement('button');
      button.className = 'btn btn-ghost';
      button.style.width = '100%';
      button.textContent = status.setupAction;
      button.title = status.setupHint;
      button.addEventListener('click', () => this.onVirtualCameraRegister?.(!needsSetup));
      section.appendChild(button);
    }

    const note = document.createElement('div');
    note.className = 'param-help';
    note.textContent = this.virtualCameraNote(status);
    section.appendChild(note);
  }

  /**
   * One line telling the user exactly where this stands, good or bad.
   *
   * Anything specific to how this platform publishes a camera arrives as
   * `setupNote`, already written by the backend that knows. What is left here
   * is the part that reads the same everywhere.
   */
  private virtualCameraNote(status: VirtualCameraStatus | null): string {
    if (!status) return 'Checking for the camera driver...';
    if (!status.available) {
      return status.error || 'This build of Domino has no virtual camera module.';
    }
    if (!status.registered || !status.registeredIsThisBuild) {
      return status.setupNote || status.error || 'The camera is not ready yet.';
    }
    if (status.error) return status.error;

    // What other applications will actually show. On Linux the card label
    // belongs to the kernel module, so telling the user to look for the name in
    // settings would send them hunting for a camera that is listed under
    // something else.
    const shown = status.publishedName || String(this.settings.virtualCameraName);

    if (status.running) {
      return `Live at ${status.width}x${status.height}, ${status.fps}fps. ${status.framesWritten} frames sent. Pick "${shown}" in your video app.`;
    }
    return (
      `Ready. Switch this on first, then open Zoom or Discord and choose "${shown}" ` +
      '- call apps read the camera list when they start, so they will not see ' +
      'it if Domino was switched on afterwards.'
    );
  }

  /** A labelled dropdown, matching the shape of the sliders above it. */
  private buildChoice(
    labelText: string,
    options: string[],
    value: string,
    onPick: (value: string) => void,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param';

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = labelText;

    const select = document.createElement('select');
    select.className = 'select';
    for (const option of options) {
      const element = document.createElement('option');
      element.value = option;
      element.textContent = option;
      select.appendChild(element);
    }
    select.value = value;
    select.addEventListener('change', () => onPick(select.value));

    row.append(label, select);
    return row;
  }

  private format(spec: ControlSpec, value: number): string {
    if (spec.percent) return `${Math.round(value * 100)}%`;
    return value.toFixed(spec.decimals);
  }

  private buildSlider(spec: ControlSpec): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param';

    const value = Number(this.settings[spec.key] ?? spec.min);

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = spec.label;
    if (spec.help) label.title = spec.help;

    const readout = document.createElement('span');
    readout.className = 'param-value';
    readout.textContent = this.format(spec, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(value);

    input.addEventListener('input', () => {
      const next = spec.decimals === 0 ? Math.round(parseFloat(input.value)) : parseFloat(input.value);
      readout.textContent = this.format(spec, next);
      this.onChange?.({ [spec.key]: next } as Partial<AppSettings>);
    });

    row.append(label, readout, input);
    this.rows.set(spec.key as string, { input, value: readout });
    return row;
  }

  private buildToggle(spec: ToggleSpec): HTMLElement {
    const row = document.createElement('label');
    row.className = 'param param-toggle';
    if (spec.help) row.title = spec.help;

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = spec.label;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(this.settings[spec.key]);
    input.addEventListener('change', () => {
      this.onChange?.({ [spec.key]: input.checked } as Partial<AppSettings>);
    });

    row.append(label, input);
    this.rows.set(spec.key as string, { input, value: label });
    return row;
  }

  /**
   * Camera device picker.
   *
   * Device labels are blank until camera permission has been granted once, so
   * before that the list shows generic names. Turning the camera on populates
   * it properly on the next render.
   */
  private buildCameraPicker(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'param';

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = 'Device';

    const select = document.createElement('select');
    select.className = 'chan-select';
    select.style.gridColumn = '1 / -1';
    select.style.width = '100%';

    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = this.cameraDevices.length ? 'Default camera' : 'Default camera (turn on to list)';
    select.appendChild(auto);

    this.cameraDevices.forEach((device, i) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${i + 1}`;
      select.appendChild(option);
    });

    select.value = String(this.settings.cameraDeviceId ?? '');
    select.addEventListener('change', () => {
      this.onChange?.({ cameraDeviceId: select.value });
    });

    row.append(label, document.createElement('span'), select);
    return row;
  }

  /** Push current settings back into the widgets, e.g. after a reset. */
  refresh(): void {
    for (const spec of CONTROLS) {
      const row = this.rows.get(spec.key as string);
      if (!row) continue;
      const value = Number(this.settings[spec.key] ?? spec.min);
      row.input.value = String(value);
      row.value.textContent = this.format(spec, value);
    }
    for (const spec of TOGGLES) {
      const row = this.rows.get(spec.key as string);
      if (!row) continue;
      row.input.checked = Boolean(this.settings[spec.key]);
    }
  }
}
