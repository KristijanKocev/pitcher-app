#pragma once

#include "HybridChordDSPSpec.hpp"
#include <vector>

// aubio types (real definitions, not forward declarations, to avoid
// typedef conflicts with aubio's anonymous-struct fvec_t)
extern "C" {
#include "aubio/types.h"
#include "aubio/fvec.h"
#include "aubio/onset/onset.h"
}

namespace margelo::nitro::chorddsp {

class HybridChordDSP : public HybridChordDSPSpec {
public:
  HybridChordDSP() : HybridObject(TAG) {}
  ~HybridChordDSP();

  std::vector<double> resampleTo22050(const std::vector<double>& samples, double sourceSampleRate) override;
  std::vector<double> computeMelSpectrogram(const std::vector<double>& samples, double sampleRate) override;
  std::vector<double> computeChromagram(const std::vector<double>& samples, double sampleRate) override;
  std::vector<double> computeBassChromagram(const std::vector<double>& samples, double sampleRate) override;
  void initOnsetDetector(double sampleRate, double bufferSize, double hopSize) override;
  std::vector<double> detectOnset(const std::vector<double>& samples) override;
  void resetOnsetDetector() override;

private:
  static constexpr int kTargetSampleRate = 22050;
  static constexpr int kFFTSize = 2048;
  static constexpr int kHopSize = 512;
  static constexpr int kMelBins = 229;
  static constexpr float kMinFreq = 30.0f;
  static constexpr float kMaxFreq = 11025.0f;

  std::vector<std::vector<float>> melFilterbank_;
  bool filterBankInitialized_ = false;

  void initMelFilterbank();
  float hzToMel(float hz);
  float melToHz(float mel);

  // Internal chromagram with configurable frequency range
  std::vector<double> computeChromagramInternal(const std::vector<double>& samples, double sampleRate, float minFreq, float maxFreq);

  // aubio onset detector
  aubio_onset_t* onsetDetector_ = nullptr;
  fvec_t* onsetInput_ = nullptr;
  fvec_t* onsetOutput_ = nullptr;
  uint_t onsetHopSize_ = 0;
};

} // namespace margelo::nitro::chorddsp
