import { normalizeSignal, type AudioFrameLike, type ObsRule } from '@shared/stream';
import type { ObsRequest } from './ObsClient';

/**
 * What the director needs from a connection. ObsClient satisfies it; the
 * tests hand in a recorder.
 */
export interface ObsSender {
  readonly connected: boolean;
  send(requests: ObsRequest[]): void;
  request<T = Record<string, unknown>>(
    requestType: string,
    requestData?: Record<string, unknown>,
  ): Promise<T>;
}

/** Everything one rule remembers between ticks. */
interface RuleState {
  beats: number;
  /** Last value actually sent, so unchanged ones are not resent. */
  lastValue: number | null;
  lastOn: boolean | null;
  /** For level one-shots: whether the signal was above threshold last tick. */
  above: boolean;
  lastFiredMs: number;
  /** The pending end of a pulse. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Sends are grouped and rate limited: a value that tracks the bass changes
 * on every frame, and OBS does not need sixty writes a second to follow it.
 * Beats are the exception - they go out on the tick they happen.
 */
const LEVEL_INTERVAL_MS = 33;

/**
 * Turns audio into OBS requests, according to the rules.
 *
 * Runs once per rendered frame. Nothing here waits on OBS: requests go out
 * as fire-and-forget batches, and the one lookup that needs an answer - a
 * scene item's id - is cached after the first time.
 */
export class ObsDirector {
  private rules: ObsRule[] = [];
  private state = new Map<string, RuleState>();
  private scenes: string[] = [];
  private sceneCursor = -1;
  private itemIds = new Map<string, number | Promise<number | null>>();
  private queue: ObsRequest[] = [];
  /** Minus infinity, so the very first tick - even one at t=0 - can flush. */
  private lastLevelFlushMs = -Infinity;
  private wasConnected = false;

  constructor(private readonly client: ObsSender) {}

  setRules(rules: ObsRule[]): void {
    this.rules = rules;
    // Drop what belonged to rules that are gone, and cancel their pulses.
    const keep = new Set(rules.map((r) => r.id));
    for (const [id, s] of this.state) {
      if (keep.has(id)) continue;
      if (s.timer) clearTimeout(s.timer);
      this.state.delete(id);
    }
  }

  /** The scene list, for "next scene" rules. Order is the order OBS shows. */
  setScenes(scenes: string[]): void {
    this.scenes = scenes;
    this.itemIds.clear();
  }

  dispose(): void {
    for (const s of this.state.values()) if (s.timer) clearTimeout(s.timer);
    this.state.clear();
    this.queue = [];
  }

  private stateOf(rule: ObsRule): RuleState {
    let s = this.state.get(rule.id);
    if (!s) {
      // lastFiredMs starts at minus infinity: a cooldown measured from zero
      // would swallow the first firing of any rule for the length of the hold.
      s = { beats: 0, lastValue: null, lastOn: null, above: false, lastFiredMs: -Infinity, timer: null };
      this.state.set(rule.id, s);
    }
    return s;
  }

  /** One frame of audio. `nowMs` is any monotonic clock in milliseconds. */
  tick(frame: AudioFrameLike, nowMs: number): void {
    if (!this.client.connected) {
      // On reconnect everything is resent, because OBS may have been restarted
      // with a filter left enabled by a pulse that never got its "off".
      if (this.wasConnected) {
        for (const s of this.state.values()) {
          s.lastValue = null;
          s.lastOn = null;
        }
        this.itemIds.clear();
      }
      this.wasConnected = false;
      return;
    }
    this.wasConnected = true;

    let beatFired = false;
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.trigger === 'beat') {
        if (!frame.beat) continue;
        const s = this.stateOf(rule);
        s.beats++;
        if (s.beats % Math.max(1, rule.every) !== 0) continue;
        this.fire(rule, s, nowMs);
        beatFired = true;
      } else {
        this.follow(rule, this.stateOf(rule), normalizeSignal(rule.signal, frame), nowMs);
      }
    }

    if (this.queue.length === 0) return;
    if (beatFired || nowMs - this.lastLevelFlushMs >= LEVEL_INTERVAL_MS) {
      this.lastLevelFlushMs = nowMs;
      this.flush();
    }
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    this.client.send(batch);
  }

  /* ------------------------------- beats -------------------------------- */

  private fire(rule: ObsRule, s: RuleState, nowMs: number): void {
    s.lastFiredMs = nowMs;
    switch (rule.action) {
      case 'filter-pulse':
        this.setFilterEnabled(rule, true);
        this.after(rule, s, () => {
          this.setFilterEnabled(rule, false);
          this.flush();
        });
        break;
      case 'filter-value':
        this.setFilterValue(rule, s, rule.max);
        this.after(rule, s, () => {
          this.setFilterValue(rule, s, rule.min);
          this.flush();
        });
        break;
      case 'item-pulse':
        this.setItemEnabled(rule, true);
        this.after(rule, s, () => {
          this.setItemEnabled(rule, false);
          this.flush();
        });
        break;
      case 'hotkey':
        if (rule.hotkey) {
          this.queue.push({
            requestType: 'TriggerHotkeyByName',
            requestData: { hotkeyName: rule.hotkey },
          });
        }
        break;
      case 'scene':
        this.switchScene(rule);
        break;
    }
  }

  /** Schedule the end of a pulse; a new beat inside the hold restarts it. */
  private after(rule: ObsRule, s: RuleState, end: () => void): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(
      () => {
        s.timer = null;
        end();
      },
      Math.max(0, rule.holdMs),
    );
  }

  /* ------------------------------- levels ------------------------------- */

  private follow(rule: ObsRule, s: RuleState, level: number, nowMs: number): void {
    switch (rule.action) {
      case 'filter-value': {
        const value = rule.min + level * (rule.max - rule.min);
        this.setFilterValue(rule, s, value);
        break;
      }
      case 'filter-pulse':
      case 'item-pulse': {
        const on = level >= rule.min;
        if (on === s.lastOn) return;
        if (rule.action === 'filter-pulse') this.setFilterEnabled(rule, on);
        else this.setItemEnabled(rule, on);
        break;
      }
      case 'hotkey':
      case 'scene': {
        // A rising edge with a little hysteresis, so a signal hovering on the
        // threshold does not machine-gun the hotkey.
        const above = s.above ? level >= rule.min * 0.8 : level >= rule.min;
        const rose = above && !s.above;
        s.above = above;
        if (!rose || nowMs - s.lastFiredMs < rule.holdMs) return;
        this.fire(rule, s, nowMs);
        break;
      }
    }
  }

  /* ------------------------------ requests ------------------------------ */

  private setFilterEnabled(rule: ObsRule, on: boolean): void {
    if (!rule.source || !rule.filter) return;
    const s = this.stateOf(rule);
    if (s.lastOn === on) return;
    s.lastOn = on;
    this.queue.push({
      requestType: 'SetSourceFilterEnabled',
      requestData: { sourceName: rule.source, filterName: rule.filter, filterEnabled: on },
    });
  }

  private setFilterValue(rule: ObsRule, s: RuleState, value: number): void {
    if (!rule.source || !rule.filter || !rule.setting) return;
    // Below a two-hundredth of the range nobody can see the difference, and
    // it keeps a steady signal from producing a stream of identical writes.
    const eps = Math.abs(rule.max - rule.min) / 200;
    if (s.lastValue !== null && Math.abs(value - s.lastValue) <= eps) return;
    s.lastValue = value;
    this.queue.push({
      requestType: 'SetSourceFilterSettings',
      requestData: {
        sourceName: rule.source,
        filterName: rule.filter,
        filterSettings: { [rule.setting]: Math.round(value * 10000) / 10000 },
        overlay: true,
      },
    });
  }

  private setItemEnabled(rule: ObsRule, on: boolean): void {
    if (!rule.scene || !rule.source) return;
    const id = this.sceneItemId(rule.scene, rule.source);
    // Not known yet: the lookup is on its way, and this beat is missed rather
    // than delayed into the wrong moment.
    if (typeof id !== 'number') return;
    const s = this.stateOf(rule);
    if (s.lastOn === on) return;
    s.lastOn = on;
    this.queue.push({
      requestType: 'SetSceneItemEnabled',
      requestData: { sceneName: rule.scene, sceneItemId: id, sceneItemEnabled: on },
    });
  }

  private sceneItemId(scene: string, source: string): number | null {
    const key = JSON.stringify([scene, source]);
    const cached = this.itemIds.get(key);
    if (typeof cached === 'number') return cached;
    if (cached) return null; // lookup in flight
    const lookup = this.client
      .request<{ sceneItemId: number }>('GetSceneItemId', { sceneName: scene, sourceName: source })
      .then((r) => {
        this.itemIds.set(key, r.sceneItemId);
        return r.sceneItemId;
      })
      .catch(() => {
        // Let the next tick try again rather than caching the failure.
        this.itemIds.delete(key);
        return null;
      });
    this.itemIds.set(key, lookup);
    return null;
  }

  private switchScene(rule: ObsRule): void {
    let target = rule.scene;
    if (!target) {
      if (this.scenes.length === 0) return;
      this.sceneCursor = (this.sceneCursor + 1) % this.scenes.length;
      target = this.scenes[this.sceneCursor];
    }
    this.queue.push({ requestType: 'SetCurrentProgramScene', requestData: { sceneName: target } });
  }
}
