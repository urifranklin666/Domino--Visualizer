import {
  findNative,
  sameBinary,
  type NativeResult,
  type SetupState,
  type VirtualCameraBackend,
} from './vcam-support';

/**
 * Windows backend: a Media Foundation media source, hosted by the Frame Server.
 *
 * Windows will not let an application simply be a camera. The camera is a COM
 * class that Windows creates inside its own Frame Server process, so publishing
 * takes a DLL registered machine-wide and a shared-memory channel to get frames
 * across the process boundary. Both live in the native module; this is the part
 * that decides when to ask the user for the one thing only they can grant.
 */

interface WindowsAddon {
  registerSource(dllPath: string): NativeResult;
  registerSourceElevated(dllPath: string, unregister: boolean): NativeResult;
  unregisterSource(): NativeResult;
  isRegistered(): { registered: boolean; path: string };
  start(width: number, height: number, fps: number, name: string): NativeResult;
  stop(): NativeResult;
  removeCamera(name: string): NativeResult;
  isRunning(): boolean;
  writeFrame(frame: Buffer): NativeResult;
  listCameras(): string[];
}

export class WindowsBackend implements VirtualCameraBackend {
  private addon: WindowsAddon | null = null;
  private error = '';
  private attempted = false;
  private name = '';

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
      this.addon = require(module) as WindowsAddon;
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

  /** The media source DLL, or an empty string when this build has none. */
  sourcePath(): string {
    return findNative('domino_vcam_source.dll');
  }

  setup(): SetupState {
    const registration = this.addon?.isRegistered() ?? { registered: false, path: '' };
    const dll = this.sourcePath();
    const isThisBuild =
      registration.registered && sameBinary(registration.path, dll);

    return {
      ready: registration.registered,
      path: registration.path,
      isThisBuild,
      action: registration.registered
        ? isThisBuild
          ? 'Unregister camera driver'
          : 'Re-register camera driver'
        : 'Register camera driver',
      // Undoing it is the same elevation for the opposite reason, and saying
      // so matters: "runs regsvr32" under a button marked Unregister reads
      // like the button is about to install something.
      hint:
        registration.registered && isThisBuild
          ? 'Removes the machine-wide registration. Also needs administrator rights.'
          : 'Runs regsvr32 as administrator. Windows will show its usual prompt.',
      note: !registration.registered
        ? 'Windows loads the camera driver in its own process, which needs a ' +
          'one-time machine-wide registration. This asks for administrator ' +
          'rights once and never again.'
        : !isThisBuild
          ? 'A different copy of Domino is registered as the camera driver ' +
            `(${registration.path}). Re-register to point Windows at this one.`
          : '',
    };
  }

  /**
   * Register the media source with Windows, prompting for administrator rights.
   *
   * A deliberate, user-initiated step rather than something the app does at
   * startup: it writes a machine-wide COM registration, and an app that quietly
   * asks for elevation the first time it runs has earned suspicion.
   */
  provision(unregister: boolean): NativeResult {
    if (!this.addon) return { ok: false, error: this.error };

    const dll = this.sourcePath();
    if (!dll) {
      return { ok: false, error: 'The camera driver was not included in this copy of Domino.' };
    }

    /*
     * Unregistering clears the device too, including an orphan left behind by
     * v0.4.0 - which published a persistent camera that outlived the app and
     * then served black frames to anything that selected it.
     */
    if (unregister) this.addon.removeCamera('Domino Visualizer');

    const result = this.addon.registerSourceElevated(dll, unregister);
    return result.ok ? result : { ok: false, error: result.error ?? 'Registration did not complete.' };
  }

  start(width: number, height: number, fps: number, name: string): NativeResult {
    if (!this.addon) return { ok: false, error: this.error };

    if (!this.addon.isRegistered().registered) {
      // Say what has to happen rather than only that it failed. Registration is
      // a one-time administrator step, and without this the user has no way to
      // know that from the app.
      return {
        ok: false,
        error:
          'The camera driver is not registered yet. Use "Register camera driver" ' +
          'first - it needs administrator rights once.',
      };
    }

    /*
     * The device lives only while Domino does.
     *
     * A persistent one was tried, so that Domino could be selected in a call
     * that was already open, and it does not work: with a persistent device
     * published and Domino producing, consumers get zero frames. See the note
     * on VirtualCamera::Start.
     */
    this.name = name;
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

  /** Whatever we published under - Windows takes the name it is given. */
  publishedName(): string {
    return this.name;
  }
}
