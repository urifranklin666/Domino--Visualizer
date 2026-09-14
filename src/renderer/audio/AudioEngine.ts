import { BeatDetector } from './BeatDetector';
import {
  createEmptyFrame,
  SPEC_SAMPLES,
  WAVE_SAMPLES,
  type AudioFrame,
  type SourceKind,
  type SourceStatus,
} from './types';

export interface AudioEngineOptions {
  fftSize: number;
  smoothing: number;
  gain: number;
  beatSensitivity: number;
}

/**
 * Owns the Web Audio graph and turns whatever is playing into an AudioFrame.
 *
 * Graph shape:
 *
 *   source -> inputGain -> splitter -> analyserL
 *                                   -> analyserR
 *                       -> monitorGain -> destination   (file playback only)
 *
 * Capture sources are deliberately NOT routed to the destination: feeding the
 * system loopback back into the system output is a feedback loop.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private inputGain: GainNode | null = null;
  private monitorGain: GainNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private sourceNode: AudioNode | null = null;
  private stream: MediaStream | null = null;
  private element: HTMLAudioElement | null = null;

  private timeBufL = new Float32Array(2048);
  private timeBufR = new Float32Array(2048);
  private freqBufL = new Float32Array(1024);
  private freqBufR = new Float32Array(1024);

  private readonly beatDetector = new BeatDetector();
  private readonly frame: AudioFrame = createEmptyFrame();

  /** Long-term band averages backing the MilkDrop-style relative levels. */
  private avgBass = 0.02;
  private avgMid = 0.02;
  private avgTreb = 0.02;
  private attBass = 0;
  private attMid = 0;
  private attTreb = 0;
  private attVol = 0;
  private warmupFrames = 0;

  private startTime = 0;
  private lastTime = 0;
  private frameCount = 0;

  private status: SourceStatus = { kind: 'none', label: 'No input', active: false };
  private statusListeners = new Set<(s: SourceStatus) => void>();

  options: AudioEngineOptions = {
    fftSize: 2048,
    smoothing: 0.72,
    gain: 1,
    beatSensitivity: 1,
  };

  /* --------------------------- graph plumbing --------------------------- */

  private ensureContext(): AudioContext {
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.inputGain = ctx.createGain();
    this.inputGain.gain.value = this.options.gain;

    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.monitorGain.connect(ctx.destination);

    this.splitter = ctx.createChannelSplitter(2);

    this.analyserL = ctx.createAnalyser();
    this.analyserR = ctx.createAnalyser();
    this.applyAnalyserSettings();

    this.inputGain.connect(this.splitter);
    this.inputGain.connect(this.monitorGain);
    this.splitter.connect(this.analyserL, 0);
    // A mono source only has channel 0; splitter output 1 would be silent, so
    // fall back to feeding both analysers from the same channel in that case.
    this.splitter.connect(this.analyserR, 1);

    this.startTime = ctx.currentTime;
    this.lastTime = ctx.currentTime;
    return ctx;
  }

  private applyAnalyserSettings(): void {
    const size = Math.min(Math.max(1 << Math.round(Math.log2(this.options.fftSize)), 512), 16384);
    for (const analyser of [this.analyserL, this.analyserR]) {
      if (!analyser) continue;
      analyser.fftSize = size;
      analyser.smoothingTimeConstant = Math.min(Math.max(this.options.smoothing, 0), 0.99);
      analyser.minDecibels = -100;
      analyser.maxDecibels = -12;
    }
    if (this.timeBufL.length !== size) {
      this.timeBufL = new Float32Array(size);
      this.timeBufR = new Float32Array(size);
      this.freqBufL = new Float32Array(size / 2);
      this.freqBufR = new Float32Array(size / 2);
    }
  }

  setOptions(patch: Partial<AudioEngineOptions>): void {
    const fftChanged = patch.fftSize !== undefined && patch.fftSize !== this.options.fftSize;
    Object.assign(this.options, patch);
    if (this.inputGain) this.inputGain.gain.value = this.options.gain;
    this.applyAnalyserSettings();
    if (fftChanged) this.beatDetector.reset();
  }

  onStatus(cb: (s: SourceStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  private setStatus(next: SourceStatus): void {
    this.status = next;
    for (const cb of this.statusListeners) cb(next);
  }

  getStatus(): SourceStatus {
    return this.status;
  }

  /* ------------------------------- sources ------------------------------- */

  /** Tears down the current source without disturbing the analysis graph. */
  private disconnectSource(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* already gone */
      }
      this.sourceNode = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.element) {
      this.element.pause();
      this.element.removeAttribute('src');
      this.element.load();
      this.element = null;
    }
    if (this.monitorGain) this.monitorGain.gain.value = 0;
  }

  private attachStream(stream: MediaStream, kind: SourceKind, label: string): void {
    const ctx = this.ensureContext();
    this.disconnectSource();
    this.stream = stream;

    const node = ctx.createMediaStreamSource(stream);
    node.connect(this.inputGain!);
    this.sourceNode = node;

    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings?.() ?? {};

    // Chromium sometimes ends a loopback track on its own (device switch,
    // exclusive-mode app grabbing the endpoint). Surface it instead of silently
    // showing a dead visualizer.
    track?.addEventListener('ended', () => {
      if (this.status.kind === kind) {
        this.setStatus({ kind: 'none', label: 'Input ended', active: false });
      }
    });

    this.resetAnalysis();
    void ctx.resume();
    this.setStatus({
      kind,
      label,
      active: true,
      sampleRate: settings.sampleRate ?? ctx.sampleRate,
      channels: settings.channelCount ?? 2,
    });
  }

  /**
   * Capture everything the computer is playing.
   *
   * Two routes, because the operating systems genuinely differ.
   *
   * On Windows the main process answers our getDisplayMedia request with
   * `audio: 'loopback'`, which is Chromium's WASAPI render-endpoint loopback -
   * the full output mix, no source picker. We ask for video because
   * getDisplayMedia is defined in terms of it, then stop that track at once so
   * we never pay for screen capture.
   *
   * On Linux that does not exist, and Chromium hides PulseAudio's monitor
   * sources from enumerateDevices(), so there is no device to pick either. The
   * main process instead points PULSE_SOURCE at the monitor of the default
   * sink before the audio service starts, which makes the plain *default*
   * capture device the desktop mix - so here that is simply what we open.
   */
  async captureSystemAudio(): Promise<void> {
    try {
      const mode = window.domino?.audioLoopback ?? 'display-loopback';

      if (mode === 'none') {
        throw new Error(
          'No PulseAudio or PipeWire server was found, so there is no way to ' +
            'capture desktop audio on this machine.',
        );
      }

      const stream =
        mode === 'pulse-monitor'
          ? await this.openDefaultCapture()
          : await this.openDisplayLoopback();

      if (stream.getAudioTracks().length === 0) {
        throw new Error(
          'No audio track came back. System loopback capture may be unavailable on this machine.',
        );
      }

      this.attachStream(stream, 'loopback', 'System Audio');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ kind: 'none', label: 'System audio failed', active: false, error: message });
      throw err;
    }
  }

  /** The Windows route: a loopback audio track dressed up as screen capture. */
  private async openDisplayLoopback(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        // Every bit of "helpful" processing distorts what we're visualizing.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } as MediaTrackConstraints,
    });

    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    return stream;
  }

  /**
   * The Linux route: the default capture device, which main has redirected.
   *
   * Asking for 'default' by name rather than leaving deviceId unset is
   * deliberate. They behave the same today, but the distinction is the whole
   * mechanism here, and an unconstrained request is exactly the kind of thing
   * a future Chromium could answer with "the most recently used microphone".
   */
  private async openDefaultCapture(): Promise<MediaStream> {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: 'default' },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  }

  /**
   * Listen to a microphone.
   *
   * With no device named this normally means "whatever the system default is",
   * but on Linux the main process has redirected that default to the desktop
   * output mix - so asking for it would hand back the music rather than the
   * room, under a label saying Microphone. Where that redirection is in force,
   * an unqualified request resolves to a real input device first.
   */
  async captureMicrophone(deviceId?: string): Promise<void> {
    try {
      const id =
        deviceId ??
        (window.domino?.audioLoopback === 'pulse-monitor'
          ? await this.firstRealInputDevice()
          : undefined);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: id ? { exact: id } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      const label = stream.getAudioTracks()[0]?.label || 'Microphone';
      this.attachStream(stream, deviceId ? 'device' : 'microphone', label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ kind: 'none', label: 'Mic failed', active: false, error: message });
      throw err;
    }
  }

  /** Plays a local file and visualizes it, routing audio to the speakers too. */
  async playFile(src: string, label: string): Promise<HTMLAudioElement> {
    const ctx = this.ensureContext();
    this.disconnectSource();

    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.src = src;
    el.loop = false;
    this.element = el;

    const node = ctx.createMediaElementSource(el);
    node.connect(this.inputGain!);
    this.sourceNode = node;
    this.monitorGain!.gain.value = 1;

    this.resetAnalysis();
    await ctx.resume();
    await el.play();

    this.setStatus({ kind: 'file', label, active: true, sampleRate: ctx.sampleRate, channels: 2 });
    return el;
  }

  stop(): void {
    this.disconnectSource();
    this.resetAnalysis();
    this.setStatus({ kind: 'none', label: 'No input', active: false });
  }

  async listInputDevices(): Promise<MediaDeviceInfo[]> {
    // Labels are blank until some capture permission has been granted once.
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  /**
   * A named capture device, skipping the aliases.
   *
   * 'default' and 'communications' are Chromium's indirections rather than
   * hardware, and 'default' is precisely the one pointed at the desktop mix.
   * Returns undefined when there is nothing else, which leaves the caller to
   * fall back to an unconstrained request - wrong, but less wrong than
   * refusing to open a microphone at all.
   */
  private async firstRealInputDevice(): Promise<string | undefined> {
    try {
      const devices = await this.listInputDevices();
      return devices.find((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
        ?.deviceId;
    } catch {
      return undefined;
    }
  }

  private resetAnalysis(): void {
    this.beatDetector.reset();
    this.avgBass = this.avgMid = this.avgTreb = 0.02;
    this.attBass = this.attMid = this.attTreb = this.attVol = 0;
    this.warmupFrames = 0;
  }

  /* ------------------------------ analysis ------------------------------ */

  /**
   * Read the analysers and produce the frame for this render tick.
   * Returns the same object every call - copy it if you need to retain it.
   */
  analyse(): AudioFrame {
    const frame = this.frame;
    const ctx = this.ctx;

    const now = ctx ? ctx.currentTime : performance.now() / 1000;
    let dt = now - this.lastTime;
    if (!(dt > 0) || dt > 0.25) dt = 1 / 60;
    this.lastTime = now;

    frame.time = ctx ? now - this.startTime : frame.time + dt;
    frame.dt = dt;
    frame.frame = ++this.frameCount;

    if (!ctx || !this.analyserL || !this.analyserR || !this.status.active) {
      this.decayToSilence(frame, dt);
      return frame;
    }

    this.analyserL.getFloatTimeDomainData(this.timeBufL);
    this.analyserR.getFloatTimeDomainData(this.timeBufR);
    this.analyserL.getFloatFrequencyData(this.freqBufL);
    this.analyserR.getFloatFrequencyData(this.freqBufR);

    resampleInto(this.timeBufL, frame.waveL);
    resampleInto(this.timeBufR, frame.waveR);
    // A mono capture leaves the right analyser silent; mirror the left so
    // stereo-aware presets don't render half a picture.
    if (isSilent(frame.waveR) && !isSilent(frame.waveL)) frame.waveR.set(frame.waveL);

    dbToLinearInto(this.freqBufL, frame.specL, this.analyserL.minDecibels, this.analyserL.maxDecibels);
    dbToLinearInto(this.freqBufR, frame.specR, this.analyserR.minDecibels, this.analyserR.maxDecibels);
    for (let i = 0; i < SPEC_SAMPLES; i++) {
      frame.spectrum[i] = (frame.specL[i] + frame.specR[i]) * 0.5;
    }

    // Absolute loudness, straight from the waveform.
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < WAVE_SAMPLES; i++) {
      const l = frame.waveL[i];
      const r = frame.waveR[i];
      sumSq += l * l + r * r;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
    }
    frame.rms = Math.sqrt(sumSq / (WAVE_SAMPLES * 2));
    frame.peak = peak;

    /*
     * Band energies.
     *
     * The analyser's bins are linear in frequency, so with a 44.1kHz context and
     * 512 exported bins, bass lives in roughly the first 3% of the array. These
     * splits (~250Hz and ~2.5kHz) match MilkDrop's own band boundaries closely
     * enough that presets behave the way their authors intended.
     */
    const sampleRate = ctx.sampleRate;
    const nyquist = sampleRate / 2;
    const bassEnd = Math.max(2, Math.round((250 / nyquist) * SPEC_SAMPLES));
    const midEnd = Math.max(bassEnd + 2, Math.round((2500 / nyquist) * SPEC_SAMPLES));

    const immBass = bandEnergy(frame.spectrum, 0, bassEnd);
    const immMid = bandEnergy(frame.spectrum, bassEnd, midEnd);
    const immTreb = bandEnergy(frame.spectrum, midEnd, SPEC_SAMPLES);

    // Long-term averages: adapt over a couple of seconds, and rise faster than
    // they fall so a sudden loud section doesn't stay pinned at maximum.
    const adapt = 1 - Math.exp(-dt / 2.2);
    this.avgBass += (immBass - this.avgBass) * adapt;
    this.avgMid += (immMid - this.avgMid) * adapt;
    this.avgTreb += (immTreb - this.avgTreb) * adapt;

    const FLOOR = 0.0015;
    frame.bass = clamp(immBass / Math.max(this.avgBass, FLOOR), 0, 8);
    frame.mid = clamp(immMid / Math.max(this.avgMid, FLOOR), 0, 8);
    frame.treb = clamp(immTreb / Math.max(this.avgTreb, FLOOR), 0, 8);

    // With no signal at all the ratios sit at a meaningless 1.0; force them down.
    const silent = frame.rms < 1e-4;
    if (silent) {
      frame.bass = frame.mid = frame.treb = 0;
    }

    // During the first moments the averages haven't converged, so scale the
    // output up gradually instead of flashing something wrong on screen.
    if (this.warmupFrames < 45) {
      this.warmupFrames++;
      const t = this.warmupFrames / 45;
      frame.bass *= t;
      frame.mid *= t;
      frame.treb *= t;
    }

    this.attBass = attenuate(this.attBass, frame.bass, dt);
    this.attMid = attenuate(this.attMid, frame.mid, dt);
    this.attTreb = attenuate(this.attTreb, frame.treb, dt);
    frame.bassAtt = this.attBass;
    frame.midAtt = this.attMid;
    frame.trebAtt = this.attTreb;

    frame.vol = (frame.bass + frame.mid + frame.treb) / 3;
    this.attVol = attenuate(this.attVol, frame.vol, dt);
    frame.volAtt = this.attVol;

    const beat = this.beatDetector.update(
      frame.spectrum,
      frame.time,
      dt,
      this.options.beatSensitivity,
    );
    frame.beat = beat.beat && !silent;
    frame.beatIntensity = beat.intensity;
    frame.beatPulse = beat.pulse;
    frame.bpm = beat.bpm;
    frame.bpmConfidence = beat.confidence;
    frame.active = !silent;

    return frame;
  }

  /** Ease everything to zero when input stops, so visuals wind down smoothly. */
  private decayToSilence(frame: AudioFrame, dt: number): void {
    const decay = Math.exp(-dt / 0.35);
    frame.bass *= decay;
    frame.mid *= decay;
    frame.treb *= decay;
    frame.bassAtt *= decay;
    frame.midAtt *= decay;
    frame.trebAtt *= decay;
    frame.vol *= decay;
    frame.volAtt *= decay;
    frame.rms *= decay;
    frame.peak *= decay;
    frame.beatPulse *= decay;
    frame.beat = false;
    frame.beatIntensity = 0;
    frame.active = false;
    for (let i = 0; i < SPEC_SAMPLES; i++) {
      frame.spectrum[i] *= decay;
      frame.specL[i] *= decay;
      frame.specR[i] *= decay;
    }
    for (let i = 0; i < WAVE_SAMPLES; i++) {
      frame.waveL[i] *= decay;
      frame.waveR[i] *= decay;
    }
  }

  dispose(): void {
    this.disconnectSource();
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close();
    this.ctx = null;
    this.statusListeners.clear();
  }
}

/* ------------------------------- helpers -------------------------------- */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Fast-attack, slow-release follower. Rising edges arrive almost immediately so
 * hits feel tight; falling edges linger so motion doesn't stutter.
 */
function attenuate(current: number, target: number, dt: number): number {
  const tau = target > current ? 0.045 : 0.28;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

function bandEnergy(spec: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += spec[i] * spec[i];
  return Math.sqrt(sum / Math.max(to - from, 1));
}

function isSilent(buf: Float32Array): boolean {
  for (let i = 0; i < buf.length; i += 8) {
    if (Math.abs(buf[i]) > 1e-5) return false;
  }
  return true;
}

/** Box-average `src` down (or copy up) into `dst`, whatever the size ratio. */
function resampleInto(src: Float32Array, dst: Float32Array): void {
  const ratio = src.length / dst.length;
  if (ratio === 1) {
    dst.set(src);
    return;
  }
  if (ratio < 1) {
    for (let i = 0; i < dst.length; i++) dst[i] = src[Math.min(Math.floor(i * ratio), src.length - 1)];
    return;
  }
  const step = Math.floor(ratio);
  for (let i = 0; i < dst.length; i++) {
    const start = Math.floor(i * ratio);
    let sum = 0;
    for (let j = 0; j < step; j++) sum += src[Math.min(start + j, src.length - 1)];
    dst[i] = sum / step;
  }
}

/**
 * Convert the analyser's dB output to 0..1 and resize to SPEC_SAMPLES.
 * Bins are averaged rather than sampled so nothing is dropped on the way down.
 */
function dbToLinearInto(src: Float32Array, dst: Float32Array, minDb: number, maxDb: number): void {
  const range = Math.max(maxDb - minDb, 1);
  const ratio = src.length / dst.length;
  for (let i = 0; i < dst.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < src.length; j++) {
      const db = src[j];
      sum += db < minDb ? 0 : (db - minDb) / range;
      count++;
    }
    dst[i] = count > 0 ? clamp(sum / count, 0, 1) : 0;
  }
}
