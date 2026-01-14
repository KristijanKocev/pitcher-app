/**
 * Smooth Tuner Component
 *
 * This is the main tuner component that integrates all Universal Tuner techniques:
 * 1. Enhanced pitch detection with confidence and jitter metrics
 * 2. Pitch stabilization with hysteresis and ghost mode
 * 3. Smooth UI-thread animations via Reanimated
 *
 * The component is optimized to minimize JS thread work and delegate
 * animations to the UI thread for 60fps performance.
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  AppState,
  AppStateStatus,
} from "react-native";
import ExpoAudioStudio from "expo-audio-studio";
import Pitchfinder from "pitchfinder";
import { AudioChunkEvent } from "expo-audio-studio/build/types";

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

/**
 * Audio configuration based on Universal Tuner analysis (S/a.java):
 *
 * Universal Tuner uses:
 * - Sample rate: 4000-196000 Hz (typically device native rate)
 * - Buffer size: 128-8192 samples
 * - Frequency range: calculated as lag = sampleRate / frequency
 *
 * For guitar tuning at 16kHz:
 * - Low E (82Hz) needs lag of 195 samples (16000/82)
 * - YIN needs ~2-3 periods, so minimum buffer ~600 samples for low E
 * - We use 1024 for good low-freq accuracy with reasonable latency (64ms)
 */
const CONFIG = {
  // Audio settings
  SAMPLE_RATE: 16000,
  // 1024 samples at 16kHz = 64ms latency
  // Good balance between response time and low-frequency accuracy
  // For 82Hz (low E), we need at least 16000/82 * 2 = 390 samples
  BUFFER_SIZE: 1024,

  // Frequency range (guitar: E2=82Hz to E6=1319Hz)
  MIN_FREQUENCY: 60, // Below E2 (82Hz) for drop tunings
  MAX_FREQUENCY: 1500, // Above E6 (1319Hz) for harmonics

  // Detection thresholds
  YIN_THRESHOLD: 0.15, // Standard YIN threshold

  // Timing
  // Ghost mode shows last pitch for 2.5s, this is fallback
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

export function SmoothTuner() {
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

  // Audio buffer (ring buffer for continuous streaming)
  const audioBufferRef = useRef<Float32Array>(
    new Float32Array(CONFIG.BUFFER_SIZE)
  );
  const bufferWriteIndexRef = useRef(0);

  // Pitch detector
  const detectPitchRef = useRef<ReturnType<typeof Pitchfinder.YIN> | null>(
    null
  );

  // Inactivity timeout
  const inactivityTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Frame counter for debugging
  const frameCountRef = useRef(0);

  // ================================================================
  // PITCH STABILIZATION HOOK
  // ================================================================

  const {
    processReading,
    reset: resetStabilization,
    getGhostState,
  } = usePitchStabilization({
    // Smaller history = faster response to new notes
    historySize: 3,
    config: {
      // Very low confidence threshold since we show raw pitch anyway
      // This is only used for ghost mode and tuned state logic
      MIN_CONFIDENCE: 0.3, // Very permissive - let pitch through
      // Faster note changes for responsive feel
      FRAMES_TO_CHANGE_NOTE: 2,
      FRAMES_TO_CHANGE_NOTE_WHILE_TUNING: 4,
      // Relaxed tuning thresholds
      TUNED_THRESHOLD_CENTS: 5,
      UNTUNED_THRESHOLD_CENTS: 10,
    },
  });

  // ================================================================
  // INITIALIZATION
  // ================================================================

  useEffect(() => {
    const setup = async () => {
      try {
        // Configure audio session
        await ExpoAudioStudio.configureAudioSession({
          category: "playAndRecord",
          mode: "default",
          options: {
            allowBluetooth: false,
            defaultToSpeaker: true,
          },
        });
        await ExpoAudioStudio.activateAudioSession();

        // Initialize YIN pitch detector
        detectPitchRef.current = Pitchfinder.YIN({
          sampleRate: CONFIG.SAMPLE_RATE,
          threshold: CONFIG.YIN_THRESHOLD,
        });

        // Enable chunk listening
        ExpoAudioStudio.setListenToChunks(true);

        if (CONFIG.LOG_ENABLED) {
          console.log("[SmoothTuner] Initialized");
        }
        setTimeout(() => {
          setIsInitialized(true);
        }, 1000);
      } catch (err) {
        console.error("[SmoothTuner] Setup error:", err);
        setError("Failed to initialize audio");
      }
    };

    setup();

    return () => {
      ExpoAudioStudio.removeAllListeners("onAudioChunk");
      ExpoAudioStudio.setListenToChunks(false);
    };
  }, []);

  // ================================================================
  // GHOST MODE UPDATE
  // ================================================================

  // Periodically check ghost state when inactive
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
        // Ghost expired
        setCurrentPitch(IDLE_STATE);
        setIsActive(false);
      }
    }, 50); // Check every 50ms

    return () => clearInterval(ghostInterval);
  }, [isRecording, currentPitch.isGhost, getGhostState]);

  // ================================================================
  // AUDIO PROCESSING
  // ================================================================

  const processAudioChunk = useCallback(
    (event: AudioChunkEvent) => {
      if (!detectPitchRef.current || !event.base64) {
        return;
      }

      frameCountRef.current++;

      try {
        // ============================================================
        // STEP 1: Decode base64 PCM data
        // ============================================================
        const binaryString = atob(event.base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // Convert to 16-bit PCM and normalize
        const int16Samples = new Int16Array(bytes.buffer);
        const samples = new Float32Array(int16Samples.length);
        for (let i = 0; i < int16Samples.length; i++) {
          samples[i] = int16Samples[i] / 32768.0;
        }

        // ============================================================
        // STEP 2: Fill ring buffer
        // ============================================================
        const buffer = audioBufferRef.current;
        const bufferSize = CONFIG.BUFFER_SIZE;

        for (let i = 0; i < samples.length; i++) {
          buffer[bufferWriteIndexRef.current] = samples[i];
          bufferWriteIndexRef.current =
            (bufferWriteIndexRef.current + 1) % bufferSize;
        }

        // Create analysis buffer (unroll ring buffer)
        const analysisBuffer = new Float32Array(bufferSize);
        for (let i = 0; i < bufferSize; i++) {
          analysisBuffer[i] =
            buffer[(bufferWriteIndexRef.current + i) % bufferSize];
        }

        // ============================================================
        // STEP 3: Run pitch detection
        // ============================================================
        // The pitch detector (YIN) returns null if it can't find a valid pitch
        const rawFrequency = detectPitchRef.current(analysisBuffer);

        // ============================================================
        // STEP 4: Enhance with confidence and jitter metrics
        // ============================================================
        const enhanced = enhancePitchfinderResult(
          rawFrequency,
          analysisBuffer,
          CONFIG.SAMPLE_RATE
        );

        // ============================================================
        // STEP 5: Validate frequency range
        // ============================================================
        if (
          enhanced.frequency === null ||
          enhanced.frequency < CONFIG.MIN_FREQUENCY ||
          enhanced.frequency > CONFIG.MAX_FREQUENCY
        ) {
          const stabilized = processReading(null);
          // Always update display (ghost mode will show last valid pitch)
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
        // STEP 6: Convert to note info
        // ============================================================
        const noteInfo = frequencyToNoteInfo(enhanced.frequency);

        // ============================================================
        // STEP 7: Create pitch reading
        // ============================================================
        const reading: PitchReading = {
          frequency: enhanced.frequency,
          semitones: noteInfo.midiNote,
          cents: noteInfo.cents,
          noteName: noteInfo.noteName,
          octave: noteInfo.octave,
          confidence: enhanced.confidence,
          jitter: enhanced.jitter,
          timestamp: Date.now(),
        };

        // ============================================================
        // STEP 8: Process through stabilization (for tuned state logic)
        // ============================================================
        const stabilized = processReading(reading);

        // ============================================================
        // STEP 9: Update state
        // ============================================================
        // KEY INSIGHT from Universal Tuner (MainActivityFragment.java line 280-283):
        // When valid pitch detected, IMMEDIATELY update display with raw pitch!
        // Ghost mode is disabled, display shows current detection.
        // The "stable note" is only used for string detection logic.

        // Clear inactivity timeout
        if (inactivityTimeoutRef.current) {
          clearTimeout(inactivityTimeoutRef.current);
        }

        setIsActive(true);

        // Show RAW detected note immediately (like Universal Tuner)
        // Only use stabilized for tuned state and ghost mode
        setCurrentPitch({
          // Use RAW note for immediate display response
          noteName: noteInfo.noteName,
          octave: noteInfo.octave,
          cents: noteInfo.cents,
          frequency: enhanced.frequency,
          // Use stabilized for tuned state (requires hysteresis)
          isTuned: stabilized.isTuned,
          // Never ghost when we have valid pitch
          isGhost: false,
          ghostOpacity: 1,
          confidence: enhanced.confidence,
        });

        if (CONFIG.LOG_ENABLED && frameCountRef.current % 10 === 0) {
          console.log("[SmoothTuner] Frame", frameCountRef.current, {
            freq: enhanced.frequency.toFixed(1),
            note: `${noteInfo.noteName}${noteInfo.octave}`,
            cents: noteInfo.cents,
            conf: enhanced.confidence.toFixed(2),
            jitter: enhanced.jitter.toFixed(2),
            tuned: stabilized.isTuned,
          });
        }
      } catch (err) {
        console.error("[SmoothTuner] Processing error:", err);
      }
    },
    [processReading]
  );

  // ================================================================
  // CONTROL HANDLERS
  // ================================================================

  const handleStart = async () => {
    try {
      setError(null);
      frameCountRef.current = 0;

      // Request permissions
      const permission = await ExpoAudioStudio.requestMicrophonePermission();
      if (!permission.granted) {
        setError("Microphone permission required");
        return;
      }

      // Reset state
      resetStabilization();
      audioBufferRef.current.fill(0);
      bufferWriteIndexRef.current = 0;
      setCurrentPitch(IDLE_STATE);

      // Add listener
      ExpoAudioStudio.addListener("onAudioChunk", processAudioChunk);

      // Start recording
      const path = ExpoAudioStudio.startRecording();
      if (!path || path.includes("error") || path.includes("Error")) {
        setError("Failed to start recording");
        return;
      }

      setIsRecording(true);

      if (CONFIG.LOG_ENABLED) {
        console.log("[SmoothTuner] Started recording:", path);
      }
    } catch (err: any) {
      console.error("[SmoothTuner] Start error:", err);
      setError(err.message || "Failed to start");
    }
  };

  const handleStop = async () => {
    try {
      // Stop recording
      ExpoAudioStudio.stopRecording();

      // Clean up
      ExpoAudioStudio.removeAllListeners("onAudioChunk");
      await ExpoAudioStudio.deactivateAudioSession();

      if (inactivityTimeoutRef.current) {
        clearTimeout(inactivityTimeoutRef.current);
      }

      // Reset state
      setIsRecording(false);
      setIsActive(false);
      setCurrentPitch(IDLE_STATE);
      resetStabilization();

      if (CONFIG.LOG_ENABLED) {
        console.log("[SmoothTuner] Stopped");
      }
    } catch (err: any) {
      console.error("[SmoothTuner] Stop error:", err);
      setError(err.message || "Failed to stop");
    }
  };

  useEffect(() => {
    const handleAppStateChange = async (nextAppState: AppStateStatus) => {
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

  useEffect(() => {
    if (appState === "active") {
      if (isInitialized) {
        handleStart();
      }
    }
    return () => {
      handleStop();
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
  button: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 30,
    marginTop: 20,
  },
  startButton: {
    backgroundColor: "#00AA55",
  },
  stopButton: {
    backgroundColor: "#DD3333",
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 18,
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

export default SmoothTuner;
