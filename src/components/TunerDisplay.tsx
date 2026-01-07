import { View, Text, Dimensions } from "react-native";
import Svg, { Circle, Line, Rect } from "react-native-svg";
import Animated, {
  useAnimatedProps,
  SharedValue,
} from "react-native-reanimated";
import { palette } from "../utils/theme/palette";
import { paletteTokens } from "../utils/theme/color-palette";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const width = Dimensions.get("window").width;
const height = 140;

const LINE_Y = 70;
const LINE_LENGTH = width;
const CENTER_X = width / 2;

export function TunerDisplay({
  cents,
  isActive,
  currentNote,
  currentOctave,
  prevNote,
  prevOctave,
  nextNote,
  nextOctave,
}: {
  cents: number;
  isActive: boolean;
  currentNote: string;
  currentOctave: number;
  prevNote: string;
  prevOctave: number;
  nextNote: string;
  nextOctave: number;
}) {
  const lineY = LINE_Y;
  const lineStartX = 0;
  const lineEndX = width;
  const lineLength = LINE_LENGTH;
  const centerX = CENTER_X;

  // Determine indicator color based on how in-tune it is (using .value for display purposes)
  const isInTune = Math.abs(cents) <= 5;

  // Animated props for the indicator circle - runs on UI thread
  const animatedCircleProps = useAnimatedProps(() => {
    const clampedCents = Math.max(-50, Math.min(50, cents));
    const indicatorX = CENTER_X + (clampedCents / 50) * (LINE_LENGTH / 2);
    const inTune = Math.abs(cents) <= 5;

    return {
      cx: indicatorX,
      fill: inTune ? palette.greens[10] : palette.yellows[10],
    };
  });

  return (
    <View className="items-center">
      {/* Note labels - prev note on left, current in center, next on right */}
      <View className="flex-row justify-between items-center w-full px-2.5 mb-2.5">
        {/* Previous note (-50 cents / left edge) */}
        <View className="flex-row items-baseline w-16 justify-center">
          <Text className="text-2xl font-medium text-gray-500">{prevNote}</Text>
          {prevNote !== "-" && (
            <Text className="text-sm text-gray-400 ml-1">{prevOctave}</Text>
          )}
        </View>

        {/* Current note (center / 0 cents) */}
        <View className="flex-row items-baseline justify-center">
          <Text
            className="text-6xl font-bold text-white"
            style={[
              {
                fontSize: 64,
                fontWeight: "bold",
                color: isInTune ? "#1AFF97" : "#888",
              },
            ]}
          >
            {currentNote}
          </Text>
          {currentNote !== "-" && (
            <Text
              className="text-3xl text-gray-400 ml-1"
              style={[
                isActive && {
                  fontSize: 32,
                  color: isInTune ? "#1AFF97" : "#888",
                },
              ]}
            >
              {currentOctave}
            </Text>
          )}
        </View>

        {/* Next note (+50 cents / right edge) */}
        <View className="flex-row items-baseline w-16 justify-center">
          <Text className="text-2xl font-medium text-gray-500">{nextNote}</Text>
          {nextNote !== "-" && (
            <Text className="text-sm text-gray-400 ml-1">{nextOctave}</Text>
          )}
        </View>
      </View>

      {/* SVG Tuner Line */}
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {/* Main horizontal line */}
        <Line
          x1={lineStartX}
          y1={lineY}
          x2={lineEndX}
          y2={lineY}
          stroke="#444"
          strokeWidth={4}
          strokeLinecap="round"
        />

        {/* In-tune zone highlight */}
        <Rect
          x={centerX - 15}
          y={lineY - 20}
          width={30}
          height={40}
          fill={palette.greens[10]}
          opacity={0.15}
          rx={4}
        />

        {/* Center tick mark (in tune / 0 cents / current note) */}
        <Line
          x1={centerX}
          y1={lineY - 25}
          x2={centerX}
          y2={lineY + 25}
          stroke={palette.greens[10]}
          strokeWidth={3}
        />

        {/* Quarter tick marks (-25 and +25 cents) */}
        {[-25, 25].map((cent) => {
          const tickX = centerX + (cent / 50) * (lineLength / 2);
          return (
            <Line
              key={cent}
              x1={tickX}
              y1={lineY - 10}
              x2={tickX}
              y2={lineY + 10}
              stroke={paletteTokens.primary.surface[5]}
              strokeWidth={2}
            />
          );
        })}

        {/* Animated indicator circle - only show when active */}
        {isActive && (
          <AnimatedCircle
            animatedProps={animatedCircleProps}
            cy={lineY}
            r={14}
            stroke={paletteTokens.primary.mainBorder}
            strokeWidth={2}
          />
        )}
      </Svg>
    </View>
  );
}
