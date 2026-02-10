const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

function withChordDSP(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const podfilePath = path.join(
        config.modRequest.platformProjectRoot,
        "Podfile"
      );
      let podfile = fs.readFileSync(podfilePath, "utf-8");

      const podLine = `  pod 'NitroChordDsp', :path => '../modules/chord-dsp'`;

      if (!podfile.includes("NitroChordDsp")) {
        podfile = podfile.replace(
          "use_expo_modules!",
          `use_expo_modules!\n${podLine}`
        );
        fs.writeFileSync(podfilePath, podfile);
      }

      return config;
    },
  ]);
}

module.exports = withChordDSP;
