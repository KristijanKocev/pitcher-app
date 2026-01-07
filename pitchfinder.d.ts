declare module "pitchfinder" {
  interface YINOptions {
    sampleRate?: number;
    threshold?: number;
  }

  type PitchDetector = (input: Float32Array | number[]) => number | null;

  export function YIN(options?: YINOptions): PitchDetector;
  export function AMDF(options?: { sampleRate?: number }): PitchDetector;
  export function DynamicWavelet(options?: {
    sampleRate?: number;
  }): PitchDetector;
  export function ACF2PLUS(options?: { sampleRate?: number }): PitchDetector;
  export function Macleod(options?: {
    sampleRate?: number;
    cutoff?: number;
  }): PitchDetector;

  const Pitchfinder: {
    YIN: typeof YIN;
    AMDF: typeof AMDF;
    DynamicWavelet: typeof DynamicWavelet;
    ACF2PLUS: typeof ACF2PLUS;
    Macleod: typeof Macleod;
  };

  export default Pitchfinder;
}
