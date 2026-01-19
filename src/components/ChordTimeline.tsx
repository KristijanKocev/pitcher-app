/**
 * ChordTimeline Component
 *
 * Displays a vertical timeline of detected notes using LegendList for smooth animations.
 * Newest entries appear at the top, older entries are pushed downward.
 * Notes detected simultaneously are displayed horizontally in the same row.
 *
 * Uses multi-peak detection to identify all prominent frequencies in each buffer.
 */

import React, { useState, useRef, useEffect, useCallback, memo } from "react";
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  AppState,
  AppStateStatus,
  ScaledSize,
  TouchableOpacity,
} from "react-native";
import {
  AudioContext,
  AudioRecorder,
  AudioManager,
} from "react-native-audio-api";
import { LegendList, LegendListRef } from "@legendapp/list";

import { frequencyToNoteInfo } from "../utils/enhancedPitchDetection";
import { paletteTokens } from "../utils/theme/color-palette";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Audio settings
  SAMPLE_RATE: 16000,
  BUFFER_SIZE: 2048,
  RING_BUFFER_SIZE: 4096,
  HOP_SIZE: 1024,
  MIN_FREQUENCY: 60,
  MAX_FREQUENCY: 1500,
  MIN_RMS_THRESHOLD: 0.02,
  INPUT_GAIN: 10.0,

  // Multi-peak detection
  MIN_PEAK_PROMINENCE: 0.45,
  MIN_PEAK_VALUE: 0.6,
  MAX_NOTES_PER_FRAME: 4,
  HARMONIC_RATIO_TOLERANCE: 0.05,

  // Timeline settings
  MAX_TIMELINE_ENTRIES: 100,
  ROW_HEIGHT: 52,

  // Logging
  LOG_ENABLED: true,
};

// Note colors
const NOTE_COLORS: Record<string, string> = {
  C: "#FF6B6B",
  "C#": "#FF8E72",
  D: "#FFA94D",
  "D#": "#FFD43B",
  E: "#A9E34B",
  F: "#51CF66",
  "F#": "#38D9A9",
  G: "#22B8CF",
  "G#": "#339AF0",
  A: "#5C7CFA",
  "A#": "#7950F2",
  B: "#BE4BDB",
};

// ============================================================================
// TYPES
// ============================================================================

interface DetectedNote {
  noteName: string;
  octave: number;
  frequency: number;
  confidence: number;
  midiNote: number;
  cents: number;
}

interface TimelineEntry {
  id: number;
  timestamp: number;
  notes: DetectedNote[];
  /** Key representing the notes (without cents) for comparison */
  noteSignature: string;
}

// ============================================================================
// NOTE COMPARISON UTILITIES
// ============================================================================

/**
 * Creates a signature string from notes that ignores cents values.
 * This is used to determine if notes have fundamentally changed.
 * Format: "C4,E4,G4" (sorted by note name + octave)
 */
function createNoteSignature(notes: DetectedNote[]): string {
  return notes
    .map((n) => `${n.noteName}${n.octave}`)
    .sort()
    .join(",");
}

// ============================================================================
// MULTI-PEAK DETECTION
// ============================================================================

/**
 * Check if two frequencies are harmonically related.
 * Returns true if either frequency is a harmonic of the other.
 */
function areHarmonicallyRelated(
  freq1: number,
  freq2: number,
  tolerance: number = CONFIG.HARMONIC_RATIO_TOLERANCE
): boolean {
  const [lower, higher] = freq1 < freq2 ? [freq1, freq2] : [freq2, freq1];

  // Check if higher is a harmonic of lower (up to 16th harmonic to catch high overtones)
  // E.g., E6 (1318 Hz) is the 10th harmonic of C3 (131 Hz)
  for (let n = 2; n <= 16; n++) {
    const expectedHarmonic = lower * n;
    const ratio = higher / expectedHarmonic;
    // Use tighter tolerance for higher harmonics
    const adjustedTolerance = tolerance * (1 + n / 30);
    if (Math.abs(ratio - 1) < adjustedTolerance) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a frequency could be a subharmonic (fundamental) of another.
 * This catches cases where we detected a harmonic first.
 */
function isSubharmonic(
  candidateFundamental: number,
  existingFreq: number,
  tolerance: number = CONFIG.HARMONIC_RATIO_TOLERANCE
): boolean {
  for (let n = 2; n <= 8; n++) {
    const expectedHarmonic = candidateFundamental * n;
    const ratio = existingFreq / expectedHarmonic;
    if (Math.abs(ratio - 1) < tolerance) {
      return true;
    }
  }
  return false;
}

/**
 * Find the true fundamental from a set of harmonically related peaks.
 * For voice/monophonic sources, we want the lowest frequency that has
 * strong harmonic support.
 */
function findTrueFundamental(
  peaks: { lag: number; value: number; frequency: number }[]
): { lag: number; value: number; frequency: number } | null {
  if (peaks.length === 0) return null;
  if (peaks.length === 1) return peaks[0];

  // Sort by frequency (lowest first)
  const sortedByFreq = [...peaks].sort((a, b) => a.frequency - b.frequency);

  // The true fundamental should be the lowest frequency that has
  // other peaks at its harmonic positions
  for (const candidate of sortedByFreq) {
    let harmonicSupport = 0;

    for (const other of peaks) {
      if (other === candidate) continue;

      // Check if 'other' is a harmonic of 'candidate'
      for (let n = 2; n <= 6; n++) {
        const expectedHarmonic = candidate.frequency * n;
        const ratio = other.frequency / expectedHarmonic;
        if (Math.abs(ratio - 1) < CONFIG.HARMONIC_RATIO_TOLERANCE) {
          harmonicSupport++;
          break;
        }
      }
    }

    // If this candidate has harmonic support, it's likely the true fundamental
    if (harmonicSupport >= 1) {
      return candidate;
    }
  }

  // Fallback: return the strongest peak
  return peaks.reduce((best, p) => (p.value > best.value ? p : best), peaks[0]);
}

/**
 * Compute autocorrelation and find peaks.
 * Shared between voice and instrument modes.
 */
function computeAutocorrPeaks(
  samples: Float32Array,
  sampleRate: number
): { lag: number; value: number; frequency: number }[] {
  const n = samples.length;
  const minLag = Math.floor(sampleRate / CONFIG.MAX_FREQUENCY);
  const maxLag = Math.min(Math.ceil(sampleRate / CONFIG.MIN_FREQUENCY), n - 1);

  const autocorr: number[] = [];

  let energyFirst = 0;
  for (let i = 0; i < n; i++) {
    energyFirst += samples[i] * samples[i];
  }

  if (energyFirst < 0.0001) {
    return [];
  }

  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    let energySecond = 0;
    const windowSize = n - lag;

    for (let i = 0; i < windowSize; i++) {
      correlation += samples[i] * samples[i + lag];
      energySecond += samples[i + lag] * samples[i + lag];
    }

    const energyFirstWindow = energyFirst * (windowSize / n);
    const normFactor = Math.sqrt(energyFirstWindow * energySecond);

    autocorr[lag - minLag] = normFactor > 0 ? correlation / normFactor : 0;
  }

  const peaks: { lag: number; value: number; frequency: number }[] = [];

  for (let i = 1; i < autocorr.length - 1; i++) {
    const value = autocorr[i];
    const left = autocorr[i - 1];
    const right = autocorr[i + 1];

    if (
      value > left &&
      value > right &&
      value > CONFIG.MIN_PEAK_VALUE &&
      value > CONFIG.MIN_PEAK_PROMINENCE
    ) {
      let leftValley = value;
      let rightValley = value;

      for (let j = i - 1; j >= 0; j--) {
        if (autocorr[j] < leftValley) leftValley = autocorr[j];
        if (autocorr[j] > value) break;
      }

      for (let j = i + 1; j < autocorr.length; j++) {
        if (autocorr[j] < rightValley) rightValley = autocorr[j];
        if (autocorr[j] > value) break;
      }

      const prominence = value - Math.max(leftValley, rightValley);

      if (prominence >= CONFIG.MIN_PEAK_PROMINENCE) {
        peaks.push({
          lag: i + minLag,
          value,
          frequency: sampleRate / (i + minLag),
        });
      }
    }
  }

  return peaks;
}

/**
 * Voice Mode: Aggressive harmonic filtering for monophonic sources.
 * Groups all harmonically-related peaks and returns only the true fundamental.
 */
function detectPitchesVoiceMode(
  samples: Float32Array,
  sampleRate: number
): DetectedNote[] {
  const peaks = computeAutocorrPeaks(samples, sampleRate);

  if (peaks.length === 0) return [];

  // Sort by strength
  peaks.sort((a, b) => b.value - a.value);

  // Group peaks into harmonic families
  const harmonicFamilies: (typeof peaks)[] = [];

  for (const peak of peaks) {
    let addedToFamily = false;

    for (const family of harmonicFamilies) {
      for (const familyPeak of family) {
        if (areHarmonicallyRelated(peak.frequency, familyPeak.frequency)) {
          family.push(peak);
          addedToFamily = true;
          break;
        }
      }
      if (addedToFamily) break;
    }

    if (!addedToFamily) {
      harmonicFamilies.push([peak]);
    }
  }

  // For each harmonic family, find the true fundamental
  const fundamentals: typeof peaks = [];

  for (const family of harmonicFamilies) {
    const fundamental = findTrueFundamental(family);
    if (fundamental) {
      fundamentals.push(fundamental);
    }

    // Voice mode: typically only 1 note, but allow up to 2 for harmonies
    if (fundamentals.length >= 2) break;
  }

  return peaksToNotes(fundamentals);
}

/**
 * Simple FFT implementation for spectral analysis.
 * Uses Cooley-Tukey radix-2 algorithm.
 */
function fft(
  real: Float32Array,
  imag: Float32Array
): { real: Float32Array; imag: Float32Array } {
  const n = real.length;

  // Bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;

    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  // Cooley-Tukey FFT
  for (let len = 2; len <= n; len *= 2) {
    const halfLen = len / 2;
    const angle = (-2 * Math.PI) / len;

    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < halfLen; j++) {
        const cos = Math.cos(angle * j);
        const sin = Math.sin(angle * j);

        const tReal = real[i + j + halfLen] * cos - imag[i + j + halfLen] * sin;
        const tImag = real[i + j + halfLen] * sin + imag[i + j + halfLen] * cos;

        real[i + j + halfLen] = real[i + j] - tReal;
        imag[i + j + halfLen] = imag[i + j] - tImag;
        real[i + j] += tReal;
        imag[i + j] += tImag;
      }
    }
  }

  return { real, imag };
}

/**
 * Apply Hann window to reduce spectral leakage.
 */
function applyHannWindow(samples: Float32Array): Float32Array {
  const n = samples.length;
  const windowed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    windowed[i] = samples[i] * window;
  }
  return windowed;
}

/**
 * Instrument Mode: FFT-based spectral analysis for polyphonic sources.
 * Finds peaks in the frequency spectrum to detect multiple simultaneous notes.
 */
function detectPitchesInstrumentMode(
  samples: Float32Array,
  sampleRate: number
): DetectedNote[] {
  const n = samples.length;

  // Apply window function
  const windowed = applyHannWindow(samples);

  // Prepare FFT input
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    real[i] = windowed[i];
    imag[i] = 0;
  }

  // Compute FFT
  fft(real, imag);

  // Compute magnitude spectrum (only need first half due to symmetry)
  const halfN = Math.floor(n / 2);
  const magnitudes = new Float32Array(halfN);
  let maxMagnitude = 0;

  for (let i = 0; i < halfN; i++) {
    magnitudes[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    if (magnitudes[i] > maxMagnitude) {
      maxMagnitude = magnitudes[i];
    }
  }

  if (maxMagnitude < 0.01) return [];

  // Normalize
  for (let i = 0; i < halfN; i++) {
    magnitudes[i] /= maxMagnitude;
  }

  // Find frequency bin range for our note range
  const minBin = Math.floor((CONFIG.MIN_FREQUENCY * n) / sampleRate);
  const maxBin = Math.ceil((CONFIG.MAX_FREQUENCY * n) / sampleRate);

  // Find peaks in the spectrum with very strict thresholds
  const spectralPeaks: { bin: number; magnitude: number; frequency: number }[] =
    [];
  const MIN_SPECTRAL_PEAK = 0.45; // Very high threshold - only strong notes
  const MIN_SPECTRAL_PROMINENCE = 0.25; // Require significant prominence

  for (let i = Math.max(3, minBin); i < Math.min(halfN - 3, maxBin); i++) {
    const mag = magnitudes[i];

    // Check if it's a strong local maximum (check 3 neighbors each side)
    if (
      mag > magnitudes[i - 1] &&
      mag > magnitudes[i + 1] &&
      mag > magnitudes[i - 2] &&
      mag > magnitudes[i + 2] &&
      mag >= magnitudes[i - 3] &&
      mag >= magnitudes[i + 3] &&
      mag > MIN_SPECTRAL_PEAK
    ) {
      // Check prominence with wider search
      let leftMin = mag;
      let rightMin = mag;

      for (let j = i - 1; j >= Math.max(minBin, i - 15); j--) {
        if (magnitudes[j] < leftMin) leftMin = magnitudes[j];
        if (magnitudes[j] > mag) break;
      }

      for (let j = i + 1; j <= Math.min(maxBin, i + 15); j++) {
        if (magnitudes[j] < rightMin) rightMin = magnitudes[j];
        if (magnitudes[j] > mag) break;
      }

      const prominence = mag - Math.max(leftMin, rightMin);

      if (prominence > MIN_SPECTRAL_PROMINENCE) {
        // Parabolic interpolation for better frequency accuracy
        const alpha = magnitudes[i - 1];
        const beta = magnitudes[i];
        const gamma = magnitudes[i + 1];
        const denom = alpha - 2 * beta + gamma;
        
        let frequency: number;
        if (Math.abs(denom) > 0.0001) {
          const p = 0.5 * (alpha - gamma) / denom;
          const interpolatedBin = i + p;
          frequency = (interpolatedBin * sampleRate) / n;
        } else {
          frequency = (i * sampleRate) / n;
        }

        spectralPeaks.push({
          bin: i,
          magnitude: mag,
          frequency,
        });
      }
    }
  }

  if (spectralPeaks.length === 0) return [];

  // Sort by magnitude (strongest first)
  spectralPeaks.sort((a, b) => b.magnitude - a.magnitude);

  // Log all detected peaks before filtering
  if (CONFIG.LOG_ENABLED && spectralPeaks.length > 0) {
    const strongestMag = spectralPeaks[0].magnitude;
    console.log("=== SPECTRAL PEAKS (before filtering) ===");
    spectralPeaks.slice(0, 10).forEach((p, i) => {
      const noteInfo = frequencyToNoteInfo(p.frequency);
      const relativeStrength = (p.magnitude / strongestMag * 100).toFixed(0);
      console.log(
        `  ${i + 1}. ${noteInfo.noteName}${noteInfo.octave} (${p.frequency.toFixed(1)} Hz) - mag: ${p.magnitude.toFixed(3)} (${relativeStrength}% of strongest)`
      );
    });
  }

  // Smart harmonic filtering strategy:
  // 1. Group peaks by note name (C, D, E, etc.) - octaves of same note are harmonically related
  // 2. For each note name group, keep only the lowest octave (fundamental)
  // 3. Filter obvious harmonics (peaks at exact 2x, 3x, etc. of a stronger peak)
  // 4. But preserve different note names even if they happen to be at harmonic ratios
  
  const HARMONIC_TOLERANCE = 0.04; // 4% tolerance for exact harmonic detection
  
  // First, convert all peaks to note info
  const peaksWithNotes = spectralPeaks.map(peak => ({
    ...peak,
    noteInfo: frequencyToNoteInfo(peak.frequency),
  }));
  
  // Group by note name (ignoring octave)
  const noteGroups = new Map<string, typeof peaksWithNotes>();
  for (const peak of peaksWithNotes) {
    const noteName = peak.noteInfo.noteName;
    if (!noteGroups.has(noteName)) {
      noteGroups.set(noteName, []);
    }
    noteGroups.get(noteName)!.push(peak);
  }
  
  // For each note name, keep only the strongest occurrence
  // This handles octave harmonics (A3 vs A4, C3 vs C4, etc.)
  const representativeNotes: typeof peaksWithNotes = [];
  
  for (const [noteName, peaks] of noteGroups) {
    // Sort by magnitude (strongest first)
    peaks.sort((a, b) => b.magnitude - a.magnitude);
    
    // Keep the strongest peak for this note name
    const strongest = peaks[0];
    
    // But if there's a lower octave version that's at least 40% as strong,
    // prefer the lower octave (it's likely the true fundamental)
    let representative = strongest;
    for (const peak of peaks) {
      if (peak.noteInfo.octave < representative.noteInfo.octave) {
        // Lower octave - check if it's strong enough
        if (peak.magnitude >= strongest.magnitude * 0.4) {
          representative = peak;
        }
      }
    }
    
    representativeNotes.push(representative);
    
    if (CONFIG.LOG_ENABLED && peaks.length > 1) {
      const filtered = peaks.filter(p => p !== representative);
      for (const f of filtered) {
        console.log(
          `  FILTERED: ${f.noteInfo.noteName}${f.noteInfo.octave} (${f.frequency.toFixed(1)} Hz) - octave duplicate of ${representative.noteInfo.noteName}${representative.noteInfo.octave}`
        );
      }
    }
  }
  
  // Now filter peaks that are exact harmonics of much stronger peaks
  // Only filter if: (1) exact harmonic ratio AND (2) significantly weaker AND (3) different note name
  const filteredPeaks: typeof peaksWithNotes = [];
  
  // Sort by magnitude for processing
  representativeNotes.sort((a, b) => b.magnitude - a.magnitude);
  
  for (const peak of representativeNotes) {
    let shouldFilter = false;
    let filterReason = "";
    
    // Check if this peak is an exact harmonic of a STRONGER, DIFFERENT note
    for (const stronger of filteredPeaks) {
      // Skip if same note name (already handled by octave grouping)
      if (peak.noteInfo.noteName === stronger.noteInfo.noteName) continue;
      
      const ratio = peak.frequency / stronger.frequency;
      const nearestHarmonic = Math.round(ratio);
      
      // Only filter if:
      // 1. Very close to an exact harmonic (within 4%)
      // 2. The harmonic number is reasonable (2-12)
      // 3. This peak is significantly weaker (< 60% of the stronger peak)
      if (
        nearestHarmonic >= 2 &&
        nearestHarmonic <= 12 &&
        Math.abs(ratio - nearestHarmonic) < HARMONIC_TOLERANCE &&
        peak.magnitude < stronger.magnitude * 0.6
      ) {
        shouldFilter = true;
        filterReason = `weak harmonic ${nearestHarmonic}x of ${stronger.noteInfo.noteName}${stronger.noteInfo.octave} (${stronger.frequency.toFixed(0)}Hz)`;
      }
    }
    
    if (CONFIG.LOG_ENABLED && shouldFilter) {
      console.log(
        `  FILTERED: ${peak.noteInfo.noteName}${peak.noteInfo.octave} (${peak.frequency.toFixed(1)} Hz) - ${filterReason}`
      );
    }
    
    if (!shouldFilter) {
      filteredPeaks.push(peak);
    }
    
    if (filteredPeaks.length >= CONFIG.MAX_NOTES_PER_FRAME + 2) break;
  }

  // Convert to notes (noteInfo already computed)
  const candidateNotes: (DetectedNote & { peakMagnitude: number })[] = [];

  for (const peak of filteredPeaks) {
    if (
      peak.frequency < CONFIG.MIN_FREQUENCY ||
      peak.frequency > CONFIG.MAX_FREQUENCY
    ) {
      continue;
    }

    candidateNotes.push({
      noteName: peak.noteInfo.noteName,
      octave: peak.noteInfo.octave,
      frequency: peak.frequency,
      confidence: peak.magnitude,
      midiNote: peak.noteInfo.midiNote,
      cents: peak.noteInfo.cents,
      peakMagnitude: peak.magnitude,
    });
  }

  // Filter notes that are too close in semitones to stronger notes
  // This catches cases where spectral leakage creates nearby false peaks
  const finalNotes: DetectedNote[] = [];
  
  for (const note of candidateNotes) {
    let isTooClose = false;
    
    for (const accepted of finalNotes) {
      const semitoneDiff = Math.abs(note.midiNote - accepted.midiNote);
      
      // If within 1 semitone of a stronger note, it's likely an artifact
      if (semitoneDiff <= 1 && note.peakMagnitude < accepted.confidence) {
        isTooClose = true;
        break;
      }
    }
    
    if (!isTooClose) {
      finalNotes.push({
        noteName: note.noteName,
        octave: note.octave,
        frequency: note.frequency,
        confidence: note.confidence,
        midiNote: note.midiNote,
        cents: note.cents,
      });
    }
  }

  if (CONFIG.LOG_ENABLED && filteredPeaks.length > 0) {
    console.log("=== AFTER HARMONIC FILTER ===");
    filteredPeaks.forEach((p, i) => {
      console.log(
        `  ${i + 1}. ${p.noteInfo.noteName}${p.noteInfo.octave} - mag: ${p.magnitude.toFixed(3)}`
      );
    });
  }

  // Limit to MAX_NOTES_PER_FRAME and sort by pitch
  const notes = finalNotes
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, CONFIG.MAX_NOTES_PER_FRAME)
    .sort((a, b) => a.midiNote - b.midiNote);

  if (CONFIG.LOG_ENABLED && notes.length > 0) {
    console.log("=== FINAL OUTPUT ===");
    notes.forEach((n) => {
      console.log(
        `  ${n.noteName}${n.octave} - confidence: ${n.confidence.toFixed(3)}`
      );
    });
    console.log("---");
  }

  return notes;
}

/**
 * Convert peaks to DetectedNote array.
 */
function peaksToNotes(
  peaks: { lag: number; value: number; frequency: number }[]
): DetectedNote[] {
  const notes: DetectedNote[] = [];
  const seenNotes = new Set<string>();

  for (const peak of peaks) {
    if (
      peak.frequency < CONFIG.MIN_FREQUENCY ||
      peak.frequency > CONFIG.MAX_FREQUENCY
    ) {
      continue;
    }

    const noteInfo = frequencyToNoteInfo(peak.frequency);
    const noteKey = `${noteInfo.noteName}${noteInfo.octave}`;

    if (seenNotes.has(noteKey)) continue;

    seenNotes.add(noteKey);
    notes.push({
      noteName: noteInfo.noteName,
      octave: noteInfo.octave,
      frequency: peak.frequency,
      confidence: peak.value,
      midiNote: noteInfo.midiNote,
      cents: noteInfo.cents,
    });
  }

  notes.sort((a, b) => a.midiNote - b.midiNote);
  return notes;
}

// ============================================================================
// MEMOIZED ROW COMPONENT
// ============================================================================

interface TimelineRowProps {
  item: TimelineEntry;
}

const TimelineRow = memo(function TimelineRow({ item }: TimelineRowProps) {
  const timeAgo = formatTimeAgo(item.timestamp);

  return (
    <View style={styles.row}>
      <View style={styles.timeIndicator}>
        <Text style={styles.timeText}>{timeAgo}</Text>
      </View>
      <View style={styles.notesRow}>
        {item.notes.map((note, idx) => (
          <NoteChip key={`${note.noteName}${note.octave}-${idx}`} note={note} />
        ))}
      </View>
    </View>
  );
});

// Get estimated item size based on average note count
const getEstimatedItemSize = () => CONFIG.ROW_HEIGHT;

// ============================================================================
// MEMOIZED NOTE CHIP COMPONENT
// ============================================================================

interface NoteChipProps {
  note: DetectedNote;
}

const NoteChip = memo(function NoteChip({ note }: NoteChipProps) {
  const color = NOTE_COLORS[note.noteName] || "#888888";
  
  // More pronounced opacity based on confidence
  // confidence 1.0 -> opacity 1.0 (fully visible)
  // confidence 0.5 -> opacity 0.6 (somewhat faded)
  // confidence 0.3 -> opacity 0.4 (quite faded)
  const noteOpacity = 0.3 + note.confidence * 0.7;

  const centsDisplay =
    note.cents === 0
      ? ""
      : note.cents > 0
        ? `+${note.cents}`
        : `${note.cents}`;

  const centsColor =
    Math.abs(note.cents) <= 5
      ? "#4ADE80"
      : Math.abs(note.cents) <= 15
        ? "#FBBF24"
        : "#F87171";
  
  // Show confidence percentage for debugging/transparency
  const confidencePercent = Math.round(note.confidence * 100);

  return (
    <View
      style={[
        styles.noteChip,
        { backgroundColor: color, opacity: noteOpacity, justifyContent: 'center', alignItems: 'center' },
      ]}
    >
      <Text style={styles.noteText}>
        {note.noteName}
        <Text style={styles.octaveText}>{note.octave}</Text>
      </Text>
      {centsDisplay !== "" && (
        <Text style={[styles.centsText, { color: centsColor }]}>
          {centsDisplay}
        </Text>
      )}
      <Text style={[styles.confidenceText, {position: 'absolute', top: -8, backgroundColor: paletteTokens.primary.surface[2], borderRadius:99, paddingHorizontal: 4, paddingVertical: 2},]}>{confidencePercent}%</Text>
    </View>
  );
});

// ============================================================================
// HELPER
// ============================================================================

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 1) return "now";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

interface ChordTimelineProps {
  isActive?: boolean;
}

export function ChordTimeline({
  isActive: isScreenActive = true,
}: ChordTimelineProps) {
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppStateStatus>("active");
  const [isInitialized, setIsInitialized] = useState(false);
  const [dimensions, setDimensions] = useState(Dimensions.get("window"));
  const [voiceMode, setVoiceMode] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioRecorderRef = useRef<AudioRecorder | null>(null);
  const listRef = useRef<LegendListRef>(null);
  const entryIdRef = useRef(0);
  const isStartedRef = useRef(false);
  const frameCountRef = useRef(0);
  const voiceModeRef = useRef(voiceMode);

  // Keep ref in sync with state
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  const audioBufferRef = useRef<Float32Array>(
    new Float32Array(CONFIG.RING_BUFFER_SIZE)
  );
  const bufferWriteIndexRef = useRef(0);
  const samplesSinceLastAnalysisRef = useRef(0);
  const analysisBufferRef = useRef<Float32Array>(
    new Float32Array(CONFIG.BUFFER_SIZE)
  );

  // Handle orientation changes
  useEffect(() => {
    const handleDimensionChange = ({ window }: { window: ScaledSize }) => {
      setDimensions(window);
    };

    const subscription = Dimensions.addEventListener(
      "change",
      handleDimensionChange
    );

    return () => subscription.remove();
  }, []);

  // Render item - defined outside to avoid re-creation
  const renderItem = useCallback(
    ({ item }: { item: TimelineEntry }) => <TimelineRow item={item} />,
    []
  );

  // Key extractor
  const keyExtractor = useCallback(
    (item: TimelineEntry) => item.id.toString(),
    []
  );

  // Audio processing
  const processAudioBuffer = useCallback(
    (samples: Float32Array, sampleRate: number) => {
      try {
        const ringBuffer = audioBufferRef.current;
        const ringSize = CONFIG.RING_BUFFER_SIZE;

        for (let i = 0; i < samples.length; i++) {
          ringBuffer[bufferWriteIndexRef.current] = samples[i];
          bufferWriteIndexRef.current =
            (bufferWriteIndexRef.current + 1) % ringSize;
        }

        samplesSinceLastAnalysisRef.current += samples.length;

        if (samplesSinceLastAnalysisRef.current < CONFIG.HOP_SIZE) return;

        samplesSinceLastAnalysisRef.current %= CONFIG.HOP_SIZE;
        frameCountRef.current++;

        const analysisBuffer = analysisBufferRef.current;
        const bufferSize = CONFIG.BUFFER_SIZE;
        const startIdx =
          (bufferWriteIndexRef.current - bufferSize + ringSize) % ringSize;

        const gain = CONFIG.INPUT_GAIN;
        let rms = 0;

        for (let i = 0; i < bufferSize; i++) {
          const sample = ringBuffer[(startIdx + i) % ringSize] * gain;
          const clamped = Math.max(-1, Math.min(1, sample));
          analysisBuffer[i] = clamped;
          rms += clamped * clamped;
        }

        rms = Math.sqrt(rms / bufferSize);

        if (rms < CONFIG.MIN_RMS_THRESHOLD) {
          setIsListening(false);
          return;
        }

        setIsListening(true);

        // Use voice mode or instrument mode based on toggle
        const notes = voiceModeRef.current
          ? detectPitchesVoiceMode(analysisBuffer, CONFIG.SAMPLE_RATE)
          : detectPitchesInstrumentMode(analysisBuffer, CONFIG.SAMPLE_RATE);

        if (notes.length > 0) {
          const newSignature = createNoteSignature(notes);

          setTimeline((prev) => {
            // Check if the new notes are the same as the previous entry
            if (prev.length > 0 && prev[0].noteSignature === newSignature) {
              // Same notes - only update the cents values in the existing entry
              const updatedFirst: TimelineEntry = {
                ...prev[0],
                notes: notes, // Update with new notes (which have updated cents)
                timestamp: Date.now(), // Optionally update timestamp
              };
              return [updatedFirst, ...prev.slice(1)];
            }

            // Notes have changed - create a new entry
            const newEntry: TimelineEntry = {
              id: entryIdRef.current++,
              timestamp: Date.now(),
              notes,
              noteSignature: newSignature,
            };

            const updated = [newEntry, ...prev];
            return updated.length > CONFIG.MAX_TIMELINE_ENTRIES
              ? updated.slice(0, CONFIG.MAX_TIMELINE_ENTRIES)
              : updated;
          });

          // Scroll to top to show new entry (only if list is not at top)
          listRef.current?.scrollToIndex({
            index: 0,
            animated: true,
          });
        }
      } catch (err) {
        console.error("[ChordTimeline] Processing error:", err);
      }
    },
    []
  );

  // Audio control
  const handleStart = useCallback(async () => {
    if (isStartedRef.current) return;

    try {
      setError(null);
      frameCountRef.current = 0;
      isStartedRef.current = true;

      AudioManager.setAudioSessionOptions({
        iosCategory: "playAndRecord",
        iosMode: "measurement",
        iosOptions: ["defaultToSpeaker"],
      });

      await AudioManager.setAudioSessionActivity(true);

      const permissionStatus = await AudioManager.requestRecordingPermissions();
      if (permissionStatus !== "Granted") {
        setError("Microphone permission required");
        isStartedRef.current = false;
        return;
      }

      audioBufferRef.current = new Float32Array(CONFIG.RING_BUFFER_SIZE);
      bufferWriteIndexRef.current = 0;
      samplesSinceLastAnalysisRef.current = 0;

      audioContextRef.current = new AudioContext({
        sampleRate: CONFIG.SAMPLE_RATE,
      });

      const actualSampleRate = audioContextRef.current.sampleRate;
      audioRecorderRef.current = new AudioRecorder();

      audioRecorderRef.current.onError((error) => {
        console.error("[ChordTimeline] Recorder error:", error);
        setError(error.message || "Recording error");
      });

      audioRecorderRef.current.onAudioReady(
        {
          sampleRate: actualSampleRate,
          bufferLength: CONFIG.HOP_SIZE,
          channelCount: 1,
        },
        (event) => {
          if (event.buffer && event.numFrames > 0) {
            const channelData = event.buffer.getChannelData(0);
            if (channelData?.length > 0) {
              processAudioBuffer(channelData, actualSampleRate);
            }
          }
        }
      );

      audioRecorderRef.current.start();
      setIsRecording(true);
    } catch (err: any) {
      console.error("[ChordTimeline] Start error:", err);
      setError(err.message || "Failed to start");
      isStartedRef.current = false;
    }
  }, [processAudioBuffer]);

  const handleStop = useCallback(async () => {
    if (!isStartedRef.current) return;

    try {
      isStartedRef.current = false;

      if (audioRecorderRef.current) {
        audioRecorderRef.current.stop();
        audioRecorderRef.current = null;
      }

      if (audioContextRef.current) {
        await audioContextRef.current.close();
        audioContextRef.current = null;
      }

      setIsRecording(false);
      setIsListening(false);
    } catch (err: any) {
      console.error("[ChordTimeline] Stop error:", err);
    }
  }, []);

  // App state handling
  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setIsInitialized(true), 1000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const shouldBeActive =
      appState === "active" && isInitialized && isScreenActive;

    if (shouldBeActive && !isStartedRef.current) {
      handleStart();
    } else if (!shouldBeActive && isStartedRef.current) {
      handleStop();
    }
  }, [appState, isInitialized, isScreenActive]);

  useEffect(() => {
    return () => {
      if (isStartedRef.current) handleStop();
    };
  }, []);

  const isLandscape = dimensions.width > dimensions.height;

  return (
    <View style={styles.container}>
      {/* Header with Status and Mode Toggle */}
      <View
        style={[
          styles.headerContainer,
          isLandscape && styles.headerContainerLandscape,
        ]}
      >
        {/* Status */}
        <View style={styles.statusSection}>
          {error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : (
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusIndicator,
                  isListening ? styles.statusActive : styles.statusInactive,
                ]}
              />
              <Text style={styles.statusText}>
                {isRecording
                  ? isListening
                    ? "Listening..."
                    : "Waiting for sound..."
                  : "Starting..."}
              </Text>
            </View>
          )}
        </View>

        {/* Mode Toggle */}
        <View style={styles.modeToggleContainer}>
          <TouchableOpacity
            style={[
              styles.modeButton,
              !voiceMode && styles.modeButtonActive,
            ]}
            onPress={() => setVoiceMode(false)}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.modeButtonText,
                !voiceMode && styles.modeButtonTextActive,
              ]}
            >
              Chords
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.modeButton,
              voiceMode && styles.modeButtonActive,
            ]}
            onPress={() => setVoiceMode(true)}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.modeButtonText,
                voiceMode && styles.modeButtonTextActive,
              ]}
            >
              Voice
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Timeline with LegendList */}
      <View
        style={[
          styles.timelineContainer,
          isLandscape && styles.timelineContainerLandscape,
          {marginBottom: 36}
        ]}
      >
        {timeline.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateText}>
              Play some notes to see them here
            </Text>
            <Text style={styles.emptyStateSubtext}>
              New notes appear at the top
            </Text>
          </View>
        ) : (
          <LegendList
            ref={listRef}
            data={timeline}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            estimatedItemSize={CONFIG.ROW_HEIGHT}
            showsVerticalScrollIndicator={true}
            contentContainerStyle={styles.listContent}
            recycleItems={true}
            maintainVisibleContentPosition
          />
        )}
      </View>

      
    </View>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  headerContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerContainerLandscape: {
    paddingVertical: 8,
  },
  statusSection: {
    flex: 1,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  statusIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusActive: {
    backgroundColor: "#4ADE80",
  },
  statusInactive: {
    backgroundColor: "#666666",
  },
  statusText: {
    color: "#888888",
    fontSize: 14,
  },
  errorText: {
    color: "#FF4444",
    fontSize: 14,
  },
  modeToggleContainer: {
    flexDirection: "row",
    backgroundColor: "#222222",
    borderRadius: 8,
    padding: 2,
  },
  modeButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  modeButtonActive: {
    backgroundColor: "#38acdd",
  },
  modeButtonText: {
    color: "#666666",
    fontSize: 13,
    fontWeight: "600",
  },
  modeButtonTextActive: {
    color: "#FFFFFF",
  },
  timelineContainer: {
    flex: 1,
    marginHorizontal: 16,
    backgroundColor: "#111111",
    borderRadius: 12,
    overflow: "hidden",
  },
  timelineContainerLandscape: {
    marginVertical: 8,
  },
  listContent: {
    padding: 12,
    paddingBottom:96
  },
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyStateText: {
    color: "#444444",
    fontSize: 16,
  },
  emptyStateSubtext: {
    color: "#333333",
    fontSize: 12,
    marginTop: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: CONFIG.ROW_HEIGHT,
    paddingVertical: 8,
    marginBottom: 6,
  },
  timeIndicator: {
    width: 36,
    marginRight: 8,
    paddingTop: 4,
  },
  timeText: {
    color: "#555555",
    fontSize: 10,
    fontWeight: "500",
  },
  notesRow: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  noteChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 56,
    gap: 6,
  },
  noteText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
  octaveText: {
    fontSize: 11,
    fontWeight: "400",
  },
  centsText: {
    fontSize: 11,
    fontWeight: "600",
  },
  confidenceText: {
    fontSize: 9,
    fontWeight: "500",
    color: "rgba(255, 255, 255, 0.6)",
    marginLeft: 2,
  },
  legendContainer: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: "#111111",
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 8,
    borderRadius: 12,
  },
  legendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 12,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 4,
  },
  legendText: {
    color: "#888888",
    fontSize: 11,
    fontWeight: "500",
  },
});

export default ChordTimeline;
