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

// --- F4: Transition Priors ---
// Plausibility indexed by ascending semitone interval (0–11).
// Index 0 = same root (1.0), 5 = P4 (0.95), 7 = P5 (0.95), 3 = m3 (0.90),
// 6 = tritone (0.60), etc.
const TRANSITION_PLAUSIBILITY = [
  1.0,  // 0: same root
  0.70, // 1: m2
  0.80, // 2: M2
  0.90, // 3: m3
  0.80, // 4: M3
  0.95, // 5: P4
  0.60, // 6: tritone
  0.95, // 7: P5
  0.80, // 8: m6
  0.85, // 9: M6
  0.80, // 10: m7
  0.65, // 11: M7
];

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
 * Get the transition plausibility between two root notes.
 * Returns 1.0 if either root is unknown.
 */
function getTransitionPlausibility(
  prevRoot: string,
  nextRoot: string
): number {
  const prevIdx = NOTE_NAMES.indexOf(prevRoot);
  const nextIdx = NOTE_NAMES.indexOf(nextRoot);
  if (prevIdx < 0 || nextIdx < 0) return 1.0;
  const interval = ((nextIdx - prevIdx) % 12 + 12) % 12;
  return TRANSITION_PLAUSIBILITY[interval];
}

/**
 * Get the dominant bass note pitch class from a bass chromagram.
 * Returns -1 if too quiet (peak must be > 0.3 and > 2× average).
 */
function getDominantBassNote(bassChroma: number[]): number {
  let maxVal = 0;
  let maxIdx = -1;
  let sum = 0;

  for (let i = 0; i < 12; i++) {
    sum += bassChroma[i];
    if (bassChroma[i] > maxVal) {
      maxVal = bassChroma[i];
      maxIdx = i;
    }
  }

  const avg = sum / 12;
  if (maxVal > 0.3 && maxVal > 2 * avg) {
    return maxIdx;
  }
  return -1;
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
 * Classify a chroma vector with bass anchoring and transition priors.
 * Boosts chords whose root matches the dominant bass note (×1.15),
 * and applies transition plausibility when a previous root is known.
 */
export function classifyChromaWithBass(
  chroma: number[],
  bassChroma: number[],
  previousRoot?: string
): ChordResult {
  const dominantBass = getDominantBassNote(bassChroma);

  let bestMatch = { root: "C", quality: "maj", similarity: -1 };

  for (const [quality, template] of Object.entries(CHORD_TEMPLATES)) {
    for (let root = 0; root < 12; root++) {
      const rotated = rotateTemplate(template, root);
      let similarity = cosineSimilarity(chroma, rotated);

      // Bass anchoring: boost chords whose root matches the dominant bass note
      if (dominantBass >= 0 && root === dominantBass) {
        similarity *= 1.15;
      }

      // Transition prior: penalize implausible root movements
      if (previousRoot) {
        similarity *= getTransitionPlausibility(previousRoot, NOTE_NAMES[root]);
      }

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
    confidence: Math.min(1, bestMatch.similarity),
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
 *
 * Onset-aware: when an onset is detected, the hold time and frame confirmation
 * requirements are relaxed to allow instant chord transitions on strums/attacks.
 */
export class ChordSmoother {
  private currentChord: string = "N/C";
  private currentRoot: string = "";
  private currentConfidence: number = 0;
  private lastChangeTime: number = 0;
  private candidateChord: string = "";
  private candidateCount: number = 0;
  private candidateConfidenceSum: number = 0;
  private minHoldMs: number;
  private minFramesToConfirm: number;
  private hysteresisMargin: number;
  private lastOnsetTime: number = 0;

  constructor(
    minHoldMs: number = 100,
    minFramesToConfirm: number = 2,
    hysteresisMargin: number = 0.1
  ) {
    this.minHoldMs = minHoldMs;
    this.minFramesToConfirm = minFramesToConfirm;
    this.hysteresisMargin = hysteresisMargin;
  }

  getCurrentRoot(): string {
    return this.currentRoot;
  }

  process(
    result: ChordResult,
    isOnset: boolean = false,
    onsetStrength: number = 0
  ): ChordResult & { smoothedChord: string } {
    const now = Date.now();
    const timeSinceChange = now - this.lastChangeTime;

    // Track onset timing
    if (isOnset) {
      this.lastOnsetTime = now;
    }

    // Onset-aware effective parameters:
    // On onset → instant switch allowed (hold=0, frames=1)
    // Between onsets → extend hold for stability
    const recentOnset = isOnset || (now - this.lastOnsetTime < 30);
    const effectiveHoldMs = recentOnset ? 0 : this.minHoldMs * 1.5;
    const effectiveFramesToConfirm = recentOnset ? 1 : this.minFramesToConfirm;

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

    // Enforce minimum hold (onset-aware)
    if (timeSinceChange < effectiveHoldMs) {
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
      !recentOnset &&
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
      this.currentRoot = result.root;
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

    if (this.candidateCount >= effectiveFramesToConfirm) {
      const avgConfidence =
        this.candidateConfidenceSum / this.candidateCount;
      this.currentChord = result.chord;
      this.currentRoot = result.root;
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
    this.currentRoot = "";
    this.currentConfidence = 0;
    this.lastChangeTime = 0;
    this.candidateChord = "";
    this.candidateCount = 0;
    this.candidateConfidenceSum = 0;
    this.lastOnsetTime = 0;
  }
}

// Re-export for F5 sequence context
export { getTransitionPlausibility, getDominantBassNote, NOTE_NAMES };
