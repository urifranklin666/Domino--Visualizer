/**
 * Virtual-camera tests.
 *
 * Run with: npm run test:native   (requires npm run build:native first)
 *
 * Only a dispatcher. The two platforms publish a camera by such different
 * means - a COM media source fed over shared memory, against a kernel loopback
 * device - that a single suite would be two suites in a trench coat, and the
 * things worth asserting barely overlap.
 */
const path = require('node:path');

const suites = {
  win32: './native.win.test.cjs',
  linux: './native.linux.test.cjs',
};

const suite = suites[process.platform];
if (!suite) {
  console.log(`SKIPPED: no virtual camera on ${process.platform}.`);
  process.exit(0);
}

require(path.join(__dirname, suite));
