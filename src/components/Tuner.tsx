import { Text, View, TouchableOpacity } from "react-native";
import { useState, useRef, useEffect, useCallback } from "react";
import ExpoAudioStudio from "expo-audio-studio";
import Pitchfinder from "pitchfinder";
import { TunerDisplay } from "./TunerDisplay";
import { frequencyToNote } from "../utils/pitchDetection";
import { AudioChunkEvent } from "expo-audio-studio/build/types";

// ============================================================================
// CONFIGURATION
// ============================================================================
const SAMPLE_RATE = 16000; // Library uses 16kHz sample rate
const BUFFER_SIZE = 1024; // Samples needed for YIN detection at 16kHz
const MIN_VOICE_FREQ = 60; // Hz - lowest expected vocal frequency
const MAX_VOICE_FREQ = 1500; // Hz - highest expected vocal frequency
const RMS_THRESHOLD = 0.05; // Minimum signal level to process
const YIN_THRESHOLD = 0.15; // YIN confidence threshold (0-1, higher = stricter)

// Smoothing configuration
const PITCH_HISTORY_SIZE = 5; // Number of readings for median filter
const CENTS_SMOOTHING = 0.3; // Exponential smoothing factor (0-1, lower = more responsive)
const MAX_PITCH_JUMP = 100; // Max Hz jump between consecutive readings

// Timing
const INACTIVITY_TIMEOUT_MS = 300; // Hide indicator after this many ms of silence
const HISTORY_RESET_MS = 1000; // Reset pitch history after this many ms of silence

// ============================================================================
// LOGGING CONFIGURATION
// ============================================================================
const LOG_CHUNK_STATS = true; // Log chunk size and timing
const LOG_RMS = true; // Log RMS values
const LOG_PITCH_DETECTION = true; // Log pitch detection results
const LOG_FILTERING = true; // Log filtering decisions
const LOG_NOTE_CHANGES = true; // Log when note changes

let chunkCount = 0;

// ============================================================================
// COMPONENT
// ============================================================================
const IDLE_NOTE = {
  noteName: "-",
  octave: 0,
  cents: 0,
  frequency: "0",
  prevNote: "-",
  prevOctave: 0,
  nextNote: "-",
  nextOctave: 0,
};

export function Tuner() {
  const [currentNote, setCurrentNote] = useState(IDLE_NOTE);
  const [isActivelyDetecting, setIsActivelyDetecting] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Audio processing refs
  const audioBufferRef = useRef<Float32Array>(new Float32Array(BUFFER_SIZE));
  const bufferFillRef = useRef(0); // Track how much of buffer is filled
  const detectPitchRef = useRef<ReturnType<typeof Pitchfinder.YIN> | null>(
    null
  );
  const inactivityTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const historyResetTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Pitch smoothing refs
  const pitchHistoryRef = useRef<number[]>([]);
  const lastCentsRef = useRef<number>(0);
  const lastNoteRef = useRef<string>("-");
  const lastValidPitchRef = useRef<number>(0);

  useEffect(() => {
    const audioSessionSetup = async () => {
      await ExpoAudioStudio.configureAudioSession({
        category: "playAndRecord",
        mode: "default", // Best for pitch detection
        options: {
          allowBluetooth: false,
          defaultToSpeaker: true,
        },
      });
      await ExpoAudioStudio.activateAudioSession();
    };

    audioSessionSetup();

    // Initialize YIN pitch detector
    detectPitchRef.current = Pitchfinder.YIN({
      sampleRate: SAMPLE_RATE,
      threshold: YIN_THRESHOLD,
    });
    const chunkListeningEnabled = ExpoAudioStudio.setListenToChunks(true);
    console.log("[Tuner] Chunk listening enabled:", chunkListeningEnabled);
  }, []);

  // Median filter to remove outliers from pitch history
  const getMedianPitch = useCallback((pitches: number[]): number => {
    if (pitches.length === 0) return 0;
    if (pitches.length === 1) return pitches[0];

    const sorted = [...pitches].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }, []);

  // Exponential smoothing for cents
  const smoothCents = useCallback(
    (newCents: number, currentNoteName: string): number => {
      if (currentNoteName !== lastNoteRef.current) {
        lastNoteRef.current = currentNoteName;
        lastCentsRef.current = newCents;
        return newCents;
      }

      const smoothed =
        lastCentsRef.current * CENTS_SMOOTHING +
        newCents * (1 - CENTS_SMOOTHING);
      lastCentsRef.current = smoothed;
      return Math.round(smoothed);
    },
    []
  );
  const processAudioChunk = useCallback(
    (event: AudioChunkEvent) => {
      console.log("Chunk received!", event.base64?.length);

      if (!detectPitchRef.current || !event.base64) {
        console.log("Chunk", "⚠️ No detector or no data");
        return;
      }

      chunkCount++;
      const chunkStartTime = Date.now();

      try {
        // ====================================================================
        // STEP 1: Decode base64 PCM data
        // ====================================================================
        const binaryString = atob(event.base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // Convert to 16-bit PCM and normalize to -1.0 to 1.0
        const int16Samples = new Int16Array(bytes.buffer);
        const samples = new Float32Array(int16Samples.length);
        for (let i = 0; i < int16Samples.length; i++) {
          samples[i] = int16Samples[i] / 32768.0;
        }

        if (LOG_CHUNK_STATS) {
          console.log("Chunk", `#${chunkCount} received`, {
            base64Length: event.base64.length,
            samplesCount: samples.length,
            durationMs: (samples.length / SAMPLE_RATE) * 1000,
          });
        }

        // ====================================================================
        // STEP 2: Fill the audio buffer
        // ====================================================================
        const samplesToUse = Math.min(samples.length, BUFFER_SIZE);
        if (samplesToUse >= BUFFER_SIZE) {
          // We have enough samples, use them directly
          audioBufferRef.current.set(
            samples.subarray(samples.length - BUFFER_SIZE)
          );
          bufferFillRef.current = BUFFER_SIZE;
        } else {
          // Shift existing buffer and append new samples
          audioBufferRef.current.copyWithin(0, samplesToUse);
          audioBufferRef.current.set(samples, BUFFER_SIZE - samplesToUse);
          bufferFillRef.current = Math.min(
            bufferFillRef.current + samplesToUse,
            BUFFER_SIZE
          );
        }

        // ====================================================================
        // STEP 3: Calculate RMS (Root Mean Square) for signal level
        // ====================================================================
        let sumSquares = 0;
        let maxSample = 0;
        let minSample = 0;
        for (let i = 0; i < audioBufferRef.current.length; i++) {
          const sample = audioBufferRef.current[i];
          sumSquares += sample * sample;
          if (sample > maxSample) maxSample = sample;
          if (sample < minSample) minSample = sample;
        }
        const rms = Math.sqrt(sumSquares / audioBufferRef.current.length);
        const peakToPeak = maxSample - minSample;

        if (LOG_RMS) {
          console.log("RMS", `Signal level`, {
            rms: rms.toFixed(4),
            threshold: RMS_THRESHOLD,
            peakToPeak: peakToPeak.toFixed(4),
            maxSample: maxSample.toFixed(4),
            minSample: minSample.toFixed(4),
            passesThreshold: rms >= RMS_THRESHOLD,
          });
        }

        // ====================================================================
        // STEP 4: Check if signal is strong enough
        // ====================================================================
        const scheduleInactivity = (reason: string) => {
          if (LOG_FILTERING) {
            console.log("Filter", `⏸️ Scheduling inactivity: ${reason}`);
          }

          if (inactivityTimeoutRef.current) {
            clearTimeout(inactivityTimeoutRef.current);
          }
          inactivityTimeoutRef.current = setTimeout(() => {
            console.log("Timeout", "⏹️ Inactivity timeout - hiding indicator");
            setIsActivelyDetecting(false);
          }, INACTIVITY_TIMEOUT_MS);

          // Reset pitch history after longer silence
          if (historyResetTimeoutRef.current) {
            clearTimeout(historyResetTimeoutRef.current);
          }
          historyResetTimeoutRef.current = setTimeout(() => {
            console.log(
              "Timeout",
              "🗑️ History reset timeout - clearing pitch history"
            );
            pitchHistoryRef.current = [];
            lastValidPitchRef.current = 0;
          }, HISTORY_RESET_MS);
        };

        if (rms < RMS_THRESHOLD) {
          scheduleInactivity(`RMS ${rms.toFixed(4)} < ${RMS_THRESHOLD}`);
          return;
        }

        // ====================================================================
        // STEP 5: Run YIN pitch detection
        // ====================================================================
        const detectedPitch = detectPitchRef.current(audioBufferRef.current);

        if (LOG_PITCH_DETECTION) {
          console.log("YIN", `Pitch detection result`, {
            detectedPitch: detectedPitch ? detectedPitch.toFixed(2) : null,
            isNull: detectedPitch === null,
          });
        }

        // ====================================================================
        // STEP 6: Validate pitch is in voice range
        // ====================================================================
        const isInVoiceRange =
          detectedPitch &&
          detectedPitch >= MIN_VOICE_FREQ &&
          detectedPitch <= MAX_VOICE_FREQ;

        if (!isInVoiceRange) {
          if (LOG_FILTERING) {
            console.log("Filter", `❌ Out of voice range`, {
              pitch: detectedPitch,
              min: MIN_VOICE_FREQ,
              max: MAX_VOICE_FREQ,
            });
          }
          scheduleInactivity(
            `Pitch ${
              detectedPitch?.toFixed(0) ?? "null"
            } out of range [${MIN_VOICE_FREQ}-${MAX_VOICE_FREQ}]`
          );
          return;
        }

        // ====================================================================
        // STEP 7: Reject sudden large jumps (likely false detections)
        // ====================================================================
        const hasRecentPitch = lastValidPitchRef.current > 0;
        const pitchJump = hasRecentPitch
          ? Math.abs(detectedPitch - lastValidPitchRef.current)
          : 0;

        if (
          hasRecentPitch &&
          pitchJump > MAX_PITCH_JUMP &&
          pitchHistoryRef.current.length >= 2
        ) {
          if (LOG_FILTERING) {
            console.log("Filter", `🦘 Rejected pitch jump`, {
              current: detectedPitch.toFixed(2),
              previous: lastValidPitchRef.current.toFixed(2),
              jump: pitchJump.toFixed(2),
              maxAllowed: MAX_PITCH_JUMP,
            });
          }
          return;
        }

        // ====================================================================
        // STEP 8: Valid pitch! Process it
        // ====================================================================
        // Clear inactivity timeouts
        if (inactivityTimeoutRef.current) {
          clearTimeout(inactivityTimeoutRef.current);
        }
        if (historyResetTimeoutRef.current) {
          clearTimeout(historyResetTimeoutRef.current);
        }
        setIsActivelyDetecting(true);

        // Update last valid pitch
        lastValidPitchRef.current = detectedPitch;

        // Add to pitch history for median filtering
        pitchHistoryRef.current.push(detectedPitch);
        if (pitchHistoryRef.current.length > PITCH_HISTORY_SIZE) {
          pitchHistoryRef.current.shift();
        }

        // ====================================================================
        // STEP 9: Apply median filter
        // ====================================================================
        const medianPitch = getMedianPitch(pitchHistoryRef.current);

        if (LOG_FILTERING) {
          console.log("Median", `Pitch smoothing`, {
            raw: detectedPitch.toFixed(2),
            history: pitchHistoryRef.current.map((p) => p.toFixed(1)),
            median: medianPitch.toFixed(2),
          });
        }

        // ====================================================================
        // STEP 10: Convert to note
        // ====================================================================
        const noteInfo = frequencyToNote(medianPitch);
        const smoothedCents = smoothCents(noteInfo.cents, noteInfo.noteName);

        const previousNote = currentNote;
        const noteChanged =
          noteInfo.noteName !== previousNote.noteName ||
          noteInfo.octave !== previousNote.octave;

        if (LOG_NOTE_CHANGES && noteChanged) {
          console.log("Note", `🎵 Note changed!`, {
            from: `${previousNote.noteName}${previousNote.octave}`,
            to: `${noteInfo.noteName}${noteInfo.octave}`,
            frequency: medianPitch.toFixed(2),
            rawCents: noteInfo.cents,
            smoothedCents: smoothedCents,
          });
        }

        // ====================================================================
        // STEP 11: Update state
        // ====================================================================
        // Update shared value for smooth UI thread animation

        setCurrentNote({
          ...noteInfo,
          cents: smoothedCents,
        });

        // Log processing time
        const processingTime = Date.now() - chunkStartTime;
        if (LOG_CHUNK_STATS && processingTime > 10) {
          console.log("Perf", `⚠️ Slow processing: ${processingTime}ms`);
        }
      } catch (err) {
        console.error("[Tuner:Error] Processing failed:", err);
      }
    },
    [getMedianPitch, smoothCents, currentNote]
  );
  const handleStartListening = async () => {
    try {
      setError(null);
      chunkCount = 0;

      // Request permissions
      const permission = await ExpoAudioStudio.requestMicrophonePermission();
      if (!permission.granted) {
        setError("Microphone permission not granted");
        return;
      }
      console.log("Permission granted", permission);

      // Add listener for recording status changes (for debugging)
      ExpoAudioStudio.addListener("onRecorderStatusChange", (event) => {
        console.log("[Tuner] Recording status changed:", event.status);
      });

      ExpoAudioStudio.addListener("onAudioChunk", processAudioChunk);
      console.log("[Tuner] Audio chunk listener added");

      // Start recording and capture the result
      const recordingPath = ExpoAudioStudio.startRecording();
      console.log("[Tuner] Recording started, path:", recordingPath);

      if (
        !recordingPath ||
        recordingPath.includes("error") ||
        recordingPath.includes("Error") ||
        recordingPath.includes("Failed")
      ) {
        setError(`Failed to start recording: ${recordingPath}`);
        return;
      }

      setIsRecording(true);
    } catch (err: any) {
      console.error("[Tuner:Error] Failed to start:", err);
      setError(err.message || "Failed to start recording");
    }
  };

  const handleStopListening = async () => {
    try {
      // Stop recording
      const stoppedPath = ExpoAudioStudio.stopRecording();
      console.log("[Tuner] Recording stopped, saved to:", stoppedPath);

      // Deactivate audio session
      await ExpoAudioStudio.deactivateAudioSession();
      console.log("[Tuner] Audio session deactivated");

      // Remove listeners and disable chunk listening
      ExpoAudioStudio.removeAllListeners("onAudioChunk");
      ExpoAudioStudio.removeAllListeners("onRecorderStatusChange");
      ExpoAudioStudio.setListenToChunks(false);

      setIsRecording(false);
      setIsActivelyDetecting(false);

      if (inactivityTimeoutRef.current) {
        clearTimeout(inactivityTimeoutRef.current);
      }
      if (historyResetTimeoutRef.current) {
        clearTimeout(historyResetTimeoutRef.current);
      }

      // Reset state
      pitchHistoryRef.current = [];
      lastCentsRef.current = 0;
      lastNoteRef.current = "-";
      lastValidPitchRef.current = 0;
      bufferFillRef.current = 0;
    } catch (err: any) {
      console.error("[Tuner:Error] Failed to stop:", err);
      setError(err.message || "Error stopping recording");
    }
  };

  return (
    <View className="items-center w-full">
      <View className="items-center mb-5 w-full">
        <TunerDisplay
          cents={currentNote.cents}
          isActive={isRecording && isActivelyDetecting}
          currentNote={currentNote.noteName}
          currentOctave={currentNote.octave}
          prevNote={currentNote.prevNote}
          prevOctave={currentNote.prevOctave}
          nextNote={currentNote.nextNote}
          nextOctave={currentNote.nextOctave}
        />

        <View className="mt-5 items-center">
          <Text className="text-lg text-gray-400">
            {currentNote.frequency} Hz
          </Text>
          <Text
            className={`text-lg font-semibold ${
              Math.abs(currentNote.cents) <= 5
                ? "text-green-500"
                : "text-yellow-500"
            }`}
          >
            {currentNote.cents > 0 ? "+" : ""}
            {currentNote.cents} cents
          </Text>
        </View>
      </View>

      <TouchableOpacity
        className={`bg-green-600 px-6 py-2 rounded-full ${
          isRecording ? "bg-red-600" : ""
        }`}
        onPress={isRecording ? handleStopListening : handleStartListening}
      >
        <Text className="text-white text-lg font-semibold">
          {isRecording ? "Stop" : "Start Listening"}
        </Text>
      </TouchableOpacity>

      {error && (
        <Text className="text-red-500 text-lg font-semibold mt-2">{error}</Text>
      )}

      <Text className="text-gray-400 text-lg font-semibold mt-2">
        {isRecording
          ? "Sing a note to see the pitch detection"
          : "Tap Start to begin"}
      </Text>
    </View>
  );
}
