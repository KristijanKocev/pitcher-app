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

  // Larger buffer for low frequency detection
  // For 82Hz (low E), we need at least 16000/82 * 3 = ~585 samples
  // Using 4096 gives us plenty of headroom for accurate low-freq detection
  BUFFER_SIZE: 4096,

  // Frequency range (guitar: E2=82Hz to E6=1319Hz)
  MIN_FREQUENCY: 60,
  MAX_FREQUENCY: 1500,

  // Detection thresholds
  // Higher threshold = more strict, fewer false positives
  // The 6400Hz readings suggest we need to be more strict
  YIN_THRESHOLD: 0.2,

  // Minimum RMS threshold for audio detection
  // Very low since the mic signal is weak
  MIN_RMS_THRESHOLD: 0.001,

  // Audio input gain multiplier to boost weak microphone signal
  INPUT_GAIN: 10.0,

  // Timing
  INACTIVITY_TIMEOUT_MS: 3000,

  // Logging
  LOG_ENABLED: __DEV__,
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

// ============================================================================
// COMPONENT
// ============================================================================

export function AudioApiTuner() {
  // ================================================================
  // STATE
  // ================================================================

  const [currentPitch, setCurrentPitch] = useState<StabilizedPitch>(IDLE_STATE);
  const [isRecording, setIsRecording] = useState(false);
  const [isActive, setIsActive] = useState(false);
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

  // Ring buffer for accumulating samples
  const audioBufferRef = useRef<Float32Array>(
    new Float32Array(CONFIG.BUFFER_SIZE)
  );
  const bufferWriteIndexRef = useRef(0);

  // Octave stabilization: track recent frequencies to detect octave jumps
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
    historySize: 3, // Larger history for more stable readings
    config: {
      MIN_CONFIDENCE: 0.2, // Lower confidence threshold for quieter sounds
      FRAMES_TO_CHANGE_NOTE: 3,
      FRAMES_TO_CHANGE_NOTE_WHILE_TUNING: 5,
      TUNED_THRESHOLD_CENTS: 5,
      UNTUNED_THRESHOLD_CENTS: 10,
      // Longer ghost duration so display doesn't fade out too quickly
      GHOST_DURATION_MS: 3000,
      GHOST_FADE_START_MS: 1000,
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

      frameCountRef.current++;

      // Log incoming buffer info periodically
      if (CONFIG.LOG_ENABLED && frameCountRef.current % 120 === 0) {
        console.log("[AudioApiTuner] Buffer info:", {
          incomingSamples: samples.length,
          sampleRate,
          configSampleRate: CONFIG.SAMPLE_RATE,
        });
      }

      try {
        // SIMPLIFIED APPROACH: Use incoming samples directly for pitch detection
        // instead of ring buffer, since we're getting consistent buffer sizes
        // This avoids potential ring buffer timing issues

        // Use the incoming samples directly if they're large enough
        // Otherwise accumulate in ring buffer
        let analysisBuffer: Float32Array;

        if (samples.length >= CONFIG.BUFFER_SIZE) {
          // Use the last BUFFER_SIZE samples from incoming data
          analysisBuffer = samples.slice(
            samples.length - CONFIG.BUFFER_SIZE,
            samples.length
          );
        } else {
          // Accumulate in ring buffer
          const buffer = audioBufferRef.current;
          const bufferSize = CONFIG.BUFFER_SIZE;

          for (let i = 0; i < samples.length; i++) {
            buffer[bufferWriteIndexRef.current] = samples[i];
            bufferWriteIndexRef.current =
              (bufferWriteIndexRef.current + 1) % bufferSize;
          }

          // Create analysis buffer (unroll ring buffer)
          analysisBuffer = new Float32Array(bufferSize);
          for (let i = 0; i < bufferSize; i++) {
            analysisBuffer[i] =
              buffer[(bufferWriteIndexRef.current + i) % bufferSize];
          }
        }

        // Apply input gain to boost weak microphone signal
        // This helps with quiet sounds and sustaining notes
        const gain = CONFIG.INPUT_GAIN;
        for (let i = 0; i < analysisBuffer.length; i++) {
          analysisBuffer[i] = Math.max(-1, Math.min(1, analysisBuffer[i] * gain));
        }

        // Check if there's any signal (RMS check)
        let rms = 0;
        const bufLen = analysisBuffer.length;
        for (let i = 0; i < bufLen; i++) {
          rms += analysisBuffer[i] * analysisBuffer[i];
        }
        rms = Math.sqrt(rms / bufLen);

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

        // Update recent frequencies for tracking
        recentFrequenciesRef.current.push(correctedFrequency);
        if (recentFrequenciesRef.current.length > 10) {
          recentFrequenciesRef.current.shift();
        }

        // Update stable frequency using median of recent readings
        if (recentFrequenciesRef.current.length >= 3) {
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

        // Process through stabilization
        const stabilized = processReading(reading);

        // Clear inactivity timeout
        if (inactivityTimeoutRef.current) {
          clearTimeout(inactivityTimeoutRef.current);
        }

        setIsActive(true);

        // Show detected note with corrected frequency
        setCurrentPitch({
          noteName: noteInfo.noteName,
          octave: noteInfo.octave,
          cents: noteInfo.cents,
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
        setIsActive(false);
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

      // Configure audio session for recording (iOS)
      AudioManager.setAudioSessionOptions({
        iosCategory: "playAndRecord",
        iosMode: "measurement",
        iosOptions: ["defaultToSpeaker"],
      });

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
      audioBufferRef.current.fill(0);
      bufferWriteIndexRef.current = 0;
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
      const callbackOptions = {
        sampleRate: actualSampleRate,
        bufferLength: CONFIG.BUFFER_SIZE,
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
      setIsActive(false);
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

  // Start/stop based on app state and initialization
  useEffect(() => {
    if (appState === "active" && isInitialized) {
      handleStart();
    }

    return () => {
      // Cleanup when component unmounts or dependencies change
      if (isStartedRef.current) {
        handleStop();
      }
    };
  }, [appState, isInitialized]);

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
        isActive={isActive}
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
          ? isActive
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
