#pragma once

#include "HybridChordDSPSpec.hpp"
#include <vector>

namespace margelo::nitro::chorddsp {

class HybridChordDSP : public HybridChordDSPSpec {
public:
  HybridChordDSP() : HybridObject(TAG) {}

  std::vector<double> resampleTo22050(const std::vector<double>& samples, double sourceSampleRate) override;
  std::vector<double> computeMelSpectrogram(const std::vector<double>& samples, double sampleRate) override;
  std::vector<double> computeChromagram(const std::vector<double>& samples, double sampleRate) override;

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
};

} // namespace margelo::nitro::chorddsp
