# Domino

A desktop music visualizer that listens to **everything your computer plays**, runs
**Shadertoy-compatible shaders** you can edit live, and includes a **from-scratch
MilkDrop engine** that loads, renders, tweaks and re-saves `.milk` presets. It can
also take your **webcam as a shader input** and publish itself back out **as a
webcam**, so the visuals go straight into Zoom, Discord or Meet.

Built with Electron + TypeScript + WebGL2. No third-party visualizer libraries —
the MilkDrop equation compiler, warp engine, HLSL translator and the virtual
camera backends on both platforms are all original.

## Download

Grab the latest **[Release](../../releases)** and pick one:

| File | What it is |
|---|---|
| `Domino-Setup-x.y.z.exe` | Windows installer. Start-menu and desktop shortcuts, uninstall entry, installs per-user so it needs no admin rights. |
| `Domino-x.y.z-portable.exe` | Windows, single file. Run it, no install. Good for a USB stick. |
| `Domino-x.y.z-x86_64.AppImage` | Linux, single file. `chmod +x` and run it, no install. |

Windows 10/11 or a 64-bit Linux desktop. Any GPU from the last decade will do —
it needs WebGL2.

> **SmartScreen warning:** the Windows builds are unsigned, so Windows will show
> "Windows protected your PC" the first time. Click **More info → Run anyway**.
> Signing requires a paid code-signing certificate; until there is one, that
> prompt is expected.

## Building it yourself

```bash
npm install
npm run dev         # development, with hot reload
npm run build       # production build into out/
npm start           # run the production build
npm run dist:win    # package installer + portable exe into release/
npm run dist:linux  # package AppImage into release/
npm run gen:presets # regenerate the generated preset families
npm run gen:icon    # regenerate build/icon.ico
```

The virtual camera is a C++ addon and is built separately, because most work on
Domino does not touch it:

```bash
npm run build:native # compile the addon for this platform
npm run test:native  # exercise it against the OS
```

Cutting a release: `npm version patch && git push --follow-tags`. The GitHub
Actions workflow builds on Windows and Linux in parallel, runs the full test
suite on each, verifies the *packaged* binary boots and finds its preset
library, and attaches every artefact to a published Release.

---

## What it does

### Hears the whole machine

Click **System Audio** and Domino captures the full output mix — Spotify, a
browser tab, a game, a DAW, all of it at once. There is no source picker and no
screen sharing.

How it gets there differs by platform, and neither route asks the user anything.
On Windows the main process answers the renderer's `getDisplayMedia` request
with `audio: 'loopback'` — Chromium's WASAPI render-endpoint loopback — and
discards the video track immediately. Linux has no such capability, and
Chromium deliberately hides PulseAudio monitor sources from
`enumerateDevices()`, so there is nothing to pick; instead Domino points
`PULSE_SOURCE` at `@DEFAULT_MONITOR@` before the audio service starts, which
makes the plain default capture device the desktop mix. Because that is
resolved by the sound server on every stream rather than once at launch, it
keeps following you from speakers to headphones mid-session.

Other inputs: **Mic**, any input device, or **File…** for local audio (which also
plays out of your speakers).

### Analyses it musically

Raw FFT magnitudes make for bad visuals, so the analyser produces what presets
actually want:

- **`bass` / `mid` / `treb`** — band energy divided by a slow-moving long-term
  average, so they sit around 1.0 and respond to *changes* in the music rather
  than absolute loudness. A quiet passage still drives a preset. This is
  MilkDrop's convention, which is why MilkDrop presets behave correctly.
- **`*Att` variants** — fast-attack, slow-release followers. Hits land tight,
  motion doesn't stutter.
- **Beat detection** — spectral flux with an adaptive threshold and a refractory
  period, weighted toward the low end where percussion lives.
- **Tempo** — autocorrelation of the onset envelope over 60–200 BPM, with
  octave-error correction.
- Stereo waveform and per-channel spectrum.

### Runs Shadertoy shaders

Paste a shader from shadertoy.com and it works. `iResolution`, `iTime`,
`iFrame`, `iMouse`, `iDate`, `iChannel0-3` and the rest are all provided, with
audio on `iChannel0` in Shadertoy's exact 512×2 layout.

On top of that, Domino passes the *analysed* audio directly, so you don't
have to re-derive a bass level in GLSL:

```glsl
uniform float iBass, iMid, iTreb;          // ~1.0 average, relative
uniform float iBassAtt, iMidAtt, iTrebAtt; // smoothed
uniform float iVolume, iVolumeAtt;
uniform float iBeat, iBeatPulse, iBPM;     // beat flag, decaying pulse, tempo
uniform float iRMS, iPeak, iSensitivity;

float dominoSpectrum(float x);  // spectrum lookup, 0..1
float dominoWave(float x);      // waveform lookup, -1..1
```

Three source styles are accepted automatically: a Shadertoy `mainImage()`, a
bare `main()`, or a complete shader with its own `#version` directive.

### Importing from Shadertoy

**Paste the link.** Shaders tab → **Import…** → *From Shadertoy link…* → paste
any `shadertoy.com/view/...` URL (or just the ID). Domino fetches it and wires
everything up: each Buffer becomes a pass, the Common tab is carried across, and
every iChannel is bound to whatever the original used.

Audio inputs are the one deliberate change — a shader that played a fixed
Shadertoy track now listens to **your** system audio instead.

**First time only**, it asks for a Shadertoy API key. The key is free: sign in
at shadertoy.com, open your profile → **App Settings**, and create one
([instructions](https://www.shadertoy.com/howto#q2)). It is stored locally in
your settings and only ever sent to shadertoy.com. There is no unauthenticated
way to read shaders, so this step is unavoidable.

Imports carry an attribution header naming the shader, its author and the source
URL. Shadertoy shaders are CC BY-NC-SA 3.0 by default unless their author says
otherwise — keep the credit if you pass one on.

**What can't come across**, and you'll be told when it happens:

| Shadertoy feature | What Domino does |
|---|---|
| Textures (`Abstract 1`, noise images, etc.) | Substitutes procedural noise and warns — the shader may look different |
| Sound pass | Skipped. Domino visualizes audio; it doesn't synthesize it |
| Cubemap / volume / video | Left unbound, with a warning |
| Webcam | Maps directly onto Domino's own camera input |
| Keyboard input | Unsupported, with a warning |

If a shader has no audio input at all, Domino says so — it will render but won't
react until you point an iChannel at Audio.

### Doing it by hand

You can also transcribe a shader tab by tab. The editor has the same tabs
Shadertoy does — Common, Buffer A–D, Image — with the iChannel bindings as
dropdowns beneath them. **+ Buffer A** adds a pass, **+ Common** adds the shared
block, **Ctrl+Enter** compiles, **Ctrl+S** saves.

Errors are reported per tab: a mistake in Common marks the Common tab, and
mistakes in a pass map back to that pass's own line numbers even though Common
was prepended to it.

**On disk** it's still one `.glsl` file. Tabs are stored as directives, so a
shader stays a single file you can copy or mail:

```glsl
//! common
float hash(vec2 p) { ... }        // prepended to every pass

//! pass BufferA
//! channel0 = bufferA            // reads its own previous frame
//! channel1 = audio
void mainImage(out vec4 o, in vec2 u) { ... }

//! pass Image
//! channel0 = bufferA
void mainImage(out vec4 o, in vec2 u) { ... }
```

You never have to write those by hand — the editor does — but the format is
plain enough to edit anywhere. Channel sources are `audio`, `noise`,
`bufferA`–`bufferD`, or `none`, and bindings matching the obvious default are
left out. A file with no directives is a plain single-pass shader, so pasting
just an Image tab still works untouched.

Feedback buffers are what make trails, fluid advection and reaction-diffusion
possible; `Ink Fluid` and `Particle Trails` in the bundled library both use one.

### Takes your webcam as a shader input

Turn it on in **Display > Camera**, or press **C**. Bind any iChannel to
**Webcam** in the editor and sample it:

```glsl
//! channel1 = webcam

vec3 c = dominoCamera(iChannel1, uv);   // mirroring handled for you
```

Shaders also get `iCameraResolution`, `iCameraActive` and `iCameraMirror`.
`Camera Bloom` in the bundled library is a worked example: chromatic split,
bass-driven pinch, beat-gated bloom and a spectrum bar over the live feed.

Shadertoy shaders that used a `webcam` input map onto this directly on import.

### Becomes a webcam of its own

Turn on **Publish as Webcam** in **Display > Virtual Camera** and Domino shows
up as a camera in Zoom, Discord, Meet, OBS or anything else that takes one. No
capture card, no screen share, no OBS virtual-camera plugin in between.

Frames leave the GPU already packed as NV12 by a fragment shader and are read
back through pixel buffer objects, so publishing never stalls the visuals. That
much is shared; below it the two platforms have nothing in common.

**Windows** will not let an application simply *be* a camera. The camera is a
Media Foundation media source — a COM class that Windows creates inside its own
Frame Server process — so Domino ships one, written for this, and frames cross
the process boundary through a lock-free shared-memory ring. A stalled
conferencing app can never slow the render loop down; it just misses a frame.
Because the Frame Server runs as LocalService, the COM registration has to be
machine-wide: **Register camera driver** does that with one administrator
prompt, running the standard `regsvr32` against the shipped DLL, and is needed
exactly once. There is an **Unregister** button beside it, because the
uninstaller cannot remove it without elevation of its own.

**Linux** needs none of that. `v4l2loopback` *is* the camera device, so
publishing is opening `/dev/videoN`, negotiating NV12 and writing frames — the
whole backend is about two hundred lines against the kernel's uapi headers, with
no second process, no COM and no shared memory. What it does need is for a
loopback device to exist, which means an out-of-tree kernel module: install
`v4l2loopback-dkms` (or `akmod-v4l2loopback` on Fedora), then **Load camera
module** runs `modprobe` through `pkexec` — one polkit prompt, once per boot.
It asks for `exclusive_caps=1`, without which Chrome, Firefox and Zoom all skip
a loopback node that has never had a producer. Where a device already exists but
is taken, **Add loopback device** adds one more rather than reloading the module
out from under whatever is using it.

One asymmetry worth knowing: the camera's name is yours to choose on Windows,
but on Linux the card label belongs to the kernel module and is fixed when it
loads. The settings field is advisory there, and the panel tells you what the
camera is actually called.

### Runs MilkDrop presets

**122 presets ship with the app**, spanning MilkDrop 1-style equation presets
and MilkDrop 2 presets with custom warp and composite shaders. Ten are
hand-written; the rest come from `npm run gen:presets`, which builds fourteen
hand-authored visual families - Tunnels, Vortex, Ripples, Bloom, Chrome, Nebula,
Lattice, Kaleido, Orbits, Waveforms, Flares, Echoes, Drift, Pulse - and varies
palette, motion direction, audio routing and decay within each. They are real
`.milk` files: open one in the editor and change it like any other.

Point **Import…** at a folder of `.milk` files and thousands more show up,
grouped by folder. The engine is a full reimplementation:

| Piece | What it is |
|---|---|
| **`.milk` parser** | Reassembles numbered code lines in numeric order, strips shader backtick markers, preserves unknown keys for lossless round-trips |
| **NS-EEL compiler** | Lexer → Pratt parser → **JavaScript codegen**, run through `new Function` so equations hit V8's JIT |
| **Warp engine** | MilkDrop's per-vertex transform: radius-dependent zoom exponent, four-octave sine warp, rotate/stretch/translate, on a configurable mesh |
| **HLSL translator** | Converts MilkDrop 2 `warp_`/`comp_` pixel shaders to GLSL ES 3.00 |
| **Decorations** | Waveform modes 0–7, custom waves 0–3, custom shapes 0–3, borders, motion vectors, darkened centre |
| **Blur pyramid** | Three separable-Gaussian levels backing `GetBlur1/2/3()` |
| **Crossfade** | Two presets render simultaneously and dissolve between |

Why compile EEL to JavaScript rather than interpret it? Per-pixel equations run
once per mesh vertex per frame — at a 48×36 mesh and 60fps that is over 100,000
evaluations a second. A tree-walking interpreter cannot keep up; generated JS
gets optimised by V8 like any other hot function.

### Lets you edit all of it

Press **E** (or **Edit**). Monaco opens over the stage with syntax highlighting
for GLSL and EEL.

- For a shader: one tab per pass — Common, Buffer A–D, Image — matching
  Shadertoy, with the iChannel bindings as dropdowns beneath them.
- For a MilkDrop preset: five tabs — `per_frame`, `per_pixel`,
  `per_frame_init`, the warp shader and the comp shader.

**Ctrl+Enter** recompiles. Compilation is transactional: if anything fails, the
previously working version keeps rendering and the errors appear as inline
squiggles mapped back to *your* line numbers, not the generated source's.
**Ctrl+S** saves.

The right-hand **Parameters** panel exposes every MilkDrop scalar as a live
slider, grouped the way MilkDrop groups them. Parameters that the preset's own
equations overwrite each frame are marked with `*` — a slider that appears not
to work is being overwritten, and the panel says so rather than leaving you
guessing.

### Naming and managing what you make

**Save** (Ctrl+S) writes over your file. **Save As…** (Ctrl+Shift+S, and it works
without opening the editor) asks for a name and puts it in your library. If the
name is taken you get a replace confirmation rather than a silent overwrite.

Right-click anything in the library for **Rename**, **Duplicate** and **Delete**.

Bundled visuals are never modified in place: saving over one, or renaming it,
forks it into your library under the new name and leaves the shipped file alone.
Delete only touches your own files — and if one of yours was shadowing a bundled
visual of the same name, deleting it brings the original back rather than
removing the entry.

### A dark set

`resources/shaders/Dark/` holds ten low-key, bass-driven pieces built for heavy
music rather than for showing off colour:

| | |
|---|---|
| **Bayou Smoke** | Rising smoke lit from below by a dull ember |
| **Bleeding Wall** | Blood wells up and runs down a dark wall in discrete drips |
| **Candle Vigil** | A row of guttering candles in a black room |
| **Concrete Sermon** | Brutalist slabs under one swinging red light |
| **Crimson Fog** | A dead sun over fog banks and a black treeline |
| **Distortion Pedal** | The waveform hard-clipped and torn into bands |
| **Open Wound** | A wet aperture that dilates on the low end |
| **Rusted Chapel** | Gothic arches with something burning behind them |
| **Static Ritual** | An occult sigil on a failing VHS tape |
| **Subwoofer Ghost** | 808 shockwaves rolling off a speaker cone |

They deliberately sit in the bottom of the range so a kick reads as light
*arriving* rather than the picture merely getting brighter. If they look too dark
on your display, raise **Brightness** in the Display tab rather than editing them.

### Controls the image

Visualizers blow out easily — feedback buffers accumulate, MilkDrop's
`gammaAdj` is a straight multiplier, and additive waves stack. Written to an
8-bit display that just clips every channel to white.

So the scene renders into a float buffer and goes through a final image stage
before it reaches the screen. A filmic (ACES) tone-map rolls highlights off
smoothly instead of clipping, which keeps detail and hue in the bright areas.

The **Display** tab in the inspector controls it:

| | |
|---|---|
| **Brightness** | Exposure before tone mapping. Lower this first if something is too hot. |
| **Contrast / Saturation / Gamma** | Standard image trims, applied after tone mapping. |
| **Filmic Tone Map** | Turn off for the raw, harder, clipping MilkDrop look. |
| **Vignette** | Corner darkening. |
| **Render Scale** | Below 100% trades sharpness for frame rate; above 100% supersamples. |
| **Warp Mesh X/Y** | MilkDrop grid resolution — smoother motion vs. CPU cost. |
| **Preset Blend / Auto Interval** | Crossfade length and auto-advance timing. |

These are user settings, not preset settings: they persist across every visual
and are never written into a preset file.

### Goes properly fullscreen

**F**, the **Fullscreen** button, or a double-click enters *immersive* mode:
OS fullscreen with no interface at all — no sidebar, no inspector, no transport
bar. The pointer hides after a few idle seconds, and the preset name flashes on
screen whenever the visual changes so you still know what is playing. **Esc**
brings everything back.

This is distinct from just maximising the window, which would only make the
panels bigger. **H** hides the interface without going fullscreen.

---

## Keyboard

| Key | Action |
|---|---|
| `Space` | Random preset |
| `←` / `→` | Previous / next preset |
| `E` | Toggle editor |
| `F` / double-click | Immersive fullscreen (no interface) |
| `H` | Hide the interface, stay windowed |
| `I` | Flash the current preset name |
| `C` | Toggle the webcam input |
| `Esc` | Close editor / leave fullscreen |
| `Ctrl+Enter` | Recompile (in editor) |
| `Ctrl+S` | Save |
| `Ctrl+Shift+S` | Save As — name it |

---

## Where files live

| | |
|---|---|
| Bundled content | `resources/{shaders,milk,presets}/` |
| Your content | `%APPDATA%/domino/library/{shaders,milk,presets}/` |
| Settings | `%APPDATA%/domino/settings.json` |

A visual's **name is its filename** — renaming in the app renames the file.

The **Folder** button opens your library directory.

---

## Layout

```
src/
  main/          Electron main: window, loopback handler, library IPC, settings
  preload/       Typed context bridge
  shared/        Types crossing the process boundary
  renderer/
    audio/       Capture graph, band analysis, beat and tempo detection
    gl/          WebGL2 context, programs, framebuffers, audio + post stage
    shadertoy/   Shadertoy-compatible multipass runtime and document format
    milkdrop/
      eel/       NS-EEL lexer, parser, JS compiler, runtime
      hlsl/      MilkDrop 2 HLSL -> GLSL ES translator
      *.ts       Parser, preset model, warp mesh, blur, decorations, engine
    ui/          Editor, library browser, parameter and display panels
test/
  eel.test.ts     NS-EEL semantics (53 cases)
  milk.test.ts    Parser, serializer, HLSL translation (71 cases)
  shader.test.ts  Pass model, directives, round-trip serialising (68 cases)
  import.test.ts  Shadertoy URL parsing, pass and channel mapping (43 cases)
  smoke.cjs       Boots the real app, loads every visual, verifies audio and
                  fullscreen end to end
```

---

## Tests

```bash
npm test           # 235 unit tests: EEL, .milk parser, HLSL, shader documents
npm run test:smoke # boots the real app end to end
npm run typecheck
```

`npm run build && npm run test:smoke -- --shots ./shots` additionally saves a PNG
of every bundled visual and fails on any that render blank.

The smoke test boots the *shipping* main process and checks the things that
static analysis cannot:

- every bundled preset and shader loads and compiles clean
- each one renders a non-blank frame (via `capturePage` — `readPixels` on the
  default framebuffer returns black after present, so it cannot tell a working
  visualizer from a broken one)
- system-audio capture starts, and the analyser produces a *varying* signal from
  the loopback tap
- immersive fullscreen actually fills the window, with no leftover row reserved
  for the transport bar, and `Esc` restores the interface

---

## Known limits

Honest notes on where this is an approximation rather than a port:

- **Waveform modes 0–7** reproduce the character of MilkDrop's eight modes and
  respond correctly to `wave_x/y/scale/mystery`, but they are not bit-exact
  ports of its geometry code. Custom waves and shapes, which is where most
  modern presets do their drawing, follow the real per-point/per-frame model.
- **The HLSL translator** covers the documented MilkDrop shader interface and
  the intrinsics presets actually use. Exotic HLSL will fail to translate; when
  that happens the engine substitutes the default shader, keeps the preset
  watchable, and reports the error in the inspector instead of going black.
- **Motion vectors** are drawn as a simple field rather than sampling the true
  warp field.
- **Textured custom shapes** ignore the `textured` flag and render flat.
- **System-audio loopback** works on Windows (WASAPI) and on Linux with a
  PulseAudio or PipeWire server. On a bare-ALSA machine there is no output
  monitor to capture and the button says so; use **Mic** with a loopback device
  as the fallback. macOS is not supported at all.
- **The virtual camera** is Windows and Linux only, and on Linux it needs the
  `v4l2loopback` kernel module, which Domino can load but cannot install.
- The renderer bundle is large (~6.5 MB) because it includes all of Monaco.
  Trimming it to just the core editor would cut most of that.

## Note on `unsafe-eval`

The Content-Security-Policy allows `unsafe-eval`. This is required, not
incidental: the MilkDrop equation compiler generates JavaScript and instantiates
it with `new Function`. The generated text is built entirely from our own AST —
identifiers only ever become property names on a scope object and numbers are
re-emitted from parsed floats — so preset source is never interpolated into
executable text.

## License

MIT
