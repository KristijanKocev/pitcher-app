import { NitroModules } from "react-native-nitro-modules";
import type { ChordDSP as ChordDSPType } from "./specs/ChordDSP.nitro";

export const ChordDSP =
  NitroModules.createHybridObject<ChordDSPType>("ChordDSP");
