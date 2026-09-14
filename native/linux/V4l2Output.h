// Publishes Domino as a webcam through v4l2loopback.
//
// The Windows side of this feature needs a COM media source hosted in another
// process and a lock-free shared-memory channel to feed it, because Windows
// will not let an application be a camera directly. Linux has no such problem:
// v4l2loopback is the device, and a producer simply writes frames into
// /dev/videoN. Everything below is therefore an open, an ioctl and a write.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace domino {

/** One /dev/video* node, as the kernel describes it. */
struct VideoDevice {
  std::string path;
  /** VIDIOC_QUERYCAP card label - "Domino Visualizer", "Integrated Camera". */
  std::string label;
  /** VIDIOC_QUERYCAP driver name; "v4l2 loopback" for the ones we can write. */
  std::string driver;
  /** The node accepts VIDEO_OUTPUT, so something may publish frames into it. */
  bool output = false;
  /** The node offers VIDEO_CAPTURE, so an application can read frames from it. */
  bool capture = false;
};

/** Every /dev/video* node, whatever it is. Never fails; an unreadable node is skipped. */
std::vector<VideoDevice> EnumerateVideoDevices();

/**
 * Loopback nodes we could publish into, best candidate first.
 *
 * A device whose label mentions Domino sorts first, so a machine with several
 * loopback nodes lands on the one that was created for us rather than on
 * whichever happens to have the lowest number.
 *
 * Note that with the module's default exclusive_caps=0 a node already carrying
 * another producer is indistinguishable from an idle one, and two writers on a
 * single loopback device interleave their frames. exclusive_caps=1 fixes that
 * as a side effect of how it flips the node between output and capture, which
 * is one of two reasons we ask for it - the other being that Chrome and Zoom
 * ignore a loopback node that has never had a producer without it.
 */
std::vector<VideoDevice> FindLoopbackDevices();

/** Capture devices an application would list, ours included. */
std::vector<std::string> EnumerateCameras();

/**
 * The pixel layout the kernel accepted for a device.
 *
 * NV12 is what the renderer packs on the GPU, and v4l2loopback normally takes
 * it unchanged. A kernel that substitutes I420 instead is handled by
 * de-interleaving the chroma plane on the way out rather than by renegotiating
 * with the renderer, which would mean plumbing a format all the way back up
 * into a fragment shader for a case most machines never hit.
 */
enum class ChromaLayout {
  Nv12,  // Y plane, then interleaved UVUV - what we are handed
  I420,  // Y plane, then a full U plane, then a full V plane
};

class V4l2Output {
 public:
  V4l2Output() = default;
  ~V4l2Output();

  V4l2Output(const V4l2Output&) = delete;
  V4l2Output& operator=(const V4l2Output&) = delete;

  /**
   * Claim a loopback device and set its format.
   *
   * `devicePath` may be empty, in which case the first usable loopback node is
   * taken. `label` is only advisory: the card label belongs to the kernel
   * module and is fixed when it is loaded, so it cannot be changed from here -
   * it is used to prefer a device that already carries Domino's name.
   */
  bool Start(const std::string& devicePath, const std::string& label,
             uint32_t width, uint32_t height, uint32_t fps, std::string* error);

  void Stop();

  bool IsRunning() const { return fd_ >= 0; }

  /**
   * Publish one NV12 frame of exactly width*height*3/2 bytes.
   *
   * A short write is treated as success. v4l2loopback drops a frame when no
   * consumer is reading fast enough, and at thirty frames a second that is
   * normal behaviour rather than something worth failing a call over.
   */
  bool WriteFrame(const uint8_t* data, size_t bytes, std::string* error);

  const std::string& DevicePath() const { return path_; }
  const std::string& DeviceLabel() const { return label_; }
  uint32_t Width() const { return width_; }
  uint32_t Height() const { return height_; }
  ChromaLayout Layout() const { return layout_; }

 private:
  int fd_ = -1;
  std::string path_;
  std::string label_;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  ChromaLayout layout_ = ChromaLayout::Nv12;
  /** Scratch for the I420 conversion, so the frame path allocates nothing. */
  std::vector<uint8_t> scratch_;
};

/** Is the v4l2loopback module loaded right now? */
bool LoopbackModuleLoaded();

/**
 * Is the module installed on this machine, whether or not it is loaded?
 *
 * Worth telling apart: a module that is merely unloaded is one pkexec away,
 * while a module that was never installed needs a package manager and a
 * kernel-headers build, which the app has no business attempting.
 */
bool LoopbackModuleInstalled();

}  // namespace domino
