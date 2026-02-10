import ChordModelInferenceModule from "./src/ChordModelInferenceModule";

export async function loadModel(): Promise<boolean> {
  return ChordModelInferenceModule.loadModel();
}

export async function runInference(
  melSpectrogram: Float32Array,
  nFrames: number
): Promise<{
  notes: Float32Array;
  onsets: Float32Array;
  contours: Float32Array;
}> {
  const result = await ChordModelInferenceModule.runInference(
    Array.from(melSpectrogram),
    nFrames
  );

  const outputKeys = Object.keys(result);

  const findOutput = (hint: string): Float32Array => {
    const key =
      outputKeys.find((k) => k.toLowerCase().includes(hint)) || outputKeys[0];
    return new Float32Array(result[key] || []);
  };

  return {
    notes: findOutput("note"),
    onsets: findOutput("onset"),
    contours: findOutput("contour"),
  };
}

export function isModelLoaded(): boolean {
  return ChordModelInferenceModule.isModelLoaded();
}
