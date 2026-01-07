import { View, Text, Dimensions } from "react-native";
import Svg, { Circle, Line, Rect } from "react-native-svg";
import { palette } from "../utils/theme/palette";
import { paletteTokens } from "../utils/theme/color-palette";

const width = Dimensions.get("window").width;
const height = 140;

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
  const lineY = 70;
  const lineStartX = 0;
  const lineEndX = width;
  const lineLength = lineEndX - lineStartX;
  const centerX = width / 2;

  // Clamp cents between -50 and +50
  // At -50 cents we're at the previous note, at +50 cents we're at the next note
  const clampedCents = Math.max(-50, Math.min(50, cents));

  // Calculate indicator position: -50 cents = left edge (prev note), 0 = center (current note), +50 cents = right edge (next note)
  const indicatorX = centerX + (clampedCents / 50) * (lineLength / 2);

  // Determine indicator color based on how in-tune it is
  const isInTune = Math.abs(cents) <= 5;
  const indicatorColor = isActive
    ? isInTune
      ? palette.greens[10]
      : palette.yellows[10]
    : paletteTokens.primary.surface[5];

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
              isActive && {
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

        {/* Indicator circle - only show when active */}
        {isActive && (
          <Circle
            cx={indicatorX}
            cy={lineY}
            r={14}
            fill={indicatorColor}
            stroke={paletteTokens.primary.mainBorder}
            strokeWidth={2}
          />
        )}
      </Svg>
    </View>
  );
}
