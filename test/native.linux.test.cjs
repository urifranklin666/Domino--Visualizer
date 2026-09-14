/**
 * Virtual-camera tests for Linux.
 *
 * Two layers, same as the Windows suite. First the parts that hold on any
 * machine: the module's surface, how it behaves before anything is started,
 * and what it reports about v4l2loopback. Then the real thing - publish a
 * frame into a loopback device and read it back out through a V4L2 capture
 * client, which is the journey a conferencing app puts it through.
 *
 * The second layer needs a loopback device with no producer on it. That is a
 * property of the machine rather than of the build, so it is skipped rather
 * than failed when there is none - the same call the Windows suite makes about
 * a runner with no Media Foundation.
 */
const path = require('node:path');

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; }
  else { console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`); failed++; }
}

let vcam;
try {
  vcam = require(path.join(__dirname, '..', 'native', 'build', 'Release', 'domino_vcam.node'));
} catch (err) {
  console.log('SKIPPED: native module not built. Run `npm run build:native`.');
  console.log(`  (${err.message})`);
  process.exit(0);
}

check('module exposes its API',
  ['start','stop','removeCamera','isRunning','writeFrame','isRegistered',
   'moduleStatus','listLoopbackDevices','listCameras','deviceInfo',
   'captureFrameForTest','streamForTest']
    .every((k) => typeof vcam[k] === 'function'));

check('nothing is running on a cold start', vcam.isRunning() === false);

// Writing before anything is started must fail cleanly rather than crash.
const early = vcam.writeFrame(Buffer.alloc(16));
check('write before start fails cleanly', early.ok === false && !!early.error, early.error);

// Not being handed a Buffer at all is a programming error, and must still be
// an error return rather than a segfault in the addon.
const notABuffer = vcam.writeFrame('nonsense');
check('a non-Buffer frame is refused', notABuffer.ok === false, notABuffer.error);

const modules = vcam.moduleStatus();
check('module status is reported',
  typeof modules.loaded === 'boolean' && typeof modules.installed === 'boolean');
check('a loaded module counts as installed', !modules.loaded || modules.installed);

check('camera enumeration returns a list', Array.isArray(vcam.listCameras()));
check('loopback enumeration returns a list', Array.isArray(vcam.listLoopbackDevices()));

const reg = vcam.isRegistered();
check('availability is reported',
  typeof reg.registered === 'boolean' && typeof reg.path === 'string');
check('an available device names a path', !reg.registered || reg.path.startsWith('/dev/video'));

const cold = vcam.deviceInfo();
check('device info is empty before start', cold.running === false && cold.path === '');

// Naming a device that does not exist must be refused rather than fall back to
// silently publishing somewhere else.
const nowhere = vcam.start(64, 48, 30, 'Domino', '/dev/video-nonexistent');
check('an unknown device path is refused', nowhere.ok === false, nowhere.error);

if (!modules.loaded) {
  console.log('\nThe v4l2loopback kernel module is not loaded on this machine.');
  console.log('Skipping the publishing tests; the checks above still ran.');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const free = vcam.listLoopbackDevices();
if (free.length === 0) {
  console.log('\nEvery v4l2loopback device already has a producer.');
  console.log('Skipping the publishing tests; the checks above still ran.');
  console.log('  (load the module with more devices, or free one up, to run them)');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

/* --------------------------- publishing, for real --------------------------- */

const W = 320, H = 240, BYTES = W * H * 3 / 2;

const started = vcam.start(W, H, 30, 'Domino Visualizer');
check('the camera starts', started.ok === true, started.error);

if (started.ok) {
  check('it reports itself running', vcam.isRunning() === true);

  const info = vcam.deviceInfo();
  check('it published into a loopback device', info.path.startsWith('/dev/video'), info.path);
  check('the size it took is the size we asked for', info.width === W && info.height === H);
  check('it negotiated a planar YUV layout', info.format === 'NV12' || info.format === 'I420',
    info.format);

  // A wrong-sized frame must be refused rather than written past the format.
  const wrong = vcam.writeFrame(Buffer.alloc(BYTES + 10));
  check('a mismatched frame size is refused', wrong.ok === false, wrong.error);

  /*
   * A gradient rather than a flat fill: a frame that is all one value would
   * survive a layout bug, a stride bug and a plane-ordering bug without
   * changing a single byte.
   */
  const frame = Buffer.alloc(BYTES);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) frame[y * W + x] = (x * 3 + y * 5) & 0xff;
  }
  for (let i = W * H; i < BYTES; i++) frame[i] = (i * 7) & 0xff;

  check('a frame writes', vcam.writeFrame(frame).ok === true);

  /*
   * Fill the queue before opening a reader. v4l2loopback hands a new capture
   * client the buffer that is waiting for it, and with none waiting the read
   * would block until the timeout for reasons that have nothing to do with
   * whether the pixels are right.
   */
  for (let i = 0; i < 4; i++) vcam.writeFrame(frame);

  const shot = vcam.captureFrameForTest(info.label, 5000);
  check('a capture client reads the camera back', shot.ok === true, shot.error);

  if (shot.ok) {
    check('the frame comes back at the published size',
      shot.width === W && shot.height === H, `${shot.width}x${shot.height}`);
    check('the frame comes back with every byte',
      shot.data.length === BYTES, `${shot.data.length} of ${BYTES}`);

    /*
     * Compared only when the kernel took NV12. Under I420 the addon
     * de-interleaves the chroma plane on the way out, so the bytes are
     * deliberately not the ones we handed it - the luma plane is untouched
     * either way, and that is what carries the layout.
     */
    const luma = BYTES === shot.data.length && info.format === 'NV12'
      ? Buffer.compare(shot.data, frame) === 0
      : Buffer.compare(shot.data.subarray(0, W * H), frame.subarray(0, W * H)) === 0;
    check(info.format === 'NV12'
      ? 'the pixels are identical end to end'
      : 'the luma plane survives the I420 conversion', luma);
  }

  vcam.stop();
  check('it stops', vcam.isRunning() === false);
  check('device info is empty again', vcam.deviceInfo().path === '');

  // Stopping twice is what the app does when it quits while already stopped.
  vcam.stop();
  check('stopping twice is harmless', vcam.isRunning() === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
