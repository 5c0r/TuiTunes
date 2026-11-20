// Native unit tests for TuiTunesSpectrum pure PCM/ring utilities.
//
// Compiled and run by scripts/test-spectrum-native.ts on a Mac (plain and
// address/undefined-behavior sanitizer builds). These prove buffer
// mechanics, scratch-boundary safety, strict tap-shape validation, and
// buffer-list copy planning (the pure half of the helper's restart guard) —
// never capture permission or consent.

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "pcm.hpp"

namespace {

int gFailures = 0;

void Check(bool condition, const std::string& what) {
  if (!condition) {
    ++gFailures;
    fprintf(stderr, "FAIL: %s\n", what.c_str());
  }
}

void CheckEq(size_t actual, size_t expected, const std::string& what) {
  if (actual != expected) {
    ++gFailures;
    fprintf(stderr, "FAIL: %s (expected %zu, got %zu)\n", what.c_str(), expected, actual);
  }
}

void TestRingRoundTrip() {
  tuitunes::SpscRingBuffer ring(1024);
  Check(ring.empty(), "new ring is empty");
  CheckEq(ring.capacity(), 1024, "capacity rounds to power of two");

  const uint8_t input[] = {1, 2, 3, 4, 5, 6, 7, 8};
  Check(ring.try_push(input, sizeof(input)), "push fits");
  CheckEq(ring.used(), sizeof(input), "used reflects push");

  uint8_t output[8] = {};
  CheckEq(ring.pop(output, sizeof(output)), sizeof(input), "pop returns length");
  Check(std::memcmp(input, output, sizeof(input)) == 0, "pop preserves bytes");
  Check(ring.empty(), "ring drains to empty");
}

void TestRingWrapAround() {
  tuitunes::SpscRingBuffer ring(16);
  uint8_t output[16];
  for (int round = 0; round < 64; ++round) {
    uint8_t input[7];
    for (size_t i = 0; i < sizeof(input); ++i) input[i] = static_cast<uint8_t>(round * 7 + i);
    Check(ring.try_push(input, sizeof(input)), "wrapped push fits");
    CheckEq(ring.pop(output, sizeof(input)), sizeof(input), "wrapped pop length");
    for (size_t i = 0; i < sizeof(input); ++i) {
      Check(output[i] == static_cast<uint8_t>(round * 7 + i), "wrapped pop preserves bytes");
    }
  }
}

void TestRingOverflowDropsWithoutBlocking() {
  tuitunes::SpscRingBuffer ring(16);
  uint8_t input[24];
  for (size_t i = 0; i < sizeof(input); ++i) input[i] = static_cast<uint8_t>(i);
  Check(ring.try_push(input, 16), "exact-capacity push fits");
  Check(!ring.try_push(input, 1), "overflow push is rejected");
  CheckEq(ring.used(), 16, "overflow push left the ring untouched");
}

void TestRingPartialPop() {
  tuitunes::SpscRingBuffer ring(8);
  const uint8_t input[] = {9, 8, 7, 6, 5, 4};
  Check(ring.try_push(input, sizeof(input)), "push fits");
  uint8_t output[3] = {};
  CheckEq(ring.pop(output, 3), 3, "partial pop length");
  Check(output[0] == 9 && output[1] == 8 && output[2] == 7, "partial pop bytes");
  CheckEq(ring.used(), 3, "used after partial pop");
}

void TestSanitizeAndConvert() {
  Check(tuitunes::SanitizeSample(std::nanf("")) == 0.0f, "NaN becomes silence");
  Check(tuitunes::SanitizeSample(INFINITY) == 0.0f, "+Inf becomes silence");
  Check(tuitunes::SanitizeSample(-0.25f) == -0.25f, "finite samples pass through");
  Check(tuitunes::S16ToFloat(0) == 0.0f, "zero int16 converts to zero");
  Check(tuitunes::S16ToFloat(32767) > 0.999f && tuitunes::S16ToFloat(32767) <= 1.0f, "max int16 ~1.0");
  Check(tuitunes::S16ToFloat(-32768) == -1.0f, "min int16 is exactly -1.0");
  Check(tuitunes::ClampSample(2.0f) == 1.0f, "clamp above range");
  Check(tuitunes::ClampSample(-2.0f) == -1.0f, "clamp below range");
  Check(tuitunes::ClampSample(std::nanf("")) == 0.0f, "clamp NaN to silence");
}

void TestInterleavePlanarStereo() {
  const float left[3] = {0.5f, -0.5f, std::nanf("")};
  const float right[3] = {-0.25f, 0.25f, 0.75f};
  uint8_t bytes[3 * 2 * sizeof(float)] = {};
  const size_t written = tuitunes::InterleavePlanarStereo(left, right, 3, bytes);
  CheckEq(written, sizeof(bytes), "interleave writes frames*2 floats");
  const auto* frames = reinterpret_cast<const float*>(bytes);
  Check(frames[0] == 0.5f && frames[1] == -0.25f, "first frame interleaved");
  Check(frames[2] == -0.5f && frames[3] == 0.25f, "second frame interleaved");
  Check(frames[4] == 0.0f && frames[5] == 0.75f, "NaN channel sanitized in interleave");
}

void TestCopyInterleavedSanitized() {
  const float input[4] = {0.1f, std::nanf(""), -INFINITY, 0.9f};
  uint8_t bytes[sizeof(input)] = {};
  const size_t written = tuitunes::CopyInterleavedSanitized(input, 2, 2, bytes);
  CheckEq(written, sizeof(input), "copy writes all samples");
  const auto* out = reinterpret_cast<const float*>(bytes);
  Check(out[0] == 0.1f, "finite sample copied");
  Check(out[1] == 0.0f && out[2] == 0.0f, "nonfinite samples sanitized");
  Check(out[3] == 0.9f, "last sample copied");
}

tuitunes::PcmShape ValidInterleavedShape() {
  tuitunes::PcmShape shape;
  shape.sampleRate = 48000.0;
  shape.channelsPerFrame = 2;
  shape.bitsPerChannel = 32;
  shape.bytesPerFrame = 8;
  shape.framesPerPacket = 1;
  shape.bytesPerPacket = 8;
  shape.isFloat = true;
  shape.isPacked = true;
  return shape;
}

tuitunes::PcmShape ValidPlanarShape() {
  tuitunes::PcmShape shape;
  shape.sampleRate = 96000.0;
  shape.channelsPerFrame = 2;
  shape.bitsPerChannel = 32;
  shape.bytesPerFrame = 4;  // planar stride is one channel's sample
  shape.framesPerPacket = 1;
  shape.bytesPerPacket = 4;
  shape.isFloat = true;
  shape.isNonInterleaved = true;
  return shape;
}

void TestIsSupportedTapShape() {
  Check(tuitunes::IsSupportedTapShape(ValidInterleavedShape()), "stereo interleaved f32 accepted");
  Check(tuitunes::IsSupportedTapShape(ValidPlanarShape()), "stereo planar f32 accepted");

  tuitunes::PcmShape mono = ValidInterleavedShape();
  mono.channelsPerFrame = 1;
  mono.bytesPerFrame = 4;
  mono.bytesPerPacket = 4;
  Check(!tuitunes::IsSupportedTapShape(mono), "mono rejected before any copy");

  tuitunes::PcmShape surround = ValidInterleavedShape();
  surround.channelsPerFrame = 6;
  surround.bytesPerFrame = 24;
  surround.bytesPerPacket = 24;
  Check(!tuitunes::IsSupportedTapShape(surround), "5.1 rejected before any copy");

  tuitunes::PcmShape s16 = ValidInterleavedShape();
  s16.bitsPerChannel = 16;
  s16.bytesPerFrame = 4;
  s16.bytesPerPacket = 4;
  s16.isFloat = false;
  s16.isSignedInteger = true;
  Check(!tuitunes::IsSupportedTapShape(s16), "int16 rejected before any copy");

  tuitunes::PcmShape integerFloat = ValidInterleavedShape();
  integerFloat.isSignedInteger = true;
  Check(!tuitunes::IsSupportedTapShape(integerFloat), "float+signed-integer flags rejected");

  tuitunes::PcmShape bigEndian = ValidInterleavedShape();
  bigEndian.isBigEndian = true;
  Check(!tuitunes::IsSupportedTapShape(bigEndian), "big-endian rejected (output is F32LE)");

  tuitunes::PcmShape unpacked = ValidInterleavedShape();
  unpacked.isPacked = false;
  Check(!tuitunes::IsSupportedTapShape(unpacked), "non-packed interleaved rejected");

  tuitunes::PcmShape wrongStride = ValidInterleavedShape();
  wrongStride.bytesPerFrame = 12;  // claims padding between frames
  wrongStride.bytesPerPacket = 12;
  Check(!tuitunes::IsSupportedTapShape(wrongStride), "wrong interleaved stride rejected");

  tuitunes::PcmShape planarStride = ValidPlanarShape();
  planarStride.bytesPerFrame = 8;  // planar must be one channel's stride
  planarStride.bytesPerPacket = 8;
  Check(!tuitunes::IsSupportedTapShape(planarStride), "planar stride mismatch rejected");

  tuitunes::PcmShape packetFrames = ValidInterleavedShape();
  packetFrames.framesPerPacket = 2;
  packetFrames.bytesPerPacket = 16;
  Check(!tuitunes::IsSupportedTapShape(packetFrames), "multi-frame packets rejected");

  tuitunes::PcmShape packetBytes = ValidInterleavedShape();
  packetBytes.bytesPerPacket = 12;
  Check(!tuitunes::IsSupportedTapShape(packetBytes), "packet bytes inconsistent rejected");

  tuitunes::PcmShape zeroRate = ValidInterleavedShape();
  zeroRate.sampleRate = 0.0;
  Check(!tuitunes::IsSupportedTapShape(zeroRate), "zero sample rate rejected");

  tuitunes::PcmShape nanRate = ValidInterleavedShape();
  nanRate.sampleRate = std::nanf("");
  Check(!tuitunes::IsSupportedTapShape(nanRate), "NaN sample rate rejected");
}

void TestPlanTapCopyInterleaved() {
  const tuitunes::PcmShape shape = ValidInterleavedShape();
  const size_t whole[1] = {8 * 100};
  tuitunes::TapCopyPlan plan = tuitunes::PlanTapCopy(shape, 1, whole);
  Check(!plan.mismatch, "interleaved single buffer matches");
  CheckEq(plan.frames, 100, "interleaved whole frames planned");

  const size_t trailing[1] = {8 * 100 + 3};  // malformed trailing bytes
  plan = tuitunes::PlanTapCopy(shape, 1, trailing);
  Check(!plan.mismatch, "trailing partial frame is not a mismatch");
  CheckEq(plan.frames, 100, "trailing partial frame floored away");

  const size_t tiny[1] = {7};  // less than one frame
  plan = tuitunes::PlanTapCopy(shape, 1, tiny);
  Check(!plan.mismatch, "sub-frame buffer is not a mismatch");
  CheckEq(plan.frames, 0, "sub-frame buffer skipped");

  const size_t two[2] = {8, 8};
  plan = tuitunes::PlanTapCopy(shape, 2, two);
  Check(plan.mismatch, "interleaved with two buffers is a mismatch");
  CheckEq(plan.frames, 0u, "mismatch plans no frames");

  plan = tuitunes::PlanTapCopy(shape, 0, nullptr);
  Check(!plan.mismatch, "empty buffer list is not a mismatch");
  CheckEq(plan.frames, 0u, "empty buffer list skipped");

  tuitunes::PcmShape broken = shape;
  broken.channelsPerFrame = 0;  // never negotiable; planner must not divide by zero
  const size_t one[1] = {8};
  plan = tuitunes::PlanTapCopy(broken, 1, one);
  Check(plan.mismatch, "zero-channel interleaved shape is a mismatch");
}

void TestPlanTapCopyPlanar() {
  const tuitunes::PcmShape shape = ValidPlanarShape();
  const size_t planes[2] = {4 * 100, 4 * 100};
  tuitunes::TapCopyPlan plan = tuitunes::PlanTapCopy(shape, 2, planes);
  Check(!plan.mismatch, "planar two buffers match");
  CheckEq(plan.frames, 100, "planar whole frames planned");

  const size_t ragged[2] = {4 * 100, 4 * 99 + 2};  // shorter, ragged plane
  plan = tuitunes::PlanTapCopy(shape, 2, ragged);
  Check(!plan.mismatch, "ragged plane is not a mismatch");
  CheckEq(plan.frames, 99, "planar copy bounded by shortest plane");

  const size_t single[1] = {4 * 100};
  plan = tuitunes::PlanTapCopy(shape, 1, single);
  Check(plan.mismatch, "planar with one buffer is a mismatch");
  CheckEq(plan.frames, 0u, "planar mismatch plans no frames");

  const size_t empty[2] = {4 * 100, 0};
  plan = tuitunes::PlanTapCopy(shape, 2, empty);
  Check(!plan.mismatch, "empty plane is not a mismatch");
  CheckEq(plan.frames, 0u, "empty plane yields no frames");

  const size_t extra[3] = {4 * 10, 4 * 10, 4 * 10};
  plan = tuitunes::PlanTapCopy(shape, 3, extra);
  Check(!plan.mismatch, "extra planar buffers are not a mismatch");
  CheckEq(plan.frames, 10, "first two planes planned safely");
}

void TestCopyChunkBoundaries() {
  // The IOProc scratch is 16 KiB; a stereo f32 chunk fills it exactly at
  // 2048 frames. Writing the exact boundary (and one frame under it) must
  // stay in bounds — the sanitizer build turns any overflow into a failure.
  const size_t kScratch = 1 << 14;
  const size_t maxFrames = kScratch / (2 * sizeof(float));
  CheckEq(maxFrames, 2048, "stereo f32 chunk capacity");

  std::vector<float> interleaved(maxFrames * 2, 0.25f);
  std::vector<uint8_t> scratch(kScratch);
  CheckEq(tuitunes::CopyInterleavedSanitized(interleaved.data(), maxFrames, 2, scratch.data()),
          kScratch, "full-boundary interleaved copy");
  const auto* out = reinterpret_cast<const float*>(scratch.data());
  Check(out[0] == 0.25f && out[maxFrames * 2 - 1] == 0.25f, "boundary copy values");

  CheckEq(tuitunes::CopyInterleavedSanitized(interleaved.data(), maxFrames - 1, 2, scratch.data()),
          kScratch - 8, "one-frame-under boundary copy");

  std::vector<float> left(maxFrames, -0.5f);
  std::vector<float> right(maxFrames, 0.5f);
  CheckEq(tuitunes::InterleavePlanarStereo(left.data(), right.data(), maxFrames, scratch.data()),
          kScratch, "full-boundary planar interleave");
  Check(out[0] == -0.5f && out[1] == 0.5f, "boundary interleave values");
}

void TestRingCapacityRoundingAndOversize() {
  tuitunes::SpscRingBuffer ring(5);
  CheckEq(ring.capacity(), 8, "capacity rounds up to power of two");
  uint8_t input[8];
  for (size_t i = 0; i < sizeof(input); ++i) input[i] = static_cast<uint8_t>(i);
  Check(ring.try_push(input, sizeof(input)), "rounded capacity accepts exact fill");
  Check(!ring.try_push(input, 1), "full ring rejects");
  uint8_t output[8] = {};
  CheckEq(ring.pop(output, sizeof(output)), 8, "drain rounded ring");
  Check(std::memcmp(input, output, sizeof(input)) == 0, "rounded ring preserves bytes");

  tuitunes::SpscRingBuffer small(16);
  uint8_t tooBig[17];
  Check(!small.try_push(tooBig, sizeof(tooBig)), "oversize push rejected");
  Check(small.empty(), "oversize push left ring untouched");
}

}  // namespace

int main() {
  TestRingRoundTrip();
  TestRingWrapAround();
  TestRingOverflowDropsWithoutBlocking();
  TestRingPartialPop();
  TestRingCapacityRoundingAndOversize();
  TestSanitizeAndConvert();
  TestInterleavePlanarStereo();
  TestCopyInterleavedSanitized();
  TestIsSupportedTapShape();
  TestPlanTapCopyInterleaved();
  TestPlanTapCopyPlanar();
  TestCopyChunkBoundaries();
  if (gFailures > 0) {
    fprintf(stderr, "%d native PCM test(s) failed\n", gFailures);
    return 1;
  }
  puts("ALL TESTS PASSED");
  return 0;
}
