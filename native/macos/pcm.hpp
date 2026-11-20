// TuiTunes pure PCM utilities.
//
// Small, dependency-free primitives shared by the CoreAudio tap helper and
// its native unit tests: a bounded single-producer/single-consumer byte ring
// for the realtime→writer handoff, strict tap-format shape validation plus
// buffer-list copy planning (the pure half of the helper's restart guard),
// and float PCM normalization helpers. Nothing here touches CoreAudio, so
// tests cover it on any architecture.

#pragma once

#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace tuitunes {

// Bounded SPSC byte ring with monotonic head/tail counters and a power-of-two
// mask. The realtime producer must never block: try_push is all-or-nothing and
// returns false when free space is insufficient (analysis samples are dropped,
// never audible audio). Capacity is fixed at construction; no allocation after.
class SpscRingBuffer {
 public:
  explicit SpscRingBuffer(size_t capacity_bytes)
      : capacity_(RoundUpPow2(capacity_bytes)),
        mask_(capacity_ - 1),
        data_(new uint8_t[capacity_]()) {}

  ~SpscRingBuffer() { delete[] data_; }

  SpscRingBuffer(const SpscRingBuffer&) = delete;
  SpscRingBuffer& operator=(const SpscRingBuffer&) = delete;

  // Producer side (realtime thread only).
  bool try_push(const uint8_t* src, size_t length) {
    if (length == 0) return true;
    const size_t head = head_.load(std::memory_order_relaxed);
    const size_t tail = tail_.load(std::memory_order_acquire);
    const size_t used = head - tail;  // monotonic counters: no wrap handling
    if (length > capacity_ - used) return false;  // drop analysis bytes, never block
    size_t index = head & mask_;
    const size_t first = capacity_ - index < length ? capacity_ - index : length;
    std::memcpy(data_ + index, src, first);
    if (length > first) std::memcpy(data_, src + first, length - first);
    head_.store(head + length, std::memory_order_release);
    return true;
  }

  // Consumer side (writer thread only). Returns bytes copied to `dst`.
  size_t pop(uint8_t* dst, size_t max) {
    const size_t head = head_.load(std::memory_order_acquire);
    const size_t tail = tail_.load(std::memory_order_relaxed);
    const size_t used = head - tail;
    const size_t length = used < max ? used : max;
    if (length == 0) return 0;
    size_t index = tail & mask_;
    const size_t first = capacity_ - index < length ? capacity_ - index : length;
    std::memcpy(dst, data_ + index, first);
    if (length > first) std::memcpy(dst + first, data_, length - first);
    tail_.store(tail + length, std::memory_order_release);
    return length;
  }

  size_t used() const {
    return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire);
  }
  size_t capacity() const { return capacity_; }
  bool empty() const { return used() == 0; }

 private:
  static size_t RoundUpPow2(size_t value) {
    size_t size = 1;
    while (size < value && size < (size_t{1} << 40)) size <<= 1;
    return size;
  }

  const size_t capacity_;
  const size_t mask_;
  uint8_t* const data_;
  std::atomic<size_t> head_{0};  // producer index (monotonic)
  std::atomic<size_t> tail_{0};  // consumer index (monotonic)
};

// Negotiated tap stream shape, mirrored from AudioStreamBasicDescription so
// format validation and buffer-list planning stay pure and testable
// off-device.
struct PcmShape {
  double sampleRate = 0.0;
  uint32_t channelsPerFrame = 0;
  uint32_t bitsPerChannel = 0;
  uint32_t bytesPerFrame = 0;
  uint32_t framesPerPacket = 0;
  uint32_t bytesPerPacket = 0;
  bool isFloat = false;
  bool isSignedInteger = false;
  bool isBigEndian = false;
  bool isNonInterleaved = false;
  bool isPacked = false;
};

// The exact stream contract the helper can normalize to its promised stereo
// interleaved 32-bit little-endian float output: 32-bit float, host
// little-endian, stereo, packed interleaved or planar (one buffer per
// channel, stride = one sample), one frame per packet, consistent packet
// bytes. Everything else is rejected before any IOProc can run — the helper
// never guesses a stride.
inline bool IsSupportedTapShape(const PcmShape& shape) {
  if (!shape.isFloat || shape.isSignedInteger) return false;
  if (shape.isBigEndian) return false;  // the emitted header promises F32LE
  if (shape.channelsPerFrame != 2) return false;
  if (shape.bitsPerChannel != 32) return false;
  if (!std::isfinite(shape.sampleRate) || shape.sampleRate <= 0.0) return false;
  if (shape.framesPerPacket != 1) return false;
  const size_t frameStride = shape.isNonInterleaved
                                 ? sizeof(float)
                                 : static_cast<size_t>(shape.channelsPerFrame) * sizeof(float);
  if (shape.bytesPerFrame != frameStride) return false;
  if (shape.bytesPerPacket != frameStride * shape.framesPerPacket) return false;
  if (!shape.isNonInterleaved && !shape.isPacked) return false;
  return true;
}

// Bytes in one output frame (interleaved stereo float) of a validated shape.
inline size_t OutputFrameBytes(const PcmShape& shape) {
  return static_cast<size_t>(shape.channelsPerFrame) * sizeof(float);
}

// How many frames of the negotiated shape one IOProc buffer list can safely
// supply. `mismatch` means the delivered layout contradicts the negotiated
// format (wrong buffer count for the layout, or a degenerate stride): the
// caller must restart instead of copying with an untrusted stride.
// `frames == 0` without mismatch means there is nothing to copy this cycle
// (trailing partial frames are floored away, never read).
struct TapCopyPlan {
  bool mismatch = false;
  size_t frames = 0;
};

inline TapCopyPlan PlanTapCopy(const PcmShape& shape, uint32_t numberBuffers,
                               const size_t* bufferBytes) {
  TapCopyPlan plan;
  const size_t frameStride = shape.isNonInterleaved
                                 ? sizeof(float)
                                 : static_cast<size_t>(shape.channelsPerFrame) * sizeof(float);
  if (frameStride == 0) {
    plan.mismatch = true;
    return plan;
  }
  if (numberBuffers == 0) return plan;  // empty cycle: skip, not an error
  if (shape.isNonInterleaved) {
    if (numberBuffers < shape.channelsPerFrame) {
      plan.mismatch = true;  // fewer buffers than planar channels
      return plan;
    }
    size_t frames = 0;
    for (uint32_t channel = 0; channel < shape.channelsPerFrame; ++channel) {
      const size_t planeFrames = bufferBytes[channel] / frameStride;
      if (channel == 0 || planeFrames < frames) frames = planeFrames;
    }
    plan.frames = frames;
  } else {
    if (numberBuffers != 1) {
      plan.mismatch = true;  // interleaved arrives as exactly one buffer
      return plan;
    }
    plan.frames = bufferBytes[0] / frameStride;
  }
  return plan;
}

// Replace non-finite samples with silence so a malformed buffer can never
// poison the analysis stream with NaN/Inf.
inline float SanitizeSample(float value) { return std::isfinite(value) ? value : 0.0f; }

// Convert one int16 sample to normalized float [-1, 1).
inline float S16ToFloat(int16_t value) { return static_cast<float>(value) / 32768.0f; }

// Interleave planar float channels into interleaved stereo f32le frames,
// sanitizing each sample. `left`/`right` hold `frames` samples each.
inline size_t InterleavePlanarStereo(const float* left, const float* right, size_t frames,
                                      uint8_t* out_f32le) {
  float* out = reinterpret_cast<float*>(out_f32le);
  for (size_t i = 0; i < frames; ++i) {
    out[2 * i] = SanitizeSample(left[i]);
    out[2 * i + 1] = SanitizeSample(right[i]);
  }
  return frames * 2 * sizeof(float);
}

// Copy interleaved float frames, sanitizing every sample in place to the
// output. Returns the number of bytes written.
inline size_t CopyInterleavedSanitized(const float* in, size_t frames, size_t channels,
                                       uint8_t* out_f32le) {
  float* out = reinterpret_cast<float*>(out_f32le);
  const size_t count = frames * channels;
  for (size_t i = 0; i < count; ++i) out[i] = SanitizeSample(in[i]);
  return count * sizeof(float);
}

// Clamp a float sample into [-1, 1]; the tap stream is already float, this
// guards against out-of-range values from unexpected formats.
inline float ClampSample(float value) {
  if (!std::isfinite(value)) return 0.0f;
  if (value > 1.0f) return 1.0f;
  if (value < -1.0f) return -1.0f;
  return value;
}

}  // namespace tuitunes
