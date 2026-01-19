/**
 * Audio API Tuner Component
 *
 * A second tuner variant using react-native-audio-api library.
 * This provides an alternative implementation for comparison with SmoothTuner.
 *
 * Uses the Web Audio API style approach with AudioRecorder:
 * 1. AudioRecorder for microphone capture
 * 2. Direct buffer processing via onAudioReady callback
 * 3. Same pitch detection and stabilization as SmoothTuner
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import { View, Text, StyleSheet, AppState, AppStateStatus } from "react-native";
import {
  AudioContext,
  AudioRecorder,
  AudioManager,
  type AudioBuffer as AudioApiBuffer,
} from "react-native-audio-api";
import Pitchfinder from "pitchfinder";

import { SmoothTunerDisplay } from "./SmoothTunerDisplay";
import {
  usePitchStabilization,
  type PitchReading,
  type StabilizedPitch,
} from "../hooks/usePitchStabilization";
import {
  enhancePitchfinderResult,
  frequencyToNoteInfo,
} from "../utils/enhancedPitchDetection";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Audio settings
  // Lower sample rate = better low frequency detection
  // At 16kHz, low E (82Hz) needs lag of 195 samples (16000/82)
  // YIN needs ~2-3 periods, so we get good detection
  SAMPLE_RATE: 16000,

  // Analysis buffer size for YIN algorithm
  // For 82Hz (low E) at 16kHz, we need at least 16000/82 * 3 = ~585 samples
  // Using 2048 samples = 128ms window - enough for accurate low-freq detection
  BUFFER_SIZE: 2048,

  // Ring buffer to accumulate samples (must be >= BUFFER_SIZE)
  RING_BUFFER_SIZE: 4096,

  // How often to run pitch detection (in samples)
  // 512 samples = 32ms hop = ~31 detections/sec
  // Good balance between responsiveness and CPU usage
  HOP_SIZE: 512,

  // Frequency range (guitar: E2=82Hz to E6=1319Hz)
  MIN_FREQUENCY: 60,
  MAX_FREQUENCY: 1500,

  // Detection thresholds
  YIN_THRESHOLD: 0.2,

  // Minimum RMS threshold for audio detection
  MIN_RMS_THRESHOLD: 0.0005,

  // Audio input gain multiplier to boost weak microphone signal
  INPUT_GAIN: 15.0,

  // Timing
  INACTIVITY_TIMEOUT_MS: 3000,

  // Logging
  LOG_ENABLED: false,
};

// ============================================================================
// IDLE STATE
// ============================================================================

const IDLE_STATE: StabilizedPitch = {
  noteName: "-",
  octave: 0,
  cents: 0,
  frequency: 0,
  isGhost: false,
  ghostOpacity: 0,
  isTuned: false,
  confidence: 0,
};


  // Configure audio session for recording (iOS)
  AudioManager.setAudioSessionOptions({
    iosCategory: "playAndRecord",
    iosMode: "measurement",
    iosOptions: ["defaultToSpeaker"],
  });

// ============================================================================
// COMPONENT
// ============================================================================

interface AudioApiTunerProps {
  /** Whether the component should be actively listening (controlled by navigation focus) */
  isActive?: boolean;
}

export function AudioApiTuner({ isActive: isScreenActive = true }: AudioApiTunerProps) {
  // ================================================================
  // STATE
  // ================================================================

  const [currentPitch, setCurrentPitch] = useState<StabilizedPitch>(IDLE_STATE);
  const [isRecording, setIsRecording] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppStateStatus>("active");
  const [isInitialized, setIsInitialized] = useState(false);

  // ================================================================
  // REFS
  // ================================================================

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioRecorderRef = useRef<AudioRecorder | null>(null);
  const detectPitchRef = useRef<ReturnType<typeof Pitchfinder.YIN> | null>(
    null
  );
  const inactivityTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const frameCountRef = useRef(0);
  const isStartedRef = useRef(false);

  // Ring buffer for accumulating samples (larger for low-freq detection)
  const audioBufferRef = useRef<Float32Array>(
    new Float32Array(CONFIG.RING_BUFFER_SIZE)
  );
  const bufferWriteIndexRef = useRef(0);
  const samplesSinceLastAnalysisRef = useRef(0);

  // Reusable analysis buffer to avoid GC pressure
  const analysisBufferRef = useRef<Float32Array>(
    new Float32Array(CONFIG.BUFFER_SIZE)
  );

  // Octave stabilization: track recent frequencies to detect octave jumps
  // Smaller window (5 instead of 10) for faster response to bends
  const recentFrequenciesRef = useRef<number[]>([]);
  const stableFrequencyRef = useRef<number | null>(null);

  // ================================================================
  // PITCH STABILIZATION HOOK
  // ================================================================

  const {
    processReading,
    reset: resetStabilization,
    getGhostState,
  } = usePitchStabilization({
    historySize: 1, // Minimal history for maximum responsiveness to bends
    config: {
      MIN_CONFIDENCE: 0.2, // Lower confidence threshold for quieter sounds
      FRAMES_TO_CHANGE_NOTE: 2, // Faster note changes
      FRAMES_TO_CHANGE_NOTE_WHILE_TUNING: 3, // Faster even when tuned
      TUNED_THRESHOLD_CENTS: 5,
      UNTUNED_THRESHOLD_CENTS: 10,
      // Shorter ghost duration for snappier response
      GHOST_DURATION_MS: 3000,
      GHOST_FADE_START_MS: 1500,
      // Reduce jump threshold to allow bends to register as pitch changes
      MAX_SEMITONE_JUMP: 6, // Allow larger jumps (full bend = 2-3 semitones)
    },
  });

  // ================================================================
  // AUDIO PROCESSING CALLBACK
  // ================================================================

  const processAudioBuffer = useCallback(
    (samples: Float32Array, sampleRate: number) => {
      if (!detectPitchRef.current) {
        return;
      }

      // Log incoming buffer info periodically
      if (CONFIG.LOG_ENABLED && frameCountRef.current % 120 === 0) {
        console.log("[AudioApiTuner] Buffer info:", {
          incomingSamples: samples.length,
          sampleRate,
          configSampleRate: CONFIG.SAMPLE_RATE,
        });
      }

      try {
        // Accumulate samples into ring buffer
        const ringBuffer = audioBufferRef.current;
        const ringSize = CONFIG.RING_BUFFER_SIZE;

        for (let i = 0; i < samples.length; i++) {
          ringBuffer[bufferWriteIndexRef.current] = samples[i];
          bufferWriteIndexRef.current =
            (bufferWriteIndexRef.current + 1) % ringSize;
        }

        // Track how many new samples we've received since last analysis
        samplesSinceLastAnalysisRef.current += samples.length;

        // Only run analysis every HOP_SIZE samples for responsive updates
        // This creates overlapping analysis windows
        if (samplesSinceLastAnalysisRef.current < CONFIG.HOP_SIZE) {
          return; // Wait for more samples
        }

        // Reset counter (keep remainder for timing accuracy)
        samplesSinceLastAnalysisRef.current =
          samplesSinceLastAnalysisRef.current % CONFIG.HOP_SIZE;

        frameCountRef.current++;

        // Reuse analysis buffer to avoid GC pressure
        const analysisBuffer = analysisBufferRef.current;
        const bufferSize = CONFIG.BUFFER_SIZE;
        const startIdx =
          (bufferWriteIndexRef.current - bufferSize + ringSize) % ringSize;

        // Extract from ring buffer and apply gain in single pass
        const gain = CONFIG.INPUT_GAIN;
        let rms = 0;

        for (let i = 0; i < bufferSize; i++) {
          const sample = ringBuffer[(startIdx + i) % ringSize] * gain;
          // Clamp to [-1, 1]
          const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
          analysisBuffer[i] = clamped;
          rms += clamped * clamped;
        }

        rms = Math.sqrt(rms / bufferSize);

        // Log RMS periodically for debugging
        if (CONFIG.LOG_ENABLED && frameCountRef.current % 60 === 0) {
          console.log("[AudioApiTuner] RMS level:", rms.toFixed(4));
        }

        // If signal is too quiet, treat as no pitch
        if (rms < CONFIG.MIN_RMS_THRESHOLD) {
          // Reset octave tracking for next note
          recentFrequenciesRef.current = [];
          stableFrequencyRef.current = null;

          const stabilized = processReading(null);
          setCurrentPitch(stabilized);

          if (stabilized.isGhost) {
            if (inactivityTimeoutRef.current) {
              clearTimeout(inactivityTimeoutRef.current);
              inactivityTimeoutRef.current = null;
            }
          }
          return;
        }

        // Run pitch detection using CONFIG sample rate (what we requested)
        const rawFrequency = detectPitchRef.current(analysisBuffer);

        // Log pitch detection result periodically
        if (CONFIG.LOG_ENABLED && frameCountRef.current % 60 === 0) {
          console.log("[AudioApiTuner] Pitch detection:", {
            rawFrequency,
            rms: rms.toFixed(4),
          });
        }

        // Enhance with confidence and jitter metrics
        const enhanced = enhancePitchfinderResult(
          rawFrequency,
          analysisBuffer,
          CONFIG.SAMPLE_RATE // Use config sample rate, not incoming
        );

        // Validate frequency range
        if (
          enhanced.frequency === null ||
          enhanced.frequency < CONFIG.MIN_FREQUENCY ||
          enhanced.frequency > CONFIG.MAX_FREQUENCY
        ) {
          const stabilized = processReading(null);
          setCurrentPitch(stabilized);

          if (stabilized.isGhost) {
            if (inactivityTimeoutRef.current) {
              clearTimeout(inactivityTimeoutRef.current);
              inactivityTimeoutRef.current = null;
            }
          }
          return;
        }

        // ============================================================
        // OCTAVE JUMP CORRECTION
        // ============================================================
        // Guitar strings produce strong harmonics. The YIN algorithm can
        // sometimes lock onto the 2nd harmonic (octave up) instead of
        // the fundamental. This causes jumps like 78Hz -> 156Hz -> 78Hz.
        //
        // Strategy: If we have a stable frequency and the new reading is
        // approximately 2x (octave up) or 0.5x (octave down), prefer the
        // lower frequency (fundamental).
        let correctedFrequency = enhanced.frequency;

        if (stableFrequencyRef.current !== null) {
          const ratio = enhanced.frequency / stableFrequencyRef.current;

          // Check if this is an octave jump (ratio ~2.0 or ~0.5)
          const isOctaveUp = ratio > 1.9 && ratio < 2.1;
          const isOctaveDown = ratio > 0.48 && ratio < 0.52;

          if (isOctaveUp) {
            // We jumped up an octave - correct back down to fundamental
            correctedFrequency = enhanced.frequency / 2;
            if (CONFIG.LOG_ENABLED) {
              console.log("[AudioApiTuner] Octave correction: down", {
                original: enhanced.frequency,
                corrected: correctedFrequency,
              });
            }
          } else if (isOctaveDown) {
            // We jumped down an octave - this is likely the correct fundamental
            // Keep the lower frequency
            correctedFrequency = enhanced.frequency;
          }
        }

        // Update recent frequencies for tracking (smaller window for bends)
        recentFrequenciesRef.current.push(correctedFrequency);
        if (recentFrequenciesRef.current.length > 5) {
          recentFrequenciesRef.current.shift();
        }

        // Update stable frequency using median of recent readings
        // Use smaller window (3 samples) for faster response to bends
        if (recentFrequenciesRef.current.length >= 2) {
          const sorted = [...recentFrequenciesRef.current].sort(
            (a, b) => a - b
          );
          const median = sorted[Math.floor(sorted.length / 2)];
          stableFrequencyRef.current = median;
        } else {
          stableFrequencyRef.current = correctedFrequency;
        }

        // Convert to note info using corrected frequency
        const noteInfo = frequencyToNoteInfo(correctedFrequency);

        // Create pitch reading with corrected frequency
        const reading: PitchReading = {
          frequency: correctedFrequency,
          semitones: noteInfo.midiNote,
          cents: noteInfo.cents,
          noteName: noteInfo.noteName,
          octave: noteInfo.octave,
          confidence: enhanced.confidence,
          jitter: enhanced.jitter,
          timestamp: Date.now(),
        };

        // Process through stabilization (for note name hysteresis and tuned state)
        const stabilized = processReading(reading);

        // Clear inactivity timeout
        if (inactivityTimeoutRef.current) {
          clearTimeout(inactivityTimeoutRef.current);
        }

        setIsListening(true);

        // IMPORTANT: Show RAW cents immediately for responsive bend tracking
        // Only use stabilized note name (hysteresis prevents note flickering)
        // This is how Universal Tuner works - display updates instantly,
        // but the "stable note" requires multiple consistent readings
        setCurrentPitch({
          noteName: stabilized.noteName, // Use stabilized note name
          octave: stabilized.octave, // Use stabilized octave
          cents: noteInfo.cents, // Use RAW cents for instant response
          frequency: correctedFrequency,
          isTuned: stabilized.isTuned,
          isGhost: false,
          ghostOpacity: 1,
          confidence: enhanced.confidence,
        });

        if (CONFIG.LOG_ENABLED && frameCountRef.current % 30 === 0) {
          console.log("[AudioApiTuner] Frame", frameCountRef.current, {
            freq: enhanced.frequency.toFixed(1),
            note: `${noteInfo.noteName}${noteInfo.octave}`,
            cents: noteInfo.cents,
            conf: enhanced.confidence.toFixed(2),
            rms: rms.toFixed(4),
          });
        }
      } catch (err) {
        console.error("[AudioApiTuner] Processing error:", err);
      }
    },
    [processReading]
  );

  // ================================================================
  // GHOST MODE UPDATE
  // ================================================================

  useEffect(() => {
    if (!isRecording) return;

    const ghostInterval = setInterval(() => {
      const ghostState = getGhostState();
      if (ghostState.isGhost) {
        setCurrentPitch((prev) => ({
          ...prev,
          isGhost: true,
          ghostOpacity: ghostState.opacity,
        }));
      } else if (currentPitch.isGhost) {
        setCurrentPitch(IDLE_STATE);
        setIsListening(false);
      }
    }, 50);

    return () => clearInterval(ghostInterval);
  }, [isRecording, currentPitch.isGhost, getGhostState]);

  // ================================================================
  // CONTROL HANDLERS
  // ================================================================

  const handleStart = useCallback(async () => {
    // Prevent multiple starts
    if (isStartedRef.current) {
      if (CONFIG.LOG_ENABLED) {
        console.log("[AudioApiTuner] Already started, skipping");
      }
      return;
    }

    try {
      setError(null);
      frameCountRef.current = 0;
      isStartedRef.current = true;

    

      // Activate the audio session
      const sessionActive = await AudioManager.setAudioSessionActivity(true);
      if (CONFIG.LOG_ENABLED) {
        console.log("[AudioApiTuner] Audio session active:", sessionActive);
      }

      // Request recording permissions via AudioManager
      const permissionStatus = await AudioManager.requestRecordingPermissions();
      if (CONFIG.LOG_ENABLED) {
        console.log("[AudioApiTuner] Permission status:", permissionStatus);
      }

      if (permissionStatus !== "Granted") {
        setError("Microphone permission required");
        isStartedRef.current = false;
        return;
      }

      // Reset state
      resetStabilization();
      audioBufferRef.current = new Float32Array(CONFIG.RING_BUFFER_SIZE);
      bufferWriteIndexRef.current = 0;
      samplesSinceLastAnalysisRef.current = 0;
      recentFrequenciesRef.current = [];
      stableFrequencyRef.current = null;
      setCurrentPitch(IDLE_STATE);

      // Create AudioContext
      audioContextRef.current = new AudioContext({
        sampleRate: CONFIG.SAMPLE_RATE,
      });

      const actualSampleRate = audioContextRef.current.sampleRate;

      // Initialize YIN pitch detector with the actual sample rate
      detectPitchRef.current = Pitchfinder.YIN({
        sampleRate: actualSampleRate,
        threshold: CONFIG.YIN_THRESHOLD,
      });

      // Create AudioRecorder
      audioRecorderRef.current = new AudioRecorder();

      // Set up audio callback with options
      // Use smaller buffer for more frequent callbacks = faster response
      const callbackOptions = {
        sampleRate: actualSampleRate,
        bufferLength: CONFIG.HOP_SIZE, // Small buffer = frequent callbacks
        channelCount: 1,
      };

      // Set up error handler first
      audioRecorderRef.current.onError((error) => {
        console.error("[AudioApiTuner] Recorder error:", error);
        setError(error.message || "Recording error");
      });

      const result = audioRecorderRef.current.onAudioReady(
        callbackOptions,
        (event) => {
          // Log first few callbacks for debugging
          if (CONFIG.LOG_ENABLED && frameCountRef.current < 5) {
            console.log("[AudioApiTuner] onAudioReady received:", {
              numFrames: event.numFrames,
              when: event.when,
              hasBuffer: !!event.buffer,
              bufferLength: event.buffer?.length,
              numberOfChannels: event.buffer?.numberOfChannels,
            });
          }

          // event.buffer is an AudioBuffer object
          // We need to get channel data from it
          if (event.buffer && event.numFrames > 0) {
            // Get the first channel's data
            const channelData = event.buffer.getChannelData(0);
            if (channelData && channelData.length > 0) {
              processAudioBuffer(channelData, actualSampleRate);
            }
          }
        }
      );

      if (CONFIG.LOG_ENABLED) {
        console.log("[AudioApiTuner] onAudioReady setup result:", result);
      }

      // Start recording
      const startResult = audioRecorderRef.current.start();
      if (CONFIG.LOG_ENABLED) {
        console.log("[AudioApiTuner] Recorder start result:", startResult);
        console.log(
          "[AudioApiTuner] isRecording:",
          audioRecorderRef.current.isRecording()
        );
      }

      setIsRecording(true);

      if (CONFIG.LOG_ENABLED) {
        console.log(
          "[AudioApiTuner] Started with sample rate:",
          actualSampleRate
        );
      }
    } catch (err: any) {
      console.error("[AudioApiTuner] Start error:", err);
      setError(err.message || "Failed to start");
      isStartedRef.current = false;
    }
  }, [processAudioBuffer, resetStabilization]);

  const handleStop = useCallback(async () => {
    if (!isStartedRef.current) {
      return;
    }

    try {
      isStartedRef.current = false;

      // Stop recorder
      if (audioRecorderRef.current) {
        audioRecorderRef.current.stop();
        audioRecorderRef.current = null;
      }

      // Close audio context
      if (audioContextRef.current) {
        await audioContextRef.current.close();
        audioContextRef.current = null;
      }

      if (inactivityTimeoutRef.current) {
        clearTimeout(inactivityTimeoutRef.current);
        inactivityTimeoutRef.current = null;
      }

      // Reset state
      setIsRecording(false);
      setIsListening(false);
      setCurrentPitch(IDLE_STATE);
      resetStabilization();

      if (CONFIG.LOG_ENABLED) {
        console.log("[AudioApiTuner] Stopped");
      }
    } catch (err: any) {
      console.error("[AudioApiTuner] Stop error:", err);
      setError(err.message || "Failed to stop");
    }
  }, [resetStabilization]);

  // ================================================================
  // APP STATE HANDLING
  // ================================================================

  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      setAppState(nextAppState);
    };

    const subscription = AppState.addEventListener(
      "change",
      handleAppStateChange
    );

    return () => {
      subscription.remove();
    };
  }, []);

  // Initialize on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsInitialized(true);
    }, 1000);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  // Start/stop based on app state, initialization, and screen focus
  useEffect(() => {
    const shouldBeActive = appState === "active" && isInitialized && isScreenActive;
    
    if (shouldBeActive && !isStartedRef.current) {
      handleStart();
    } else if (!shouldBeActive && isStartedRef.current) {
      handleStop();
    }
  }, [appState, isInitialized, isScreenActive]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isStartedRef.current) {
        handleStop();
      }
    };
  }, []);

  // ================================================================
  // COMPUTE NEIGHBOR NOTES
  // ================================================================

  const neighborNotes = React.useMemo(() => {
    if (currentPitch.noteName === "-") {
      return {
        prevNote: "-",
        prevOctave: 0,
        nextNote: "-",
        nextOctave: 0,
      };
    }

    const noteInfo = frequencyToNoteInfo(currentPitch.frequency || 440);
    return {
      prevNote: noteInfo.prevNote,
      prevOctave: noteInfo.prevOctave,
      nextNote: noteInfo.nextNote,
      nextOctave: noteInfo.nextOctave,
    };
  }, [currentPitch.noteName, currentPitch.frequency]);

  // ================================================================
  // RENDER
  // ================================================================

  return (
    <View style={styles.container}>
      {/* Tuner Display */}
      <SmoothTunerDisplay
        cents={currentPitch.cents}
        isActive={isListening}
        noteName={currentPitch.noteName}
        octave={currentPitch.octave}
        prevNote={neighborNotes.prevNote}
        prevOctave={neighborNotes.prevOctave}
        nextNote={neighborNotes.nextNote}
        nextOctave={neighborNotes.nextOctave}
        frequency={currentPitch.frequency}
        isGhost={currentPitch.isGhost}
        ghostOpacity={currentPitch.ghostOpacity}
        isTuned={currentPitch.isTuned}
        confidence={currentPitch.confidence}
      />

      {/* Error Display */}
      {error && <Text style={styles.errorText}>{error}</Text>}

      {/* Status Text */}
      <Text style={styles.statusText}>
        {isRecording
          ? isListening
            ? "Listening..."
            : "Waiting for sound..."
          : "Starting..."}
      </Text>

      {/* Debug Info (only in dev) */}
      {CONFIG.LOG_ENABLED && isRecording && (
        <View style={styles.debugContainer}>
          <Text style={styles.debugText}>
            Conf: {(currentPitch.confidence * 100).toFixed(0)}%
          </Text>
          <Text style={styles.debugText}>
            Ghost: {currentPitch.isGhost ? "Yes" : "No"} | Tuned:{" "}
            {currentPitch.isTuned ? "Yes" : "No"}
          </Text>
        </View>
      )}
    </View>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    width: "100%",
  },
  labelContainer: {
    backgroundColor: "#2A2A2A",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginBottom: 10,
  },
  labelText: {
    color: "#38acdd",
    fontSize: 12,
    fontWeight: "600",
  },
  errorText: {
    color: "#FF4444",
    fontSize: 14,
    marginTop: 10,
  },
  statusText: {
    color: "#888888",
    fontSize: 14,
    marginTop: 10,
  },
  debugContainer: {
    marginTop: 20,
    padding: 10,
    backgroundColor: "#222222",
    borderRadius: 8,
    alignItems: "center",
  },
  debugText: {
    color: "#666666",
    fontSize: 12,
    fontFamily: "monospace",
  },
});

export default AudioApiTuner;
