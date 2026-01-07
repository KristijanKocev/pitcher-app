/**
 * Enhanced Pitch Detection Utilities
 *
 * Implements techniques from Universal Tuner:
 * 1. Octave error correction via harmonic analysis
 * 2. Confidence scoring based on autocorrelation strength
 * 3. Jitter calculation for stability assessment
 * 4. Normalized autocorrelation for better accuracy
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

export const DETECTION_CONFIG = {
  // Frequency range
  MIN_FREQUENCY: 60, // Hz - lowest expected (B1)
  MAX_FREQUENCY: 1500, // Hz - highest expected (F#6)

  // Octave correction
  HARMONIC_THRESHOLD: 0.85, // Harmonics must be this strong relative to fundamental
  MAX_HARMONIC_CHECK: 4, // Check up to 4th harmonic

  // Confidence thresholds
  MIN_AUTOCORR_PEAK: 0.3, // Minimum autocorrelation peak for valid detection
  HIGH_CONFIDENCE_PEAK: 0.7, // Peak value for high confidence
};

// ============================================================================
// TYPES
// ============================================================================

export interface EnhancedPitchResult {
  /** Detected frequency in Hz (null if no valid pitch) */
  frequency: number | null;
  /** Detection confidence (0-1) */
  confidence: number;
  /** Autocorrelation peak value */
  autocorrPeak: number;
  /** Frequency deviation/jitter estimate */
  jitter: number;
  /** Raw detected frequency before octave correction */
  rawFrequency: number | null;
  /** Whether octave correction was applied */
  octaveCorrected: boolean;
}

// ============================================================================
// NOTE CONVERSION UTILITIES
// ============================================================================

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

/**
 * Convert frequency to semitones from A4 (MIDI note number)
 * A4 (440Hz) = 69
 */
export function frequencyToSemitones(frequency: number): number {
  return 12 * Math.log2(frequency / 440) + 69;
}

/**
 * Convert semitones to frequency
 */
export function semitonesToFrequency(semitones: number): number {
  return 440 * Math.pow(2, (semitones - 69) / 12);
}

/**
 * Get note info from frequency
 */
export function frequencyToNoteInfo(frequency: number): {
  noteName: string;
  octave: number;
  cents: number;
  midiNote: number;
  prevNote: string;
  prevOctave: number;
  nextNote: string;
  nextOctave: number;
} {
  const semitones = frequencyToSemitones(frequency);
  const midiNote = Math.round(semitones);
  const cents = Math.round((semitones - midiNote) * 100);

  const noteIndex = ((midiNote % 12) + 12) % 12;
  const octave = Math.floor(midiNote / 12) - 1;

  const prevNoteIndex = (noteIndex - 1 + 12) % 12;
  const nextNoteIndex = (noteIndex + 1) % 12;
  const prevOctave = noteIndex === 0 ? octave - 1 : octave;
  const nextOctave = noteIndex === 11 ? octave + 1 : octave;

  return {
    noteName: NOTE_NAMES[noteIndex],
    octave,
    cents,
    midiNote,
    prevNote: NOTE_NAMES[prevNoteIndex],
    prevOctave,
    nextNote: NOTE_NAMES[nextNoteIndex],
    nextOctave,
  };
}

// ============================================================================
// SIGNAL ANALYSIS
// ============================================================================

/**
 * Calculate peak-to-peak amplitude
 */
export function calculatePeakToPeak(samples: Float32Array): number {
  let min = samples[0];
  let max = samples[0];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] < min) min = samples[i];
    if (samples[i] > max) max = samples[i];
  }
  return max - min;
}

/**
 * Estimate noise level using high-frequency content
 */
export function estimateNoiseLevel(samples: Float32Array): number {
  // Simple high-pass filter to estimate noise
  let noiseSum = 0;
  for (let i = 1; i < samples.length; i++) {
    const diff = samples[i] - samples[i - 1];
    noiseSum += diff * diff;
  }
  return Math.sqrt(noiseSum / (samples.length - 1));
}

// ============================================================================
// AUTOCORRELATION-BASED PITCH DETECTION
// ============================================================================

/**
 * Compute normalized autocorrelation using the YIN-style difference function
 * This is similar to what Universal Tuner uses in S.a class
 */
export function computeNormalizedAutocorrelation(
  samples: Float32Array,
  sampleRate: number,
  minFreq: number = DETECTION_CONFIG.MIN_FREQUENCY,
  maxFreq: number = DETECTION_CONFIG.MAX_FREQUENCY
): { lag: number; value: number }[] {
  const n = samples.length;
  const minLag = Math.floor(sampleRate / maxFreq);
  const maxLag = Math.min(Math.ceil(sampleRate / minFreq), n - 1);

  const results: { lag: number; value: number }[] = [];

  // Compute energy for normalization
  let energy = 0;
  for (let i = 0; i < n; i++) {
    energy += samples[i] * samples[i];
  }

  // No energy filtering - let any signal through
  // Universal Tuner shows ANY detected frequency > 0
  if (energy === 0) {
    return results;
  }

  // Compute normalized autocorrelation for each lag
  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    let energyStart = 0;
    let energyEnd = 0;

    const windowSize = n - lag;

    for (let i = 0; i < windowSize; i++) {
      correlation += samples[i] * samples[i + lag];
      energyStart += samples[i] * samples[i];
      energyEnd += samples[i + lag] * samples[i + lag];
    }

    // Normalize by geometric mean of energies
    const normFactor = Math.sqrt(energyStart * energyEnd);
    if (normFactor > 0) {
      const normalizedCorr = correlation / normFactor;

      // Apply bias correction favoring lower frequencies (from Universal Tuner)
      // This helps select fundamental over harmonics
      const biasCorrection = 1 - 0.5 / lag;
      const biasedCorr = normalizedCorr * biasCorrection;

      results.push({ lag, value: biasedCorr });
    }
  }

  return results;
}

/**
 * Find the best pitch from autocorrelation results
 * Implements octave error correction via harmonic analysis
 */
export function findBestPitch(
  autocorr: { lag: number; value: number }[],
  sampleRate: number
): {
  frequency: number | null;
  confidence: number;
  peak: number;
  rawFrequency: number | null;
  octaveCorrected: boolean;
} {
  if (autocorr.length === 0) {
    return {
      frequency: null,
      confidence: 0,
      peak: 0,
      rawFrequency: null,
      octaveCorrected: false,
    };
  }

  // Find the peak
  let maxValue = autocorr[0].value;
  let maxIndex = 0;

  for (let i = 1; i < autocorr.length; i++) {
    if (autocorr[i].value > maxValue) {
      maxValue = autocorr[i].value;
      maxIndex = i;
    }
  }

  if (maxValue < DETECTION_CONFIG.MIN_AUTOCORR_PEAK) {
    return {
      frequency: null,
      confidence: 0,
      peak: maxValue,
      rawFrequency: null,
      octaveCorrected: false,
    };
  }

  const bestLag = autocorr[maxIndex].lag;
  const rawFrequency = sampleRate / bestLag;

  // ================================================================
  // OCTAVE ERROR CORRECTION (from Universal Tuner's S.a class)
  // Check if harmonics are present to detect octave errors
  // ================================================================
  let correctedFrequency = rawFrequency;
  let octaveCorrected = false;

  // Check for potential octave errors by looking at sub-harmonics
  const harmonicThreshold = maxValue * DETECTION_CONFIG.HARMONIC_THRESHOLD;

  // Check if we should divide by 2, 3, or 4 (we might have detected a harmonic)
  for (
    let divisor = 2;
    divisor <= DETECTION_CONFIG.MAX_HARMONIC_CHECK;
    divisor++
  ) {
    // Check if all harmonics up to this divisor are strong
    let allHarmonicsStrong = true;

    for (let h = 1; h < divisor; h++) {
      const harmonicLag = Math.round((bestLag * h) / divisor);

      // Find the autocorrelation value at this lag
      const harmonicEntry = autocorr.find(
        (a) => Math.abs(a.lag - harmonicLag) <= 1
      );

      if (!harmonicEntry || harmonicEntry.value < harmonicThreshold) {
        allHarmonicsStrong = false;
        break;
      }
    }

    if (allHarmonicsStrong) {
      // We likely detected a harmonic, divide to get fundamental
      correctedFrequency = rawFrequency / divisor;
      octaveCorrected = true;
      break;
    }
  }

  // Calculate confidence based on peak strength
  const confidence = Math.min(
    maxValue / DETECTION_CONFIG.HIGH_CONFIDENCE_PEAK,
    1
  );

  return {
    frequency: correctedFrequency,
    confidence,
    peak: maxValue,
    rawFrequency,
    octaveCorrected,
  };
}

/**
 * Refine pitch estimate using parabolic interpolation
 * This gives sub-sample accuracy
 */
export function refinePitchEstimate(
  autocorr: { lag: number; value: number }[],
  peakIndex: number,
  sampleRate: number
): number {
  if (peakIndex <= 0 || peakIndex >= autocorr.length - 1) {
    return sampleRate / autocorr[peakIndex].lag;
  }

  const y0 = autocorr[peakIndex - 1].value;
  const y1 = autocorr[peakIndex].value;
  const y2 = autocorr[peakIndex + 1].value;

  // Parabolic interpolation
  const delta = (y2 - y0) / (2 * (2 * y1 - y0 - y2));
  const refinedLag = autocorr[peakIndex].lag + delta;

  return sampleRate / refinedLag;
}

/**
 * Estimate frequency jitter/deviation from autocorrelation peak width
 *
 * In the Universal Tuner app, jitter is calculated as the absolute frequency
 * deviation (in Hz) based on how "wide" the autocorrelation peak is.
 * A sharper peak means more stable pitch = lower jitter.
 *
 * The jitter ratio (jitter / frequency) should be < 0.005 for "tuned" state.
 */
export function estimateJitter(
  autocorr: { lag: number; value: number }[],
  peakIndex: number,
  sampleRate: number
): number {
  if (peakIndex <= 0 || peakIndex >= autocorr.length - 1) {
    return 0;
  }

  const peakLag = autocorr[peakIndex].lag;
  const peakValue = autocorr[peakIndex].value;
  const leftValue = autocorr[peakIndex - 1].value;
  const rightValue = autocorr[peakIndex + 1].value;

  // Peak sharpness: how much higher is the peak than its neighbors
  // Higher sharpness = more stable frequency = lower jitter
  const avgNeighbor = (leftValue + rightValue) / 2;
  const sharpness = peakValue - avgNeighbor;

  // If peak is not sharp (sharpness close to 0), jitter is high
  // If peak is very sharp (sharpness close to peakValue), jitter is low
  // Normalize sharpness to 0-1 range
  const normalizedSharpness = Math.max(
    0,
    Math.min(1, sharpness / Math.max(peakValue, 0.001))
  );

  // Convert to frequency jitter estimate
  // At the peak lag, frequency = sampleRate / peakLag
  // Jitter is estimated as a fraction of this frequency based on peak width
  const frequency = sampleRate / peakLag;

  // Jitter in Hz: lower sharpness = higher jitter
  // Scale factor calibrated to match Universal Tuner's behavior
  // A very sharp peak (sharpness ~= 1) gives jitter ~= 0
  // A flat peak (sharpness ~= 0) gives jitter ~= frequency * 0.02
  const jitterHz = frequency * 0.02 * (1 - normalizedSharpness);

  return jitterHz;
}

// ============================================================================
// MAIN ENHANCED DETECTION FUNCTION
// ============================================================================

/**
 * Enhanced pitch detection with all Universal Tuner techniques
 *
 * @param samples - Audio samples (Float32Array, normalized -1 to 1)
 * @param sampleRate - Sample rate in Hz
 * @returns Enhanced pitch result with confidence and quality metrics
 */
export function detectPitchEnhanced(
  samples: Float32Array,
  sampleRate: number
): EnhancedPitchResult {
  // Compute normalized autocorrelation
  const autocorr = computeNormalizedAutocorrelation(
    samples,
    sampleRate,
    DETECTION_CONFIG.MIN_FREQUENCY,
    DETECTION_CONFIG.MAX_FREQUENCY
  );

  if (autocorr.length === 0) {
    return {
      frequency: null,
      confidence: 0,
      autocorrPeak: 0,
      jitter: 0,
      rawFrequency: null,
      octaveCorrected: false,
    };
  }

  // Find best pitch with octave correction
  const pitchResult = findBestPitch(autocorr, sampleRate);

  if (pitchResult.frequency === null) {
    return {
      frequency: null,
      confidence: pitchResult.confidence,
      autocorrPeak: pitchResult.peak,
      jitter: 0,
      rawFrequency: null,
      octaveCorrected: false,
    };
  }

  // Find peak index for jitter estimation
  let peakIndex = 0;
  for (let i = 0; i < autocorr.length; i++) {
    if (autocorr[i].value > autocorr[peakIndex].value) {
      peakIndex = i;
    }
  }

  const jitter = estimateJitter(autocorr, peakIndex, sampleRate);

  return {
    frequency: pitchResult.frequency,
    confidence: pitchResult.confidence,
    autocorrPeak: pitchResult.peak,
    jitter,
    rawFrequency: pitchResult.rawFrequency,
    octaveCorrected: pitchResult.octaveCorrected,
  };
}

// ============================================================================
// WRAPPER FOR PITCHFINDER INTEGRATION
// ============================================================================

/**
 * Wrapper that enhances pitchfinder results with our additional metrics.
 *
 * Universal Tuner's confidence is the **normalized autocorrelation peak value**
 * at the detected pitch period. This is stored in f112e in S/a.java (line 117):
 *   this.f112e = (float) d14;  // d14 is the autocorrelation peak
 *
 * The autocorrelation is normalized by dividing by the product of energies
 * (see line 77 in S/a.java):
 *   double a2 = b.a(this.f109b[i13]) / (d3 * d4);
 *
 * This gives values in range 0-1 where:
 * - 0.7+ is considered "confident enough" for note detection
 * - 0.92+ with jitter ratio < 0.01 is needed for "tuned" state
 */
export function enhancePitchfinderResult(
  pitchfinderFrequency: number | null,
  samples: Float32Array,
  sampleRate: number
): EnhancedPitchResult {
  // Only check if pitchfinder returned null (couldn't detect pitch)
  if (pitchfinderFrequency === null) {
    return {
      frequency: null,
      confidence: 0,
      autocorrPeak: 0,
      jitter: 0,
      rawFrequency: null,
      octaveCorrected: false,
    };
  }

  // Compute normalized autocorrelation at the detected pitch period
  // This matches Universal Tuner's approach in S/a.java
  const expectedLag = Math.round(sampleRate / pitchfinderFrequency);

  // Compute autocorrelation at the expected lag (and neighbors for jitter)
  const n = samples.length;

  // Calculate energies for normalization (like d3 and d4 in S/a.java)
  let energyFirst = 0;
  let energySecond = 0;
  for (let i = 0; i < n - expectedLag; i++) {
    energyFirst += samples[i] * samples[i];
    energySecond += samples[i + expectedLag] * samples[i + expectedLag];
  }

  // Calculate autocorrelation at expected lag
  let correlation = 0;
  for (let i = 0; i < n - expectedLag; i++) {
    correlation += samples[i] * samples[i + expectedLag];
  }

  // Normalize correlation (this is the confidence value)
  // In Universal Tuner: a2 = b.a(this.f109b[i13]) / (d3 * d4)
  // where b.a() is likely Math.abs() or squaring
  const normalizer = Math.sqrt(energyFirst * energySecond);
  const autocorrPeak = normalizer > 0 ? Math.abs(correlation) / normalizer : 0;

  // Confidence is the normalized autocorrelation peak (0-1 range)
  // Values above 0.7 are considered confident
  let confidence = Math.min(autocorrPeak, 1);

  // Calculate jitter by looking at how correlation changes around the peak
  // This estimates pitch stability
  let jitter = 0;
  if (expectedLag > 1 && expectedLag < n - 2) {
    // Calculate correlation at neighboring lags
    let corrMinus = 0;
    let corrPlus = 0;
    const lagMinus = expectedLag - 1;
    const lagPlus = expectedLag + 1;

    for (let i = 0; i < n - lagPlus; i++) {
      corrMinus += samples[i] * samples[i + lagMinus];
      corrPlus += samples[i] * samples[i + lagPlus];
    }

    // Normalize
    let energyMinus = 0;
    let energyPlus = 0;
    for (let i = 0; i < n - lagMinus; i++) {
      energyMinus += samples[i + lagMinus] * samples[i + lagMinus];
    }
    for (let i = 0; i < n - lagPlus; i++) {
      energyPlus += samples[i + lagPlus] * samples[i + lagPlus];
    }

    const normMinus = Math.sqrt(energyFirst * energyMinus);
    const normPlus = Math.sqrt(energyFirst * energyPlus);

    const peakMinus = normMinus > 0 ? Math.abs(corrMinus) / normMinus : 0;
    const peakPlus = normPlus > 0 ? Math.abs(corrPlus) / normPlus : 0;

    // Peak sharpness: difference between peak and average of neighbors
    const avgNeighbor = (peakMinus + peakPlus) / 2;
    const sharpness = autocorrPeak - avgNeighbor;

    // Convert sharpness to jitter (Hz)
    // Sharper peak = lower jitter
    //
    // In Universal Tuner, the jitter ratio thresholds are:
    // - 0.005 (0.5%) for "tuned" state
    // - 0.01 (1%) for "stable" detection
    //
    // So we want jitter to typically be in the 0.1-1% range for good signals.
    // Scale: if sharpness is 0 (flat), jitter ratio is ~1% of frequency
    // if sharpness is high (~0.1), jitter ratio is ~0.1% of frequency
    const normalizedSharpness = Math.max(0, Math.min(1, sharpness / 0.1));
    // Base jitter is 1% of frequency, reduced by sharpness to minimum of 0.1%
    jitter = pitchfinderFrequency * (0.01 - 0.009 * normalizedSharpness);
  }

  return {
    frequency: pitchfinderFrequency,
    confidence,
    autocorrPeak,
    jitter,
    rawFrequency: pitchfinderFrequency,
    octaveCorrected: false,
  };
}
