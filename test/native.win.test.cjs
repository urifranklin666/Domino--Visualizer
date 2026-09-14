/**
 * Virtual-camera tests.
 *
 * Run with: npm run test:native   (requires npm run build:native first)
 *
 * Two layers. The shared-memory channel comes first, because a seqlock bug
 * produces torn frames only under load and is close to undebuggable once it is
 * inside the Windows Frame Server. Then the media source DLL itself, loaded
 * directly and driven with a real source reader - which covers everything the
 * DLL does except the hop through the Frame Server, and needs no machine-wide
 * registration to run.
 */
const fs = require('node:fs');
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
  ['registerSource','registerSourceElevated','unregisterSource','isRegistered',
   'openChannel','closeChannel','start','stop','isRunning','writeFrame',
   'listCameras','listDirectShowCameras','mediaFoundationAvailable',
   'setPublishing','removeCamera','probeSourceClass','captureFromDllForTest']
    .every((k) => typeof vcam[k] === 'function'));

check('nothing is running on a cold start', vcam.isRunning() === false);

// Writing with no channel open must fail cleanly rather than crash.
const early = vcam.writeFrame(Buffer.alloc(16));
check('write without a channel fails cleanly', early.ok === false && !!early.error, early.error);

const W = 64, H = 48, BYTES = W * H * 3 / 2;
check('channel opens', vcam.openChannel(W, H, 30).ok === true);

// Odd dimensions have no valid NV12 layout and must be rejected.
const odd = vcam.openChannel(65, 49, 30);
check('odd dimensions are rejected', odd.ok === false, odd.error);
check('channel reopens after a rejected size', vcam.openChannel(W, H, 30).ok === true);

const frame = Buffer.alloc(BYTES);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) frame[y * W + x] = (x * 4 + y) & 0xff;
frame.fill(0x80, W * H);

check('frame writes', vcam.writeFrame(frame).ok === true);

const back = vcam.readBackForTest();
check('frame reads back', back !== null);
if (back) {
  check('dimensions survive', back.width === W && back.height === H);
  check('byte count survives', back.data.length === BYTES);
  check('pixels are identical', Buffer.compare(back.data, frame) === 0);
}

// A wrong-sized frame must be refused, not written past the slot.
const wrong = vcam.writeFrame(Buffer.alloc(BYTES + 10));
check('mismatched frame size is refused', wrong.ok === false, wrong.error);

// Slot rotation and the seqlock, repeatedly.
let mismatches = 0;
for (let i = 0; i < 500; i++) {
  frame[0] = i & 0xff;
  frame[BYTES - 1] = (255 - i) & 0xff;
  if (!vcam.writeFrame(frame).ok) { mismatches++; continue; }
  const r = vcam.readBackForTest();
  if (!r || Buffer.compare(r.data, frame) !== 0) mismatches++;
}
check('500 round-trips with no tearing', mismatches === 0, `${mismatches} mismatched`);

const beforeClose = vcam.readBackForTest();
check('heartbeat advances', beforeClose && beforeClose.heartbeat > 1);

vcam.closeChannel();
check('reader detaches after close', vcam.readBackForTest() === null);

// Registration reporting should be honest about a path that does not exist.
const reg = vcam.isRegistered();
check('registration state is reported', typeof reg.registered === 'boolean');

const missing = vcam.registerSource('E:\\nowhere\\domino_vcam_source.dll');
check('registering a missing DLL is refused', missing.ok === false, missing.error);

/*
 * Everything below needs Media Foundation. Windows Server - and therefore most
 * CI runners - ships without it, which makes the camera unavailable through no
 * fault of the build. The transport tests above are pure Win32 and always run.
 */
const HAS_MF = vcam.mediaFoundationAvailable();
if (!HAS_MF) {
  console.log('\nMedia Foundation is not installed on this machine.');
  console.log('Skipping the media source tests; the transport tests above still ran.');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

check('camera enumeration returns a list', Array.isArray(vcam.listCameras()));

/* ------------------------- the media source DLL ------------------------- */

const DLL = path.join(__dirname, '..', 'native', 'build', 'Release', 'domino_vcam_source.dll');

if (!fs.existsSync(DLL)) {
  console.log('SKIPPED: media source DLL not built.');
} else {
  // Loaded straight off disk rather than through the registry, so this runs
  // without administrator rights and works in CI.
  const probe = vcam.probeSourceClass(DLL);
  check('the DLL creates a media source', probe.ok === true, probe.error);

  // The registered CLSID must resolve to an activate object, not to the source
  // itself. Windows creates the class, queries this, and calls ActivateObject;
  // a class that hands back a media source directly is created successfully
  // and then rejected by the Frame Server with a bare E_NOINTERFACE.
  check(
    'the CLSID resolves to an activate object',
    probe.interfaces?.['IMFActivate (on the class)'] === 0,
    `hr 0x${((probe.interfaces?.['IMFActivate (on the class)'] ?? -1) >>> 0).toString(16)}`,
  );

  const required = [
    'IMFMediaSource',
    'IMFMediaSourceEx',
    'IMFMediaEventGenerator',
    'IMFGetService',
    'IKsControl',
    'IMFSampleAllocatorControl',
  ];
  for (const name of required) {
    const hr = probe.interfaces?.[name];
    check(`source implements ${name}`, hr === 0, `hr 0x${((hr ?? -1) >>> 0).toString(16)}`);
  }

  const badPath = vcam.probeSourceClass('E:\\nowhere\\domino_vcam_source.dll');
  check('a missing DLL is reported, not crashed on', badPath.ok === false);

  // With nothing publishing, the source must still deliver frames: a camera
  // that stalls when the app is idle would hang whatever opened it.
  vcam.closeChannel();
  const black = vcam.captureFromDllForTest(DLL, 8000);
  check('source produces frames with no producer', black.ok === true, black.error);
  if (black.ok) {
    check(
      'fallback frame uses the declared default size',
      black.width === 1280 && black.height === 720,
      `${black.width}x${black.height}`,
    );
    check(
      'fallback frame is black, not garbage',
      black.data[0] === 16 && black.data[black.width * black.height] === 128,
      `luma ${black.data[0]}, chroma ${black.data[black.width * black.height]}`,
    );
  }

  // The real path: a frame written into shared memory has to come back out of
  // the media source byte for byte.
  const CW = 640;
  const CH = 480;
  check('channel opens at the camera size', vcam.openChannel(CW, CH, 30).ok === true);

  const source = Buffer.alloc((CW * CH * 3) / 2);
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) source[y * CW + x] = (x * 3 + y * 5) & 0xff;
  }
  // Not 128: a neutral chroma plane would pass even if the plane were dropped.
  source.fill(200, CW * CH);
  check('frame is published', vcam.writeFrame(source).ok === true);

  const shot = vcam.captureFromDllForTest(DLL, 8000);
  check('source delivers a frame', shot.ok === true, shot.error);
  if (shot.ok) {
    check(
      'source adopts the size the channel declares',
      shot.width === CW && shot.height === CH,
      `${shot.width}x${shot.height}`,
    );
    check('frame is the right length', shot.data.length === (CW * CH * 3) / 2,
      `${shot.data.length} bytes`);
    check(
      'luma survives the round trip byte for byte',
      Buffer.compare(shot.data.subarray(0, CW * CH), source.subarray(0, CW * CH)) === 0,
    );
    check(
      'chroma survives the round trip byte for byte',
      Buffer.compare(shot.data.subarray(CW * CH), source.subarray(CW * CH)) === 0,
    );
  }

  /*
   * Pausing must show black rather than freeze on the last frame. The channel
   * deliberately stays open across a pause - closing it would change the frame
   * size a newly created source picks up - so the source has to notice the
   * flag instead of the absence of the channel.
   */
  vcam.setPublishing(false);
  const paused = vcam.captureFromDllForTest(DLL, 8000);
  check('a paused producer still delivers frames', paused.ok === true, paused.error);
  if (paused.ok) {
    check(
      'paused frames are black, not the last picture',
      paused.data[0] === 16 && paused.data[paused.width * paused.height] === 128,
      `luma ${paused.data[0]}, chroma ${paused.data[paused.width * paused.height]}`,
    );
    check(
      'the frame size is unchanged by pausing',
      paused.width === CW && paused.height === CH,
      `${paused.width}x${paused.height}`,
    );
  }

  vcam.setPublishing(true);
  vcam.writeFrame(source);
  const resumed = vcam.captureFromDllForTest(DLL, 8000);
  check('resuming brings the picture back', resumed.ok === true, resumed.error);
  if (resumed.ok) {
    check(
      'resumed luma matches what was published',
      Buffer.compare(resumed.data.subarray(0, CW * CH), source.subarray(0, CW * CH)) === 0,
    );
  }

  vcam.closeChannel();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
