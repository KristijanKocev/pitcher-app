module.exports = {
  dependencies: {
    "chord-dsp": {
      root: "./modules/chord-dsp",
      platforms: {
        ios: {
          podspecPath: "./modules/chord-dsp/ios/ChordDSP.podspec",
        },
        android: null,
      },
    },
  },
};
