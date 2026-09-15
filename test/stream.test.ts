/**
 * Stream tests: the browser-source bridge, the obs-websocket handshake, and
 * the rules engine.
 *
 * Run with: npm run test:stream
 *
 * The bridge is started for real on a free loopback port and driven with
 * Node's own WebSocket client, so what is under test is the bytes on the
 * wire rather than a mock of them. OBS itself is not needed: the director
 * is fed a recorder that satisfies the same interface as the client.
 */
import { createHash } from 'node:crypto';
import { Bridge, encodeFrame } from '../src/main/bridge';
import { obsAuthString, type ObsRequest } from '../src/renderer/obs/ObsClient';
import { ObsDirector, type ObsSender } from '../src/renderer/obs/ObsDirector';
import {
  createRule,
  normalizeSignal,
  sanitizeRule,
  summarizeFrame,
  STREAM_BINS,
  type AudioFrameLike,
  type StreamAudioFrame,
} from '../src/shared/stream';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
  } else {
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
    failed++;
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, ok, ok ? undefined : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function frame(patch: Partial<AudioFrameLike> = {}): AudioFrameLike {
  const spectrum = new Float32Array(512);
  for (let i = 0; i < 512; i++) spectrum[i] = i / 511;
  const wave = new Float32Array(512);
  for (let i = 0; i < 512; i++) wave[i] = Math.sin((i / 512) * Math.PI * 2);
  return {
    time: 12.3456,
    bass: 1.5,
    mid: 1,
    treb: 0.5,
    bassAtt: 1.2,
    midAtt: 1,
    trebAtt: 0.6,
    vol: 1,
    volAtt: 0.9,
    rms: 0.3,
    peak: 0.8,
    beat: false,
    beatPulse: 0.4,
    bpm: 128.04,
    bpmConfidence: 0.7,
    active: true,
    spectrum,
    waveL: wave,
    waveR: wave,
    ...patch,
  };
}

/* ------------------------------ summaries ------------------------------- */

{
  const s = summarizeFrame(frame());
  eq('summary carries the bands', [s.bass, s.mid, s.treb], [1.5, 1, 0.5]);
  eq('summary rounds time', s.t, 12.346);
  eq('summary rounds tempo to a tenth', s.bpm, 128);
  eq('spectrum is shrunk to the wire size', s.spectrum.length, STREAM_BINS);
  eq('wave is shrunk to the wire size', s.wave.length, STREAM_BINS);
  check('spectrum keeps its ramp', s.spectrum[0] < s.spectrum[31] && s.spectrum[31] < s.spectrum[63]);
  check('spectrum stays in range', s.spectrum.every((v) => v >= 0 && v <= 1));
  check('wave stays in range', s.wave.every((v) => v >= -1 && v <= 1));
  check('summary is small on the wire', JSON.stringify(s).length < 1500, `${JSON.stringify(s).length} bytes`);
}

{
  const f = frame({ bass: 2, bpm: 100, beatPulse: 0.25, rms: 1.7 });
  eq('a band at 2.0 is full scale', normalizeSignal('bass', f), 1);
  eq('a band at 1.0 (average) is half', normalizeSignal('mid', f), 0.5);
  eq('tempo is scaled against 200', normalizeSignal('bpm', f), 0.5);
  eq('beat pulse is already 0..1', normalizeSignal('beatPulse', f), 0.25);
  eq('nothing exceeds 1', normalizeSignal('rms', f), 1);
}

/* -------------------------------- rules --------------------------------- */

{
  eq('a non-object is not a rule', sanitizeRule('x'), null);
  eq('a rule needs an id', sanitizeRule({ enabled: true }), null);
  const r = sanitizeRule({
    id: 'a',
    trigger: 'level',
    signal: 'nope',
    action: 'hotkey',
    hotkey: 'OBSBasic.Transition',
    every: 2.6,
    holdMs: -5,
    min: 'bad',
    extra: 1,
  });
  check('a mostly valid rule is kept', r !== null);
  eq('unknown signal falls back', r!.signal, 'bass');
  eq('known fields are kept', [r!.trigger, r!.action, r!.hotkey], ['level', 'hotkey', 'OBSBasic.Transition']);
  eq('every is rounded and at least 1', r!.every, 3);
  eq('hold cannot be negative', r!.holdMs, 0);
  eq('a mistyped number keeps its default', r!.min, 0);
  eq('unknown keys are dropped', 'extra' in r!, false);
}

/* --------------------------------- auth --------------------------------- */

async function testAuth(): Promise<void> {
  const password = 'hunter2';
  const salt = 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAHo3ixNI=';
  const challenge = 'ztTBnnuqrqaKDzRM3xcVdbYm/nI4wo7jqSiTUdiUvvI=';
  const secret = createHash('sha256').update(password + salt).digest('base64');
  const expected = createHash('sha256').update(secret + challenge).digest('base64');
  eq('auth string matches the spec', await obsAuthString(password, salt, challenge), expected);
}

/* -------------------------------- bridge -------------------------------- */

async function testBridge(): Promise<void> {
  const bridge = new Bridge();
  const counts: number[] = [];
  bridge.onClients = (n) => counts.push(n);

  const status = await bridge.start(0);
  check('bridge starts on a free port', status.running && status.port > 0, JSON.stringify(status));
  eq('bridge url is loopback', status.url, `http://127.0.0.1:${status.port}/`);

  const base = status.url;
  const index = await fetch(base);
  eq('index page is html', index.headers.get('content-type'), 'text/html; charset=utf-8');
  check('index page loads the client', (await index.text()).includes('domino-audio.js'));
  const lib = await fetch(`${base}domino-audio.js`);
  check('client library is served', (await lib.text()).includes('DominoAudio'));
  eq('client library allows any origin', lib.headers.get('access-control-allow-origin'), '*');
  eq('audio.json is null before any frame', await (await fetch(`${base}audio.json`)).json(), null);
  eq('unknown paths are 404', (await fetch(`${base}nope`)).status, 404);

  // A page connects.
  const received: StreamAudioFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${status.port}/audio`);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('websocket failed to open'));
  });
  socket.onmessage = (ev) => received.push(JSON.parse(String(ev.data)));
  await sleep(20);
  eq('bridge counts the page', bridge.getStatus().clients, 1);
  eq('client callback fired on connect', counts, [1]);

  bridge.broadcast(summarizeFrame(frame({ beat: true })));
  await sleep(30);
  eq('page received one frame', received.length, 1);
  eq('frame arrived intact', received[0]?.beat, true);
  eq('frame arrived with its spectrum', received[0]?.spectrum.length, STREAM_BINS);
  eq('audio.json now has the frame', (await (await fetch(`${base}audio.json`)).json()).bass, 1.5);

  // A larger payload takes the 16-bit length path.
  const big = summarizeFrame(frame());
  (big as unknown as { pad: string }).pad = 'x'.repeat(70000);
  bridge.broadcast(big);
  await sleep(50);
  eq('a frame past 64KiB arrives whole', (received[1] as unknown as { pad: string })?.pad?.length, 70000);

  // Something the page sends is consumed without complaint, and a ping is answered.
  socket.send('hello from the page');
  await sleep(20);
  eq('a message from the page is harmless', bridge.getStatus().clients, 1);

  // A second page gets the latest frame immediately.
  const late = new WebSocket(`ws://127.0.0.1:${status.port}/audio`);
  const first = await new Promise<StreamAudioFrame>((resolve, reject) => {
    late.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
    late.onerror = () => reject(new Error('second socket failed'));
  });
  check('a late page is sent the latest frame at once', (first as unknown as { pad: string }).pad?.length === 70000);
  await sleep(10);
  eq('two pages counted', bridge.getStatus().clients, 2);

  // Wrong path is refused.
  const wrong = new WebSocket(`ws://127.0.0.1:${status.port}/other`);
  const refused = await new Promise<boolean>((resolve) => {
    wrong.onopen = () => resolve(false);
    wrong.onerror = () => resolve(true);
    wrong.onclose = () => resolve(true);
  });
  check('a websocket on the wrong path is refused', refused);

  // Pages leave.
  socket.close();
  late.close();
  await sleep(50);
  eq('pages are dropped on close', bridge.getStatus().clients, 0);

  const stopped = await bridge.stop();
  eq('bridge stops', stopped.running, false);
  const gone = await fetch(base).then(() => false, () => true);
  check('nothing listens after stop', gone);

  // Port already in use is reported, not thrown.
  const a = new Bridge();
  const s1 = await a.start(0);
  const b = new Bridge();
  const s2 = await b.start(s1.port);
  check('a busy port is reported', !s2.running && s2.error.includes('already in use'), s2.error);
  await a.stop();

  // Frame encoding edge: the 64-bit length path.
  const small = encodeFrame(0x1, Buffer.alloc(100));
  eq('7-bit length header', [small[1], small.length], [100, 102]);
  const medium = encodeFrame(0x1, Buffer.alloc(1000));
  eq('16-bit length header', [medium[1], medium.readUInt16BE(2)], [126, 1000]);
  const giant = encodeFrame(0x1, Buffer.alloc(70000));
  eq('64-bit length header', [giant[1], Number(giant.readBigUInt64BE(2))], [127, 70000]);
}

/* ------------------------------- director ------------------------------- */

class Recorder implements ObsSender {
  connected = true;
  batches: ObsRequest[][] = [];
  lookups: Array<Record<string, unknown> | undefined> = [];
  send(requests: ObsRequest[]): void {
    this.batches.push(requests);
  }
  request<T>(requestType: string, requestData?: Record<string, unknown>): Promise<T> {
    this.lookups.push(requestData);
    if (requestType === 'GetSceneItemId') return Promise.resolve({ sceneItemId: 7 } as T);
    return Promise.resolve({} as T);
  }
  get all(): ObsRequest[] {
    return this.batches.flat();
  }
}

async function testDirector(): Promise<void> {
  /* beat → pulse a filter */
  {
    const obs = new Recorder();
    const d = new ObsDirector(obs);
    const rule = { ...createRule('p'), source: 'Cam', filter: 'Glitch', holdMs: 15 };
    d.setRules([rule]);

    d.tick(frame({ beat: false }), 0);
    eq('no beat, nothing sent', obs.all.length, 0);
    d.tick(frame({ beat: true }), 16);
    eq('beat enables the filter at once', obs.all, [
      {
        requestType: 'SetSourceFilterEnabled',
        requestData: { sourceName: 'Cam', filterName: 'Glitch', filterEnabled: true },
      },
    ]);
    await sleep(40);
    eq('and disables it after the hold', obs.all[1]?.requestData?.filterEnabled, false);
    eq('nothing else was sent', obs.all.length, 2);
    d.dispose();
  }

  /* every Nth beat */
  {
    const obs = new Recorder();
    const d = new ObsDirector(obs);
    d.setRules([{ ...createRule('h'), action: 'hotkey', hotkey: 'OBSBasic.Transition', every: 3 }]);
    for (let i = 0; i < 7; i++) d.tick(frame({ beat: true }), i * 100);
    eq('every third beat fires', obs.all.length, 2);
    eq('hotkey request is well formed', obs.all[0], {
      requestType: 'TriggerHotkeyByName',
      requestData: { hotkeyName: 'OBSBasic.Transition' },
    });
    d.dispose();
  }

  /* beat → next scene cycles */
  {
    const obs = new Recorder();
    const d = new ObsDirector(obs);
    d.setScenes(['A', 'B']);
    d.setRules([{ ...createRule('s'), action: 'scene', scene: '' }]);
    for (let i = 0; i < 3; i++) d.tick(frame({ beat: true }), i * 100);
    eq(
      'next scene cycles through the list',
      obs.all.map((r) => r.requestData?.sceneName),
      ['A', 'B', 'A'],
    );
    d.dispose();
  }

  /* level → filter value mapping, rate limited and deduplicated */
  {
    const obs = new Recorder();
    const d = new ObsDirector(obs);
    d.setRules([
      {
        ...createRule('v'),
        trigger: 'level',
        signal: 'bass',
        action: 'filter-value',
        source: 'Cam',
        filter: 'Color',
        setting: 'saturation',
        min: 1,
        max: 3,
      },
    ]);
    d.tick(frame({ bass: 1 }), 100); // normalised 0.5 → 2
    eq('level maps into the range', obs.all[0]?.requestData?.filterSettings, { saturation: 2 });
    eq('overlay keeps the other settings', obs.all[0]?.requestData?.overlay, true);
    d.tick(frame({ bass: 1 }), 110);
    eq('an unchanged value is not resent', obs.all.length, 1);
    d.tick(frame({ bass: 2 }), 120);
    eq('a change inside the interval waits', obs.all.length, 1);
    d.tick(frame({ bass: 2 }), 140);
    eq('and goes out at the next interval', obs.all.length, 2);
    eq('full scale hits max', obs.all[1]?.requestData?.filterSettings, { saturation: 3 });
    d.dispose();
  }

  /* level → gate a filter */
  {
    const obs = new Recorder();
    const d = new ObsDirector(obs);
    d.setRules([
      { ...createRule('g'), trigger: 'level', signal: 'treb', action: 'filter-pulse', source: 'Cam', filter: 'Glow', min: 0.6 },
    ]);
    d.tick(frame({ treb: 0.5 }), 100); // 0.25, below
    eq('below threshold sends off once', obs.all.map((r) => r.requestData?.filterEnabled), [false]);
    d.tick(frame({ treb: 0.5 }), 200);
    eq('staying below sends nothing more', obs.all.length, 1);
    d.tick(frame({ treb: 1.5 }), 300); // 0.75, above
    eq('crossing above sends on', obs.all.map((r) => r.requestData?.filterEnabled), [false, true]);
    d.dispose();
  }

  /* level → hotkey on a rising edge with cooldown and hysteresis */
  {
    const obs = new Recorder();
    const d = new ObsDirector(obs);
    d.setRules([
      { ...createRule('e'), trigger: 'level', signal: 'bass', action: 'hotkey', hotkey: 'K', min: 0.6, holdMs: 500 },
    ]);
    d.tick(frame({ bass: 0.4 }), 0);
    d.tick(frame({ bass: 1.4 }), 50); // 0.7 rises above
    eq('rising edge fires', obs.all.length, 1);
    d.tick(frame({ bass: 1.0 }), 100); // 0.5: above 0.48 hysteresis, still "above"
    d.tick(frame({ bass: 1.4 }), 150);
    eq('wobble inside hysteresis does not refire', obs.all.length, 1);
    d.tick(frame({ bass: 0.2 }), 200);
    d.tick(frame({ bass: 1.4 }), 250); // rises again, but inside cooldown
    eq('cooldown holds it', obs.all.length, 1);
    d.tick(frame({ bass: 0.2 }), 600);
    d.tick(frame({ bass: 1.4 }), 700);
    eq('after the cooldown it fires again', obs.all.length, 2);
    d.dispose();
  }

  /* scene item: id is looked up once, first beat is missed, later ones land */
  {
    const obs = new Recorder();
    const d = new ObsDirector(obs);
    d.setRules([{ ...createRule('i'), action: 'item-pulse', scene: 'Main', source: 'Logo', holdMs: 10 }]);
    d.tick(frame({ beat: true }), 0);
    eq('first beat triggers the lookup', obs.lookups, [{ sceneName: 'Main', sourceName: 'Logo' }]);
    eq('and sends nothing yet', obs.all.length, 0);
    await sleep(5);
    d.tick(frame({ beat: true }), 100);
    eq('next beat shows the item', obs.all[0], {
      requestType: 'SetSceneItemEnabled',
      requestData: { sceneName: 'Main', sceneItemId: 7, sceneItemEnabled: true },
    });
    eq('the id was looked up only once', obs.lookups.length, 1);
    await sleep(30);
    eq('and hides it after the hold', obs.all[1]?.requestData?.sceneItemEnabled, false);
    d.dispose();
  }

  /* disconnected: nothing sent, state resets on reconnect */
  {
    const obs = new Recorder();
    const d = new ObsDirector(obs);
    d.setRules([
      { ...createRule('r'), trigger: 'level', action: 'filter-pulse', source: 'Cam', filter: 'Glow', min: 0.1 },
    ]);
    d.tick(frame({ treb: 2 }), 0);
    eq('gate opened', obs.all.length, 1);
    obs.connected = false;
    d.tick(frame({ treb: 2 }), 100);
    eq('disconnected sends nothing', obs.all.length, 1);
    obs.connected = true;
    d.tick(frame({ treb: 2 }), 200);
    eq('reconnecting resends the state', obs.all.length, 2);
    d.dispose();
  }

  /* disabled rules are inert, removed rules cancel their pulses */
  {
    const obs = new Recorder();
    const d = new ObsDirector(obs);
    const rule = { ...createRule('x'), source: 'Cam', filter: 'Glitch', holdMs: 20 };
    d.setRules([{ ...rule, enabled: false }]);
    d.tick(frame({ beat: true }), 0);
    eq('a disabled rule does nothing', obs.all.length, 0);
    d.setRules([rule]);
    d.tick(frame({ beat: true }), 100);
    eq('enabled again it fires', obs.all.length, 1);
    d.setRules([]);
    await sleep(40);
    eq('removing the rule cancels the pending off', obs.all.length, 1);
    d.dispose();
  }
}

(async () => {
  await testAuth();
  await testBridge();
  await testDirector();
  console.log(`stream: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.log(`FAIL  uncaught: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
