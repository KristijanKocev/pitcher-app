import { type HybridObject } from "react-native-nitro-modules";

export interface ChordDSP extends HybridObject<{ ios: "c++" }> {
  resampleTo22050(samples: number[], sourceSampleRate: number): number[];
  computeMelSpectrogram(samples: number[], sampleRate: number): number[];
  computeChromagram(samples: number[], sampleRate: number): number[];
  computeBassChromagram(samples: number[], sampleRate: number): number[];
  initOnsetDetector(sampleRate: number, bufferSize: number, hopSize: number): void;
  detectOnset(samples: number[]): number[];
  resetOnsetDetector(): void;
}
