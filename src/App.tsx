import { Text, View, TouchableOpacity } from "react-native";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  useAudioRecorder,
  ExpoAudioStreamModule,
  RecordingConfig,
  AudioDataEvent,
} from "@siteed/expo-audio-studio";
import Pitchfinder from "pitchfinder";
import { TunerDisplay } from "./components/TunerDisplay";
import "../global.css";
import { frequencyToNote } from "./utils/pitchDetection";

const SAMPLE_RATE = 44100;
const BUFFER_SIZE = 2048; // Need enough samples for reliable YIN detection
const MIN_VOICE_FREQ = 60;
const MAX_VOICE_FREQ = 1500;

// Smoothing configuration
const PITCH_HISTORY_SIZE = 5; // More history for better outlier rejection
const CENTS_SMOOTHING = 0.3; // Lower = more responsive
const MAX_PITCH_JUMP = 100; // Max Hz jump between consecutive valid readings

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

export default function App() {
  const [currentNote, setCurrentNote] = useState(IDLE_NOTE);
  const [isActivelyDetecting, setIsActivelyDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Audio processing refs
  const audioBufferRef = useRef<Float32Array>(new Float32Array(BUFFER_SIZE));
  const bufferIndexRef = useRef(0);
  const detectPitchRef = useRef<ReturnType<typeof Pitchfinder.YIN> | null>(
    null
  );
  const inactivityTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Pitch smoothing refs
  const pitchHistoryRef = useRef<number[]>([]);
  const lastCentsRef = useRef<number>(0);
  const lastNoteRef = useRef<string>("-");
  const lastValidPitchRef = useRef<number>(0);

  const { startRecording, stopRecording, isRecording } = useAudioRecorder();

  useEffect(() => {
    // Initialize YIN pitch detector
    // Threshold controls confidence - higher = more strict, fewer false positives
    detectPitchRef.current = Pitchfinder.YIN({
      sampleRate: SAMPLE_RATE,
      threshold: 0.15, // Balance between sensitivity and accuracy
    });
  }, []);

  const handleStartListening = async () => {
    try {
      setError(null);
      bufferIndexRef.current = 0;

      // Request permissions
      const { status } = await ExpoAudioStreamModule.requestPermissionsAsync();
      if (status !== "granted") {
        setError("Microphone permission not granted");
        return;
      }

      const config: RecordingConfig = {
        sampleRate: SAMPLE_RATE,
        channels: 1,
        encoding: "pcm_16bit",
        interval: 30, // Get audio data every 30ms for faster response

        output: {
          primary: { enabled: false },
          compressed: { enabled: false },
        },

        onAudioStream: async (audioData: AudioDataEvent) => {
          processAudioData(audioData);
        },
      };

      await startRecording(config);
    } catch (err: any) {
      console.error("Failed to start recording:", err);
      setError(err.message || "Failed to start recording");
    }
  };

  const handleStopListening = async () => {
    try {
      await stopRecording();
      setIsActivelyDetecting(false);
      if (inactivityTimeoutRef.current) {
        clearTimeout(inactivityTimeoutRef.current);
      }
      bufferIndexRef.current = 0;
      pitchHistoryRef.current = [];
      lastCentsRef.current = 0;
      lastNoteRef.current = "-";
      lastValidPitchRef.current = 0;
    } catch (err: any) {
      console.error("Error stopping recording:", err);
      setError(err.message || "Error stopping recording");
    }
  };

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

  // Exponential smoothing for cents to reduce jitter while staying responsive
  const smoothCents = useCallback(
    (newCents: number, currentNote: string): number => {
      // Reset smoothing when note changes for immediate response
      if (currentNote !== lastNoteRef.current) {
        lastNoteRef.current = currentNote;
        lastCentsRef.current = newCents;
        return newCents;
      }

      // Apply exponential smoothing
      const smoothed =
        lastCentsRef.current * CENTS_SMOOTHING +
        newCents * (1 - CENTS_SMOOTHING);
      lastCentsRef.current = smoothed;
      return Math.round(smoothed);
    },
    []
  );

  function processAudioData(event: AudioDataEvent) {
    if (!detectPitchRef.current || !event.data) return;

    try {
      // Decode base64 PCM data to samples
      const binaryString = atob(event.data as string);
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

      // Use fresh buffer instead of rolling buffer for more responsive detection
      // Copy the most recent samples directly
      const samplesToUse = Math.min(samples.length, BUFFER_SIZE);
      if (samplesToUse >= BUFFER_SIZE) {
        // We have enough samples, use them directly
        audioBufferRef.current.set(
          samples.subarray(samples.length - BUFFER_SIZE)
        );
      } else {
        // Shift existing buffer and append new samples
        audioBufferRef.current.copyWithin(0, samplesToUse);
        audioBufferRef.current.set(samples, BUFFER_SIZE - samplesToUse);
      }

      // Calculate RMS to check if there's enough signal
      let sumSquares = 0;
      for (let i = 0; i < audioBufferRef.current.length; i++) {
        sumSquares += audioBufferRef.current[i] * audioBufferRef.current[i];
      }
      const rms = Math.sqrt(sumSquares / audioBufferRef.current.length);

      // Helper to hide indicator after inactivity
      const scheduleInactivity = () => {
        if (inactivityTimeoutRef.current) {
          clearTimeout(inactivityTimeoutRef.current);
        }
        inactivityTimeoutRef.current = setTimeout(() => {
          setIsActivelyDetecting(false);
          pitchHistoryRef.current = []; // Clear history on inactivity
          lastValidPitchRef.current = 0; // Reset so next note can start fresh
        }, 150); // Timeout for inactivity
      };

      // RMS threshold - based on logs, good signals have RMS > 0.1
      // Bad detections (17kHz+) happen when RMS drops below 0.08
      if (rms < 0.1) {
        scheduleInactivity();
        return;
      }

      // Run YIN pitch detection
      const detectedPitch = detectPitchRef.current(audioBufferRef.current);

      // Check if pitch is valid (within human voice range)
      const isInVoiceRange =
        detectedPitch &&
        detectedPitch >= MIN_VOICE_FREQ &&
        detectedPitch <= MAX_VOICE_FREQ;

      if (!isInVoiceRange) {
        scheduleInactivity();
        return;
      }

      // Reject sudden large jumps (likely false detections)
      // But allow jumps if we don't have a recent valid pitch
      const hasRecentPitch = lastValidPitchRef.current > 0;
      const pitchJump = hasRecentPitch
        ? Math.abs(detectedPitch - lastValidPitchRef.current)
        : 0;

      // If pitch jumped too much, it's likely noise - skip this reading
      // But allow it if it's been a while (history is empty or small)
      if (
        hasRecentPitch &&
        pitchJump > MAX_PITCH_JUMP &&
        pitchHistoryRef.current.length >= 2
      ) {
        // Don't schedule inactivity - just skip this bad reading
        return;
      }

      // Valid pitch detected - show indicator and update note
      if (inactivityTimeoutRef.current) {
        clearTimeout(inactivityTimeoutRef.current);
      }
      setIsActivelyDetecting(true);

      // Update last valid pitch
      lastValidPitchRef.current = detectedPitch;

      // Add to pitch history for median filtering
      pitchHistoryRef.current.push(detectedPitch);
      if (pitchHistoryRef.current.length > PITCH_HISTORY_SIZE) {
        pitchHistoryRef.current.shift();
      }

      // Use median pitch to filter out any remaining outliers
      const medianPitch = getMedianPitch(pitchHistoryRef.current);

      const noteInfo = frequencyToNote(medianPitch);

      // Apply cents smoothing for stable display without losing responsiveness
      const smoothedCents = smoothCents(noteInfo.cents, noteInfo.noteName);

      setCurrentNote({
        ...noteInfo,
        cents: smoothedCents,
      });
    } catch (err) {
      console.error("Error processing audio:", err);
    }
  }

  return (
    <View className="flex-1 items-center justify-center bg-black">
      <Text className="text-white text-2xl font-bold">Vocal Tuner</Text>

      <View className="items-center mb-5 w-full ">
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
        <Text className="text-  red-500 text-lg font-semibold">{error}</Text>
      )}

      <Text className="text-gray-400 text-lg font-semibold">
        {isRecording
          ? "Sing a note to see the pitch detection"
          : "Tap Start to begin"}
      </Text>
    </View>
  );
}
