/**
 * Stream end-to-end test.
 *
 * Run with: npm run test:stream:e2e   (requires `npm run build` first)
 *
 * Boots the real main process with settings that switch both halves of the
 * Stream tab on, then checks each against something real:
 *
 *  - OBS: a fake obs-websocket server in this harness, with a password. The
 *    app must complete the Hello / Identify handshake with the right auth
 *    string, and a level rule seeded in settings must arrive as a request.
 *  - Browser source: the served overlay page is loaded in a second window,
 *    which must connect to the feed and receive frames; the app's own panel
 *    must then report the page as connected.
 *
 * Pass --shots <dir> to save screenshots of the panel and the overlay.
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const shotFlag = process.argv.indexOf('--shots');
const SHOT_DIR = shotFlag >= 0 ? path.resolve(process.argv[shotFlag + 1] ?? 'shots') : null;

const OBS_PASSWORD = 'correct horse';
const failures = [];
const consoleErrors = [];

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
    failures.push(label);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ fake OBS -------------------------------- */

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, payload]);
}

/** Pull complete masked frames off a buffer; returns [texts, remainder]. */
function decodeFrames(buf) {
  const texts = [];
  for (;;) {
    if (buf.length < 2) return [texts, buf];
    const opcode = buf[0] & 0x0f;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return [texts, buf];
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return [texts, buf];
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    const total = off + 4 + len;
    if (buf.length < total) return [texts, buf];
    const mask = buf.subarray(off, off + 4);
    const payload = Buffer.from(buf.subarray(off + 4, total));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    if (opcode === 0x1) texts.push(payload.toString('utf8'));
    buf = buf.subarray(total);
  }
}

/**
 * Enough of obs-websocket v5 to see the app authenticate and send requests.
 * Records every request it is sent.
 */
function startFakeObs() {
  const salt = crypto.randomBytes(16).toString('base64');
  const challenge = crypto.randomBytes(16).toString('base64');
  const secret = crypto.createHash('sha256').update(OBS_PASSWORD + salt).digest('base64');
  const expectedAuth = crypto.createHash('sha256').update(secret + challenge).digest('base64');

  const state = { identified: false, authOk: false, requests: [], port: 0 };
  const server = http.createServer((_req, res) => res.writeHead(426).end());

  server.on('upgrade', (req, socket) => {
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + WS_MAGIC)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.write(
      encodeText(
        JSON.stringify({
          op: 0,
          d: { obsWebSocketVersion: '5.4.2', rpcVersion: 1, authentication: { challenge, salt } },
        }),
      ),
    );

    let pending = Buffer.alloc(0);
    const reply = (obj) => socket.write(encodeText(JSON.stringify(obj)));
    const answer = (requestType, requestId, responseData) =>
      reply({
        op: 7,
        d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData },
      });

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const [texts, rest] = decodeFrames(pending);
      pending = rest;
      for (const text of texts) {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }
        if (msg.op === 1) {
          state.authOk = msg.d.authentication === expectedAuth;
          if (!state.authOk) {
            socket.end();
            return;
          }
          state.identified = true;
          reply({ op: 2, d: { negotiatedRpcVersion: 1 } });
        } else if (msg.op === 6) {
          state.requests.push(msg.d);
          const { requestType, requestId } = msg.d;
          if (requestType === 'GetVersion') answer(requestType, requestId, { obsVersion: '30.1.2' });
          else if (requestType === 'GetSceneList')
            answer(requestType, requestId, {
              scenes: [
                { sceneName: 'Main', sceneIndex: 1 },
                { sceneName: 'BRB', sceneIndex: 0 },
              ],
            });
          else if (requestType === 'GetInputList')
            answer(requestType, requestId, { inputs: [{ inputName: 'Cam' }, { inputName: 'Mic' }] });
          else if (requestType === 'GetHotkeyList')
            answer(requestType, requestId, { hotkeys: ['OBSBasic.Transition'] });
          else if (requestType === 'GetSourceFilterList')
            answer(requestType, requestId, {
              filters: [{ filterName: 'Glow', filterKind: 'color_filter_v2', filterSettings: {} }],
            });
          else if (requestType === 'GetSourceFilterDefaultSettings')
            answer(requestType, requestId, { defaultFilterSettings: { brightness: 0, saturation: 1 } });
          else answer(requestType, requestId, {});
        } else if (msg.op === 8) {
          for (const r of msg.d.requests) state.requests.push(r);
          reply({ op: 9, d: { requestId: msg.d.requestId, results: msg.d.requests.map(() => ({ requestStatus: { result: true, code: 100 } })) } });
        }
      }
    });
    socket.on('error', () => undefined);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      resolve({ state, server });
    });
  });
}

/* ------------------------------- the app -------------------------------- */

(async () => {
  const fake = await startFakeObs();

  // A private settings directory: the seeded settings must not touch the
  // user's own, and a second copy of the app must not be refused by the
  // single-instance lock if one is already running.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'domino-stream-e2e-'));
  app.setPath('userData', userData);
  const bridgePort = 4400 + Math.floor(Math.random() * 500);
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      obsEnabled: true,
      obsHost: '127.0.0.1',
      obsPort: fake.state.port,
      obsPassword: OBS_PASSWORD,
      obsRules: [
        {
          id: 'e2e-gate',
          enabled: true,
          trigger: 'level',
          signal: 'vol',
          action: 'filter-pulse',
          source: 'Cam',
          filter: 'Glow',
          min: 0,
          max: 1,
          holdMs: 100,
        },
      ],
      bridgeEnabled: true,
      bridgePort,
      showFps: true,
    }),
  );

  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('console-message', (_ev, level, message) => {
      if (level >= 2) consoleErrors.push(message);
    });
    win.webContents.on('render-process-gone', (_ev, details) => {
      failures.push(`renderer crashed: ${details.reason}`);
    });
  });

  require(path.join(ROOT, 'out/main/index.js'));
  await app.whenReady();

  const isMain = (w) => !w.webContents.getURL().includes('splash');
  const win = await new Promise((resolve) => {
    const existing = BrowserWindow.getAllWindows().find(isMain);
    if (existing) return resolve(existing);
    const onCreated = (_e, created) => {
      created.webContents.once('did-start-loading', () => {
        if (isMain(created)) {
          app.off('browser-window-created', onCreated);
          resolve(created);
        }
      });
    };
    app.on('browser-window-created', onCreated);
  });
  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once('did-finish-load', resolve);
  });
  await sleep(6000);

  console.log('\nStream tab');
  const tab = await win.webContents.executeJavaScript(`
    (() => {
      const tab = [...document.querySelectorAll('.itab')].find((t) => t.dataset.panel === 'stream');
      if (!tab) return { found: false };
      tab.click();
      const body = document.getElementById('stream-body');
      return {
        found: true,
        visible: !body.hidden,
        text: body.textContent,
        rules: body.querySelectorAll('.rule').length,
        resetHidden: document.getElementById('btn-reset-params').hidden,
      };
    })()
  `);
  check('Stream tab exists and opens', tab.found && tab.visible);
  check('panel shows the OBS section', tab.text.includes('Connect to OBS'));
  check('panel shows the browser source section', tab.text.includes('Serve audio feed'));
  check('seeded rule is listed', tab.rules === 1, `${tab.rules} rules`);
  check('reset button is hidden on this tab', tab.resetHidden === true);

  /* OBS */
  console.log('\nOBS');
  await sleep(1500);
  check('app authenticated with the fake OBS', fake.state.identified && fake.state.authOk);
  const sent = fake.state.requests.map((r) => r.requestType);
  check('app asked for the version', sent.includes('GetVersion'));
  check('app fetched the catalogue', sent.includes('GetSceneList') && sent.includes('GetInputList'));
  const gate = fake.state.requests.find((r) => r.requestType === 'SetSourceFilterEnabled');
  check(
    'level rule reached OBS as a filter switch',
    Boolean(gate) && gate.requestData.sourceName === 'Cam' && gate.requestData.filterName === 'Glow',
    JSON.stringify(gate),
  );
  const obsNote = await win.webContents.executeJavaScript(
    `document.querySelector('#stream-body .param-help').textContent`,
  );
  check('panel reports the connection', obsNote.includes('Connected to OBS 30.1.2'), obsNote);

  /* bridge */
  console.log('\nBrowser source');
  const statusUrl = `http://127.0.0.1:${bridgePort}/status.json`;
  const before = await fetch(statusUrl).then((r) => r.json());
  check('bridge is serving on the configured port', before.running && before.port === bridgePort);
  const audio = await fetch(`http://127.0.0.1:${bridgePort}/audio.json`).then((r) => r.json());
  check('no page yet, so no frame has been summarised', audio === null);

  const overlay = new BrowserWindow({ width: 640, height: 360, show: false, webPreferences: { offscreen: true } });
  await overlay.loadURL(`http://127.0.0.1:${bridgePort}/?hint=1`);
  await sleep(1500);
  const page = await overlay.webContents.executeJavaScript(`
    ({
      state: document.getElementById('state').textContent,
      connected: feed.connected,
      bins: feed.latest.spectrum.length,
      t: feed.latest.t,
    })
  `);
  check('overlay page connected to the feed', page.connected, JSON.stringify(page));
  check('overlay receives frames with the full spectrum', page.bins === 64, JSON.stringify(page));
  check('overlay reports its state', page.state === 'connected, silent' || page.state === 'live', page.state);
  const after = await fetch(statusUrl).then((r) => r.json());
  check('bridge counts the page', after.clients === 1, JSON.stringify(after));
  const bridgeNote = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('#stream-body .param-help')].map((n) => n.textContent).find((t) => t.includes('Serving'))`,
  );
  check('panel reports the connected page', Boolean(bridgeNote) && bridgeNote.includes('1 page connected'), bridgeNote);

  if (SHOT_DIR) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, 'stream-tab.png'), (await win.capturePage()).toPNG());
    fs.writeFileSync(path.join(SHOT_DIR, 'overlay.png'), (await overlay.capturePage()).toPNG());
    console.log(`\nScreenshots in ${SHOT_DIR}`);
  }

  /* adding a rule through the panel persists it */
  console.log('\nRules');
  const added = await win.webContents.executeJavaScript(`
    (() => {
      const body = document.getElementById('stream-body');
      const add = [...body.querySelectorAll('button')].find((b) => b.textContent.includes('Add rule'));
      add.click();
      const cards = body.querySelectorAll('.rule');
      return { count: cards.length, summary: cards[cards.length - 1].querySelector('.rule-summary').textContent };
    })()
  `);
  check('a new rule card appears', added.count === 2, JSON.stringify(added));
  check('with a readable summary', added.summary.includes('every beat'), added.summary);
  await sleep(600);
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  check('the rule was written to settings', Array.isArray(saved.obsRules) && saved.obsRules.length === 2);

  /* pages leaving are noticed */
  overlay.destroy();
  await sleep(300);
  const gone = await fetch(statusUrl).then((r) => r.json());
  check('bridge drops the page when it closes', gone.clients === 0, JSON.stringify(gone));

  const errors = consoleErrors.filter((m) => !/Insecure Content-Security-Policy|GL Driver|GroupMarker|swiftshader|Autofill/.test(m));
  check('no renderer errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  fake.server.close();
  console.log(failures.length ? `\nSTREAM E2E FAILED: ${failures.join('; ')}` : '\nSTREAM E2E PASSED');
  app.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.log(`\nSTREAM E2E CRASHED: ${err.stack || err}`);
  app.exit(1);
});
