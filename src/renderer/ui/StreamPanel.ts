import type { AppSettings } from '@shared/types';
import {
  createRule,
  OBS_ACTIONS,
  OBS_SIGNALS,
  type BridgeStatus,
  type ObsAction,
  type ObsRule,
  type ObsSignal,
  type ObsTrigger,
} from '@shared/stream';
import type { ObsStatus } from '../obs/ObsClient';

/**
 * The Stream tab: OBS on one side, a browser source on the other.
 *
 * The OBS half is a connection and a list of rules - "on every beat, pulse
 * this filter", "follow the bass with that setting". The names a rule points
 * at are typed into fields backed by lists fetched from OBS, so they can be
 * picked when OBS is connected and still typed when it is not.
 *
 * Rules are edited in place. Every field commits on change rather than on
 * each keystroke, and only the selects that alter a card's shape rebuild it,
 * so the focus never jumps out from under a name half typed.
 */

export interface FilterInfo {
  name: string;
  kind: string;
  settings: string[];
}

export interface ObsCatalog {
  scenes: string[];
  inputs: string[];
  hotkeys: string[];
  /** Filters per source, fetched on demand. */
  filters: Map<string, FilterInfo[]>;
  /** Scene item source names per scene, fetched on demand. */
  items: Map<string, string[]>;
}

const ACTION_LABELS: Record<ObsAction, string> = {
  'filter-pulse': 'Switch a filter on',
  'filter-value': 'Set a filter value',
  'item-pulse': 'Show a scene item',
  hotkey: 'Trigger a hotkey',
  scene: 'Switch scene',
};

const SIGNAL_LABELS: Record<ObsSignal, string> = {
  bass: 'Bass',
  mid: 'Mid',
  treb: 'Treble',
  vol: 'Volume',
  bassAtt: 'Bass (smoothed)',
  midAtt: 'Mid (smoothed)',
  trebAtt: 'Treble (smoothed)',
  volAtt: 'Volume (smoothed)',
  rms: 'Loudness (RMS)',
  peak: 'Peak',
  beatPulse: 'Beat pulse',
  bpm: 'Tempo',
};

let datalistSeq = 0;

export class StreamPanel {
  private host: HTMLElement;
  private settings: AppSettings;
  private rulesHost: HTMLElement | null = null;
  private obsNote: HTMLElement | null = null;
  private bridgeNote: HTMLElement | null = null;
  private refreshButton: HTMLButtonElement | null = null;

  obsStatus: ObsStatus = { state: 'off', obsVersion: '', error: '', requestsSent: 0, lastError: '' };
  bridgeStatus: BridgeStatus = { running: false, port: 0, clients: 0, url: '', error: '' };
  catalog: ObsCatalog = { scenes: [], inputs: [], hotkeys: [], filters: new Map(), items: new Map() };

  onChange: ((patch: Partial<AppSettings>) => void) | null = null;
  onRulesChange: ((rules: ObsRule[]) => void) | null = null;
  onObsEnabled: ((on: boolean) => void) | null = null;
  onBridgeEnabled: ((on: boolean) => void) | null = null;
  onRefreshCatalog: (() => void) | null = null;
  /** Asked when a rule names a source or scene the catalogue has no detail for. */
  onLookup: ((kind: 'filters' | 'items', name: string) => void) | null = null;
  onCopyUrl: ((url: string) => void) | null = null;

  constructor(host: HTMLElement, settings: AppSettings) {
    this.host = host;
    this.settings = settings;
  }

  setSettings(settings: AppSettings): void {
    this.settings = settings;
  }

  /* -------------------------------- render ------------------------------ */

  render(): void {
    this.host.replaceChildren();
    const fragment = document.createDocumentFragment();
    fragment.appendChild(this.buildObsSection());
    fragment.appendChild(this.buildRulesSection());
    fragment.appendChild(this.buildBridgeSection());
    this.host.appendChild(fragment);
    this.refreshStatus();
  }

  /** Update the live lines without rebuilding anything the user may be editing. */
  refreshStatus(): void {
    if (this.obsNote) {
      this.obsNote.textContent = this.obsText();
      this.obsNote.classList.toggle('is-error', this.obsStatus.state === 'error');
      this.obsNote.classList.toggle('is-ok', this.obsStatus.state === 'connected');
    }
    if (this.refreshButton) this.refreshButton.disabled = this.obsStatus.state !== 'connected';
    if (this.bridgeNote) {
      this.bridgeNote.textContent = this.bridgeText();
      this.bridgeNote.classList.toggle('is-error', Boolean(this.bridgeStatus.error));
      this.bridgeNote.classList.toggle('is-ok', this.bridgeStatus.running);
    }
  }

  /** Rebuild the rule cards, e.g. after a lookup filled in a list. */
  renderRules(): void {
    if (!this.rulesHost) return;
    this.rulesHost.replaceChildren();
    for (const rule of this.settings.obsRules) this.rulesHost.appendChild(this.buildRule(rule));
  }

  private obsText(): string {
    const s = this.obsStatus;
    switch (s.state) {
      case 'off':
        return 'Off. Turn on the WebSocket server in OBS under Tools, then switch this on.';
      case 'connecting':
        return `Connecting to ${this.settings.obsHost}:${this.settings.obsPort}...`;
      case 'error':
        return s.error;
      case 'connected': {
        const version = s.obsVersion ? `OBS ${s.obsVersion}` : 'OBS';
        const sent = s.requestsSent > 0 ? `, ${s.requestsSent} sent` : '';
        const complaint = s.lastError ? ` Last problem: ${s.lastError}` : '';
        return `Connected to ${version}${sent}.${complaint}`;
      }
    }
  }

  private bridgeText(): string {
    const b = this.bridgeStatus;
    if (b.error) return b.error;
    if (!b.running) {
      return 'Off. Switch on to serve the audio analysis to a Browser Source on this machine.';
    }
    const pages = b.clients === 1 ? '1 page connected' : `${b.clients} pages connected`;
    return `Serving at ${b.url} - ${pages}.`;
  }

  /* --------------------------------- OBS -------------------------------- */

  private buildObsSection(): HTMLElement {
    const section = group('OBS');

    section.appendChild(
      toggle('Connect to OBS', this.settings.obsEnabled, (on) => this.onObsEnabled?.(on), {
        help: 'Drives OBS over its WebSocket server (OBS 28 or newer, Tools > WebSocket Server Settings).',
      }),
    );
    section.appendChild(
      textField('Host', this.settings.obsHost, (v) => this.onChange?.({ obsHost: v || '127.0.0.1' })),
    );
    section.appendChild(
      numberField('Port', this.settings.obsPort, 1, 65535, 1, (v) => this.onChange?.({ obsPort: v })),
    );
    section.appendChild(
      textField('Password', this.settings.obsPassword, (v) => this.onChange?.({ obsPassword: v }), {
        password: true,
        help: 'From the WebSocket Server Settings dialog. Kept in Domino’s settings file and sent only to the host above.',
      }),
    );

    this.obsNote = note('');
    section.appendChild(this.obsNote);

    this.refreshButton = document.createElement('button');
    this.refreshButton.className = 'btn btn-ghost';
    this.refreshButton.style.width = '100%';
    this.refreshButton.textContent = 'Refresh scenes, sources and hotkeys';
    this.refreshButton.addEventListener('click', () => this.onRefreshCatalog?.());
    section.appendChild(this.refreshButton);

    return section;
  }

  /* -------------------------------- rules ------------------------------- */

  private buildRulesSection(): HTMLElement {
    const section = group('Rules');

    this.rulesHost = document.createElement('div');
    this.rulesHost.className = 'rules';
    section.appendChild(this.rulesHost);
    this.renderRules();

    const add = document.createElement('button');
    add.className = 'btn btn-ghost';
    add.style.width = '100%';
    add.textContent = '+ Add rule';
    add.addEventListener('click', () => {
      const rule = createRule(`r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`);
      this.settings.obsRules = [...this.settings.obsRules, rule];
      this.commitRules();
      this.rulesHost?.appendChild(this.buildRule(rule));
    });
    section.appendChild(add);

    const help = note(
      'A beat rule acts on the beat. A level rule follows a signal: a value tracks it, ' +
        'a switch holds while it is above the threshold, a hotkey or scene fires as it crosses.',
    );
    section.appendChild(help);
    return section;
  }

  private commitRules(): void {
    this.onRulesChange?.(this.settings.obsRules);
  }

  private buildRule(rule: ObsRule): HTMLElement {
    const card = document.createElement('div');
    card.className = 'rule';
    card.classList.toggle('is-off', !rule.enabled);

    const rebuild = (): void => {
      const next = this.buildRule(rule);
      card.replaceWith(next);
    };

    /* header: enable, summary, remove */
    const head = document.createElement('div');
    head.className = 'rule-head';

    const enable = document.createElement('input');
    enable.type = 'checkbox';
    enable.checked = rule.enabled;
    enable.title = 'Rule on or off';
    enable.addEventListener('change', () => {
      rule.enabled = enable.checked;
      card.classList.toggle('is-off', !rule.enabled);
      this.commitRules();
    });

    const summary = document.createElement('span');
    summary.className = 'rule-summary';
    summary.textContent = describeRule(rule);

    const remove = document.createElement('button');
    remove.className = 'btn btn-ghost btn-tiny';
    remove.textContent = '×';
    remove.title = 'Remove this rule';
    remove.addEventListener('click', () => {
      this.settings.obsRules = this.settings.obsRules.filter((r) => r !== rule);
      this.commitRules();
      card.remove();
    });

    head.append(enable, summary, remove);
    card.appendChild(head);

    const touched = (): void => {
      summary.textContent = describeRule(rule);
      this.commitRules();
    };

    /* trigger */
    card.appendChild(
      selectField(
        'When',
        [
          ['beat', 'On the beat'],
          ['level', 'Following a level'],
        ],
        rule.trigger,
        (v) => {
          rule.trigger = v as ObsTrigger;
          touched();
          rebuild();
        },
      ),
    );

    if (rule.trigger === 'beat') {
      card.appendChild(
        numberField('Every N beats', rule.every, 1, 64, 1, (v) => {
          rule.every = Math.max(1, Math.round(v));
          touched();
        }),
      );
    } else {
      card.appendChild(
        selectField(
          'Signal',
          OBS_SIGNALS.map((s) => [s, SIGNAL_LABELS[s]]),
          rule.signal,
          (v) => {
            rule.signal = v as ObsSignal;
            touched();
          },
        ),
      );
    }

    /* action */
    card.appendChild(
      selectField(
        'Do',
        OBS_ACTIONS.map((a) => [a, ACTION_LABELS[a]]),
        rule.action,
        (v) => {
          rule.action = v as ObsAction;
          touched();
          rebuild();
        },
      ),
    );

    const level = rule.trigger === 'level';
    const sourceList = this.catalog.inputs;
    const filtersOf = (source: string): FilterInfo[] => this.catalog.filters.get(source) ?? [];

    const sourceField = (): void => {
      card.appendChild(
        listField('Source', rule.source, sourceList, (v) => {
          rule.source = v;
          touched();
          if (v && !this.catalog.filters.has(v)) this.onLookup?.('filters', v);
        }),
      );
      if (rule.source && !this.catalog.filters.has(rule.source) && this.obsStatus.state === 'connected') {
        this.onLookup?.('filters', rule.source);
      }
    };
    const filterField = (): void => {
      card.appendChild(
        listField(
          'Filter',
          rule.filter,
          filtersOf(rule.source).map((f) => f.name),
          (v) => {
            rule.filter = v;
            touched();
            if (rule.action === 'filter-value') rebuild();
          },
        ),
      );
    };
    const holdField = (label: string): void => {
      card.appendChild(
        numberField(label, rule.holdMs, 0, 60000, 10, (v) => {
          rule.holdMs = Math.max(0, Math.round(v));
          touched();
        }),
      );
    };
    const thresholdField = (): void => {
      card.appendChild(
        numberField('Threshold (0-1)', rule.min, 0, 1, 0.05, (v) => {
          rule.min = v;
          touched();
        }),
      );
    };

    switch (rule.action) {
      case 'filter-pulse':
        sourceField();
        filterField();
        if (level) thresholdField();
        else holdField('Hold (ms)');
        break;
      case 'filter-value': {
        sourceField();
        filterField();
        const filter = filtersOf(rule.source).find((f) => f.name === rule.filter);
        card.appendChild(
          listField('Setting', rule.setting, filter?.settings ?? [], (v) => {
            rule.setting = v;
            touched();
          }),
        );
        card.appendChild(
          numberField(level ? 'At silence' : 'Rest value', rule.min, -1e9, 1e9, 0.01, (v) => {
            rule.min = v;
            touched();
          }),
        );
        card.appendChild(
          numberField(level ? 'At full' : 'Beat value', rule.max, -1e9, 1e9, 0.01, (v) => {
            rule.max = v;
            touched();
          }),
        );
        if (!level) holdField('Hold (ms)');
        break;
      }
      case 'item-pulse': {
        card.appendChild(
          listField('Scene', rule.scene, this.catalog.scenes, (v) => {
            rule.scene = v;
            touched();
            if (v && !this.catalog.items.has(v)) this.onLookup?.('items', v);
            rebuild();
          }),
        );
        if (rule.scene && !this.catalog.items.has(rule.scene) && this.obsStatus.state === 'connected') {
          this.onLookup?.('items', rule.scene);
        }
        card.appendChild(
          listField('Item', rule.source, this.catalog.items.get(rule.scene) ?? [], (v) => {
            rule.source = v;
            touched();
          }),
        );
        if (level) thresholdField();
        else holdField('Hold (ms)');
        break;
      }
      case 'hotkey':
        card.appendChild(
          listField('Hotkey', rule.hotkey, this.catalog.hotkeys, (v) => {
            rule.hotkey = v;
            touched();
          }),
        );
        if (level) thresholdField();
        holdField('Cooldown (ms)');
        break;
      case 'scene':
        card.appendChild(
          listField(
            'Scene',
            rule.scene,
            this.catalog.scenes,
            (v) => {
              rule.scene = v;
              touched();
            },
            'next scene',
          ),
        );
        if (level) thresholdField();
        holdField('Cooldown (ms)');
        break;
    }

    return card;
  }

  /* ------------------------------- bridge ------------------------------- */

  private buildBridgeSection(): HTMLElement {
    const section = group('Browser Source');

    section.appendChild(
      toggle('Serve audio feed', this.settings.bridgeEnabled, (on) => this.onBridgeEnabled?.(on), {
        help: 'A local web page any OBS Browser Source can load, with the live audio analysis pushed to it.',
      }),
    );
    section.appendChild(
      numberField('Port', this.settings.bridgePort, 1024, 65535, 1, (v) => this.onChange?.({ bridgePort: v })),
    );

    this.bridgeNote = note('');
    section.appendChild(this.bridgeNote);

    const copy = document.createElement('button');
    copy.className = 'btn btn-ghost';
    copy.style.width = '100%';
    copy.textContent = 'Copy Browser Source URL';
    copy.addEventListener('click', () => {
      const url = this.bridgeStatus.url || `http://127.0.0.1:${this.settings.bridgePort}/`;
      this.onCopyUrl?.(url);
    });
    section.appendChild(copy);

    section.appendChild(
      note(
        'In OBS add a Browser Source with that URL: it draws a spectrum ring over a transparent ' +
          'background. Your own page can load /domino-audio.js from the same address and read ' +
          'DominoAudio.connect().latest every frame.',
      ),
    );
    return section;
  }
}

/* ------------------------------- widgets -------------------------------- */

function group(title: string): HTMLElement {
  const section = document.createElement('div');
  section.className = 'param-group';
  const head = document.createElement('div');
  head.className = 'param-group-title';
  head.textContent = title;
  section.appendChild(head);
  return section;
}

function note(text: string): HTMLElement {
  const node = document.createElement('div');
  node.className = 'param-help';
  node.textContent = text;
  return node;
}

function labelled(labelText: string, help?: string): { row: HTMLElement; label: HTMLElement } {
  const row = document.createElement('div');
  row.className = 'param';
  const label = document.createElement('span');
  label.className = 'param-label';
  label.textContent = labelText;
  if (help) label.title = help;
  row.appendChild(label);
  return { row, label };
}

function toggle(
  labelText: string,
  value: boolean,
  onPick: (on: boolean) => void,
  opts: { help?: string } = {},
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'param param-toggle';
  if (opts.help) row.title = opts.help;
  const label = document.createElement('span');
  label.className = 'param-label';
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onPick(input.checked));
  row.append(label, input);
  return row;
}

function textField(
  labelText: string,
  value: string,
  onCommit: (v: string) => void,
  opts: { password?: boolean; help?: string } = {},
): HTMLElement {
  const { row } = labelled(labelText, opts.help);
  const input = document.createElement('input');
  input.type = opts.password ? 'password' : 'text';
  input.className = 'field';
  input.value = value;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.addEventListener('change', () => onCommit(input.value.trim()));
  row.appendChild(input);
  return row;
}

function numberField(
  labelText: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onCommit: (v: number) => void,
): HTMLElement {
  const { row } = labelled(labelText);
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'field field-num';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('change', () => {
    const n = parseFloat(input.value);
    if (!Number.isFinite(n)) {
      input.value = String(value);
      return;
    }
    const clamped = Math.min(Math.max(n, min), max);
    input.value = String(clamped);
    onCommit(clamped);
  });
  row.appendChild(input);
  return row;
}

function selectField(
  labelText: string,
  options: Array<[string, string]>,
  value: string,
  onPick: (v: string) => void,
): HTMLElement {
  const { row } = labelled(labelText);
  const select = document.createElement('select');
  select.className = 'field';
  for (const [v, text] of options) {
    const option = document.createElement('option');
    option.value = v;
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = value;
  select.addEventListener('change', () => onPick(select.value));
  row.appendChild(select);
  return row;
}

/**
 * A text field with suggestions: pick a name OBS reported, or type one when
 * OBS is not around to ask.
 */
function listField(
  labelText: string,
  value: string,
  options: string[],
  onCommit: (v: string) => void,
  placeholder = '',
): HTMLElement {
  const { row } = labelled(labelText);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field';
  input.value = value;
  input.placeholder = placeholder || (options.length ? 'pick or type' : 'type a name');
  input.spellcheck = false;
  input.autocomplete = 'off';
  if (options.length) {
    const list = document.createElement('datalist');
    list.id = `dl${++datalistSeq}`;
    for (const o of options) {
      const option = document.createElement('option');
      option.value = o;
      list.appendChild(option);
    }
    input.setAttribute('list', list.id);
    row.appendChild(list);
  }
  input.addEventListener('change', () => onCommit(input.value.trim()));
  row.appendChild(input);
  return row;
}

/** The one-line summary at the top of a rule card. */
export function describeRule(rule: ObsRule): string {
  const when =
    rule.trigger === 'beat'
      ? rule.every > 1
        ? `every ${rule.every} beats`
        : 'every beat'
      : SIGNAL_LABELS[rule.signal].toLowerCase();
  let what: string;
  switch (rule.action) {
    case 'filter-pulse':
      what = rule.filter ? `${rule.trigger === 'beat' ? 'pulse' : 'gate'} ${rule.filter}` : 'switch a filter';
      break;
    case 'filter-value':
      what = rule.setting ? `${rule.filter || '?'}.${rule.setting}` : 'set a value';
      break;
    case 'item-pulse':
      what = rule.source ? `show ${rule.source}` : 'show an item';
      break;
    case 'hotkey':
      what = rule.hotkey || 'a hotkey';
      break;
    case 'scene':
      what = rule.scene ? `scene ${rule.scene}` : 'next scene';
      break;
  }
  return `${when} → ${what}`;
}
