#include "V4l2Output.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/videodev2.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <fstream>
#include <string>

namespace domino {
namespace {

/** v4l2loopback's VIDIOC_QUERYCAP driver string. */
constexpr char kLoopbackDriver[] = "v4l2 loopback";

std::string Errno(const char* what) {
  return std::string(what) + ": " + strerror(errno);
}

/**
 * ioctl, retried through signal interruption.
 *
 * Electron's main process takes signals for its own reasons - the GPU process
 * watchdog among them - and an ioctl that returns EINTR is not a failure. Left
 * unhandled this surfaced as a camera that occasionally refused to start for no
 * reason anyone could reproduce.
 */
int Ioctl(int fd, unsigned long request, void* arg) {
  int result;
  do {
    result = ::ioctl(fd, request, arg);
  } while (result == -1 && errno == EINTR);
  return result;
}

/** Trim trailing NULs and spaces out of a fixed-size kernel string field. */
std::string FromField(const unsigned char* field, size_t size) {
  std::string out(reinterpret_cast<const char*>(field),
                  strnlen(reinterpret_cast<const char*>(field), size));
  while (!out.empty() && std::isspace(static_cast<unsigned char>(out.back()))) {
    out.pop_back();
  }
  return out;
}

bool Describe(const std::string& path, VideoDevice* out) {
  // O_NONBLOCK so a node whose driver blocks on open cannot hang enumeration,
  // which runs on the main thread every time the status panel polls.
  const int fd = ::open(path.c_str(), O_RDWR | O_NONBLOCK);
  if (fd < 0) return false;

  v4l2_capability cap{};
  const bool ok = Ioctl(fd, VIDIOC_QUERYCAP, &cap) == 0;
  ::close(fd);
  if (!ok) return false;

  // device_caps describes this node; capabilities describes the whole physical
  // device, which for a multi-node driver answers a different question than the
  // one we are asking.
  const uint32_t caps = (cap.capabilities & V4L2_CAP_DEVICE_CAPS)
                            ? cap.device_caps
                            : cap.capabilities;

  out->path = path;
  out->label = FromField(cap.card, sizeof(cap.card));
  out->driver = FromField(cap.driver, sizeof(cap.driver));
  out->output = (caps & (V4L2_CAP_VIDEO_OUTPUT | V4L2_CAP_VIDEO_OUTPUT_MPLANE)) != 0;
  out->capture = (caps & (V4L2_CAP_VIDEO_CAPTURE | V4L2_CAP_VIDEO_CAPTURE_MPLANE)) != 0;
  return true;
}

/** Numeric suffix of "/dev/videoN", for ordering nodes the way a user reads them. */
long NodeNumber(const std::string& path) {
  size_t i = path.size();
  while (i > 0 && std::isdigit(static_cast<unsigned char>(path[i - 1]))) i--;
  if (i == path.size()) return 0;
  // strtol rather than stoi: this is only a sort key, and an absurd node number
  // should saturate rather than throw out of a comparator.
  return strtol(path.c_str() + i, nullptr, 10);
}

bool MentionsDomino(const std::string& label) {
  std::string lower = label;
  std::transform(lower.begin(), lower.end(), lower.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  return lower.find("domino") != std::string::npos;
}

/**
 * Set the output format, preferring NV12 and accepting I420.
 *
 * The kernel rewrites the struct with whatever it actually took, so the
 * returned fourcc - not the requested one - decides how frames are laid out on
 * the way to write().
 */
bool Negotiate(int fd, uint32_t width, uint32_t height, ChromaLayout* layout,
               std::string* error) {
  const uint32_t candidates[] = {V4L2_PIX_FMT_NV12, V4L2_PIX_FMT_YUV420};

  for (const uint32_t fourcc : candidates) {
    v4l2_format fmt{};
    fmt.type = V4L2_BUF_TYPE_VIDEO_OUTPUT;
    fmt.fmt.pix.width = width;
    fmt.fmt.pix.height = height;
    fmt.fmt.pix.pixelformat = fourcc;
    fmt.fmt.pix.field = V4L2_FIELD_NONE;
    fmt.fmt.pix.bytesperline = width;
    fmt.fmt.pix.sizeimage = width * height * 3 / 2;
    // Matches the limited-range BT.601 the packing shader emits. Getting this
    // wrong does not fail anything, it just makes every consumer render the
    // visualiser washed out.
    fmt.fmt.pix.colorspace = V4L2_COLORSPACE_SMPTE170M;

    if (Ioctl(fd, VIDIOC_S_FMT, &fmt) != 0) continue;

    // A driver is allowed to substitute rather than refuse, so believe the
    // struct it handed back rather than the one we sent.
    if (fmt.fmt.pix.width != width || fmt.fmt.pix.height != height) continue;

    if (fmt.fmt.pix.pixelformat == V4L2_PIX_FMT_NV12) {
      *layout = ChromaLayout::Nv12;
      return true;
    }
    if (fmt.fmt.pix.pixelformat == V4L2_PIX_FMT_YUV420) {
      *layout = ChromaLayout::I420;
      return true;
    }
  }

  *error =
      "The loopback device would not accept NV12 or I420 at this size. Try a "
      "different resolution, or reload v4l2loopback with a larger max_width "
      "and max_height.";
  return false;
}

/** Declare the frame rate, so consumers report the right number back to the user. */
void DeclareFrameRate(int fd, uint32_t fps) {
  if (fps == 0) return;
  v4l2_streamparm parm{};
  parm.type = V4L2_BUF_TYPE_VIDEO_OUTPUT;
  parm.parm.output.timeperframe.numerator = 1;
  parm.parm.output.timeperframe.denominator = fps;
  // Advisory only: v4l2loopback paces on our writes regardless, and a driver
  // that refuses this still streams correctly.
  Ioctl(fd, VIDIOC_S_PARM, &parm);
}

}  // namespace

std::vector<VideoDevice> EnumerateVideoDevices() {
  std::vector<VideoDevice> devices;

  DIR* dir = ::opendir("/dev");
  if (!dir) return devices;

  while (const dirent* entry = ::readdir(dir)) {
    const std::string name = entry->d_name;
    if (name.rfind("video", 0) != 0) continue;
    if (name.size() == 5) continue;
    if (!std::all_of(name.begin() + 5, name.end(),
                     [](unsigned char c) { return std::isdigit(c); })) {
      continue;
    }

    VideoDevice device;
    if (Describe("/dev/" + name, &device)) devices.push_back(std::move(device));
  }
  ::closedir(dir);

  std::sort(devices.begin(), devices.end(),
            [](const VideoDevice& a, const VideoDevice& b) {
              return NodeNumber(a.path) < NodeNumber(b.path);
            });
  return devices;
}

std::vector<VideoDevice> FindLoopbackDevices() {
  std::vector<VideoDevice> loopbacks;
  for (VideoDevice& device : EnumerateVideoDevices()) {
    if (device.driver != kLoopbackDriver) continue;
    /*
     * With exclusive_caps=1 an idle node advertises output only, and flips to
     * capture once a producer attaches - so a node that is capture-only is
     * already taken and must not be offered as somewhere to publish. With the
     * default exclusive_caps=0 every node advertises both and this test passes
     * for all of them, which is the case the header warns about.
     */
    if (!device.output) continue;
    loopbacks.push_back(std::move(device));
  }

  std::stable_sort(loopbacks.begin(), loopbacks.end(),
                   [](const VideoDevice& a, const VideoDevice& b) {
                     return MentionsDomino(a.label) && !MentionsDomino(b.label);
                   });
  return loopbacks;
}

std::vector<std::string> EnumerateCameras() {
  std::vector<std::string> names;
  for (const VideoDevice& device : EnumerateVideoDevices()) {
    if (!device.capture) continue;
    names.push_back(device.label);
  }
  return names;
}

V4l2Output::~V4l2Output() { Stop(); }

bool V4l2Output::Start(const std::string& devicePath, const std::string& label,
                       uint32_t width, uint32_t height, uint32_t fps,
                       std::string* error) {
  Stop();

  std::string target = devicePath;
  std::string targetLabel = label;

  if (target.empty()) {
    std::vector<VideoDevice> loopbacks = FindLoopbackDevices();
    if (loopbacks.empty()) {
      *error =
          LoopbackModuleLoaded()
              ? "v4l2loopback is loaded but every loopback device is already "
                "in use. Reload it with more devices, or close whatever is "
                "publishing into them."
              : "No v4l2loopback device was found. Load the kernel module "
                "first.";
      return false;
    }
    target = loopbacks.front().path;
    targetLabel = loopbacks.front().label;
  }

  const int fd = ::open(target.c_str(), O_RDWR);
  if (fd < 0) {
    *error = errno == EACCES
                 ? "No permission to write to " + target +
                       ". Add yourself to the 'video' group and log back in."
                 : Errno(("Could not open " + target).c_str());
    return false;
  }

  ChromaLayout layout = ChromaLayout::Nv12;
  if (!Negotiate(fd, width, height, &layout, error)) {
    ::close(fd);
    return false;
  }
  DeclareFrameRate(fd, fps);

  fd_ = fd;
  path_ = target;
  label_ = targetLabel;
  width_ = width;
  height_ = height;
  layout_ = layout;
  if (layout_ == ChromaLayout::I420) {
    scratch_.resize(static_cast<size_t>(width) * height * 3 / 2);
  } else {
    scratch_.clear();
    scratch_.shrink_to_fit();
  }
  return true;
}

void V4l2Output::Stop() {
  if (fd_ >= 0) {
    ::close(fd_);
    fd_ = -1;
  }
  path_.clear();
  label_.clear();
  width_ = 0;
  height_ = 0;
}

bool V4l2Output::WriteFrame(const uint8_t* data, size_t bytes,
                            std::string* error) {
  if (fd_ < 0) {
    *error = "The virtual camera is not running.";
    return false;
  }

  const size_t expected = static_cast<size_t>(width_) * height_ * 3 / 2;
  if (bytes != expected) {
    *error = "Frame is " + std::to_string(bytes) + " bytes, expected " +
             std::to_string(expected) + " for " + std::to_string(width_) + "x" +
             std::to_string(height_) + " NV12.";
    return false;
  }

  const uint8_t* payload = data;

  if (layout_ == ChromaLayout::I420) {
    /*
     * Split the interleaved UVUV plane into a U plane and a V plane. The luma
     * plane is identical in both layouts, so only the back third is touched -
     * about 460KB at 720p, which is well inside a frame's budget and confined
     * to the machines whose kernel would not take NV12.
     */
    const size_t lumaBytes = static_cast<size_t>(width_) * height_;
    const size_t chromaPairs = lumaBytes / 4;

    memcpy(scratch_.data(), data, lumaBytes);
    uint8_t* u = scratch_.data() + lumaBytes;
    uint8_t* v = u + chromaPairs;
    const uint8_t* uv = data + lumaBytes;
    for (size_t i = 0; i < chromaPairs; i++) {
      u[i] = uv[i * 2];
      v[i] = uv[i * 2 + 1];
    }
    payload = scratch_.data();
  }

  size_t written = 0;
  while (written < bytes) {
    const ssize_t n = ::write(fd_, payload + written, bytes - written);
    if (n > 0) {
      written += static_cast<size_t>(n);
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    /*
     * Anything else means the kernel dropped this frame - no consumer is
     * reading, or its buffers are full. That is ordinary at thirty frames a
     * second and must not be reported as an error, or the status panel would
     * fill with noise whenever nobody has the camera open.
     */
    return true;
  }
  return true;
}

bool LoopbackModuleLoaded() {
  struct stat info;
  return ::stat("/sys/module/v4l2loopback", &info) == 0;
}

bool LoopbackModuleInstalled() {
  if (LoopbackModuleLoaded()) return true;

  utsname uts{};
  if (::uname(&uts) != 0) return false;

  /*
   * modules.dep lists every module depmod knows about for the running kernel,
   * which covers the DKMS build v4l2loopback normally arrives as. Reading it
   * beats shelling out to modinfo: this is called from a status poll, and
   * spawning a process thirty times a minute to answer a yes/no question would
   * be absurd.
   */
  const std::string dep =
      std::string("/lib/modules/") + uts.release + "/modules.dep";
  std::ifstream file(dep);
  if (!file) return false;

  std::string line;
  while (std::getline(file, line)) {
    if (line.find("/v4l2loopback.ko") != std::string::npos) return true;
  }
  return false;
}

}  // namespace domino
