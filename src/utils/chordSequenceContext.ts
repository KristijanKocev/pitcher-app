/**
 * ChordSequenceContext — JS sequence model for temporal chord smoothing.
 *
 * Maintains a sliding window of recent chord predictions and applies:
 * 1. Majority voting with recency weighting (newest = 1.0, oldest = 0.3)
 * 2. Transition priors on vote weights
 * 3. Bass consensus — boost chord roots matching recent bass notes
 *
 * Sits between raw classification + ML fusion and the ChordSmoother.
 */

import {
  ChordResult,
  getTransitionPlausibility,
  getDominantBassNote,
} from "./chordClassification";

interface SequenceEntry {
  result: ChordResult;
  bassNote: number; // pitch class of dominant bass, or -1
}

export class ChordSequenceContext {
  private window: SequenceEntry[] = [];
  private windowSize: number;

  constructor(windowSize: number = 24) {
    this.windowSize = windowSize;
  }

  /**
   * Add a new prediction and return the consensus chord.
   *
   * @param result - Raw classified chord result (after ML fusion)
   * @param bassChroma - Normalized 12-bin bass chromagram
   * @returns Consensus chord result with adjusted confidence
   */
  process(result: ChordResult, bassChroma: number[]): ChordResult {
    const bassNote = getDominantBassNote(bassChroma);

    this.window.push({ result, bassNote });
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }

    // Need at least 3 entries for meaningful voting
    if (this.window.length < 3) {
      return result;
    }

    // Recency-weighted majority vote
    const votes = new Map<
      string,
      { weight: number; totalConf: number; root: string; quality: string; chroma: number[] }
    >();

    const len = this.window.length;
    const prevChord = len >= 2 ? this.window[len - 2].result.chord : null;

    for (let i = 0; i < len; i++) {
      const entry = this.window[i];
      const chord = entry.result.chord;

      // Recency weight: oldest = 0.3, newest = 1.0
      const recency = 0.3 + 0.7 * (i / (len - 1));

      // Transition prior weight relative to previous chord
      let transitionWeight = 1.0;
      if (prevChord && i === len - 1) {
        // Only apply transition prior to the newest entry
        const prevEntry = this.window[len - 2];
        transitionWeight = getTransitionPlausibility(
          prevEntry.result.root,
          entry.result.root
        );
      }

      const weight = recency * transitionWeight * entry.result.confidence;

      const existing = votes.get(chord);
      if (existing) {
        existing.weight += weight;
        existing.totalConf += entry.result.confidence;
      } else {
        votes.set(chord, {
          weight,
          totalConf: entry.result.confidence,
          root: entry.result.root,
          quality: entry.result.quality,
          chroma: entry.result.chroma,
        });
      }
    }

    // Bass consensus: count dominant bass note in recent 8 frames
    const recentBassWindow = Math.min(8, len);
    const bassCounts = new Array(12).fill(0);
    for (let i = len - recentBassWindow; i < len; i++) {
      const bn = this.window[i].bassNote;
      if (bn >= 0) bassCounts[bn]++;
    }

    // Find the dominant bass pitch class across recent frames
    let dominantBassClass = -1;
    let maxBassCount = 0;
    for (let i = 0; i < 12; i++) {
      if (bassCounts[i] > maxBassCount) {
        maxBassCount = bassCounts[i];
        dominantBassClass = i;
      }
    }

    // Boost chords whose root matches the bass consensus
    const NOTE_NAMES = [
      "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];

    if (dominantBassClass >= 0 && maxBassCount >= 3) {
      for (const [, data] of votes) {
        const rootIdx = NOTE_NAMES.indexOf(data.root);
        if (rootIdx === dominantBassClass) {
          data.weight *= 1.2;
        }
      }
    }

    // Find winning chord
    let bestChord = result.chord;
    let bestWeight = -1;
    let bestData = {
      root: result.root,
      quality: result.quality,
      chroma: result.chroma,
      totalConf: result.confidence,
    };

    for (const [chord, data] of votes) {
      if (data.weight > bestWeight) {
        bestWeight = data.weight;
        bestChord = chord;
        bestData = data;
      }
    }

    // Normalize confidence: the winning weight relative to total weight
    let totalWeight = 0;
    for (const [, data] of votes) {
      totalWeight += data.weight;
    }
    const normalizedConfidence =
      totalWeight > 0 ? Math.min(1, bestWeight / totalWeight) : result.confidence;

    return {
      chord: bestChord,
      root: bestData.root,
      quality: bestData.quality,
      confidence: normalizedConfidence,
      chroma: bestData.chroma,
    };
  }

  reset(): void {
    this.window = [];
  }
}
