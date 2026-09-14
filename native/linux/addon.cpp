// N-API surface for Domino's virtual camera on Linux.
//
// Deliberately mirrors the Windows addon's shape so the main process can treat
// the two as one feature: the same start/stop/writeFrame/isRunning calls, the
// same { ok, error? } results, the same listCameras. What differs is what sits
// behind them - v4l2loopback rather than a Media Foundation source hosted in
// the Frame Server - and the registration story, which lives in TypeScript
// here because loading a kernel module is a pkexec away rather than a COM
// registration.

#include <napi.h>

#include <string>
#include <vector>

#include "CaptureProbe.h"
#include "V4l2Output.h"

namespace {

domino::V4l2Output g_output;

/** Uniform { ok, error? } result, so the JS side never has to catch. */
Napi::Object Result(Napi::Env env, bool ok, const std::string& error = {}) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("ok", Napi::Boolean::New(env, ok));
  if (!ok) obj.Set("error", Napi::String::New(env, error));
  return obj;
}

uint32_t NumberAt(const Napi::CallbackInfo& info, size_t index, uint32_t fallback) {
  if (info.Length() > index && info[index].IsNumber()) {
    return info[index].As<Napi::Number>().Uint32Value();
  }
  return fallback;
}

std::string StringAt(const Napi::CallbackInfo& info, size_t index,
                     const std::string& fallback) {
  if (info.Length() > index && info[index].IsString()) {
    return info[index].As<Napi::String>().Utf8Value();
  }
  return fallback;
}

Napi::Object DeviceToObject(Napi::Env env, const domino::VideoDevice& device) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("path", Napi::String::New(env, device.path));
  obj.Set("label", Napi::String::New(env, device.label));
  obj.Set("driver", Napi::String::New(env, device.driver));
  obj.Set("output", Napi::Boolean::New(env, device.output));
  obj.Set("capture", Napi::Boolean::New(env, device.capture));
  return obj;
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const uint32_t width = NumberAt(info, 0, 1280);
  const uint32_t height = NumberAt(info, 1, 720);
  const uint32_t fps = NumberAt(info, 2, 30);
  const std::string name = StringAt(info, 3, "Domino");
  // Optional: pin a specific node rather than taking the best candidate. The
  // settings UI does not offer this, but a machine with several loopback
  // devices needs some way to say which one.
  const std::string devicePath = StringAt(info, 4, "");

  std::string error;
  if (!g_output.Start(devicePath, name, width, height, fps, &error)) {
    return Result(env, false, error);
  }
  return Result(env, true);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  g_output.Stop();
  return Result(info.Env(), true);
}

/**
 * Stop publishing.
 *
 * Kept for symmetry with the Windows addon, where it removes a device this
 * process may not have created. Nothing here can remove a loopback node -
 * those belong to the kernel module and go away when it is unloaded - so the
 * honest implementation is to let go of the one we hold.
 */
Napi::Value RemoveCamera(const Napi::CallbackInfo& info) {
  g_output.Stop();
  return Result(info.Env(), true);
}

Napi::Value IsRunning(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_output.IsRunning());
}

/**
 * Publish one NV12 frame.
 *
 * Synchronous on purpose. The write is a copy into the kernel's buffer for the
 * loopback device - about 1.4MB at 720p - which is far cheaper than marshalling
 * the buffer to a worker thread would be, and this is already running on the
 * main process's event loop thirty times a second.
 */
Napi::Value WriteFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    return Result(env, false, "A Buffer of NV12 pixel data is required");
  }
  auto buffer = info[0].As<Napi::Buffer<uint8_t>>();
  std::string error;
  return Result(env, g_output.WriteFrame(buffer.Data(), buffer.Length(), &error),
                error);
}

/**
 * Is there somewhere to publish?
 *
 * The Windows addon answers the same question about a machine-wide COM
 * registration. Here it is about a loopback device existing and being writable,
 * which is what the user actually has to arrange either way.
 */
Napi::Value IsRegistered(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  // A running camera holds the node we are publishing into, and with
  // exclusive_caps=1 that node no longer advertises output - so asking the
  // enumeration again would report the camera as unavailable the moment it
  // started working.
  const bool running = g_output.IsRunning();
  const std::vector<domino::VideoDevice> loopbacks =
      running ? std::vector<domino::VideoDevice>{} : domino::FindLoopbackDevices();

  Napi::Object obj = Napi::Object::New(env);
  obj.Set("registered",
          Napi::Boolean::New(env, running || !loopbacks.empty()));
  obj.Set("path", Napi::String::New(env, running ? g_output.DevicePath()
                                                 : loopbacks.empty()
                                                       ? ""
                                                       : loopbacks.front().path));
  return obj;
}

/** Whether the kernel module is loaded, and whether it is even installed. */
Napi::Value ModuleStatus(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("loaded", Napi::Boolean::New(env, domino::LoopbackModuleLoaded()));
  obj.Set("installed", Napi::Boolean::New(env, domino::LoopbackModuleInstalled()));
  return obj;
}

/** Every loopback node we could publish into. */
Napi::Value ListLoopbackDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::vector<domino::VideoDevice> devices = domino::FindLoopbackDevices();
  Napi::Array out = Napi::Array::New(env, devices.size());
  for (size_t i = 0; i < devices.size(); i++) {
    out.Set(static_cast<uint32_t>(i), DeviceToObject(env, devices[i]));
  }
  return out;
}

/** Every capture device an application can see, ours included. */
Napi::Value ListCameras(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::vector<std::string> names = domino::EnumerateCameras();
  Napi::Array out = Napi::Array::New(env, names.size());
  for (size_t i = 0; i < names.size(); i++) {
    out.Set(static_cast<uint32_t>(i), Napi::String::New(env, names[i]));
  }
  return out;
}

/** What the running camera settled on, for the status panel and for tests. */
Napi::Value DeviceInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("running", Napi::Boolean::New(env, g_output.IsRunning()));
  obj.Set("path", Napi::String::New(env, g_output.DevicePath()));
  obj.Set("label", Napi::String::New(env, g_output.DeviceLabel()));
  obj.Set("width", Napi::Number::New(env, g_output.Width()));
  obj.Set("height", Napi::Number::New(env, g_output.Height()));
  obj.Set("format",
          Napi::String::New(env, g_output.Layout() == domino::ChromaLayout::Nv12
                                     ? "NV12"
                                     : "I420"));
  return obj;
}

/**
 * Open our own camera as an application would and read one frame back.
 *
 * A frame returned here has gone out of the renderer, through this addon, into
 * the kernel and back out to a V4L2 capture client - the same journey it makes
 * for a conferencing app.
 */
Napi::Value CaptureFrameForTest(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string name = StringAt(info, 0, "Domino");
  const uint32_t timeoutMs = NumberAt(info, 1, 5000);

  domino::CapturedFrame frame;
  std::string error;
  Napi::Object obj = Napi::Object::New(env);
  if (!domino::CaptureOneFrame(name, timeoutMs, &frame, &error)) {
    obj.Set("ok", Napi::Boolean::New(env, false));
    obj.Set("error", Napi::String::New(env, error));
    return obj;
  }

  obj.Set("ok", Napi::Boolean::New(env, true));
  obj.Set("device", Napi::String::New(env, frame.deviceName));
  obj.Set("width", Napi::Number::New(env, frame.width));
  obj.Set("height", Napi::Number::New(env, frame.height));
  obj.Set("format", Napi::String::New(env, frame.format));
  obj.Set("data",
          Napi::Buffer<uint8_t>::Copy(env, frame.data.data(), frame.data.size()));
  return obj;
}

/** Hold the camera open for a while and report how the stream behaved. */
Napi::Value StreamForTest(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string name = StringAt(info, 0, "Domino");
  const uint32_t durationMs = NumberAt(info, 1, 10000);

  domino::StreamStats stats;
  std::string error;
  const bool ok = domino::StreamFromCamera(name, durationMs, &stats, &error);

  Napi::Object obj = Napi::Object::New(env);
  obj.Set("ok", Napi::Boolean::New(env, ok));
  if (!ok) obj.Set("error", Napi::String::New(env, error));
  obj.Set("frames", Napi::Number::New(env, stats.frames));
  obj.Set("width", Napi::Number::New(env, stats.width));
  obj.Set("height", Napi::Number::New(env, stats.height));
  obj.Set("longestGapMs", Napi::Number::New(env, stats.longestGapMs));
  obj.Set("elapsedMs", Napi::Number::New(env, stats.elapsedMs));
  return obj;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("removeCamera", Napi::Function::New(env, RemoveCamera));
  exports.Set("isRunning", Napi::Function::New(env, IsRunning));
  exports.Set("writeFrame", Napi::Function::New(env, WriteFrame));
  exports.Set("isRegistered", Napi::Function::New(env, IsRegistered));
  exports.Set("moduleStatus", Napi::Function::New(env, ModuleStatus));
  exports.Set("listLoopbackDevices", Napi::Function::New(env, ListLoopbackDevices));
  exports.Set("listCameras", Napi::Function::New(env, ListCameras));
  exports.Set("deviceInfo", Napi::Function::New(env, DeviceInfo));
  exports.Set("captureFrameForTest", Napi::Function::New(env, CaptureFrameForTest));
  exports.Set("streamForTest", Napi::Function::New(env, StreamForTest));
  return exports;
}

}  // namespace

NODE_API_MODULE(domino_vcam, Init)
