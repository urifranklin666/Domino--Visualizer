import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  findNative,
  type NativeResult,
  type SetupState,
  type VirtualCameraBackend,
} from './vcam-support';

/**
 * Linux backend: v4l2loopback.
 *
 * Far less machinery than the Windows side needs. There is no second process
 * and no COM: v4l2loopback *is* the camera device, and publishing is opening
 * /dev/videoN, setting a format and writing frames. The native module does all
 * of that in about two hundred lines.
 *
 * What is left for this file is the part the kernel will not do for us. A
 * loopback device has to exist before anything can be published into it, and
 * creating one means loading an out-of-tree kernel module - so this is where
 * Domino works out whether that has happened, and asks for it politely when it
 * has not.
 */

const MODULE = 'v4l2loopback';

/**
 * The card label the device is created with.
 *
 * Fixed at module-load time and owned by the kernel, so unlike on Windows the
 * user's chosen camera name cannot be applied to an existing device. Domino
 * prefers a device already carrying this label and otherwise takes what it is
 * given, which is why the settings field is advisory on this platform.
 */
const CARD_LABEL = 'Domino Visualizer';

interface LoopbackDevice {
  path: string;
  label: string;
  driver: string;
  output: boolean;
  capture: boolean;
}

interface LinuxAddon {
  start(width: number, height: number, fps: number, name: string, devicePath?: string): NativeResult;
  stop(): NativeResult;
  removeCamera(name: string): NativeResult;
  isRunning(): boolean;
  writeFrame(frame: Buffer): NativeResult;
  isRegistered(): { registered: boolean; path: string };
  moduleStatus(): { loaded: boolean; installed: boolean };
  listLoopbackDevices(): LoopbackDevice[];
  listCameras(): string[];
  deviceInfo(): {
    running: boolean;
    path: string;
    label: string;
    width: number;
    height: number;
    format: string;
  };
}

/** Is `name` an executable we could run? */
function onPath(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  return dirs.some((dir) => dir !== '' && existsSync(path.join(dir, name)));
}

/**
 * Run a command as root through pkexec.
 *
 * pkexec is the desktop equivalent of the UAC prompt the Windows backend
 * raises: polkit shows the user exactly which program is about to run as root
 * and who asked for it. Same reasoning as there - Domino does not ship a setuid
 * helper and does not want the whole app running privileged for the sake of one
 * optional feature.
 */
function elevated(command: string, args: string[]): NativeResult {
  if (!onPath('pkexec')) {
    return {
      ok: false,
      error:
        'pkexec was not found, so Domino cannot ask for the rights this needs. ' +
        `Run this in a terminal instead:\n  sudo ${command} ${args.join(' ')}`,
    };
  }

  const result = spawnSync('pkexec', [command, ...args], { encoding: 'utf8' });

  if (result.error) return { ok: false, error: result.error.message };
  if (result.status === 0) return { ok: true };

  /*
   * 126 is polkit's "the user dismissed the dialog" and 127 its "not
   * authorised". Declining a prompt is a normal outcome rather than a fault,
   * and reporting it as one would be shouting at someone for changing their
   * mind.
   */
  if (result.status === 126) return { ok: false, error: '' };
  if (result.status === 127) {
    return { ok: false, error: 'Not authorised to make this change on this machine.' };
  }

  const detail = (result.stderr || result.stdout || '').trim().split('\n').pop();
  return {
    ok: false,
    error: detail || `${command} exited with code ${String(result.status)}.`,
  };
}

export class LinuxBackend implements VirtualCameraBackend {
  private addon: LinuxAddon | null = null;
  private error = '';
  private attempted = false;

  load(): boolean {
    if (this.attempted) return this.addon !== null;
    this.attempted = true;

    const module = this.modulePath();
    if (!module) {
      this.error = 'The virtual camera module was not built into this copy of Domino.';
      return false;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.addon = require(module) as LinuxAddon;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.addon = null;
    }
    return this.addon !== null;
  }

  loadError(): string {
    return this.error;
  }

  modulePath(): string {
    return findNative('domino_vcam.node');
  }

  /** The loopback device we would publish into, or are publishing into now. */
  sourcePath(): string {
    return this.addon?.isRegistered().path ?? '';
  }

  setup(): SetupState {
    if (!this.addon) {
      return { ready: false, path: '', isThisBuild: false, action: '', hint: '', note: this.error };
    }

    const registration = this.addon.isRegistered();
    const module = this.addon.moduleStatus();

    /*
     * Nothing here can be stale the way a Windows registration can. The device
     * belongs to the running kernel rather than to a path recorded on disk, so
     * there is no older copy of Domino for it to point at - reported as true
     * whenever the camera is ready so the shared UI gating works unchanged.
     */
    const base = { ready: registration.registered, path: registration.path, isThisBuild: true };

    if (registration.registered) {
      return { ...base, action: 'Remove loopback device', hint: removeHint(), note: '' };
    }

    if (!module.installed) {
      return {
        ...base,
        action: '',
        hint: '',
        note:
          'Publishing as a webcam needs the v4l2loopback kernel module, which ' +
          'is not installed. Install it with your package manager - ' +
          'v4l2loopback-dkms on Debian, Ubuntu and Arch, akmod-v4l2loopback on ' +
          'Fedora - then come back to this panel.',
      };
    }

    if (!module.loaded) {
      return {
        ...base,
        action: 'Load camera module',
        hint:
          'Runs modprobe through pkexec, which will ask for your password. ' +
          'The module stays loaded until you reboot.',
        note:
          'The v4l2loopback module is installed but not loaded, so there is no ' +
          'device to publish into yet. Loading it needs administrator rights ' +
          'once per boot.',
      };
    }

    /*
     * Loaded, but every loopback node is taken. Reloading the module would
     * create a free one and would also yank the device out from under whatever
     * is already using it - OBS, most likely - so that is offered only as a
     * command the user can weigh up themselves.
     */
    return {
      ...base,
      action: canAddDevice() ? 'Add loopback device' : '',
      hint: 'Adds one more loopback device without disturbing the existing ones.',
      note: canAddDevice()
        ? 'v4l2loopback is loaded but every loopback device already has a ' +
          'producer. Adding one more leaves the existing devices alone.'
        : 'v4l2loopback is loaded but every loopback device already has a ' +
          'producer. Install v4l2loopback-utils to add another without a ' +
          'reboot, or free one up by closing whatever is publishing into it.',
    };
  }

  /**
   * Create a loopback device, or take ours away again.
   *
   * Three routes, chosen by what the machine is already doing, and none of them
   * disturbs a device somebody else is using. Reloading the module would be the
   * simple answer and is deliberately not offered: it would stop OBS mid-stream
   * to save the user one command.
   */
  provision(unregister: boolean): NativeResult {
    if (!this.addon) return { ok: false, error: this.error };

    const module = this.addon.moduleStatus();

    if (unregister) {
      if (!module.loaded) return { ok: true };

      // Removing just our own device leaves any others in place. Failing that,
      // unload the module - which the kernel refuses while anything is using
      // it, so it cannot take another application's camera away.
      const device = this.addon.isRegistered().path;
      if (canAddDevice() && device) {
        return elevated('v4l2loopback-ctl', ['delete', device]);
      }
      return elevated('modprobe', ['-r', MODULE]);
    }

    if (!module.installed) {
      return {
        ok: false,
        error: 'The v4l2loopback kernel module is not installed on this machine.',
      };
    }

    if (!module.loaded) {
      /*
       * exclusive_caps=1 is not optional. Without it a loopback node advertises
       * capture from the moment it is created, and Chrome, Firefox and Zoom all
       * skip a camera that has never had a producer - so Domino would be
       * invisible in exactly the applications this feature exists for.
       */
      return elevated('modprobe', [
        MODULE,
        'devices=1',
        'exclusive_caps=1',
        `card_label=${CARD_LABEL}`,
      ]);
    }

    if (!canAddDevice()) {
      return {
        ok: false,
        error:
          'Every loopback device is in use and v4l2loopback-ctl is not ' +
          'installed, so another cannot be added without reloading the module.',
      };
    }
    return elevated('v4l2loopback-ctl', ['add', '-n', CARD_LABEL, '-x', '1']);
  }

  start(width: number, height: number, fps: number, name: string): NativeResult {
    if (!this.addon) return { ok: false, error: this.error };

    if (!this.addon.isRegistered().registered) {
      const { action } = this.setup();
      return {
        ok: false,
        error: action
          ? `There is no loopback device to publish into yet. Use "${action}" first.`
          : 'There is no loopback device to publish into, and none can be created from here.',
      };
    }
    return this.addon.start(width, height, fps, name);
  }

  stop(): void {
    this.addon?.stop();
  }

  writeFrame(frame: Buffer): NativeResult {
    if (!this.addon) return { ok: false, error: this.error };
    return this.addon.writeFrame(frame);
  }

  listCameras(): string[] {
    return this.addon?.listCameras() ?? [];
  }

  /**
   * The card label of the device we are publishing into.
   *
   * Not the name from settings, and it cannot be: the label is fixed when the
   * kernel module loads. Domino creates its device as CARD_LABEL when it is the
   * one loading the module, and otherwise takes whatever it is handed - so the
   * only honest answer is what the kernel says the device is called.
   */
  publishedName(): string {
    if (!this.addon) return '';
    const info = this.addon.deviceInfo();
    if (info.running) return info.label;
    return this.addon.listLoopbackDevices()[0]?.label ?? '';
  }

  /** What the running camera settled on, for the selftest and the e2e harness. */
  deviceInfo(): ReturnType<LinuxAddon['deviceInfo']> | null {
    return this.addon?.deviceInfo() ?? null;
  }
}

function canAddDevice(): boolean {
  return onPath('v4l2loopback-ctl');
}

function removeHint(): string {
  return canAddDevice()
    ? 'Deletes the loopback device through pkexec. Other devices are left alone.'
    : 'Unloads the v4l2loopback module through pkexec. The kernel refuses ' +
        'while another application is using a loopback device.';
}
