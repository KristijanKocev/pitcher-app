#include "HybridChordDSP.hpp"
#include <cmath>
#include <algorithm>

#ifdef __APPLE__
#include <Accelerate/Accelerate.h>
#endif

namespace margelo::nitro::chorddsp {

float HybridChordDSP::hzToMel(float hz) {
  return 2595.0f * std::log10(1.0f + hz / 700.0f);
}

float HybridChordDSP::melToHz(float mel) {
  return 700.0f * (std::pow(10.0f, mel / 2595.0f) - 1.0f);
}

void HybridChordDSP::initMelFilterbank() {
  if (filterBankInitialized_) return;

  int fftBins = kFFTSize / 2 + 1;
  float melMin = hzToMel(kMinFreq);
  float melMax = hzToMel(kMaxFreq);

  std::vector<float> melPoints(kMelBins + 2);
  for (int i = 0; i < kMelBins + 2; i++) {
    melPoints[i] = melMin + (melMax - melMin) * i / (kMelBins + 1);
  }

  std::vector<float> binFreqs(kMelBins + 2);
  for (int i = 0; i < kMelBins + 2; i++) {
    float hz = melToHz(melPoints[i]);
    binFreqs[i] = hz * kFFTSize / static_cast<float>(kTargetSampleRate);
  }

  melFilterbank_.resize(kMelBins, std::vector<float>(fftBins, 0.0f));

  for (int m = 0; m < kMelBins; m++) {
    float left = binFreqs[m];
    float center = binFreqs[m + 1];
    float right = binFreqs[m + 2];

    for (int k = 0; k < fftBins; k++) {
      float fk = static_cast<float>(k);
      if (fk >= left && fk <= center && center > left) {
        melFilterbank_[m][k] = (fk - left) / (center - left);
      } else if (fk > center && fk <= right && right > center) {
        melFilterbank_[m][k] = (right - fk) / (right - center);
      }
    }
  }

  filterBankInitialized_ = true;
}

std::vector<double> HybridChordDSP::resampleTo22050(const std::vector<double>& samples, double sourceSampleRate) {
  if (static_cast<int>(sourceSampleRate) == kTargetSampleRate) {
    return samples;
  }

  double ratio = static_cast<double>(kTargetSampleRate) / sourceSampleRate;
  int outputLen = static_cast<int>(std::ceil(samples.size() * ratio));
  std::vector<double> output(outputLen);

  for (int i = 0; i < outputLen; i++) {
    double srcIdx = i / ratio;
    int idx0 = static_cast<int>(srcIdx);
    double frac = srcIdx - idx0;

    if (idx0 + 1 < static_cast<int>(samples.size())) {
      output[i] = samples[idx0] * (1.0 - frac) + samples[idx0 + 1] * frac;
    } else if (idx0 < static_cast<int>(samples.size())) {
      output[i] = samples[idx0];
    }
  }

  return output;
}

std::vector<double> HybridChordDSP::computeMelSpectrogram(const std::vector<double>& samples, double sampleRate) {
  initMelFilterbank();

  std::vector<double> audio;
  if (static_cast<int>(sampleRate) != kTargetSampleRate) {
    audio = resampleTo22050(samples, sampleRate);
  } else {
    audio = samples;
  }

  int numSamples = static_cast<int>(audio.size());
  int numFrames = std::max(0, (numSamples - kFFTSize) / kHopSize + 1);
  if (numFrames == 0) return {};

  int fftBins = kFFTSize / 2 + 1;
  std::vector<double> result(numFrames * kMelBins, 0.0);

  std::vector<float> window(kFFTSize);
  for (int i = 0; i < kFFTSize; i++) {
    window[i] = 0.5f * (1.0f - std::cos(2.0f * M_PI * i / (kFFTSize - 1)));
  }

#ifdef __APPLE__
  vDSP_Length log2n = static_cast<vDSP_Length>(std::log2(kFFTSize));
  FFTSetup fftSetup = vDSP_create_fftsetup(log2n, FFT_RADIX2);

  std::vector<float> realPart(kFFTSize);
  std::vector<float> imagPart(kFFTSize);
  DSPSplitComplex splitComplex = {realPart.data(), imagPart.data()};
  std::vector<float> magnitudes(fftBins);
  std::vector<float> windowed(kFFTSize);

  for (int frame = 0; frame < numFrames; frame++) {
    int offset = frame * kHopSize;

    for (int i = 0; i < kFFTSize; i++) {
      windowed[i] = static_cast<float>(audio[offset + i]) * window[i];
    }

    vDSP_ctoz(reinterpret_cast<DSPComplex*>(windowed.data()), 2, &splitComplex, 1, kFFTSize / 2);
    vDSP_fft_zrip(fftSetup, &splitComplex, 1, log2n, FFT_FORWARD);

    float scale = 1.0f / (2.0f * kFFTSize);
    vDSP_zvmags(&splitComplex, 1, magnitudes.data(), 1, fftBins);
    vDSP_vsmul(magnitudes.data(), 1, &scale, magnitudes.data(), 1, fftBins);

    for (int m = 0; m < kMelBins; m++) {
      float sum = 0.0f;
      vDSP_dotpr(magnitudes.data(), 1, melFilterbank_[m].data(), 1, &sum, fftBins);
      result[frame * kMelBins + m] = static_cast<double>(std::log(std::max(sum, 1e-10f)));
    }
  }

  vDSP_destroy_fftsetup(fftSetup);
#else
  for (int frame = 0; frame < numFrames; frame++) {
    int offset = frame * kHopSize;
    std::vector<float> magnitudes(fftBins, 0.0f);

    for (int k = 0; k < fftBins; k++) {
      float re = 0.0f, im = 0.0f;
      for (int n = 0; n < kFFTSize; n++) {
        float sample = static_cast<float>(audio[offset + n]) * window[n];
        float angle = 2.0f * M_PI * k * n / kFFTSize;
        re += sample * std::cos(angle);
        im -= sample * std::sin(angle);
      }
      magnitudes[k] = (re * re + im * im) / kFFTSize;
    }

    for (int m = 0; m < kMelBins; m++) {
      float sum = 0.0f;
      for (int k = 0; k < fftBins; k++) {
        sum += magnitudes[k] * melFilterbank_[m][k];
      }
      result[frame * kMelBins + m] = static_cast<double>(std::log(std::max(sum, 1e-10f)));
    }
  }
#endif

  return result;
}

std::vector<double> HybridChordDSP::computeChromagram(const std::vector<double>& samples, double sampleRate) {
  int numSamples = static_cast<int>(samples.size());
  if (numSamples < kFFTSize) return std::vector<double>(12, 0.0);

  int numFrames = (numSamples - kFFTSize) / kHopSize + 1;
  std::vector<double> chroma(12, 0.0);

  std::vector<float> window(kFFTSize);
  for (int i = 0; i < kFFTSize; i++) {
    window[i] = 0.5f * (1.0f - std::cos(2.0f * M_PI * i / (kFFTSize - 1)));
  }

  int fftBins = kFFTSize / 2 + 1;
  int sr = static_cast<int>(sampleRate);

#ifdef __APPLE__
  vDSP_Length log2n = static_cast<vDSP_Length>(std::log2(kFFTSize));
  FFTSetup fftSetup = vDSP_create_fftsetup(log2n, FFT_RADIX2);

  std::vector<float> realPart(kFFTSize);
  std::vector<float> imagPart(kFFTSize);
  DSPSplitComplex splitComplex = {realPart.data(), imagPart.data()};
  std::vector<float> magnitudes(fftBins);
  std::vector<float> windowed(kFFTSize);

  for (int frame = 0; frame < numFrames; frame++) {
    int offset = frame * kHopSize;

    for (int i = 0; i < kFFTSize; i++) {
      windowed[i] = static_cast<float>(samples[offset + i]) * window[i];
    }

    vDSP_ctoz(reinterpret_cast<DSPComplex*>(windowed.data()), 2, &splitComplex, 1, kFFTSize / 2);
    vDSP_fft_zrip(fftSetup, &splitComplex, 1, log2n, FFT_FORWARD);

    float scale = 1.0f / (2.0f * kFFTSize);
    vDSP_zvmags(&splitComplex, 1, magnitudes.data(), 1, fftBins);
    vDSP_vsmul(magnitudes.data(), 1, &scale, magnitudes.data(), 1, fftBins);

    for (int k = 1; k < fftBins; k++) {
      float freq = static_cast<float>(k) * sr / kFFTSize;
      if (freq < 60.0f || freq > 2000.0f) continue;

      float midiNote = 69.0f + 12.0f * std::log2(freq / 440.0f);
      int pitchClass = static_cast<int>(std::round(midiNote)) % 12;
      if (pitchClass < 0) pitchClass += 12;

      chroma[pitchClass] += static_cast<double>(magnitudes[k]);
    }
  }

  vDSP_destroy_fftsetup(fftSetup);
#else
  for (int frame = 0; frame < numFrames; frame++) {
    int offset = frame * kHopSize;

    for (int k = 1; k < fftBins; k++) {
      float re = 0.0f, im = 0.0f;
      for (int n = 0; n < kFFTSize; n++) {
        float sample = static_cast<float>(samples[offset + n]) * window[n];
        float angle = 2.0f * M_PI * k * n / kFFTSize;
        re += sample * std::cos(angle);
        im -= sample * std::sin(angle);
      }
      float mag = (re * re + im * im) / kFFTSize;

      float freq = static_cast<float>(k) * sr / kFFTSize;
      if (freq < 60.0f || freq > 2000.0f) continue;

      float midiNote = 69.0f + 12.0f * std::log2(freq / 440.0f);
      int pitchClass = static_cast<int>(std::round(midiNote)) % 12;
      if (pitchClass < 0) pitchClass += 12;

      chroma[pitchClass] += static_cast<double>(mag);
    }
  }
#endif

  double maxVal = *std::max_element(chroma.begin(), chroma.end());
  if (maxVal > 0.0) {
    for (auto& v : chroma) v /= maxVal;
  }

  return chroma;
}

} // namespace margelo::nitro::chorddsp
