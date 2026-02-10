import { View, Text } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { ChordDetection } from "../components/ChordDetection";

export function ChordDetectionScreen() {
  const isFocused = useIsFocused();

  return (
    <View className="flex-1 bg-black">
      <View className="pt-12 pb-2 px-4">
        <Text className="text-white text-2xl font-bold text-center">
          Chords
        </Text>
        <Text className="text-gray-400 text-sm text-center mt-1">
          Play chords to detect them in real-time
        </Text>
      </View>
      <ChordDetection isActive={isFocused} />
    </View>
  );
}
