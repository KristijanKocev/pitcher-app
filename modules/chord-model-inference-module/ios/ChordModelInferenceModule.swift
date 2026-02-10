import ExpoModulesCore
import CoreML

public class ChordModelInferenceModule: Module {
  private var model: MLModel?

  public func definition() -> ModuleDefinition {
    Name("ChordModelInferenceModule")

    AsyncFunction("loadModel") { () -> Bool in
      do {
        if let modelURL = Bundle.main.url(forResource: "nmp", withExtension: "mlmodelc") {
          self.model = try MLModel(contentsOf: modelURL)
          return true
        }

        if let mlmodelURL = Bundle.main.url(forResource: "nmp", withExtension: "mlmodel") {
          let compiledURL = try MLModel.compileModel(at: mlmodelURL)
          self.model = try MLModel(contentsOf: compiledURL)
          return true
        }

        let moduleBundles = Bundle.allBundles.filter { $0.bundlePath.contains("chord-model-inference") }
        for bundle in moduleBundles {
          if let pkgURL = bundle.url(forResource: "nmp", withExtension: "mlpackage") {
            let compiledURL = try MLModel.compileModel(at: pkgURL)
            self.model = try MLModel(contentsOf: compiledURL)
            return true
          }
        }

        throw NSError(domain: "ChordModelInference", code: 1, userInfo: [
          NSLocalizedDescriptionKey: "BasicPitch model (nmp.mlpackage) not found in bundle"
        ])
      } catch {
        throw NSError(domain: "ChordModelInference", code: 2, userInfo: [
          NSLocalizedDescriptionKey: "Failed to load model: \(error.localizedDescription)"
        ])
      }
    }

    AsyncFunction("runInference") { (melSpectrogram: [Float], nFrames: Int) -> [String: [Float]] in
      guard let model = self.model else {
        throw NSError(domain: "ChordModelInference", code: 3, userInfo: [
          NSLocalizedDescriptionKey: "Model not loaded. Call loadModel() first."
        ])
      }

      let melBins = 229

      let inputShape = [1, nFrames, melBins, 1] as [NSNumber]
      guard let inputArray = try? MLMultiArray(shape: inputShape, dataType: .float32) else {
        throw NSError(domain: "ChordModelInference", code: 4, userInfo: [
          NSLocalizedDescriptionKey: "Failed to create input array"
        ])
      }

      let expectedSize = nFrames * melBins
      let actualSize = min(melSpectrogram.count, expectedSize)
      for i in 0..<actualSize {
        inputArray[i] = NSNumber(value: melSpectrogram[i])
      }

      let inputFeature = try MLDictionaryFeatureProvider(dictionary: [
        "input_2": MLFeatureValue(multiArray: inputArray)
      ])

      let prediction = try model.prediction(from: inputFeature)

      var result: [String: [Float]] = [:]

      for featureName in prediction.featureNames {
        if let multiArray = prediction.featureValue(for: featureName)?.multiArrayValue {
          var values: [Float] = []
          let count = multiArray.count
          values.reserveCapacity(count)
          for i in 0..<count {
            values.append(multiArray[i].floatValue)
          }
          result[featureName] = values
        }
      }

      return result
    }

    Function("isModelLoaded") { () -> Bool in
      return self.model != nil
    }
  }
}
