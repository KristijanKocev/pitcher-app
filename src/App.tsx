import { Text, TouchableOpacity, View } from "react-native";
import { Tuner } from "./components/Tuner";
import "../global.css";

export default function App() {
  return (
    <View className="flex-1 items-center justify-center bg-black">
      <Text className="text-white text-2xl font-bold mb-4">Vocal Tuner</Text>
      <Tuner />
    </View>
  );
}
