/**
 * Chord Classification
 *
 * Converts BasicPitch note activations (88 piano keys) into chord labels
 * using a two-stage approach inspired by ChordAI:
 *
 * Stage 1: Root Detection - uses bass chroma to identify the root note
 * Stage 2: Quality Detection - given the root, classify chord quality
 *
 * This separation prevents harmonic bleed from confusing root detection.
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

// Simplicity bias: prefer triads over extended chords unless the extension is clearly present.
// Extended chords (4+ notes) get a penalty that must be overcome by strong 7th presence.
const QUALITY_COMPLEXITY_PENALTY: Record<string, number> = {
  maj: 0,
  min: 0,
  sus2: 0,
  sus4: 0,
  "7": 0.08, // dom7 penalty
  maj7: 0.10, // maj7 penalty (slightly higher - often confused with triads)
  min7: 0.08, // min7 penalty
};

// Index of the 7th degree for each 7th chord type (relative to root at 0)
const SEVENTH_INDICES: Record<string, number> = {
  "7": 10, // minor 7th (10 semitones from root)
  maj7: 11, // major 7th (11 semitones from root)
  min7: 10, // minor 7th (10 semitones from root)
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
 * Applies a simplicity bias: 7th chords are penalized unless the 7th degree
 * has sufficient energy in the chroma. This prevents over-eager detection of
 * extended chords when only a triad is played.
 *
 * @param chroma - 12-bin normalized chroma vector
 * @returns Best matching chord with confidence
 */
export function classifyChroma(chroma: number[]): ChordResult {
  let bestMatch = { root: "C", quality: "maj", similarity: -1 };

  for (const [quality, template] of Object.entries(CHORD_TEMPLATES)) {
    for (let root = 0; root < 12; root++) {
      const rotated = rotateTemplate(template, root);
      let similarity = cosineSimilarity(chroma, rotated);

      // Apply simplicity bias for 7th chords
      const penalty = QUALITY_COMPLEXITY_PENALTY[quality] ?? 0;
      if (penalty > 0) {
        const seventhIdx = SEVENTH_INDICES[quality];
        if (seventhIdx !== undefined) {
          // Get the chroma energy at the 7th position for this root
          const seventhPosition = (root + seventhIdx) % 12;
          const seventhEnergy = chroma[seventhPosition];

          // Only apply full penalty reduction if 7th is clearly present (>0.4)
          // Partial reduction for moderate presence (0.2-0.4)
          // Full penalty if 7th is weak (<0.2)
          if (seventhEnergy > 0.4) {
            // Strong 7th present - no penalty
          } else if (seventhEnergy > 0.2) {
            // Moderate 7th - partial penalty
            similarity -= penalty * 0.5;
          } else {
            // Weak/absent 7th - full penalty
            similarity -= penalty;
          }
        }
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
    confidence: bestMatch.similarity,
    chroma,
  };
}

/**
 * Classify a chroma vector with bass anchoring and transition priors.
 * Boosts chords whose root matches the dominant bass note (×1.15),
 * and applies transition plausibility when a previous root is known.
 * Also applies simplicity bias for 7th chords.
 * Uses bass 3rd detection to distinguish major/minor from sus chords.
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

      // Apply simplicity bias for 7th chords
      const penalty = QUALITY_COMPLEXITY_PENALTY[quality] ?? 0;
      if (penalty > 0) {
        const seventhIdx = SEVENTH_INDICES[quality];
        if (seventhIdx !== undefined) {
          const seventhPosition = (root + seventhIdx) % 12;
          const seventhEnergy = chroma[seventhPosition];

          if (seventhEnergy > 0.4) {
            // Strong 7th present - no penalty
          } else if (seventhEnergy > 0.2) {
            // Moderate 7th - partial penalty
            similarity -= penalty * 0.5;
          } else {
            // Weak/absent 7th - full penalty
            similarity -= penalty;
          }
        }
      }

      // Bass 3rd detection: use bass to distinguish major/minor from sus chords.
      // Only apply when the 3rd is actually prominent relative to other bass notes,
      // to avoid false positives (e.g., G in bass being the 5th of C, not 3rd of E).
      const minor3rdPos = (root + 3) % 12;
      const major3rdPos = (root + 4) % 12;
      const fifthPos = (root + 7) % 12;
      const bassMinor3rd = bassChroma[minor3rdPos];
      const bassMajor3rd = bassChroma[major3rdPos];
      const bassRoot = bassChroma[root];
      const bassFifth = bassChroma[fifthPos];

      // Find max bass energy to check if 3rd is actually prominent
      let bassMax = 0;
      for (let i = 0; i < 12; i++) {
        if (bassChroma[i] > bassMax) bassMax = bassChroma[i];
      }

      if (quality === "min" || quality === "min7") {
        // Only boost if minor 3rd is near-dominant in bass (within 30% of max)
        // AND stronger than this chord's 5th (to distinguish from relative major)
        if (bassMinor3rd > 0.5 && bassMinor3rd > bassMax * 0.7 && bassMinor3rd > bassFifth) {
          similarity *= 1.10;
        }
      } else if (quality === "maj" || quality === "maj7" || quality === "7") {
        // Only boost if major 3rd is near-dominant in bass
        if (bassMajor3rd > 0.5 && bassMajor3rd > bassMax * 0.7 && bassMajor3rd > bassFifth) {
          similarity *= 1.10;
        }
      } else if (quality === "sus2" || quality === "sus4") {
        // Penalize sus chords when a clear 3rd is present in chroma.
        // For sus chords to be valid, there should be NO 3rd (they replace 3rd with 2nd or 4th).

        // Check full chroma for 3rd presence
        const chromaMinor3rd = chroma[(root + 3) % 12];
        const chromaMajor3rd = chroma[(root + 4) % 12];

        // Also check the sus note and the 5th
        const susNote = quality === "sus4" ? chroma[(root + 5) % 12] : chroma[(root + 2) % 12];
        const fifthNote = chroma[(root + 7) % 12];

        // Strong penalty when any 3rd is present - sus chords should NOT have a 3rd
        if (chromaMinor3rd > 0.3 || chromaMajor3rd > 0.3) {
          similarity *= 0.5; // Very heavy penalty
        } else if (chromaMinor3rd > 0.15 || chromaMajor3rd > 0.15) {
          similarity *= 0.7;
        }

        // Additional penalty if sus note is weaker than the 3rd
        // This catches cases like Asus4 vs Dm where F (m3 of D) is stronger than E (P5 of A mistaken as sus)
        const strongerThird = Math.max(chromaMinor3rd, chromaMajor3rd);
        if (susNote < strongerThird && strongerThird > 0.2) {
          similarity *= 0.6;
        }

        // Penalty if the 5th is much weaker than expected
        if (fifthNote < 0.2 && chroma[root] > 0.5) {
          similarity *= 0.8;
        }
      }

      // Bass anchoring: strongly boost chords whose root matches the dominant bass note.
      // When bass clearly indicates a root, trust it heavily - this distinguishes
      // C major from Em (both share E,G but bass shows C vs E).
      if (dominantBass >= 0) {
        if (root === dominantBass) {
          // Strong boost when root matches dominant bass
          similarity *= 1.25;
        } else {
          // Penalize chords whose root doesn't match when bass is clear
          // This prevents Em from winning over C when bass shows C
          const bassStrength = bassChroma[dominantBass];
          if (bassStrength > 0.7) {
            similarity *= 0.85; // Strong penalty when bass is very clear
          } else if (bassStrength > 0.5) {
            similarity *= 0.92; // Moderate penalty
          }
        }
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
 * Compute bass reliability score (0-1). Low score means bass is noisy/unclear.
 * We're conservative here - only trust bass when it's very clear.
 */
function getBassReliability(bassChroma: number[]): number {
  let max = 0;
  let secondMax = 0;
  let sum = 0;
  let nonZeroCount = 0;

  for (let i = 0; i < 12; i++) {
    sum += bassChroma[i];
    if (bassChroma[i] > 0.1) nonZeroCount++;
    if (bassChroma[i] > max) {
      secondMax = max;
      max = bassChroma[i];
    } else if (bassChroma[i] > secondMax) {
      secondMax = bassChroma[i];
    }
  }

  const avg = sum / 12;
  if (max < 0.4) return 0; // No clear bass

  // If too many bins are active, bass is noisy
  if (nonZeroCount > 6) return 0.1;

  // High reliability when peak is well above average and second peak
  const peakRatio = max / (avg + 0.01);
  const separation = (max - secondMax) / (max + 0.01);

  // More conservative: need strong separation
  if (separation < 0.3) return 0.2; // Poor separation

  return Math.min(1, (peakRatio - 2) * 0.15 + separation * 0.4);
}

/**
 * Two-stage chord classification with bass reliability check.
 *
 * When bass is reliable: uses bass for root, then matches quality.
 * When bass is unreliable: uses pure chroma template matching.
 * Hybrid: compares both approaches and picks best match.
 */
export function classifyChromaTwoStage(
  chroma: number[],
  bassChroma: number[],
  previousRoot?: string
): ChordResult {
  const bassReliability = getBassReliability(bassChroma);

  // Always compute pure chroma-based result as fallback/comparison
  const chromaResult = classifyChromaWithPenalties(chroma, previousRoot);

  // If bass is unreliable, trust pure chroma matching
  if (bassReliability < 0.3) {
    return chromaResult;
  }

  // Stage 1: Determine root candidates from bass + chroma
  const rootCandidates: { root: number; score: number }[] = [];

  for (let root = 0; root < 12; root++) {
    // Blend bass and chroma for root detection based on reliability
    let score = bassChroma[root] * bassReliability + chroma[root] * (1 - bassReliability * 0.5);

    // Also consider the 5th in bass (common for inversions)
    const fifthPos = (root + 7) % 12;
    score += bassChroma[fifthPos] * 0.2 * bassReliability;

    // Transition prior
    if (previousRoot) {
      score *= getTransitionPlausibility(previousRoot, NOTE_NAMES[root]);
    }

    rootCandidates.push({ root, score });
  }

  // Sort by score descending
  rootCandidates.sort((a, b) => b.score - a.score);

  // Take top 5 root candidates (more candidates when bass is less reliable)
  const numCandidates = bassReliability > 0.6 ? 3 : 5;
  const topRoots = rootCandidates.slice(0, numCandidates);

  // Stage 2: For each root candidate, find best quality match
  let bestMatch = { root: "C", quality: "maj", similarity: -1, rootScore: 0 };

  for (const { root, score: rootScore } of topRoots) {
    for (const [quality, template] of Object.entries(CHORD_TEMPLATES)) {
      const rotated = rotateTemplate(template, root);
      let similarity = cosineSimilarity(chroma, rotated);

      // Apply simplicity bias for 7th chords
      const penalty = QUALITY_COMPLEXITY_PENALTY[quality] ?? 0;
      if (penalty > 0) {
        const seventhIdx = SEVENTH_INDICES[quality];
        if (seventhIdx !== undefined) {
          const seventhPosition = (root + seventhIdx) % 12;
          const seventhEnergy = chroma[seventhPosition];

          if (seventhEnergy > 0.4) {
            // Strong 7th present - no penalty
          } else if (seventhEnergy > 0.2) {
            similarity -= penalty * 0.5;
          } else {
            similarity -= penalty;
          }
        }
      }

      // Quality-specific validation using chroma
      const thirdPos = (root + (quality === "min" || quality === "min7" ? 3 : 4)) % 12;

      // For major/minor, boost if the 3rd is present
      if (quality === "maj" || quality === "min" || quality === "maj7" || quality === "min7" || quality === "7") {
        const thirdEnergy = chroma[thirdPos];
        if (thirdEnergy > 0.3) {
          similarity *= 1.08;
        }
      }

      // For sus chords, penalize strongly if a clear 3rd is present
      if (quality === "sus2" || quality === "sus4") {
        const minor3rd = chroma[(root + 3) % 12];
        const major3rd = chroma[(root + 4) % 12];
        const susNote = quality === "sus4" ? chroma[(root + 5) % 12] : chroma[(root + 2) % 12];

        // Very heavy penalty when any 3rd is clearly present
        if (minor3rd > 0.3 || major3rd > 0.3) {
          similarity *= 0.5;
        } else if (minor3rd > 0.15 || major3rd > 0.15) {
          similarity *= 0.7;
        }

        // Penalty if sus note is weaker than the 3rd
        const strongerThird = Math.max(minor3rd, major3rd);
        if (susNote < strongerThird && strongerThird > 0.2) {
          similarity *= 0.6;
        }

        // Penalty if sus note is not clearly present
        if (susNote < 0.2) {
          similarity *= 0.7;
        }
      }

      // Light bass boost only when bass is reliable
      if (bassReliability > 0.5) {
        const bassRoot = bassChroma[root];
        if (bassRoot > 0.5) {
          similarity *= 1.0 + bassReliability * 0.1;
        }
      }

      if (similarity > bestMatch.similarity) {
        bestMatch = { root: NOTE_NAMES[root], quality, similarity, rootScore };
      }
    }
  }

  // Compare with pure chroma result - pick the one with higher confidence
  // But prefer the two-stage result when bass is reliable
  const twoStageConfidence = bestMatch.similarity;
  const chromaConfidence = chromaResult.confidence;

  if (chromaConfidence > twoStageConfidence + 0.05 * bassReliability) {
    return chromaResult;
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
 * Pure chroma-based classification with penalties (no bass).
 */
function classifyChromaWithPenalties(chroma: number[], previousRoot?: string): ChordResult {
  let bestMatch = { root: "C", quality: "maj", similarity: -1 };

  for (const [quality, template] of Object.entries(CHORD_TEMPLATES)) {
    for (let root = 0; root < 12; root++) {
      const rotated = rotateTemplate(template, root);
      let similarity = cosineSimilarity(chroma, rotated);

      // Transition prior
      if (previousRoot) {
        similarity *= getTransitionPlausibility(previousRoot, NOTE_NAMES[root]);
      }

      // Apply simplicity bias for 7th chords
      const penalty = QUALITY_COMPLEXITY_PENALTY[quality] ?? 0;
      if (penalty > 0) {
        const seventhIdx = SEVENTH_INDICES[quality];
        if (seventhIdx !== undefined) {
          const seventhPosition = (root + seventhIdx) % 12;
          const seventhEnergy = chroma[seventhPosition];
          if (seventhEnergy < 0.4) {
            similarity -= penalty * (seventhEnergy > 0.2 ? 0.5 : 1);
          }
        }
      }

      // For sus chords, penalize strongly if a clear 3rd is present
      if (quality === "sus2" || quality === "sus4") {
        const minor3rd = chroma[(root + 3) % 12];
        const major3rd = chroma[(root + 4) % 12];
        const susNote = quality === "sus4" ? chroma[(root + 5) % 12] : chroma[(root + 2) % 12];

        // Very heavy penalty when any 3rd is present
        if (minor3rd > 0.3 || major3rd > 0.3) {
          similarity *= 0.5;
        } else if (minor3rd > 0.15 || major3rd > 0.15) {
          similarity *= 0.7;
        }

        // Penalty if sus note is weaker than the 3rd
        const strongerThird = Math.max(minor3rd, major3rd);
        if (susNote < strongerThird && strongerThird > 0.2) {
          similarity *= 0.6;
        }

        // Penalty if sus note is not present
        if (susNote < 0.2) {
          similarity *= 0.7;
        }
      }

      // Boost major/minor when 3rd is present
      if (quality === "maj" || quality === "min") {
        const thirdPos = (root + (quality === "min" ? 3 : 4)) % 12;
        if (chroma[thirdPos] > 0.3) {
          similarity *= 1.08;
        }
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
 * Applies simplicity bias for 7th chords.
 */
export function classifyChromaTopN(chroma: number[], n: number): ChordResult[] {
  const all: { root: string; quality: string; similarity: number }[] = [];

  for (const [quality, template] of Object.entries(CHORD_TEMPLATES)) {
    for (let root = 0; root < 12; root++) {
      const rotated = rotateTemplate(template, root);
      let similarity = cosineSimilarity(chroma, rotated);

      // Apply simplicity bias for 7th chords
      const penalty = QUALITY_COMPLEXITY_PENALTY[quality] ?? 0;
      if (penalty > 0) {
        const seventhIdx = SEVENTH_INDICES[quality];
        if (seventhIdx !== undefined) {
          const seventhPosition = (root + seventhIdx) % 12;
          const seventhEnergy = chroma[seventhPosition];

          if (seventhEnergy > 0.4) {
            // Strong 7th present - no penalty
          } else if (seventhEnergy > 0.2) {
            // Moderate 7th - partial penalty
            similarity -= penalty * 0.5;
          } else {
            // Weak/absent 7th - full penalty
            similarity -= penalty;
          }
        }
      }

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
