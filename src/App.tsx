import { NavigationContainer } from "@react-navigation/native";
import { createNativeBottomTabNavigator, NativeBottomTabIcon } from "@react-navigation/bottom-tabs/unstable";
import { Platform } from "react-native";
import { TunerScreen, ChordTimelineScreen, ChordDetectionScreen } from "./screens";
import "../global.css";

const Tab = createNativeBottomTabNavigator();

export default function App() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: "#38acdd",
          lazy: true,
          
        }}
        
      >
        <Tab.Screen
          name="Tuner"
          component={TunerScreen}
          options={{
            tabBarLabel: "Tuner",
            tabBarIcon: ({ focused }) => {
              return {
                type: 'sfSymbol',
                name: focused ? 'tuningfork' : 'tuningfork',
              };
            } ,
          }}
        />
        <Tab.Screen
          name="Timeline"
          component={ChordTimelineScreen}
          options={{
            tabBarLabel: "Timeline",
            tabBarIcon: ({ focused }) => {
              return {
                type: 'sfSymbol',
                name: focused ? 'waveform.path' : 'waveform.path.ecg',
              };
            },
          }}
        />
        <Tab.Screen
          name="Chords"
          component={ChordDetectionScreen}
          options={{
            tabBarLabel: "Chords",
            tabBarIcon: ({ focused }) => {
              return {
                type: 'sfSymbol',
                name: focused ? 'music.note.list' : 'music.note.list',
              };
            },
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
