import { Text, View } from "react-native";
import { SmoothTuner } from "./components/SmoothTuner";
import "../global.css";

export default function App() {
  return (
    <View className="flex-1 items-center justify-center bg-black">
      <Text className="text-white text-2xl font-bold"> Tuner</Text>
      <SmoothTuner />
    </View>
  );
}
