// Opens the virtual camera the way a real application would.
//
// The Windows counterpart of this file exists because nothing short of a real
// capture client proves the Frame Server loaded our media source. Linux has far
// less to go wrong - there is no second process and no COM - but the same
// question is still worth answering directly: if a V4L2 capture client can
// stream NV12 out of the node Domino is writing, then Zoom can too.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace domino {

struct CapturedFrame {
  uint32_t width = 0;
  uint32_t height = 0;
  std::string deviceName;
  /** Whatever fourcc the device negotiated, as four ASCII characters. */
  std::string format;
  std::vector<uint8_t> data;
};

/**
 * Read one frame from the first capture device whose label contains
 * `nameContains`, or from any capture device when that is empty.
 *
 * `timeoutMs` bounds the whole attempt: a loopback node with no producer never
 * delivers a buffer, and a test that hangs is worse than one that fails.
 */
bool CaptureOneFrame(const std::string& nameContains, uint32_t timeoutMs,
                     CapturedFrame* out, std::string* error);

struct StreamStats {
  uint32_t frames = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t longestGapMs = 0;
  uint32_t elapsedMs = 0;
};

/**
 * Hold the camera open and pull frames for a while, the way a call does.
 *
 * A single frame proves the pipe connects and says nothing about what happens
 * over minutes of streaming, which is where a stall or a leak between producer
 * and consumer would actually show up.
 */
bool StreamFromCamera(const std::string& nameContains, uint32_t durationMs,
                      StreamStats* stats, std::string* error);

}  // namespace domino
