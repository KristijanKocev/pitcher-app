/**
 * ChordDetection Component
 *
 * Real-time chord detection pipeline:
 * 1. Audio capture via react-native-audio-api
 * 2. Nitro C++ DSP module for chromagram / mel spectrogram
 * 3. CoreML BasicPitch for ML-based note detection
 * 4. JS chord classification via chroma template matching
 */

import React, { useState, useRef, useEffect, useCallback, memo } from "react";
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  AppState,
  AppStateStatus,
} from "react-native";
import {
  AudioContext,
  AudioRecorder,
  AudioManager,
} from "react-native-audio-api";
import { LegendList, LegendListRef } from "@legendapp/list";

import {
  classifyChromaWithBass,
  classifyChromaTopN,
  classifyFrame,
  ChordSmoother,
  ChordResult,
} from "../utils/chordClassification";
import { ChordSequenceContext } from "../utils/chordSequenceContext";
import { ChordDSP } from "chord-dsp";
import * as ChordModelInference from "../../modules/chord-model-inference-module";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  SAMPLE_RATE: 16000,
  BUFFER_SIZE: 4096,
  RING_BUFFER_SIZE: 32000, // ~2 seconds at 16kHz
  HOP_SIZE: 1024,
  MIN_RMS_THRESHOLD: 0.005,
  INPUT_GAIN: 10.0,
  FFT_SIZE: 2048,
  MIN_FREQUENCY: 60,
  MAX_FREQUENCY: 2000,
  MAX_TIMELINE_ENTRIES: 100,
  ROW_HEIGHT: 52,
};

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

interface ChordTimelineEntry {
  id: number;
  timestamp: number;
  chord: string;
  root: string;
  quality: string;
  confidence: number;
}

// ============================================================================
// MEMOIZED COMPONENTS
// ============================================================================

interface TimelineRowProps {
  item: ChordTimelineEntry;
}

const TimelineRow = memo(function TimelineRow({ item }: TimelineRowProps) {
  const timeAgo = formatTimeAgo(item.timestamp);
  const color = NOTE_COLORS[item.root] || "#888888";

  return (
    <View style={styles.row}>
      <View style={styles.timeIndicator}>
        <Text style={styles.timeText}>{timeAgo}</Text>
      </View>
      <View style={[styles.chordChip, { backgroundColor: color }]}>
        <Text style={styles.chordChipText}>{item.chord}</Text>
      </View>
      <View style={styles.confidenceBar}>
        <View
          style={[
            styles.confidenceBarFill,
            {
              width: `${Math.round(item.confidence * 100)}%`,
              backgroundColor: color,
            },
          ]}
        />
      </View>
      <Text style={styles.confidenceText}>
        {Math.round(item.confidence * 100)}%
      </Text>
    </View>
  );
});

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 1) return "now";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

interface ChordDetectionProps {
  isActive?: boolean;
}

export function ChordDetection({
  isActive: isScreenActive = true,
}: ChordDetectionProps) {
  const [timeline, setTimeline] = useState<ChordTimelineEntry[]>([]);
  const [currentChord, setCurrentChord] = useState<string>("N/C");
  const [currentConfidence, setCurrentConfidence] = useState<number>(0);
  const [alternatives, setAlternatives] = useState<ChordResult[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppStateStatus>("active");
  const [isInitialized, setIsInitialized] = useState(false);
  const [dimensions, setDimensions] = useState(Dimensions.get("window"));
  const [mlReady, setMlReady] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioRecorderRef = useRef<AudioRecorder | null>(null);
  const listRef = useRef<LegendListRef>(null);
  const entryIdRef = useRef(0);
  const isStartedRef = useRef(false);
  const chordSmootherRef = useRef(new ChordSmoother(50, 1, 0.03));

  const audioBufferRef = useRef<Float32Array>(
    new Float32Array(CONFIG.RING_BUFFER_SIZE)
  );
  const bufferWriteIndexRef = useRef(0);
  const samplesSinceLastAnalysisRef = useRef(0);

  // Exponential decay chroma accumulator — notes fade naturally over time,
  // so arpeggiated notes accumulate into a full chord picture
  const chromaAccumulatorRef = useRef<number[] | null>(null);
  const bassChromaAccumulatorRef = useRef<number[] | null>(null);
  const framesAccumulatedRef = useRef(0);
  // Separate counter for ML inference gating
  const mlFrameCountRef = useRef(0);
  // Sequence context for temporal voting (F5)
  const sequenceContextRef = useRef(new ChordSequenceContext(24));
  // Onset detector initialization flag
  const onsetInitializedRef = useRef(false);

  // ML inference lock and latest result
  const mlInferenceInProgressRef = useRef(false);
  const mlReadyRef = useRef(false);
  const mlLastResultRef = useRef<{
    chord: string;
    root: string;
    quality: string;
    confidence: number;
  } | null>(null);

  // Load CoreML model on mount
  useEffect(() => {
    ChordModelInference.loadModel()
      .then(() => {
        console.log("[ChordDetection] CoreML BasicPitch model loaded");
        mlReadyRef.current = true;
        setMlReady(true);
      })
      .catch((err) => {
        console.warn("[ChordDetection] CoreML model failed to load:", err.message);
      });
  }, []);

  useEffect(() => {
    const sub = Dimensions.addEventListener("change", ({ window }) =>
      setDimensions(window)
    );
    return () => sub.remove();
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: ChordTimelineEntry }) => <TimelineRow item={item} />,
    []
  );

  const keyExtractor = useCallback(
    (item: ChordTimelineEntry) => item.id.toString(),
    []
  );

  // ML inference pipeline (async) - uses shorter window with recency weighting
  const runMLInference = useCallback(
    async (samples: Float32Array, sampleRate: number) => {
      if (mlInferenceInProgressRef.current) return null;
      mlInferenceInProgressRef.current = true;

      try {
        const samplesArray = Array.from(samples);
        const melSpec = ChordDSP.computeMelSpectrogram(samplesArray, sampleRate);

        const melBins = 229;
        const nFrames = Math.floor(melSpec.length / melBins);
        if (nFrames === 0) return null;

        const melFloat32 = new Float32Array(melSpec);
        const output = await ChordModelInference.runInference(melFloat32, nFrames);

        if (output.notes.length >= 88) {
          const framesCount = Math.floor(output.notes.length / 88);
          const avgActivations = new Float32Array(88);

          // Recency-weighted averaging: recent frames contribute more
          let totalWeight = 0;
          for (let f = 0; f < framesCount; f++) {
            const weight = (f + 1) / framesCount; // linear ramp: last frame = 1.0
            totalWeight += weight;
            for (let i = 0; i < 88; i++) {
              avgActivations[i] += output.notes[f * 88 + i] * weight;
            }
          }
          for (let i = 0; i < 88; i++) avgActivations[i] /= totalWeight;

          return classifyFrame(avgActivations, 0.4);
        }

        return null;
      } catch (err) {
        console.error("[ChordDetection] ML inference error:", err);
        return null;
      } finally {
        mlInferenceInProgressRef.current = false;
      }
    },
    []
  );

  const updateTimeline = useCallback(
    (smoothed: { smoothedChord: string; root: string; quality: string; confidence: number }) => {
      setTimeline((prev) => {
        if (prev.length > 0 && prev[0].chord === smoothed.smoothedChord) {
          const updated = { ...prev[0], confidence: smoothed.confidence };
          return [updated, ...prev.slice(1)];
        }

        if (smoothed.smoothedChord === "N/C") return prev;

        const newEntry: ChordTimelineEntry = {
          id: entryIdRef.current++,
          timestamp: Date.now(),
          chord: smoothed.smoothedChord,
          root: smoothed.root,
          quality: smoothed.quality,
          confidence: smoothed.confidence,
        };

        const updated = [newEntry, ...prev];
        return updated.length > CONFIG.MAX_TIMELINE_ENTRIES
          ? updated.slice(0, CONFIG.MAX_TIMELINE_ENTRIES)
          : updated;
      });

      listRef.current?.scrollToIndex({ index: 0, animated: true });
    },
    []
  );

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

        // Extract analysis window with gain
        const analysisSize = CONFIG.FFT_SIZE;
        const analysisBuffer = new Float32Array(analysisSize);
        const startIdx =
          (bufferWriteIndexRef.current - analysisSize + ringSize) % ringSize;

        const gain = CONFIG.INPUT_GAIN;
        let rms = 0;

        for (let i = 0; i < analysisSize; i++) {
          const sample = ringBuffer[(startIdx + i) % ringSize] * gain;
          const clamped = Math.max(-1, Math.min(1, sample));
          analysisBuffer[i] = clamped;
          rms += clamped * clamped;
        }

        rms = Math.sqrt(rms / analysisSize);

        if (rms < CONFIG.MIN_RMS_THRESHOLD) {
          setIsListening(false);
          chromaAccumulatorRef.current = null;
          bassChromaAccumulatorRef.current = null;
          framesAccumulatedRef.current = 0;
          mlFrameCountRef.current = 0;
          sequenceContextRef.current.reset();
          setAlternatives([]);
          return;
        }

        setIsListening(true);

        const analysisArray = Array.from(analysisBuffer);

        // Nitro C++ DSP: compute full + bass chromagrams
        const frameChroma = ChordDSP.computeChromagram(analysisArray, sampleRate);
        const frameBassChroma = ChordDSP.computeBassChromagram(analysisArray, sampleRate);

        // aubio onset detection: extract latest HOP_SIZE samples
        let isOnset = false;
        let onsetStrength = 0;
        if (onsetInitializedRef.current) {
          const hopSize = CONFIG.HOP_SIZE;
          const hopStart = (bufferWriteIndexRef.current - hopSize + ringSize) % ringSize;
          const hopSamples = new Array(hopSize);
          for (let i = 0; i < hopSize; i++) {
            hopSamples[i] = ringBuffer[(hopStart + i) % ringSize] * gain;
          }
          const onsetResult = ChordDSP.detectOnset(hopSamples);
          isOnset = onsetResult[0] > 0;
          onsetStrength = onsetResult[1];
        }

        // Adaptive decay accumulator for full chroma
        const acc = chromaAccumulatorRef.current;
        const avgChroma = new Array(12);

        if (acc === null) {
          for (let i = 0; i < 12; i++) avgChroma[i] = frameChroma[i];
        } else {
          let flux = 0;
          for (let i = 0; i < 12; i++) {
            const increase = frameChroma[i] - acc[i];
            if (increase > 0) flux += increase;
          }
          const decay = Math.max(0.2, 0.7 - flux * 0.7);
          for (let i = 0; i < 12; i++) {
            avgChroma[i] = acc[i] * decay + frameChroma[i] * (1 - decay);
          }
        }
        chromaAccumulatorRef.current = avgChroma;

        // Adaptive decay accumulator for bass chroma (same logic)
        const bassAcc = bassChromaAccumulatorRef.current;
        const avgBassChroma = new Array(12);

        if (bassAcc === null) {
          for (let i = 0; i < 12; i++) avgBassChroma[i] = frameBassChroma[i];
        } else {
          let bassFlux = 0;
          for (let i = 0; i < 12; i++) {
            const increase = frameBassChroma[i] - bassAcc[i];
            if (increase > 0) bassFlux += increase;
          }
          const bassDecay = Math.max(0.2, 0.7 - bassFlux * 0.7);
          for (let i = 0; i < 12; i++) {
            avgBassChroma[i] = bassAcc[i] * bassDecay + frameBassChroma[i] * (1 - bassDecay);
          }
        }
        bassChromaAccumulatorRef.current = avgBassChroma;

        framesAccumulatedRef.current++;

        // Wait for accumulator to warm up (~3 frames / ~192ms)
        if (framesAccumulatedRef.current < 3) return;

        // Normalize full chroma for classification
        const maxVal = Math.max(...avgChroma);
        const classChroma = new Array(12);
        if (maxVal > 0) {
          for (let i = 0; i < 12; i++) classChroma[i] = avgChroma[i] / maxVal;
        } else {
          for (let i = 0; i < 12; i++) classChroma[i] = 0;
        }

        // Normalize bass chroma separately
        const bassMaxVal = Math.max(...avgBassChroma);
        const classBassChroma = new Array(12);
        if (bassMaxVal > 0) {
          for (let i = 0; i < 12; i++) classBassChroma[i] = avgBassChroma[i] / bassMaxVal;
        } else {
          for (let i = 0; i < 12; i++) classBassChroma[i] = 0;
        }

        // ML inference on a separate cadence (~every 4 analysis frames)
        mlFrameCountRef.current++;
        if (
          mlReadyRef.current &&
          !mlInferenceInProgressRef.current &&
          mlFrameCountRef.current >= 4
        ) {
          mlFrameCountRef.current = 0;
          // 1.5 second window — captures more arpeggio notes (~61 mel frames) [F1]
          const mlWindowSize = Math.floor(sampleRate * 1.5);
          const mlBuffer = new Float32Array(mlWindowSize);
          const mlStart =
            (bufferWriteIndexRef.current - mlWindowSize + ringSize) % ringSize;
          for (let i = 0; i < mlWindowSize; i++) {
            mlBuffer[i] = ringBuffer[(mlStart + i) % ringSize] * gain;
          }
          runMLInference(mlBuffer, sampleRate).then((mlResult) => {
            if (mlResult && mlResult.confidence > 0.5) {
              mlLastResultRef.current = mlResult;
            }
          });
        }

        // Chroma classification with bass anchoring + transition priors [F2, F4]
        const previousRoot = chordSmootherRef.current.getCurrentRoot() || undefined;
        const rawResult = classifyChromaWithBass(classChroma, classBassChroma, previousRoot);

        // Fuse ML result: boost confidence when ML agrees, or defer to
        // high-confidence ML when chroma is uncertain
        const mlResult = mlLastResultRef.current;
        if (mlResult) {
          if (mlResult.chord === rawResult.chord) {
            rawResult.confidence = Math.min(1, rawResult.confidence * 1.15);
          } else if (
            mlResult.confidence > 0.8 &&
            rawResult.confidence < 0.5
          ) {
            rawResult.chord = mlResult.chord;
            rawResult.root = mlResult.root;
            rawResult.quality = mlResult.quality;
            rawResult.confidence = mlResult.confidence;
          }
        }

        // Sequence context: temporal voting with bass consensus [F5]
        const contextResult = sequenceContextRef.current.process(rawResult, classBassChroma);

        // Onset-aware smoothing [F3]
        const smoothed = chordSmootherRef.current.process(contextResult, isOnset, onsetStrength);

        setCurrentChord(smoothed.smoothedChord);
        setCurrentConfidence(smoothed.confidence);
        updateTimeline(smoothed);

        // Compute alternative chords (2 runners-up with distinct names)
        const topN = classifyChromaTopN(classChroma, 5);
        const alts: ChordResult[] = [];
        for (const candidate of topN) {
          if (candidate.chord === smoothed.smoothedChord) continue;
          alts.push(candidate);
          if (alts.length >= 2) break;
        }
        setAlternatives(alts);
      } catch (err) {
        console.error("[ChordDetection] Processing error:", err);
      }
    },
    [runMLInference, updateTimeline]
  );

  const handleStart = useCallback(async () => {
    if (isStartedRef.current) return;

    try {
      setError(null);
      isStartedRef.current = true;
      chordSmootherRef.current.reset();

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
      chromaAccumulatorRef.current = null;
      bassChromaAccumulatorRef.current = null;
      framesAccumulatedRef.current = 0;
      mlFrameCountRef.current = 0;
      mlLastResultRef.current = null;
      sequenceContextRef.current.reset();

      audioContextRef.current = new AudioContext({
        sampleRate: CONFIG.SAMPLE_RATE,
      });

      const actualSampleRate = audioContextRef.current.sampleRate;

      // Initialize aubio onset detector [F3]
      try {
        ChordDSP.initOnsetDetector(actualSampleRate, CONFIG.FFT_SIZE, CONFIG.HOP_SIZE);
        onsetInitializedRef.current = true;
      } catch (e) {
        console.warn("[ChordDetection] Onset detector init failed:", e);
        onsetInitializedRef.current = false;
      }
      audioRecorderRef.current = new AudioRecorder();

      audioRecorderRef.current.onError((error) => {
        console.error("[ChordDetection] Recorder error:", error);
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
      console.error("[ChordDetection] Start error:", err);
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
      console.error("[ChordDetection] Stop error:", err);
    }
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", setAppState);
    return () => sub.remove();
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
  const rootMatch = currentChord.match(/^([A-G]#?)/);
  const chordColor = rootMatch ? NOTE_COLORS[rootMatch[1]] || "#888" : "#888";

  return (
    <View style={styles.container}>
      {/* Current Chord Display */}
      <View style={styles.currentChordContainer}>
        {error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : (
          <>
            <View style={styles.chordRow}>
              {/* Left alternative */}
              <View style={styles.altChordSlot}>
                {alternatives[0] && (
                  <>
                    <Text style={styles.altChordText} numberOfLines={1}>
                      {alternatives[0].chord}
                    </Text>
                    <Text style={styles.altConfidenceText}>
                      {Math.round(alternatives[0].confidence * 100)}%
                    </Text>
                  </>
                )}
              </View>

              {/* Main chord */}
              <View style={styles.mainChordSlot}>
                <Text
                  style={[styles.currentChordText, { color: chordColor }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {currentChord}
                </Text>
              </View>

              {/* Right alternative */}
              <View style={styles.altChordSlot}>
                {alternatives[1] && (
                  <>
                    <Text style={styles.altChordText} numberOfLines={1}>
                      {alternatives[1].chord}
                    </Text>
                    <Text style={styles.altConfidenceText}>
                      {Math.round(alternatives[1].confidence * 100)}%
                    </Text>
                  </>
                )}
              </View>
            </View>

            <View style={styles.confidenceRow}>
              <View
                style={[
                  styles.statusDot,
                  isListening ? styles.statusActive : styles.statusInactive,
                ]}
              />
              <Text style={styles.confidenceLabel}>
                {isRecording
                  ? isListening
                    ? `Confidence: ${Math.round(currentConfidence * 100)}%`
                    : "Waiting for sound..."
                  : "Starting..."}
              </Text>
            </View>
            <Text style={styles.pipelineLabel}>
              {mlReady ? "ML + Native DSP" : "Native DSP"}
            </Text>
          </>
        )}
      </View>

      {/* Timeline */}
      <View
        style={[
          styles.timelineContainer,
          isLandscape && styles.timelineContainerLandscape,
        ]}
      >
        {timeline.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateText}>
              Play a chord to see it detected
            </Text>
            <Text style={styles.emptyStateSubtext}>
              Detected chords appear here
            </Text>
          </View>
        ) : (
          <LegendList
            ref={listRef}
            data={timeline}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            estimatedItemSize={CONFIG.ROW_HEIGHT}
            showsVerticalScrollIndicator
            contentContainerStyle={styles.listContent}
            recycleItems
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
  currentChordContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  chordRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
  },
  altChordSlot: {
    width: 90,
    height: 50,
    alignItems: "center",
    justifyContent: "center",
  },
  altChordText: {
    fontSize: 28,
    fontWeight: "700",
    color: "#555555",
    textAlign: "center",
  },
  altConfidenceText: {
    fontSize: 11,
    color: "#444444",
    marginTop: 2,
  },
  mainChordSlot: {
    width: 160,
    height: 85,
    alignItems: "center",
    justifyContent: "center",
  },
  currentChordText: {
    fontSize: 72,
    fontWeight: "800",
    letterSpacing: -2,
    textAlign: "center",
  },
  confidenceRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
  },
  statusDot: {
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
  confidenceLabel: {
    color: "#888888",
    fontSize: 14,
  },
  pipelineLabel: {
    color: "#444444",
    fontSize: 10,
    marginTop: 4,
  },
  errorText: {
    color: "#FF4444",
    fontSize: 16,
  },
  timelineContainer: {
    flex: 1,
    marginHorizontal: 16,
    backgroundColor: "#111111",
    borderRadius: 12,
    overflow: "hidden",
    marginBottom: 36,
  },
  timelineContainerLandscape: {
    marginVertical: 8,
  },
  listContent: {
    padding: 12,
    paddingBottom: 96,
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
    alignItems: "center",
    minHeight: 52,
    paddingVertical: 8,
    marginBottom: 4,
    gap: 8,
  },
  timeIndicator: {
    width: 36,
  },
  timeText: {
    color: "#555555",
    fontSize: 10,
    fontWeight: "500",
  },
  chordChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 56,
    alignItems: "center",
  },
  chordChipText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
  confidenceBar: {
    flex: 1,
    height: 4,
    backgroundColor: "#222222",
    borderRadius: 2,
    overflow: "hidden",
  },
  confidenceBarFill: {
    height: "100%",
    borderRadius: 2,
    opacity: 0.6,
  },
  confidenceText: {
    color: "#666666",
    fontSize: 11,
    fontWeight: "500",
    width: 32,
    textAlign: "right",
  },
});

export default ChordDetection;
