import { View, Text } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { ChordTimeline } from "../components/ChordTimeline";

export function ChordTimelineScreen() {
  const isFocused = useIsFocused();

  return (
    <View className="flex-1 bg-black">
      <View className="pt-12 pb-4 px-4">
        <Text className="text-white text-2xl font-bold text-center">
          Chord Timeline
        </Text>
        <Text className="text-gray-400 text-sm text-center mt-1">
          Play notes to see them appear
        </Text>
      </View>
      <ChordTimeline isActive={isFocused} />
    </View>
  );
}
