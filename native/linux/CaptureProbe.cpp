#include "CaptureProbe.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/videodev2.h>
#include <poll.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>

#include "V4l2Output.h"

namespace domino {
namespace {

constexpr uint32_t kBufferCount = 4;

int Ioctl(int fd, unsigned long request, void* arg) {
  int result;
  do {
    result = ::ioctl(fd, request, arg);
  } while (result == -1 && errno == EINTR);
  return result;
}

uint64_t NowMs() {
  timespec ts{};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<uint64_t>(ts.tv_sec) * 1000 + ts.tv_nsec / 1000000;
}

std::string Lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  return s;
}

std::string FourccOf(uint32_t fourcc) {
  return {static_cast<char>(fourcc & 0xff),
          static_cast<char>((fourcc >> 8) & 0xff),
          static_cast<char>((fourcc >> 16) & 0xff),
          static_cast<char>((fourcc >> 24) & 0xff)};
}

/** The capture node matching `nameContains`, or the first one when it is empty. */
bool PickDevice(const std::string& nameContains, VideoDevice* out,
                std::string* error) {
  const std::string needle = Lower(nameContains);
  for (const VideoDevice& device : EnumerateVideoDevices()) {
    if (!device.capture) continue;
    if (!needle.empty() && Lower(device.label).find(needle) == std::string::npos) {
      continue;
    }
    *out = device;
    return true;
  }
  *error = nameContains.empty()
               ? "No video capture device was found."
               : "No capture device named like \"" + nameContains + "\" was found.";
  return false;
}

/** One mmap'd capture buffer. */
struct Mapping {
  void* start = MAP_FAILED;
  size_t length = 0;
};

/**
 * A streaming capture session, torn down in the right order however it ends.
 *
 * Everything here has to be undone - queued buffers, mmaps, the stream itself -
 * and doing that by hand at each of the dozen failure points below is how a
 * probe ends up leaking the device it was meant to be testing.
 */
class CaptureSession {
 public:
  ~CaptureSession() {
    if (streaming_) {
      v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
      Ioctl(fd_, VIDIOC_STREAMOFF, &type);
    }
    for (Mapping& m : maps_) {
      if (m.start != MAP_FAILED) ::munmap(m.start, m.length);
    }
    if (fd_ >= 0) ::close(fd_);
  }

  bool Open(const VideoDevice& device, std::string* error) {
    device_ = device;
    fd_ = ::open(device.path.c_str(), O_RDWR);
    if (fd_ < 0) {
      *error = "Could not open " + device.path + ": " + strerror(errno);
      return false;
    }

    v4l2_format fmt{};
    fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    if (Ioctl(fd_, VIDIOC_G_FMT, &fmt) != 0) {
      *error = std::string("VIDIOC_G_FMT failed: ") + strerror(errno);
      return false;
    }
    width_ = fmt.fmt.pix.width;
    height_ = fmt.fmt.pix.height;
    format_ = FourccOf(fmt.fmt.pix.pixelformat);
    imageBytes_ = fmt.fmt.pix.sizeimage;

    v4l2_requestbuffers request{};
    request.count = kBufferCount;
    request.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    request.memory = V4L2_MEMORY_MMAP;
    if (Ioctl(fd_, VIDIOC_REQBUFS, &request) != 0) {
      *error = std::string("VIDIOC_REQBUFS failed: ") + strerror(errno);
      return false;
    }

    maps_.resize(request.count);
    for (uint32_t i = 0; i < request.count; i++) {
      v4l2_buffer buffer{};
      buffer.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
      buffer.memory = V4L2_MEMORY_MMAP;
      buffer.index = i;
      if (Ioctl(fd_, VIDIOC_QUERYBUF, &buffer) != 0) {
        *error = std::string("VIDIOC_QUERYBUF failed: ") + strerror(errno);
        return false;
      }
      maps_[i].length = buffer.length;
      maps_[i].start = ::mmap(nullptr, buffer.length, PROT_READ | PROT_WRITE,
                              MAP_SHARED, fd_, buffer.m.offset);
      if (maps_[i].start == MAP_FAILED) {
        *error = std::string("mmap failed: ") + strerror(errno);
        return false;
      }
      if (Ioctl(fd_, VIDIOC_QBUF, &buffer) != 0) {
        *error = std::string("VIDIOC_QBUF failed: ") + strerror(errno);
        return false;
      }
    }

    v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    if (Ioctl(fd_, VIDIOC_STREAMON, &type) != 0) {
      *error = std::string("VIDIOC_STREAMON failed: ") + strerror(errno);
      return false;
    }
    streaming_ = true;
    return true;
  }

  /**
   * Wait for one frame, copying it out when `out` is given.
   *
   * Returns false on timeout, which is the expected answer for a loopback node
   * nobody is publishing into rather than a fault.
   */
  bool NextFrame(uint32_t timeoutMs, std::vector<uint8_t>* out) {
    pollfd pfd{fd_, POLLIN, 0};
    const int ready = ::poll(&pfd, 1, static_cast<int>(timeoutMs));
    if (ready <= 0) return false;

    v4l2_buffer buffer{};
    buffer.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    buffer.memory = V4L2_MEMORY_MMAP;
    if (Ioctl(fd_, VIDIOC_DQBUF, &buffer) != 0) return false;

    if (out) {
      const size_t bytes = std::min<size_t>(
          buffer.bytesused ? buffer.bytesused : imageBytes_, maps_[buffer.index].length);
      const uint8_t* pixels = static_cast<const uint8_t*>(maps_[buffer.index].start);
      out->assign(pixels, pixels + bytes);
    }

    // Hand the buffer straight back: four are in flight, and a caller that
    // keeps one would stall the queue within a sixth of a second.
    Ioctl(fd_, VIDIOC_QBUF, &buffer);
    return true;
  }

  uint32_t Width() const { return width_; }
  uint32_t Height() const { return height_; }
  const std::string& Format() const { return format_; }
  const VideoDevice& Device() const { return device_; }

 private:
  int fd_ = -1;
  bool streaming_ = false;
  VideoDevice device_;
  std::vector<Mapping> maps_;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  uint32_t imageBytes_ = 0;
  std::string format_;
};

}  // namespace

bool CaptureOneFrame(const std::string& nameContains, uint32_t timeoutMs,
                     CapturedFrame* out, std::string* error) {
  VideoDevice device;
  if (!PickDevice(nameContains, &device, error)) return false;

  CaptureSession session;
  if (!session.Open(device, error)) return false;

  if (!session.NextFrame(timeoutMs, &out->data)) {
    *error = "No frame arrived from " + device.path + " within " +
             std::to_string(timeoutMs) +
             "ms. Nothing is publishing into that device.";
    return false;
  }

  out->width = session.Width();
  out->height = session.Height();
  out->format = session.Format();
  out->deviceName = device.label;
  return true;
}

bool StreamFromCamera(const std::string& nameContains, uint32_t durationMs,
                      StreamStats* stats, std::string* error) {
  VideoDevice device;
  if (!PickDevice(nameContains, &device, error)) return false;

  CaptureSession session;
  if (!session.Open(device, error)) return false;

  const uint64_t start = NowMs();
  uint64_t previous = start;

  while (NowMs() - start < durationMs) {
    if (!session.NextFrame(1000, nullptr)) continue;

    const uint64_t now = NowMs();
    // Skip the first interval: it measures how long the producer took to get
    // going, not a gap in a running stream.
    if (stats->frames > 0) {
      stats->longestGapMs =
          std::max<uint32_t>(stats->longestGapMs, static_cast<uint32_t>(now - previous));
    }
    previous = now;
    stats->frames++;
  }

  stats->width = session.Width();
  stats->height = session.Height();
  stats->elapsedMs = static_cast<uint32_t>(NowMs() - start);

  if (stats->frames == 0) {
    *error = "No frames arrived from " + device.path + " in " +
             std::to_string(durationMs) + "ms.";
    return false;
  }
  return true;
}

}  // namespace domino
