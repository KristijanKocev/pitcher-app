import { Text, View } from "react-native";
import { AudioApiTuner } from "./components/AudioApiTuner";
import "../global.css";


export default function App() {

  return (
    <View className="flex-1 bg-black  justify-center items-center">
      

      
    <Text className="text-white text-3xl font-bold text-center">Tuner</Text>
          <AudioApiTuner />
    </View>
  );
}
