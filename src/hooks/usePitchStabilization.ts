/**
 * Pitch Stabilization Hooks
 *
 * These hooks implement the stability and hysteresis systems from Universal Tuner.
 * They run on the JS thread but are optimized for minimal state updates.
 *
 * Key concepts:
 * 1. Hysteresis: Require multiple consistent readings before changing note
 * 2. Ghost mode: Show last reading briefly when signal drops
 * 3. Confidence filtering: Only process high-confidence readings
 * 4. Jump rejection: Filter out sudden unrealistic pitch jumps
 */

import { useRef, useCallback, useMemo } from "react";

// ============================================================================
// CONFIGURATION (from Universal Tuner analysis)
// ============================================================================

/**
 * Stabilization configuration based on Universal Tuner analysis.
 *
 * From MainActivityFragment.java:
 * - Line 280-282: When valid pitch detected, IMMEDIATELY disable ghost and update
 * - Line 387: d3 < 0.7 means low confidence (but still show, just don't lock note)
 * - Line 289: d3 >= 0.7 to process note changes
 * - Line 399-402: 4 frames to change note, but DISPLAY updates immediately
 * - Line 318: abs > 0.03 (3 cents) || jitter > 0.005 means not tuned
 *
 * Key insight: Universal Tuner ALWAYS shows the detected pitch immediately,
 * but the "stable note" (for string detection) requires hysteresis.
 * The display shows raw pitch, stability is for logic.
 */
export const STABILIZATION_CONFIG = {
  // Hysteresis: frames needed to change the "stable" note
  // This is for logic (string detection), NOT display
  // Display should update immediately with raw pitch
  FRAMES_TO_CHANGE_NOTE: 4, // Original Universal Tuner value
  FRAMES_TO_CHANGE_NOTE_WHILE_TUNING: 12, // Original value

  // Ghost mode timing (from line 477)
  GHOST_DURATION_MS: 2500,
  GHOST_FADE_START_MS: 500,

  // Confidence thresholds (from Universal Tuner)
  // Line 387: d3 < 0.7 means reject for note change logic
  // But pitch is still SHOWN on display
  MIN_CONFIDENCE: 0.7, // Original value
  HIGH_CONFIDENCE: 0.92, // Original value

  // Jitter thresholds (from lines 318, 454)
  // Line 318: f3 > 0.005 means not tuned
  // Line 454: c2/b2 >= 0.01 means not stable
  MAX_JITTER_RATIO: 0.01,
  TUNED_JITTER_RATIO: 0.005,

  // Pitch jump - triggers state reset
  MAX_SEMITONE_JUMP: 3,

  // Tuned state thresholds (from line 318)
  // abs > 0.03 (3 cents) means not tuned
  TUNED_THRESHOLD_CENTS: 3,
  UNTUNED_THRESHOLD_CENTS: 5,

  // Tuned state hysteresis (from lines 334, 325)
  FRAMES_TO_TUNE: 4,
  FRAMES_TO_UNTUNE: 8,
};

// ============================================================================
// TYPES
// ============================================================================

export interface PitchReading {
  /** Detected frequency in Hz */
  frequency: number;
  /** Pitch in semitones from A4 (MIDI note - 69) */
  semitones: number;
  /** Cents deviation from nearest note */
  cents: number;
  /** Note name (C, C#, D, etc.) */
  noteName: string;
  /** Octave number */
  octave: number;
  /** Detection confidence (0-1) */
  confidence: number;
  /** Frequency deviation/jitter */
  jitter: number;
  /** Timestamp */
  timestamp: number;
}

export interface StabilizedPitch {
  /** Stabilized note name */
  noteName: string;
  /** Stabilized octave */
  octave: number;
  /** Smoothed cents (can still vary within note) */
  cents: number;
  /** Frequency for display */
  frequency: number;
  /** Whether this is a ghost reading */
  isGhost: boolean;
  /** Ghost opacity (1.0 = solid, 0 = invisible) */
  ghostOpacity: number;
  /** Whether currently in "tuned" state */
  isTuned: boolean;
  /** Detection confidence */
  confidence: number;
}

interface StabilizationState {
  // Current stable note
  stableNote: string;
  stableOctave: number;

  // Candidate for note change
  candidateNote: string;
  candidateOctave: number;
  candidateFrames: number;

  // Ghost mode
  lastValidReading: PitchReading | null;
  ghostStartTime: number;

  // Tuned state
  isTuned: boolean;
  tunedFrames: number;
  untunedFrames: number;

  // Pitch history for smoothing
  pitchHistory: number[];
  centsHistory: number[];

  // Last valid pitch for jump detection
  lastValidPitch: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculate semitones from frequency (A4 = 440Hz = 69)
 */
function frequencyToSemitones(frequency: number): number {
  return 12 * Math.log2(frequency / 440) + 69;
}

/**
 * Median filter for pitch values
 */
function medianFilter(values: number[]): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

// ============================================================================
// MAIN HOOK: usePitchStabilization
// ============================================================================

export interface UsePitchStabilizationOptions {
  /** History size for median filter (default: 5) */
  historySize?: number;
  /** Custom configuration overrides */
  config?: Partial<typeof STABILIZATION_CONFIG>;
}

export interface UsePitchStabilizationResult {
  /** Process a new pitch reading and get stabilized output */
  processReading: (reading: PitchReading | null) => StabilizedPitch;
  /** Reset all state */
  reset: () => void;
  /** Get current ghost state */
  getGhostState: () => { isGhost: boolean; opacity: number };
}

/**
 * Main hook for pitch stabilization.
 * Implements hysteresis, ghost mode, and confidence filtering.
 */
export function usePitchStabilization(
  options?: UsePitchStabilizationOptions
): UsePitchStabilizationResult {
  const historySize = options?.historySize ?? 5;
  const config = useMemo(
    () => ({ ...STABILIZATION_CONFIG, ...options?.config }),
    [options?.config]
  );

  // State ref to avoid re-renders on every frame
  const stateRef = useRef<StabilizationState>({
    stableNote: "-",
    stableOctave: 0,
    candidateNote: "",
    candidateOctave: 0,
    candidateFrames: 0,
    lastValidReading: null,
    ghostStartTime: 0,
    isTuned: false,
    tunedFrames: 0,
    untunedFrames: 0,
    pitchHistory: [],
    centsHistory: [],
    lastValidPitch: 0,
  });

  const reset = useCallback(() => {
    stateRef.current = {
      stableNote: "-",
      stableOctave: 0,
      candidateNote: "",
      candidateOctave: 0,
      candidateFrames: 0,
      lastValidReading: null,
      ghostStartTime: 0,
      isTuned: false,
      tunedFrames: 0,
      untunedFrames: 0,
      pitchHistory: [],
      centsHistory: [],
      lastValidPitch: 0,
    };
  }, []);

  const getGhostState = useCallback((): {
    isGhost: boolean;
    opacity: number;
  } => {
    const state = stateRef.current;
    if (!state.lastValidReading || state.ghostStartTime === 0) {
      return { isGhost: false, opacity: 0 };
    }

    const elapsed = Date.now() - state.ghostStartTime;
    if (elapsed >= config.GHOST_DURATION_MS) {
      return { isGhost: false, opacity: 0 };
    }

    // Calculate fade opacity
    let opacity = 1;
    if (elapsed > config.GHOST_FADE_START_MS) {
      const fadeProgress =
        (elapsed - config.GHOST_FADE_START_MS) /
        (config.GHOST_DURATION_MS - config.GHOST_FADE_START_MS);
      opacity = 1 - fadeProgress;
    }

    return { isGhost: true, opacity };
  }, [config]);

  const processReading = useCallback(
    (reading: PitchReading | null): StabilizedPitch => {
      const state = stateRef.current;
      const now = Date.now();

      // ================================================================
      // CASE 1: No reading (signal dropped)
      // ================================================================
      if (!reading) {
        // Start ghost mode if we have a last valid reading
        if (state.lastValidReading && state.ghostStartTime === 0) {
          state.ghostStartTime = now;
        }

        const ghostState = getGhostState();

        if (ghostState.isGhost && state.lastValidReading) {
          // Return ghost reading
          return {
            noteName: state.stableNote,
            octave: state.stableOctave,
            cents: state.lastValidReading.cents,
            frequency: state.lastValidReading.frequency,
            isGhost: true,
            ghostOpacity: ghostState.opacity,
            isTuned: false, // Never show tuned in ghost mode
            confidence: 0,
          };
        }

        // Ghost expired or no last reading
        return {
          noteName: "-",
          octave: 0,
          cents: 0,
          frequency: 0,
          isGhost: false,
          ghostOpacity: 0,
          isTuned: false,
          confidence: 0,
        };
      }

      // ================================================================
      // CASE 2: Low confidence reading
      // ================================================================
      if (reading.confidence < config.MIN_CONFIDENCE) {
        // Treat as no reading
        return processReading(null);
      }

      // ================================================================
      // CASE 3: Calculate jitter ratio (used later for tuned state)
      // NOTE: In Universal Tuner, high jitter does NOT reject readings!
      // It only affects whether the "tuned" state can be achieved.
      // ================================================================
      const jitterRatio = reading.jitter / reading.frequency;
      // We'll use this later for tuned state determination

      // ================================================================
      // CASE 4: Pitch jump detection
      // ================================================================
      // In Universal Tuner, large pitch jumps are handled differently:
      // - Small jumps (< 3 semitones): normal processing
      // - Large jumps: reset history and accept new note
      //
      // This is important for guitar tuning where:
      // - Octave errors can cause 12-semitone jumps
      // - Switching strings causes large jumps
      // - Harmonics can cause jumps
      if (state.lastValidPitch > 0) {
        const semitoneJump = Math.abs(
          frequencyToSemitones(reading.frequency) -
            frequencyToSemitones(state.lastValidPitch)
        );

        // If there's a large jump, reset history to accept the new pitch
        // This allows the tuner to respond to string changes
        if (semitoneJump > config.MAX_SEMITONE_JUMP) {
          // Reset pitch history to allow new note to be detected
          state.pitchHistory = [];
          state.centsHistory = [];
          // Reset stable note so the new note can be accepted immediately
          state.stableNote = "-";
          state.stableOctave = 0;
          state.candidateNote = "";
          state.candidateOctave = 0;
          state.candidateFrames = 0;
          state.isTuned = false;
          state.tunedFrames = 0;
          state.untunedFrames = 0;
        }
      }

      // ================================================================
      // VALID READING - Process it
      // ================================================================

      // Clear ghost mode
      state.ghostStartTime = 0;
      state.lastValidReading = reading;
      state.lastValidPitch = reading.frequency;

      // Add to history for smoothing
      state.pitchHistory.push(reading.frequency);
      state.centsHistory.push(reading.cents);
      if (state.pitchHistory.length > historySize) {
        state.pitchHistory.shift();
        state.centsHistory.shift();
      }

      // Apply median filter to cents
      const smoothedCents = Math.round(medianFilter(state.centsHistory));

      // ================================================================
      // NOTE HYSTERESIS
      // ================================================================
      const { noteName, octave } = reading;
      const isNoteChange =
        noteName !== state.stableNote || octave !== state.stableOctave;

      // IMPORTANT: If we're in idle state ("-"), immediately accept the first valid note
      // This prevents the indicator from being stuck when starting
      const isIdleState = state.stableNote === "-";

      if (isIdleState) {
        // First valid reading - accept immediately
        state.stableNote = noteName;
        state.stableOctave = octave;
        state.candidateNote = "";
        state.candidateOctave = 0;
        state.candidateFrames = 0;
      } else if (isNoteChange) {
        // Check if this is the same candidate
        if (
          noteName === state.candidateNote &&
          octave === state.candidateOctave
        ) {
          state.candidateFrames++;

          // Determine threshold based on current state
          const threshold = state.isTuned
            ? config.FRAMES_TO_CHANGE_NOTE_WHILE_TUNING
            : config.FRAMES_TO_CHANGE_NOTE;

          if (state.candidateFrames >= threshold) {
            // Accept the note change
            state.stableNote = noteName;
            state.stableOctave = octave;
            state.candidateFrames = 0;
            state.isTuned = false; // Reset tuned state on note change
            state.tunedFrames = 0;
            state.untunedFrames = 0;
          }
        } else {
          // New candidate
          state.candidateNote = noteName;
          state.candidateOctave = octave;
          state.candidateFrames = 1;
        }
      } else {
        // Same note - reset candidate
        state.candidateNote = "";
        state.candidateOctave = 0;
        state.candidateFrames = 0;
      }

      // ================================================================
      // TUNED STATE HYSTERESIS
      // ================================================================
      const absCents = Math.abs(smoothedCents);
      const isHighConfidence = reading.confidence >= config.HIGH_CONFIDENCE;
      const isLowJitter = jitterRatio <= config.TUNED_JITTER_RATIO;

      if (
        absCents <= config.TUNED_THRESHOLD_CENTS &&
        isHighConfidence &&
        isLowJitter
      ) {
        // Within tuned threshold
        state.tunedFrames++;
        state.untunedFrames = 0;

        if (state.tunedFrames >= config.FRAMES_TO_TUNE) {
          state.isTuned = true;
        }
      } else if (absCents >= config.UNTUNED_THRESHOLD_CENTS || !isLowJitter) {
        // Outside untuned threshold
        state.untunedFrames++;
        state.tunedFrames = 0;

        if (state.untunedFrames >= config.FRAMES_TO_UNTUNE) {
          state.isTuned = false;
        }
      } else {
        // In between - maintain state
        state.tunedFrames = 0;
        state.untunedFrames = 0;
      }

      return {
        noteName: state.stableNote,
        octave: state.stableOctave,
        cents: smoothedCents,
        frequency: reading.frequency,
        isGhost: false,
        ghostOpacity: 1,
        isTuned: state.isTuned,
        confidence: reading.confidence,
      };
    },
    [config, historySize, getGhostState]
  );

  return {
    processReading,
    reset,
    getGhostState,
  };
}

// ============================================================================
// HELPER HOOK: useStableNote
// ============================================================================

/**
 * Simplified hook that just provides stable note with hysteresis.
 * Use this if you don't need full stabilization features.
 */
export function useStableNote(
  detectedNote: string,
  detectedOctave: number,
  confidence: number,
  framesToChange: number = 4
): { noteName: string; octave: number } {
  const stateRef = useRef({
    stableNote: "-",
    stableOctave: 0,
    candidateNote: "",
    candidateOctave: 0,
    candidateFrames: 0,
  });

  const state = stateRef.current;

  // Low confidence - return current stable
  if (confidence < 0.7) {
    return { noteName: state.stableNote, octave: state.stableOctave };
  }

  const isChange =
    detectedNote !== state.stableNote || detectedOctave !== state.stableOctave;

  if (isChange) {
    if (
      detectedNote === state.candidateNote &&
      detectedOctave === state.candidateOctave
    ) {
      state.candidateFrames++;
      if (state.candidateFrames >= framesToChange) {
        state.stableNote = detectedNote;
        state.stableOctave = detectedOctave;
        state.candidateFrames = 0;
      }
    } else {
      state.candidateNote = detectedNote;
      state.candidateOctave = detectedOctave;
      state.candidateFrames = 1;
    }
  } else {
    state.candidateNote = "";
    state.candidateOctave = 0;
    state.candidateFrames = 0;
  }

  return { noteName: state.stableNote, octave: state.stableOctave };
}

// ============================================================================
// HELPER HOOK: useGhostPitch
// ============================================================================

/**
 * Simplified hook for ghost mode only.
 * Shows last valid reading when signal drops.
 */
export function useGhostPitch<T>(
  currentValue: T | null,
  timeout: number = 2500
): { value: T | null; isGhost: boolean; opacity: number } {
  const stateRef = useRef<{
    lastValue: T | null;
    ghostStartTime: number;
  }>({
    lastValue: null,
    ghostStartTime: 0,
  });

  const state = stateRef.current;
  const now = Date.now();

  if (currentValue !== null) {
    // Valid value - update and clear ghost
    state.lastValue = currentValue;
    state.ghostStartTime = 0;
    return { value: currentValue, isGhost: false, opacity: 1 };
  }

  // No value - check ghost
  if (state.lastValue === null) {
    return { value: null, isGhost: false, opacity: 0 };
  }

  // Start ghost if not started
  if (state.ghostStartTime === 0) {
    state.ghostStartTime = now;
  }

  const elapsed = now - state.ghostStartTime;
  if (elapsed >= timeout) {
    // Ghost expired
    state.lastValue = null;
    state.ghostStartTime = 0;
    return { value: null, isGhost: false, opacity: 0 };
  }

  // Calculate fade
  const fadeStart = timeout * 0.2; // Start fading at 20%
  let opacity = 1;
  if (elapsed > fadeStart) {
    opacity = 1 - (elapsed - fadeStart) / (timeout - fadeStart);
  }

  return { value: state.lastValue, isGhost: true, opacity };
}
