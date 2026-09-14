/**
 * Virtual camera, end to end.
 *
 * Run with: npm run test:vcam   (requires `npm run build`, `npm run build:native`
 * and a camera device the app can publish into)
 *
 * Everything else in the suite stops at the edge of the operating system. This
 * one goes all the way: it boots the real app, turns the camera on by clicking
 * the same checkbox a user would, and then opens that camera from a *separate
 * process*, which is the only arrangement that resembles a video call. On
 * Windows that is also the only way to exercise the hop through the Frame
 * Server, since Windows hosts the media source in its own service; on Linux
 * the frames go through the kernel instead, and a second process is what keeps
 * the test honest about reading them back the way any other application would.
 *
 * The same script covers both, because what it asserts - frames arrive, they
 * carry a picture, streaming does not stall, and the app stays responsive
 * throughout - is the same question on either platform.
 *
 * It cannot run in CI: publishing needs a one-time privileged setup step
 * (registering the driver, or loading v4l2loopback). It skips cleanly when
 * that has not been done.
 */
const { app, BrowserWindow } = require('electron');
const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'native/build/Release/domino_vcam.node');

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
    failures.push(label);
  }
}
function info(label, detail) {
  console.log(`  info  ${label}${detail !== undefined ? `: ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `probe` until it returns truthy, or give up. */
async function until(probe, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await wait(everyMs);
  }
}

/**
 * Open the camera from another process and bring one frame back.
 *
 * Deliberately a child process: opening a virtual camera from inside the
 * process that publishes it is not the case anyone actually runs, and Media
 * Foundation behaves differently when it can shortcut the Frame Server.
 */
/**
 * Hold the camera open the way a video call does, and watch both ends.
 *
 * A single frame proves the pipe connects and nothing more. Publishing a
 * persistent device once passed that check and still delivered zero frames to
 * a real consumer, because the failure only appears once something streams -
 * so this measures sustained delivery *and* whether the app stayed responsive
 * while it happened.
 */
function streamFromAnotherProcess(name, durationMs) {
  const script = `
    const addon = require(${JSON.stringify(ADDON)});
    console.log(JSON.stringify(addon.streamForTest(${JSON.stringify(name)}, ${durationMs})));
  `;
  return spawn(process.execPath, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}

function captureFromAnotherProcess(name, timeoutMs) {
  const script = `
    const addon = require(${JSON.stringify(ADDON)});
    const shot = addon.captureFrameForTest(${JSON.stringify(name)}, ${timeoutMs});
    if (!shot.ok) { console.log(JSON.stringify({ ok: false, error: shot.error })); }
    else {
      const luma = shot.data.subarray(0, shot.width * shot.height);
      let min = 255, max = 0, sum = 0;
      for (let i = 0; i < luma.length; i++) {
        const v = luma[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      const mean = sum / luma.length;
      let varsum = 0;
      for (let i = 0; i < luma.length; i++) varsum += (luma[i] - mean) ** 2;
      console.log(JSON.stringify({
        ok: true, device: shot.device, width: shot.width, height: shot.height,
        bytes: shot.data.length, min, max, mean,
        stdev: Math.sqrt(varsum / luma.length),
      }));
    }
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: timeoutMs + 20000,
    // ELECTRON_RUN_AS_NODE: this test runs under Electron, and the child must
    // behave as plain Node rather than trying to start a second app.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const ENABLE_CAMERA = `
  (() => {
    const rows = Array.from(document.querySelectorAll('.param-toggle'));
    const row = rows.find((r) => r.textContent.includes('Publish as Webcam'));
    if (!row) return { found: false };
    const box = row.querySelector('input[type=checkbox]');
    if (!box) return { found: false };
    if (box.disabled) return { found: true, disabled: true };
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    return { found: true, disabled: false };
  })()
`;

require(path.join(ROOT, 'out/main/index.js'));

app.whenReady().then(async () => {
  console.log('\nVirtual camera, end to end:\n');

  // Skip the startup splash and attach to the app window itself.
  const win = await until(
    async () =>
      BrowserWindow.getAllWindows().find(
        (w) => !w.webContents.getURL().includes('splash'),
      ),
    20000,
  );
  if (!win) {
    console.log('  FAIL  the app never opened a window');
    app.exit(1);
    return;
  }
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
  }
  // Let the renderer settle and start producing frames.
  await wait(3000);

  const vcam = require(ADDON);
  const registration = vcam.isRegistered();
  if (!registration.registered) {
    console.log('  SKIPPED: there is nowhere to publish a camera on this machine.');
    if (process.platform === 'win32') {
      console.log('  Register the driver once from the app, or with:');
      console.log('    regsvr32 <install dir>\\resources\\native\\domino_vcam_source.dll');
    } else {
      console.log('  Create a loopback device from the app, or with:');
      console.log('    sudo modprobe v4l2loopback devices=1 exclusive_caps=1 \\');
      console.log('      card_label="Domino Visualizer"');
    }
    app.exit(0);
    return;
  }
  info(process.platform === 'win32' ? 'driver registered at' : 'publishing into',
    registration.path);

  /*
   * The registered driver is a path, and it may well point at an installed
   * copy of Domino rather than this working tree. Publishing would then
   * exercise somebody else's DLL, so this is a skip rather than a failure -
   * and saying so beats a red run that looks like a regression. Linux has no
   * equivalent: the device belongs to the kernel, not to a build.
   */
  const status0 = await win.webContents.executeJavaScript(
    'window.domino.virtualCamera.status()',
  );
  if (process.platform === 'win32' && !status0.registeredIsThisBuild) {
    console.log('  SKIPPED: a different build is registered as the camera driver.');
    console.log(`    registered: ${status0.registeredPath}`);
    console.log(`    this build: ${status0.sourcePath}`);
    console.log('  Re-register from the app (or install this build) to test it.');
    app.exit(0);
    return;
  }

  const toggled = await win.webContents.executeJavaScript(ENABLE_CAMERA);
  check('the Publish as Webcam control exists', toggled.found === true);
  check('the control is enabled once there is somewhere to publish',
    toggled.disabled !== true);
  if (!toggled.found || toggled.disabled) {
    app.exit(1);
    return;
  }

  const status = await until(async () => {
    const s = await win.webContents.executeJavaScript(
      'window.domino.virtualCamera.status()',
    );
    return s.running && s.framesWritten > 30 ? s : null;
  }, 25000);

  check('the app publishes the camera and starts sending frames', status !== null);
  if (!status) {
    const last = await win.webContents.executeJavaScript(
      'window.domino.virtualCamera.status()',
    );
    console.log(`        last status: ${JSON.stringify(last)}`);
    app.exit(1);
    return;
  }
  info('publishing', `${status.width}x${status.height} @ ${status.fps}fps, ${status.framesWritten} frames sent`);

  /*
   * What the camera is actually called to everything else. Windows publishes
   * under the name it is given; a Linux loopback device carries the card label
   * its kernel module was loaded with, which may well not say Domino at all -
   * so looking for our own name there would fail on a perfectly working setup.
   */
  const cameraName = status.publishedName || 'Domino';
  info('published as', cameraName);

  const cameras = await win.webContents.executeJavaScript(
    'window.domino.virtualCamera.listCameras()',
  );
  check(
    'the camera appears in the system device list',
    cameras.some((c) => c.includes(cameraName)),
    JSON.stringify(cameras),
  );

  let shot;
  try {
    shot = captureFromAnotherProcess(cameraName, 15000);
  } catch (err) {
    check('another process can open the camera', false, err.message);
    app.exit(1);
    return;
  }

  check('another process can open the camera and read a frame', shot.ok === true, shot.error);
  if (!shot.ok) {
    app.exit(1);
    return;
  }

  info('received', `${shot.device} ${shot.width}x${shot.height}, ${shot.bytes} bytes`);
  info('luma', `min ${shot.min}, max ${shot.max}, mean ${shot.mean.toFixed(1)}, stdev ${shot.stdev.toFixed(1)}`);

  check(
    'the frame matches the size the app is publishing',
    shot.width === status.width && shot.height === status.height,
    `${shot.width}x${shot.height} vs ${status.width}x${status.height}`,
  );
  check(
    'the frame is the right length for NV12',
    shot.bytes === (shot.width * shot.height * 3) / 2,
    `${shot.bytes} bytes`,
  );

  /*
   * The real assertion. A camera that hands back a uniform frame is indistinguishable
   * from one that is wired up and showing nothing, which is the failure this whole
   * feature is prone to - so structure in the image, not merely a frame arriving, is
   * what counts as working.
   */
  check(
    'the frame carries a real picture, not a flat fill',
    shot.stdev > 6,
    `standard deviation ${shot.stdev.toFixed(2)} across the luma plane`,
  );
  check(
    'the frame is not the black one a camera with no producer hands back',
    shot.max > 32,
    `brightest luma ${shot.max}`,
  );

  /* --------------------- sustained streaming --------------------- */

  const STREAM_MS = 10000;
  const streamer = streamFromAnotherProcess(cameraName, STREAM_MS);
  let streamOut = '';
  streamer.stdout.on('data', (d) => {
    streamOut += d;
  });
  /*
   * Attached now, not after the sampling loop below. The consumer finishes
   * while that loop is still running, so a listener added afterwards misses
   * `close` entirely and waits for an event that has already happened.
   */
  const streamerClosed = new Promise((resolve) => streamer.on('close', resolve));

  // While it streams, keep asking the renderer for something. If the app locks
  // up - which is what a consumer must never be able to cause - these stop
  // coming back.
  let worstRoundTrip = 0;
  let unanswered = 0;
  const streamStart = Date.now();
  while (Date.now() - streamStart < STREAM_MS + 2000) {
    const t0 = Date.now();
    const answered = await Promise.race([
      // Caught, so a window that went away fails the check rather than
      // rejecting into a hang.
      win.webContents.executeJavaScript('1').then(() => true, () => false),
      wait(4000).then(() => false),
    ]);
    const dt = Date.now() - t0;
    if (!answered) unanswered++;
    if (dt > worstRoundTrip) worstRoundTrip = dt;
    await wait(300);
  }
  await streamerClosed;

  let stream = {};
  try {
    stream = JSON.parse(streamOut.trim().split('\n').pop());
  } catch {
    stream = { ok: false, error: `unparseable: ${streamOut.slice(0, 200)}` };
  }

  info(
    'stream',
    `${stream.frames} frames in ${stream.elapsedMs}ms, longest gap ${stream.longestGapMs}ms`,
  );
  info('renderer round-trip while streaming', `worst ${worstRoundTrip}ms`);

  check('a sustained consumer keeps receiving frames', (stream.frames ?? 0) > 60,
    `${stream.frames} frames over ${STREAM_MS}ms`);
  check('the stream does not stall', (stream.longestGapMs ?? 9999) < 1500,
    `longest gap ${stream.longestGapMs}ms`);
  // Windows-only: a Media Foundation source can signal end-of-stream, and
  // doing so mid-call is a specific failure it has had. Nothing on Linux
  // reports this, where an absent field reads as "did not happen".
  check('the stream does not end early', stream.endOfStream !== true);
  check('the app stays responsive while a consumer streams', unanswered === 0,
    `${unanswered} unanswered probes, worst round-trip ${worstRoundTrip}ms`);

  await win.webContents.executeJavaScript('window.domino.virtualCamera.stop()');
  const after = await win.webContents.executeJavaScript(
    'window.domino.virtualCamera.status()',
  );
  check('the camera stops on request', after.running === false);

  console.log(
    failures.length === 0
      ? '\nVIRTUAL CAMERA E2E PASSED\n'
      : `\nVIRTUAL CAMERA E2E FAILED (${failures.length})\n`,
  );
  app.exit(failures.length === 0 ? 0 : 1);
});
