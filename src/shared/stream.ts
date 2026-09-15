/**
 * The streaming surface: what Domino tells OBS, and what it tells a browser
 * source. Shared by the renderer (which produces it), the main process (which
 * serves it) and the tests. Keep this file dependency-free.
 */

/** Something an OBS rule can follow. */
export type ObsSignal =
  | 'bass'
  | 'mid'
  | 'treb'
  | 'vol'
  | 'bassAtt'
  | 'midAtt'
  | 'trebAtt'
  | 'volAtt'
  | 'rms'
  | 'peak'
  | 'beatPulse'
  | 'bpm';

export const OBS_SIGNALS: ObsSignal[] = [
  'bass',
  'mid',
  'treb',
  'vol',
  'bassAtt',
  'midAtt',
  'trebAtt',
  'volAtt',
  'rms',
  'peak',
  'beatPulse',
  'bpm',
];

/**
 * When a rule acts.
 *
 * 'beat' fires on the frame a beat lands, every Nth one. 'level' follows a
 * signal continuously: a value action tracks it, a switch action gates on it,
 * a one-shot action fires as it crosses the threshold upward.
 */
export type ObsTrigger = 'beat' | 'level';

/**
 * What a rule does in OBS.
 *
 * filter-pulse   enable a filter for a moment (beat) or while a signal is high (level)
 * filter-value   write a number into a filter setting: a pulse on beat, a mapping on level
 * item-pulse     show a scene item for a moment, or while a signal is high
 * hotkey         trigger any OBS hotkey by name
 * scene          switch program scene; with no scene named, step to the next one
 */
export type ObsAction = 'filter-pulse' | 'filter-value' | 'item-pulse' | 'hotkey' | 'scene';

export const OBS_ACTIONS: ObsAction[] = ['filter-pulse', 'filter-value', 'item-pulse', 'hotkey', 'scene'];

export interface ObsRule {
  id: string;
  enabled: boolean;
  trigger: ObsTrigger;
  /** For a beat trigger: act on every Nth beat. */
  every: number;
  /** For a level trigger: the value to follow. */
  signal: ObsSignal;
  action: ObsAction;
  /** Scene for 'scene' and 'item-pulse'. Empty with 'scene' on a beat means "next scene". */
  scene: string;
  /** The input (or scene) that carries the filter, or the scene item to show. */
  source: string;
  filter: string;
  /** Setting key inside the filter, for 'filter-value'. */
  setting: string;
  /**
   * For 'filter-value': the output range. For a level-triggered switch or
   * one-shot: `min` is the threshold on the normalised 0..1 signal.
   */
  min: number;
  max: number;
  /** How long a pulse lasts, or the cooldown between one-shots, in ms. */
  holdMs: number;
  hotkey: string;
}

export function createRule(id: string): ObsRule {
  return {
    id,
    enabled: true,
    trigger: 'beat',
    every: 1,
    signal: 'bass',
    action: 'filter-pulse',
    scene: '',
    source: '',
    filter: '',
    setting: '',
    min: 0,
    max: 1,
    holdMs: 120,
    hotkey: '',
  };
}

/** Accept only a well-formed rule, filling gaps with defaults. */
export function sanitizeRule(raw: unknown): ObsRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '') return null;
  const out = createRule(r.id);
  const str = (key: keyof ObsRule): void => {
    if (typeof r[key] === 'string') (out as unknown as Record<string, unknown>)[key] = r[key];
  };
  const num = (key: keyof ObsRule): void => {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v)) (out as unknown as Record<string, unknown>)[key] = v;
  };
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (r.trigger === 'beat' || r.trigger === 'level') out.trigger = r.trigger;
  if (OBS_SIGNALS.includes(r.signal as ObsSignal)) out.signal = r.signal as ObsSignal;
  if (OBS_ACTIONS.includes(r.action as ObsAction)) out.action = r.action as ObsAction;
  for (const key of ['scene', 'source', 'filter', 'setting', 'hotkey'] as const) str(key);
  for (const key of ['every', 'min', 'max', 'holdMs'] as const) num(key);
  out.every = Math.max(1, Math.round(out.every));
  out.holdMs = Math.max(0, Math.round(out.holdMs));
  return out;
}

/** How many spectrum and waveform points a browser source receives. */
export const STREAM_BINS = 64;

/**
 * One frame of audio as it leaves the app.
 *
 * A trimmed copy of the renderer's AudioFrame: the same MilkDrop-style
 * relative bands, plus a coarse spectrum and waveform, small enough to send
 * thirty times a second as JSON without anyone noticing.
 */
export interface StreamAudioFrame {
  /** Seconds since the audio engine started. */
  t: number;
  bass: number;
  mid: number;
  treb: number;
  bassAtt: number;
  midAtt: number;
  trebAtt: number;
  vol: number;
  volAtt: number;
  rms: number;
  peak: number;
  beat: boolean;
  beatPulse: number;
  bpm: number;
  bpmConfidence: number;
  active: boolean;
  /** STREAM_BINS values in 0..1, low frequencies first. */
  spectrum: number[];
  /** STREAM_BINS samples in -1..1. */
  wave: number[];
}

/** The subset of the renderer's AudioFrame this needs; kept structural so the type stays here. */
export interface AudioFrameLike {
  time: number;
  bass: number;
  mid: number;
  treb: number;
  bassAtt: number;
  midAtt: number;
  trebAtt: number;
  vol: number;
  volAtt: number;
  rms: number;
  peak: number;
  beat: boolean;
  beatPulse: number;
  bpm: number;
  bpmConfidence: number;
  active: boolean;
  spectrum: Float32Array;
  waveL: Float32Array;
  waveR: Float32Array;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Box-average `src` down to `bins` values, rounded for the wire. */
function shrink(src: Float32Array, bins: number): number[] {
  const out = new Array<number>(bins);
  const ratio = src.length / bins;
  for (let i = 0; i < bins; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += src[j];
    out[i] = round3(sum / (end - start));
  }
  return out;
}

export function summarizeFrame(a: AudioFrameLike): StreamAudioFrame {
  const wave = new Array<number>(STREAM_BINS);
  const ratio = a.waveL.length / STREAM_BINS;
  for (let i = 0; i < STREAM_BINS; i++) {
    const j = Math.min(Math.floor(i * ratio), a.waveL.length - 1);
    wave[i] = round3((a.waveL[j] + a.waveR[j]) * 0.5);
  }
  return {
    t: round3(a.time),
    bass: round3(a.bass),
    mid: round3(a.mid),
    treb: round3(a.treb),
    bassAtt: round3(a.bassAtt),
    midAtt: round3(a.midAtt),
    trebAtt: round3(a.trebAtt),
    vol: round3(a.vol),
    volAtt: round3(a.volAtt),
    rms: round3(a.rms),
    peak: round3(a.peak),
    beat: a.beat,
    beatPulse: round3(a.beatPulse),
    bpm: Math.round(a.bpm * 10) / 10,
    bpmConfidence: round3(a.bpmConfidence),
    active: a.active,
    spectrum: shrink(a.spectrum, STREAM_BINS),
    wave,
  };
}

/**
 * A signal on a 0..1 scale, so thresholds and mappings mean the same thing
 * whichever one a rule follows.
 *
 * The relative bands sit at 1.0 for "average loudness" and swing up to about
 * 3 on a hit, so half of 2.0 puts the average at 0.5 with room above it. Tempo
 * is put against 200bpm, and the rest already live in 0..1.
 */
export function normalizeSignal(signal: ObsSignal, frame: AudioFrameLike | StreamAudioFrame): number {
  let v: number;
  switch (signal) {
    case 'bass':
    case 'mid':
    case 'treb':
    case 'vol':
    case 'bassAtt':
    case 'midAtt':
    case 'trebAtt':
    case 'volAtt':
      v = frame[signal] / 2;
      break;
    case 'bpm':
      v = frame.bpm / 200;
      break;
    default:
      v = frame[signal];
  }
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** What the main process reports about the browser-source bridge. */
export interface BridgeStatus {
  running: boolean;
  port: number;
  /** Browser sources currently connected to the audio feed. */
  clients: number;
  /** What to paste into an OBS Browser Source. */
  url: string;
  error: string;
}
