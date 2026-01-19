import { View, Text } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { AudioApiTuner } from "../components/AudioApiTuner";

export function TunerScreen() {
  const isFocused = useIsFocused();

  return (
    <View className="flex-1 bg-black justify-center items-center">
      <Text className="text-white text-3xl font-bold text-center">Tuner</Text>
      <AudioApiTuner isActive={isFocused} />
    </View>
  );
}
