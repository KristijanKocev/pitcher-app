/**
 * Chord Classification
 *
 * Converts BasicPitch note activations (88 piano keys) into chord labels
 * using chroma vector template matching with cosine similarity.
 *
 * Supports 84 chords: 12 roots × 7 qualities (maj, min, 7, maj7, min7, sus2, sus4)
 */

// Chord templates (root = C, intervals as semitones from root)
// Each template is a 12-dimensional binary vector
const CHORD_TEMPLATES: Record<string, number[]> = {
  maj: [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0],
  min: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0],
  "7": [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  maj7: [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1],
  min7: [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0],
  sus2: [1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0],
  sus4: [1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0],
};

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

// Display-friendly quality names
const QUALITY_DISPLAY: Record<string, string> = {
  maj: "",
  min: "m",
  "7": "7",
  maj7: "maj7",
  min7: "m7",
  sus2: "sus2",
  sus4: "sus4",
};

export interface ChordResult {
  chord: string; // e.g. "Am7", "C", "G7"
  root: string; // e.g. "A", "C", "G"
  quality: string; // e.g. "min7", "maj", "7"
  confidence: number; // 0-1
  chroma: number[]; // 12-bin chroma used for classification
}

/**
 * Rotate an array by n positions to the right
 */
function rotateTemplate(template: number[], n: number): number[] {
  const len = template.length;
  const rotated = new Array(len);
  for (let i = 0; i < len; i++) {
    rotated[(i + n) % len] = template[i];
  }
  return rotated;
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dotProduct / denom : 0;
}

/**
 * Build 12-bin chroma vector from BasicPitch note activations.
 *
 * @param noteActivations - Array of 88 values (one per piano key, C1 to C8)
 * @param threshold - Minimum activation to consider a note "on"
 */
export function buildChromaFromActivations(
  noteActivations: Float32Array | number[],
  threshold: number = 0.5
): number[] {
  const chroma = new Array(12).fill(0);

  // BasicPitch outputs 88 piano keys: MIDI 21 (A0) to MIDI 108 (C8)
  for (let i = 0; i < 88; i++) {
    const activation = noteActivations[i];
    if (activation < threshold) continue;

    const midiNote = i + 21; // BasicPitch starts at MIDI 21
    const pitchClass = midiNote % 12;
    chroma[pitchClass] += activation;
  }

  // Normalize
  const maxVal = Math.max(...chroma);
  if (maxVal > 0) {
    for (let i = 0; i < 12; i++) {
      chroma[i] /= maxVal;
    }
  }

  return chroma;
}

/**
 * Classify a chroma vector into a chord label.
 *
 * @param chroma - 12-bin normalized chroma vector
 * @returns Best matching chord with confidence
 */
export function classifyChroma(chroma: number[]): ChordResult {
  let bestMatch = { root: "C", quality: "maj", similarity: -1 };

  for (const [quality, template] of Object.entries(CHORD_TEMPLATES)) {
    for (let root = 0; root < 12; root++) {
      const rotated = rotateTemplate(template, root);
      const similarity = cosineSimilarity(chroma, rotated);

      if (similarity > bestMatch.similarity) {
        bestMatch = { root: NOTE_NAMES[root], quality, similarity };
      }
    }
  }

  const displayQuality = QUALITY_DISPLAY[bestMatch.quality] ?? bestMatch.quality;
  const chordName = `${bestMatch.root}${displayQuality}`;

  return {
    chord: chordName,
    root: bestMatch.root,
    quality: bestMatch.quality,
    confidence: bestMatch.similarity,
    chroma,
  };
}

/**
 * Return the top N chord matches for a chroma vector, sorted by confidence descending.
 * Deduplicates by chord name (keeps highest confidence per unique name).
 */
export function classifyChromaTopN(chroma: number[], n: number): ChordResult[] {
  const all: { root: string; quality: string; similarity: number }[] = [];

  for (const [quality, template] of Object.entries(CHORD_TEMPLATES)) {
    for (let root = 0; root < 12; root++) {
      const rotated = rotateTemplate(template, root);
      const similarity = cosineSimilarity(chroma, rotated);
      all.push({ root: NOTE_NAMES[root], quality, similarity });
    }
  }

  // Sort descending by similarity
  all.sort((a, b) => b.similarity - a.similarity);

  // Deduplicate by chord display name (keep first/highest)
  const seen = new Set<string>();
  const results: ChordResult[] = [];

  for (const entry of all) {
    const displayQuality = QUALITY_DISPLAY[entry.quality] ?? entry.quality;
    const chordName = `${entry.root}${displayQuality}`;

    if (seen.has(chordName)) continue;
    seen.add(chordName);

    results.push({
      chord: chordName,
      root: entry.root,
      quality: entry.quality,
      confidence: entry.similarity,
      chroma,
    });

    if (results.length >= n) break;
  }

  return results;
}

/**
 * Classify BasicPitch note activations for a single frame.
 *
 * @param noteActivations - 88-element array from BasicPitch "notes" output
 * @param threshold - Activation threshold
 */
export function classifyFrame(
  noteActivations: Float32Array | number[],
  threshold: number = 0.5
): ChordResult {
  const chroma = buildChromaFromActivations(noteActivations, threshold);
  return classifyChroma(chroma);
}

/**
 * Classify multiple frames and apply temporal smoothing.
 * Aggregates activations across frames before classification.
 *
 * @param noteFrames - Array of 88-element arrays, one per frame
 * @param threshold - Activation threshold
 */
export function classifyFrames(
  noteFrames: (Float32Array | number[])[],
  threshold: number = 0.5
): ChordResult {
  if (noteFrames.length === 0) {
    return {
      chord: "N/C",
      root: "",
      quality: "",
      confidence: 0,
      chroma: new Array(12).fill(0),
    };
  }

  // Aggregate chroma across all frames
  const aggregatedChroma = new Array(12).fill(0);

  for (const frame of noteFrames) {
    const frameChroma = buildChromaFromActivations(frame, threshold);
    for (let i = 0; i < 12; i++) {
      aggregatedChroma[i] += frameChroma[i];
    }
  }

  // Normalize
  const maxVal = Math.max(...aggregatedChroma);
  if (maxVal > 0) {
    for (let i = 0; i < 12; i++) {
      aggregatedChroma[i] /= maxVal;
    }
  }

  return classifyChroma(aggregatedChroma);
}

/**
 * Temporal chord smoother - prevents rapid chord flickering.
 * Uses confidence hysteresis: a new chord must exceed the current chord's
 * confidence by a margin before switching. This prevents bouncing between
 * closely-scored chords during arpeggios.
 */
export class ChordSmoother {
  private currentChord: string = "N/C";
  private currentConfidence: number = 0;
  private lastChangeTime: number = 0;
  private candidateChord: string = "";
  private candidateCount: number = 0;
  private candidateConfidenceSum: number = 0;
  private minHoldMs: number;
  private minFramesToConfirm: number;
  private hysteresisMargin: number;

  constructor(
    minHoldMs: number = 100,
    minFramesToConfirm: number = 2,
    hysteresisMargin: number = 0.1
  ) {
    this.minHoldMs = minHoldMs;
    this.minFramesToConfirm = minFramesToConfirm;
    this.hysteresisMargin = hysteresisMargin;
  }

  process(result: ChordResult): ChordResult & { smoothedChord: string } {
    const now = Date.now();
    const timeSinceChange = now - this.lastChangeTime;

    if (result.chord === this.currentChord) {
      this.candidateChord = "";
      this.candidateCount = 0;
      this.candidateConfidenceSum = 0;
      this.currentConfidence = result.confidence;
      return { ...result, smoothedChord: this.currentChord };
    }

    // Different chord detected — decay stored confidence so stale chords
    // don't block switches indefinitely. Each frame the current chord isn't
    // re-confirmed, its stored confidence drops ~5%.
    this.currentConfidence *= 0.95;

    // Enforce minimum hold
    if (timeSinceChange < this.minHoldMs) {
      return {
        ...result,
        smoothedChord: this.currentChord,
        confidence: this.currentConfidence,
      };
    }

    // Hysteresis: new chord must beat current by a margin to even be
    // considered. Combined with confidence decay above, this prevents
    // arpeggio flicker while still allowing real chord changes through.
    if (
      this.currentChord !== "N/C" &&
      result.confidence < this.currentConfidence + this.hysteresisMargin
    ) {
      this.candidateChord = "";
      this.candidateCount = 0;
      this.candidateConfidenceSum = 0;
      return {
        ...result,
        smoothedChord: this.currentChord,
        confidence: this.currentConfidence,
      };
    }

    // High-confidence fast path: skip frame confirmation when the new chord
    // is clearly dominant
    if (
      result.confidence > 0.7 &&
      result.confidence > this.currentConfidence + 0.1
    ) {
      this.currentChord = result.chord;
      this.currentConfidence = result.confidence;
      this.lastChangeTime = now;
      this.candidateChord = "";
      this.candidateCount = 0;
      this.candidateConfidenceSum = 0;
      return { ...result, smoothedChord: this.currentChord };
    }

    // Standard path: accumulate candidate frames
    if (result.chord === this.candidateChord) {
      this.candidateCount++;
      this.candidateConfidenceSum += result.confidence;
    } else {
      this.candidateChord = result.chord;
      this.candidateCount = 1;
      this.candidateConfidenceSum = result.confidence;
    }

    if (this.candidateCount >= this.minFramesToConfirm) {
      const avgConfidence =
        this.candidateConfidenceSum / this.candidateCount;
      this.currentChord = result.chord;
      this.currentConfidence = avgConfidence;
      this.lastChangeTime = now;
      this.candidateChord = "";
      this.candidateCount = 0;
      this.candidateConfidenceSum = 0;
      return {
        ...result,
        smoothedChord: this.currentChord,
        confidence: avgConfidence,
      };
    }

    return {
      ...result,
      smoothedChord: this.currentChord,
      confidence: this.currentConfidence,
    };
  }

  reset(): void {
    this.currentChord = "N/C";
    this.currentConfidence = 0;
    this.lastChangeTime = 0;
    this.candidateChord = "";
    this.candidateCount = 0;
    this.candidateConfidenceSum = 0;
  }
}
