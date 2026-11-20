// TuiTunesSpectrum — macOS process-tap PCM helper (feature 15).
//
// Independently authored against Apple's public CoreAudio tap APIs (macOS
// 14.2+). Taps ONLY the pid passed on the command line via CATapDescription's
// initStereoMixdownOfProcesses: inclusion initializer (privateTap, unmuted),
// routes it through a private aggregate device, and copies IOProc buffers
// into a preallocated SPSC ring. A non-realtime writer thread emits, in order:
//
//   stdout: "TUITUNES_PCM 1 <sampleRate> 2 F32LE\n" followed by PCM bytes
//   stderr: "TUITUNES_STATUS <text>" / "TUITUNES_ERROR <text>" /
//           "TUITUNES_RESTART format-change|shape-mismatch" (bounded text)
//
// `--version` prints "TUITUNES_SPECTRUM_HELPER 1" and exits 0 without
// creating a tap or triggering the audio-capture permission prompt.
// Silence is never treated as proof of denial; OSStatus failures are
// reported generically. Startup failures throw instead of exit()ing so every
// live CoreAudio/CF resource is released by RAII in reverse creation order.
// SIGTERM/SIGINT/SIGHUP, format changes, buffer-shape mismatches, and parent
// disconnect (SIGPIPE ignored; stdout write errors) all unwind through the
// same teardown: bounded writer drain, then reverse-order destruction.

#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/CATapDescription.h>
#import <Foundation/Foundation.h>
#include <cctype>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <atomic>
#include <memory>
#include <string>
#include <vector>

#include "pcm.hpp"

namespace {

constexpr const char* kStatusPrefix = "TUITUNES_STATUS ";
constexpr const char* kErrorPrefix = "TUITUNES_ERROR ";
constexpr const char* kRestartPrefix = "TUITUNES_RESTART ";
constexpr uint32_t kExpectedChannels = 2;
// ~2.7 s of stereo f32 at 96 kHz: bounded, preallocated, generous.
constexpr size_t kRingBytes = 1 << 21;
// One realtime chunk of interleaved stereo f32 copied into the ring.
constexpr size_t kScratchBytes = 1 << 14;
// A planar buffer list carries one AudioBuffer per channel; bound the scan.
constexpr uint32_t kMaxCallbackBuffers = 16;
// Once a stop is requested the writer drains at most this long, so teardown
// can never hang on a full or closed stdout pipe.
constexpr int kWriterStallLimitMs = 2000;

std::atomic<bool> gDone{false};
std::atomic<bool> gRestart{false};
std::atomic<int> gRestartReason{0};
volatile sig_atomic_t gSignal = 0;

enum class RestartReason { kNone = 0, kFormatChange, kShapeMismatch };

void RequestRestart(RestartReason reason) {
  gRestartReason.store(static_cast<int>(reason), std::memory_order_release);
  gRestart.store(true, std::memory_order_release);
}

// Fatal helper failures unwind the stack so RAII releases every live
// CoreAudio/CF object in reverse creation order; exit() would skip them all.
struct HelperFatal {
  std::string message;
  int status;
};

[[noreturn]] void Fail(const std::string& message, int status) {
  throw HelperFatal{message, status};
}

void EmitStatus(const std::string& text) {
  fprintf(stderr, "%s%s\n", kStatusPrefix, text.c_str());
  fflush(stderr);
}

std::string FourCCToString(OSStatus status) {
  char code[5] = {0, 0, 0, 0, 0};
  const uint32_t value = static_cast<uint32_t>(status);
  code[0] = static_cast<char>((value >> 24) & 0xff);
  code[1] = static_cast<char>((value >> 16) & 0xff);
  code[2] = static_cast<char>((value >> 8) & 0xff);
  code[3] = static_cast<char>(value & 0xff);
  if (isprint(static_cast<unsigned char>(code[0])) &&
      isprint(static_cast<unsigned char>(code[1])) &&
      isprint(static_cast<unsigned char>(code[2])) &&
      isprint(static_cast<unsigned char>(code[3]))) {
    return std::string(code);
  }
  char numeric[16];
  snprintf(numeric, sizeof(numeric), "%d", static_cast<int>(status));
  return std::string(numeric);
}

std::string Hex32(uint32_t value) {
  char text[11];
  snprintf(text, sizeof(text), "0x%08x", value);
  return std::string(text);
}

void HandleSignal(int signalNumber) { gSignal = signalNumber; }

// Any input stream format change invalidates the negotiated stride: request
// a full restart so the parent re-handshakes with a fresh header.
OSStatus FormatListener(AudioObjectID /*inObjectID*/, UInt32 /*inNumberAddresses*/,
                        const AudioObjectPropertyAddress* /*inAddresses*/,
                        void* /*inClientData*/) {
  RequestRestart(RestartReason::kFormatChange);
  return noErr;
}

// RAII session: format listener, IOProc, aggregate, and tap are destroyed in
// reverse creation order. Destroy is idempotent, so the destructor can
// safely follow an explicit teardown call.
struct TapSession {
  AudioObjectID tap = kAudioObjectUnknown;
  AudioObjectID aggregate = kAudioObjectUnknown;
  AudioDeviceIOProcID ioProc = nullptr;
  bool ioRunning = false;
  bool formatListenerAdded = false;
  void* formatListenerClient = nullptr;
  AudioObjectPropertyAddress formatListenerAddress = {};

  ~TapSession() { Destroy(); }

  void Destroy() {
    if (formatListenerAdded && aggregate != kAudioObjectUnknown) {
      AudioObjectRemovePropertyListener(aggregate, &formatListenerAddress, FormatListener,
                                        formatListenerClient);
      formatListenerAdded = false;
    }
    if (ioRunning && aggregate != kAudioObjectUnknown) {
      AudioDeviceStop(aggregate, ioProc);
      ioRunning = false;
    }
    if (ioProc != nullptr && aggregate != kAudioObjectUnknown) {
      AudioDeviceDestroyIOProcID(aggregate, ioProc);
      ioProc = nullptr;
    }
    if (aggregate != kAudioObjectUnknown) {
      AudioHardwareDestroyAggregateDevice(aggregate);
      aggregate = kAudioObjectUnknown;
    }
    if (tap != kAudioObjectUnknown) {
      AudioHardwareDestroyProcessTap(tap);
      tap = kAudioObjectUnknown;
    }
  }
};

// Owns exactly one CoreFoundation reference for the remainder of the scope.
// The aggregate description dictionary is ARC-owned and passed with
// __bridge; only getter/creation results (tap UID, tap array) use this.
struct CFScope {
  CFTypeRef ref;
  explicit CFScope(CFTypeRef owned) : ref(owned) {}
  ~CFScope() {
    if (ref != nullptr) CFRelease(ref);
  }
  CFScope(const CFScope&) = delete;
  CFScope& operator=(const CFScope&) = delete;
};

struct AudioPipeline {
  TapSession session;
  // Frozen by strict validation before the IOProc can ever run; the
  realtime thread only reads it.
  tuitunes::PcmShape shape;
  tuitunes::SpscRingBuffer ring{kRingBytes};
  std::atomic<size_t> droppedBytes{0};
  std::atomic<bool> writerFailed{false};
};

tuitunes::PcmShape ShapeFromAsbd(const AudioStreamBasicDescription& format) {
  const AudioFormatFlags flags = format.mFormatFlags;
  tuitunes::PcmShape shape;
  shape.sampleRate = format.mSampleRate;
  shape.channelsPerFrame = format.mChannelsPerFrame;
  shape.bitsPerChannel = format.mBitsPerChannel;
  shape.bytesPerFrame = format.mBytesPerFrame;
  shape.framesPerPacket = format.mFramesPerPacket;
  shape.bytesPerPacket = format.mBytesPerPacket;
  shape.isFloat = (flags & kLinearPCMFormatFlagIsFloat) != 0;
  shape.isSignedInteger = (flags & kLinearPCMFormatFlagIsSignedInteger) != 0;
  shape.isBigEndian = (flags & kLinearPCMFormatFlagIsBigEndian) != 0;
  shape.isNonInterleaved = (flags & kLinearPCMFormatFlagIsNonInterleaved) != 0;
  shape.isPacked = (flags & kLinearPCMFormatFlagIsPacked) != 0;
  return shape;
}

void PushOrDrop(AudioPipeline* pipeline, const uint8_t* data, size_t bytes) {
  if (!pipeline->ring.try_push(data, bytes)) {
    pipeline->droppedBytes.fetch_add(bytes, std::memory_order_relaxed);
  }
}

// Realtime callback: guard restarts, validate the delivered buffer list
// against the negotiated shape, and copy fixed-bound chunks into the ring.
// No locks, no allocation, no logging — overflow drops analysis samples, and
// any layout contradiction requests a restart instead of copying.
OSStatus IOProc(AudioObjectID /*inDevice*/, const AudioTimeStamp* /*inNow*/,
                const AudioBufferList* inInputData, const AudioTimeStamp* /*inInputTime*/,
                AudioBufferList* /*outOutputData*/, const AudioTimeStamp* /*inOutputTime*/,
                void* inClientData) {
  auto* pipeline = static_cast<AudioPipeline*>(inClientData);
  // Restart guard: once any restart is requested the negotiated stride may
  // be stale; never decode another buffer list with it.
  if (gRestart.load(std::memory_order_acquire)) return noErr;
  if (inInputData == nullptr || inInputData->mNumberBuffers == 0) return noErr;
  const UInt32 buffers = inInputData->mNumberBuffers;
  if (buffers > kMaxCallbackBuffers) {
    RequestRestart(RestartReason::kShapeMismatch);
    return noErr;
  }
  size_t bufferBytes[kMaxCallbackBuffers];
  for (UInt32 index = 0; index < buffers; ++index) {
    const AudioBuffer& buffer = inInputData->mBuffers[index];
    bufferBytes[index] = buffer.mData == nullptr ? 0 : buffer.mDataByteSize;
  }
  const tuitunes::TapCopyPlan plan = tuitunes::PlanTapCopy(pipeline->shape, buffers, bufferBytes);
  if (plan.mismatch) {
    // The delivered layout contradicts the negotiated format: restart
    // rather than copy with a stride that may not match these buffers.
    RequestRestart(RestartReason::kShapeMismatch);
    return noErr;
  }
  if (plan.frames == 0) return noErr;

  uint8_t scratch[kScratchBytes];
  const size_t frameBytes = tuitunes::OutputFrameBytes(pipeline->shape);
  const size_t maxFrames = kScratchBytes / frameBytes;
  size_t offset = 0;
  if (pipeline->shape.isNonInterleaved) {
    const float* left = static_cast<const float*>(inInputData->mBuffers[0].mData);
    const float* right = static_cast<const float*>(inInputData->mBuffers[1].mData);
    if (left == nullptr || right == nullptr) return noErr;
    while (offset < plan.frames) {
      const size_t remaining = plan.frames - offset;
      const size_t chunk = remaining < maxFrames ? remaining : maxFrames;
      const size_t bytes =
          tuitunes::InterleavePlanarStereo(left + offset, right + offset, chunk, scratch);
      PushOrDrop(pipeline, scratch, bytes);
      offset += chunk;
    }
  } else {
    const float* samples = static_cast<const float*>(inInputData->mBuffers[0].mData);
    if (samples == nullptr) return noErr;
    const size_t channels = pipeline->shape.channelsPerFrame;
    while (offset < plan.frames) {
      const size_t remaining = plan.frames - offset;
      const size_t chunk = remaining < maxFrames ? remaining : maxFrames;
      const size_t bytes =
          tuitunes::CopyInterleavedSanitized(samples + offset * channels, chunk, channels, scratch);
      PushOrDrop(pipeline, scratch, bytes);
      offset += chunk;
    }
  }
  return noErr;
}

OSStatus FindProcessObject(uint32_t pid, AudioObjectID* outObject) {
  const AudioObjectPropertyAddress address = {kAudioHardwarePropertyProcessObjectList,
                                              kAudioObjectPropertyScopeGlobal,
                                              kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  OSStatus status =
      AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr, &size);
  if (status != noErr) return status;
  if (size == 0 || size % sizeof(AudioObjectID) != 0) return kAudioHardwareBadObjectError;
  // Mutable RAII storage: the property getter writes into this buffer, and
  // every return path (and any throw) releases it.
  std::vector<AudioObjectID> objects(size / sizeof(AudioObjectID));
  status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size,
                                      objects.data());
  if (status != noErr) return status;
  const size_t reported = size / sizeof(AudioObjectID);
  const UInt32 count = static_cast<UInt32>(reported < objects.size() ? reported : objects.size());
  AudioObjectID match = kAudioObjectUnknown;
  UInt32 matches = 0;
  for (UInt32 index = 0; index < count; ++index) {
    const AudioObjectID object = objects[index];
    const AudioObjectPropertyAddress pidAddress = {kAudioProcessPropertyPID,
                                                   kAudioObjectPropertyScopeGlobal,
                                                   kAudioObjectPropertyElementMain};
    UInt32 objectPid = 0;
    UInt32 pidSize = sizeof(objectPid);
    if (AudioObjectGetPropertyData(object, &pidAddress, 0, nullptr, &pidSize, &objectPid) != noErr) {
      continue;
    }
    if (objectPid != pid) continue;
    match = object;
    matches++;
  }
  if (matches != 1) {
    *outObject = kAudioObjectUnknown;
    return matches == 0 ? kAudioHardwareObjectDoesNotExistError : kAudioHardwareIllegalOperationError;
  }
  *outObject = match;
  return noErr;
}

void GiveUp(AudioPipeline* pipeline) {
  pipeline->writerFailed.store(true, std::memory_order_release);
}

// Raw nonblocking write: resumes partial writes; treats EPIPE/EBADF/ENXIO/
// zero-progress writes as parent disconnect; and once a stop was requested,
// gives up after the bounded drain budget so join() can never hang on a
// full or closed stdout pipe.
bool WriteAll(AudioPipeline* pipeline, const uint8_t* data, size_t length, bool stopping,
              int* stalledMs) {
  size_t offset = 0;
  while (offset < length) {
    const ssize_t written = write(STDOUT_FILENO, data + offset, length - offset);
    if (written > 0) {
      offset += static_cast<size_t>(written);
      *stalledMs = 0;
      continue;
    }
    if (written < 0 && errno == EINTR) continue;
    if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      struct pollfd waiter;
      waiter.fd = STDOUT_FILENO;
      waiter.events = POLLOUT;
      waiter.revents = 0;
      const int ready = poll(&waiter, 1, 20);
      if (ready < 0 && errno != EINTR) {
        GiveUp(pipeline);
        return false;
      }
      if (stopping) {
        *stalledMs += 20;
        if (*stalledMs >= kWriterStallLimitMs) {
          GiveUp(pipeline);
          return false;
        }
      }
      continue;
    }
    GiveUp(pipeline);  // write() of 0, EPIPE, EBADF, ENXIO, ...
    return false;
  }
  return true;
}

void* WriterThread(void* argument) {
  auto* pipeline = static_cast<AudioPipeline*>(argument);
  uint8_t chunk[1 << 15];
  int stalledMs = 0;
  while (true) {
    const bool stopping = gDone.load(std::memory_order_acquire) ||
                          gRestart.load(std::memory_order_acquire) || gSignal != 0;
    if (stopping && stalledMs >= kWriterStallLimitMs) break;
    const size_t bytes = pipeline->ring.pop(chunk, sizeof(chunk));
    if (bytes == 0) {
      if (stopping) break;
      struct timespec nap = {0, 4 * 1000 * 1000};  // 4 ms; analysis runs at ≤20 Hz
      nanosleep(&nap, nullptr);
      continue;
    }
    if (!WriteAll(pipeline, chunk, bytes, stopping, &stalledMs)) break;
  }
  return nullptr;
}

int RunTapSession(uint32_t pid, const char* clientLabel) {
  auto pipeline = std::make_unique<AudioPipeline>();

  AudioObjectID processObject = kAudioObjectUnknown;
  OSStatus status = FindProcessObject(pid, &processObject);
  if (status != noErr) {
    Fail("cannot resolve a single audio process object for pid " + std::to_string(pid) +
             " (OSStatus " + FourCCToString(status) + ")",
         2);
  }

  if (@available(macOS 14.2, *)) {
    CATapDescription* description =
        [[CATapDescription alloc] initStereoMixdownOfProcesses:@[ @(processObject) ]];
    if (description == nil) {
      Fail("CATapDescription allocation failed", 3);
    }
    description.name = @"TuiTunes Spectrum";
    description.privateTap = YES;               // visible only to this helper
    description.muteBehavior = CATapUnmuted;    // keep the process audible

    status = AudioHardwareCreateProcessTap(description, &pipeline->session.tap);
    if (status != noErr) {
      Fail(std::string("AudioHardwareCreateProcessTap failed (OSStatus ") + FourCCToString(status) +
               ")",
           4);
    }

    // kAudioTapPropertyUID returns a CFStringRef the caller owns; RAII it so
    // every exit below releases the one reference.
    const AudioObjectPropertyAddress uidAddress = {kAudioTapPropertyUID,
                                                   kAudioObjectPropertyScopeGlobal,
                                                   kAudioObjectPropertyElementMain};
    CFStringRef tapUid = nullptr;
    UInt32 uidSize = sizeof(tapUid);
    status = AudioObjectGetPropertyData(pipeline->session.tap, &uidAddress, 0, nullptr, &uidSize,
                                        &tapUid);
    if (status != noErr || tapUid == nullptr) {
      Fail(std::string("kAudioTapPropertyUID failed (OSStatus ") + FourCCToString(status) + ")", 5);
    }
    const CFScope uidScope(tapUid);

    // Aggregate composition per Apple's capture lifecycle sample: create
    // with name+UID, then attach the tap through
    // kAudioAggregateDevicePropertyTapList as an array of tap UID strings.
    NSString* aggregateUID =
        [NSString stringWithFormat:@"TuiTunesSpectrum-%@", [[NSUUID UUID] UUIDString]];
    NSDictionary* aggregateDescription = @{
      @kAudioAggregateDeviceNameKey : @"TuiTunes Spectrum Aggregate",
      @kAudioAggregateDeviceUIDKey : aggregateUID,
      @kAudioAggregateDeviceIsPrivateKey : @YES,
    };
    status = AudioHardwareCreateAggregateDevice(
        (__bridge CFDictionaryRef)aggregateDescription, &pipeline->session.aggregate);
    if (status != noErr) {
      Fail(std::string("AudioHardwareCreateAggregateDevice failed (OSStatus ") +
               FourCCToString(status) + ")",
           6);
    }

    const void* tapObjects[1] = {tapUid};
    CFArrayRef tapList = CFArrayCreate(kCFAllocatorDefault, tapObjects, 1, &kCFTypeArrayCallBacks);
    if (tapList == nullptr) {
      Fail("tap list allocation failed", 7);
    }
    const AudioObjectPropertyAddress tapListAddress = {kAudioAggregateDevicePropertyTapList,
                                                       kAudioObjectPropertyScopeGlobal,
                                                       kAudioObjectPropertyElementMain};
    UInt32 tapListSize = sizeof(tapList);
    status = AudioObjectSetPropertyData(pipeline->session.aggregate, &tapListAddress, 0, nullptr,
                                        tapListSize, &tapList);
    CFRelease(tapList);  // the HAL copies the array; drop our reference
    if (status != noErr) {
      Fail(std::string("kAudioAggregateDevicePropertyTapList failed (OSStatus ") +
               FourCCToString(status) + ")",
           8);
    }

    const AudioObjectPropertyAddress formatAddress = {kAudioDevicePropertyStreamFormat,
                                                      kAudioObjectPropertyScopeInput, 0};
    AudioStreamBasicDescription format = {};
    UInt32 formatSize = sizeof(format);
    status = AudioObjectGetPropertyData(pipeline->session.aggregate, &formatAddress, 0, nullptr,
                                        &formatSize, &format);
    if (status != noErr) {
      Fail(std::string("input stream format query failed (OSStatus ") + FourCCToString(status) +
               ")",
           9);
    }
    pipeline->shape = ShapeFromAsbd(format);
    if (!tuitunes::IsSupportedTapShape(pipeline->shape)) {
      // Exact contract: 32-bit float, native little-endian, stereo, packed
      // interleaved or one-buffer-per-channel planar. Nothing else can be
      // normalized to the promised stereo F32LE stream; never guess a stride.
      Fail("unsupported tap stream format (formatID " + std::to_string(format.mFormatID) +
               ", channels " + std::to_string(format.mChannelsPerFrame) + ", bits " +
               std::to_string(format.mBitsPerChannel) + ", bytesPerFrame " +
               std::to_string(format.mBytesPerFrame) + ", flags " + Hex32(format.mFormatFlags) +
               ")",
           10);
    }

    status = AudioDeviceCreateIOProcID(pipeline->session.aggregate, IOProc, pipeline.get(),
                                       &pipeline->session.ioProc);
    if (status != noErr) {
      Fail(std::string("AudioDeviceCreateIOProcID failed (OSStatus ") + FourCCToString(status) +
               ")",
           11);
    }

    // Register the format listener BEFORE starting IO so no format change
    // can slip between start and registration; failure to register is fatal.
    AudioObjectPropertyAddress listenerAddress = {kAudioDevicePropertyStreamFormat,
                                                  kAudioObjectPropertyScopeInput, 0};
    status = AudioObjectAddPropertyListener(pipeline->session.aggregate, &listenerAddress,
                                            FormatListener, pipeline.get());
    if (status != noErr) {
      Fail(std::string("stream format listener registration failed (OSStatus ") +
               FourCCToString(status) + ")",
           12);
    }
    pipeline->session.formatListenerAddress = listenerAddress;
    pipeline->session.formatListenerClient = pipeline.get();
    pipeline->session.formatListenerAdded = true;

    if (setvbuf(stdout, nullptr, _IONBF, 0) != 0) {
      Fail("cannot set unbuffered stdout", 13);
    }
    printf("TUITUNES_PCM 1 %u %u F32LE\n", static_cast<unsigned>(pipeline->shape.sampleRate + 0.5),
           static_cast<unsigned>(kExpectedChannels));
    if (fflush(stdout) != 0) {
      Fail("cannot write PCM header", 14);
    }
    EmitStatus(std::string("tapping pid ") + std::to_string(pid) +
               (clientLabel != nullptr ? std::string(" (") + clientLabel + ")" : ""));

    // stdout is written with raw nonblocking write() from here so a full or
    // closed pipe can never hang teardown (SIGPIPE is ignored in main). If
    // O_NONBLOCK cannot be set the poll()-based drain budget still bounds
    // the post-stop path; blocking writes then only risk a pipe that fills
    // exactly during teardown.
    const int stdoutFlags = fcntl(STDOUT_FILENO, F_GETFL, 0);
    if (stdoutFlags >= 0) {
      (void)fcntl(STDOUT_FILENO, F_SETFL, stdoutFlags | O_NONBLOCK);
    }

    pthread_t writer = 0;
    if (pthread_create(&writer, nullptr, WriterThread, pipeline.get()) != 0) {
      Fail("cannot start writer thread", 15);
    }
    status = AudioDeviceStart(pipeline->session.aggregate, pipeline->session.ioProc);
    if (status != noErr) {
      // Nothing may throw with the writer running: stop and join it first,
      // then fail so RAII unwinds the rest in reverse order.
      gDone.store(true, std::memory_order_release);
      pthread_join(writer, nullptr);
      Fail(std::string("AudioDeviceStart failed (OSStatus ") + FourCCToString(status) + ")", 16);
    }
    pipeline->session.ioRunning = true;

    // The OS may prompt for audio-capture consent on first start; that is
    // expected and can take a while. Silence afterwards proves nothing about
    // permission.
    while (!gRestart.load(std::memory_order_acquire) && gSignal == 0 &&
           !pipeline->writerFailed.load(std::memory_order_acquire)) {
      struct timespec nap = {0, 20 * 1000 * 1000};
      nanosleep(&nap, nullptr);
      const size_t dropped = pipeline->droppedBytes.load(std::memory_order_relaxed);
      if (dropped > 0) {
        EmitStatus("ring overflow: dropped " + std::to_string(dropped) + " analysis bytes");
        pipeline->droppedBytes.store(0, std::memory_order_relaxed);
      }
    }

    gDone.store(true, std::memory_order_release);
    pthread_join(writer, nullptr);
    const int reason = gRestartReason.load(std::memory_order_acquire);
    pipeline->session.Destroy();
    if (gRestart.load(std::memory_order_acquire)) {
      fprintf(stderr, "%s%s\n", kRestartPrefix,
              reason == static_cast<int>(RestartReason::kShapeMismatch) ? "shape-mismatch"
                                                                        : "format-change");
      fflush(stderr);
    }
    return 0;
  } else {
    Fail("macOS 14.2 or newer is required for CoreAudio process taps", 1);
  }
}

int RunTap(uint32_t pid, const char* clientLabel) {
  try {
    return RunTapSession(pid, clientLabel);
  } catch (const HelperFatal& fatal) {
    fprintf(stderr, "%s%s\n", kErrorPrefix, fatal.message.c_str());
    fflush(stderr);
    return fatal.status;
  }
}

}  // namespace

int main(int argc, char** argv) {
  if (argc > 1 && strcmp(argv[1], "--version") == 0) {
    // Protocol probe: must not create a tap or trigger the permission prompt.
    fputs("TUITUNES_SPECTRUM_HELPER 1\n", stdout);
    return 0;
  }
  if (argc < 2) {
    fputs("usage: tuitunes-spectrum-tap <pid> [client-name]\n", stderr);
    return 64;
  }
  const char* pidText = argv[1];
  char* end = nullptr;
  const long parsed = strtol(pidText, &end, 10);
  if (end == pidText || *end != '\0' || parsed <= 0 || parsed > 0x7fffffff) {
    fputs("invalid pid\n", stderr);
    return 64;
  }
  signal(SIGTERM, HandleSignal);
  signal(SIGINT, HandleSignal);
  signal(SIGHUP, HandleSignal);
  // Parent disconnect must surface as a write() error so RAII teardown can
  // run, not as a SIGPIPE kill mid-copy.
  signal(SIGPIPE, SIG_IGN);
  return RunTap(static_cast<uint32_t>(parsed), argc > 2 ? argv[2] : nullptr);
}
