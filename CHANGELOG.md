# Changelog

## Unreleased

**Domino drives OBS.** A new **Stream** tab connects to OBS Studio's built-in
WebSocket server and runs a list of rules against the music: pulse a filter on
every beat, map the bass into a filter setting, show a scene item while the
treble is up, fire a hotkey every eight beats, step to the next scene on the
drop. The names a rule points at are fetched from OBS once connected, so they
are picked rather than typed. Writes are batched, rate limited to thirty a
second and only sent when a value moves; beats go out on the frame they land;
nothing waits on OBS. A request OBS refuses shows up in the panel rather than
failing silently.

**And feeds a Browser Source.** The same tab can serve a small local web page
- a spectrum ring with a transparent background - that any OBS Browser Source
can load, with Domino's audio analysis pushed to it over a WebSocket thirty
times a second. The page is an example: `domino-audio.js` from the same
address gives any overlay the bands, beat, tempo, spectrum and waveform. The
server is written directly against the protocol, loopback only, and free of
Electron so it runs in the unit tests.

**Also**

- `npm run test:stream` covers the bridge on the wire, the obs-websocket auth
  string, and the rules engine; `npm run test:stream:e2e` boots the app
  against a fake OBS and a real overlay page.
- The renderer's Content Security Policy now allows WebSocket connections,
  which the OBS client needs.

**Domino runs on Linux.** Everything the app does on Windows it now does on a
Linux desktop too, virtual camera included, and Windows is untouched.

Most of Domino was already portable - the whole renderer, the MilkDrop engine,
the Shadertoy runtime, the library and settings. What was not portable was the
two features that reach into the operating system, and both are genuinely
different here rather than ported.

**Publishing as a webcam** goes through `v4l2loopback` instead of Media
Foundation. On Windows an application cannot be a camera: it has to ship a COM
media source that Windows hosts in the Frame Server, and feed it across a
process boundary through shared memory. On Linux the kernel module *is* the
device, so the new backend opens `/dev/videoN`, negotiates NV12 and writes
frames - about two hundred lines replacing four thousand, with no second
process, no COM, no shared memory and no machine-wide registration. The GPU
NV12 packing path is untouched and feeds the kernel directly; an I420 fallback
handles a kernel that will not take NV12.

The one-time setup step is a loaded kernel module rather than a registered DLL,
so the panel offers **Load camera module**, which runs `modprobe` through
`pkexec` - one polkit prompt, once per boot, the same bargain as the UAC prompt
on Windows. It asks for `exclusive_caps=1`, without which Chrome, Firefox and
Zoom all skip a loopback node that has never had a producer. Where a device
exists but is already taken, **Add loopback device** adds another instead of
reloading the module out from under whatever is using it - Domino will not stop
your OBS stream to save you a command.

**Hearing the whole machine** takes a different route too. Linux has no
equivalent of the WASAPI loopback Chromium hands us on Windows, and Chromium
deliberately hides PulseAudio monitor sources from `enumerateDevices()`, so
there is no device for the app to pick. Domino instead points `PULSE_SOURCE` at
`@DEFAULT_MONITOR@` before the audio service starts, which makes the plain
default capture device the desktop output mix. The sound server resolves that
on every stream rather than once at launch, so it follows you from speakers to
headphones without a restart. The Mic button now names a real input device
explicitly, since "default" is no longer a microphone.

**Also**

- The virtual camera is split into per-platform backends behind one interface,
  so the main process, the IPC surface and the renderer no longer know or care
  which operating system is publishing.
- The settings panel's copy for the setup step now comes from whichever backend
  is running, instead of the renderer hardcoding `regsvr32` and "administrator
  rights" at a Linux user.
- The panel reports what the camera is *actually* called. On Linux the card
  label belongs to the kernel module and is fixed when it loads, so the name in
  settings is advisory - and telling someone to look for "Domino Visualizer"
  when the device says "Dummy video device" is how you lose ten minutes.
- Releases now build on Windows and Linux in parallel, with an AppImage added
  to the artefacts. The Linux CI job loads `v4l2loopback` so the camera tests
  run against the real kernel device rather than skipping.
- `npm run test:native` dispatches to a per-platform suite. The Linux one
  publishes a frame and reads it back through a V4L2 capture client, comparing
  the pixels byte for byte.
- The packaged-build selftest no longer fails on Linux for the absence of a
  media source DLL that has no business existing there.

## 0.4.1

**Fixes the camera producing no output.** Two separate causes, both of which
left the camera listed and silent.

The first was mine, in 0.4.0. That release made the camera device persistent so
it would stay in the list when Domino was closed, on the reasoning that call
apps read the camera list once at startup. The device did stay in the list, and
delivered *zero frames* to anything that opened it while Domino was actually
publishing. It also outlived its creator, so a crash left a dead camera behind
that nothing could remove. Reverted, and this release also clears an orphan
left by 0.4.0 - use **Unregister camera driver**, or just turn the camera on
once and off again.

The second was older and worse. Domino refused to publish whenever the shared
frame buffer already existed, on the assumption that meant a second copy of
Domino was running. But every *consumer* holds that buffer open too, so once
Discord or Zoom had opened the camera even briefly, Domino would report
"another copy is already publishing" and produce nothing until a reboot.
Whether another copy is publishing is now tracked with a lock that Windows
releases automatically when its owner dies, so a crashed Domino no longer locks
the camera out either.

**Also**

- The camera is now created and owned on a dedicated thread in the
  multithreaded apartment. Publishing from the main thread let Windows drive
  the camera through the application's UI thread, which is a freeze waiting to
  happen the moment something streams from it.
- A camera service that is still tearing down a previous session (a Domino that
  was killed rather than closed) is retried rather than reported as a failure.
- Sustained streaming is now a test. Everything here passed a
  read-one-frame check and still failed in a real call, because the failures
  only appear once something holds the camera open - so the suite now streams
  for ten seconds and asserts that frames keep arriving and the app stays
  responsive while they do.

## 0.4.0

**The camera stays in the list.** Applications build their camera list once,
when they start, so a camera that only existed while Domino happened to be
running was invisible to any call that was already open — the most common way
this feature looked broken. Domino now registers the device persistently, the
way every other virtual camera does. Pick it in Zoom whenever you like; it
shows clean black until you switch publishing on, and **Unregister camera
driver** takes it out of the list for good.

Switching *Publish as Webcam* off now pauses rather than tears down, so nothing
loses its camera mid-call. The frame channel deliberately stays open across a
pause, because closing it would change the frame size a newly opened consumer
negotiates.

**A splash screen.** Domino takes a couple of seconds to scan its preset
library, compile shaders and bring up a GL context, and showing nothing during
that reads as an app that failed to launch. The splash paints in the first
frames of the process, reports what is actually happening, and hands over the
moment the first frame is on screen. It is a shader, naturally.

**Also**

- A stale registration pointing at an older install is detected and reported
  instead of quietly producing a black camera — compared by content, so the
  same build at two paths is not a false alarm.
- Diagnostics for both camera enumeration paths, Media Foundation and
  DirectShow, since apps differ in which one they use.

## 0.3.0

**Domino can be a webcam.** Turn on **Publish as Webcam** in *Display → Virtual
Camera* and it appears as a camera in Zoom, Discord, Meet, OBS or anything else
that takes one. No capture card, no screen share, no OBS virtual-camera plugin
in between — this is an original Media Foundation media source written for
Domino.

Frames leave the GPU already packed as NV12 by a fragment shader and are read
back through pixel buffer objects, so publishing never stalls the visuals. They
cross into the Windows Frame Server through a lock-free shared-memory ring: a
slow conferencing app can drop a frame, but it can never slow the render loop
down.

Windows loads camera drivers inside its own service process, so the driver needs
a one-time machine-wide registration. **Register camera driver** does that with a
single Windows administrator prompt — it runs the standard `regsvr32` against the
shipped DLL — and there is an **Unregister** button beside it.

**Your webcam as a shader input.** Turn it on in *Display → Camera*, or press
**C**, and bind any iChannel to **Webcam**. Shaders get `iCameraResolution`,
`iCameraActive` and `iCameraMirror`, plus a `dominoCamera()` helper that applies
mirroring for you. `Camera Bloom` ships as a worked example. Shadertoy shaders
that used a webcam input now map onto this on import instead of being dropped.

**Also in this release**

- Pasting a Shadertoy `<iframe>` embed snippet imports the shader it points at.
- The packaged build verifies at startup that the camera binaries were shipped.

## 0.2.0

- 100 more presets, bringing the bundled library to 122.
- Dark, bass-driven shaders, and a horror-styled set including Crimson Fog.
- Shadertoy import by link, including multi-tab shaders (Common and Buffer A–D).
- Name your own visuals and save them into the user library.

## 0.1.0

First public build: WASAPI loopback capture, the from-scratch MilkDrop engine,
Shadertoy-compatible shader editing, and the Windows installer and portable exe.
