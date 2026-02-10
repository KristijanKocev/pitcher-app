import { NativeModule, requireNativeModule } from "expo";

declare class ChordModelInferenceModuleType extends NativeModule {
  loadModel(): Promise<boolean>;
  runInference(
    melSpectrogram: number[],
    nFrames: number
  ): Promise<{ [key: string]: number[] }>;
  isModelLoaded(): boolean;
}

export default requireNativeModule<ChordModelInferenceModuleType>(
  "ChordModelInferenceModule"
);
