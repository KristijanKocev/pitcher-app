/**
 * Smooth Tuner Display Component
 *
 * This component implements all the UI techniques from Universal Tuner:
 * 1. Spring-damper animation for pitch indicator (UI thread via Reanimated)
 * 2. Smooth note transitions with fade/scale effects
 * 3. Tuned state indicator with glow and pulse
 * 4. Ghost mode visualization
 * 5. Signal level and confidence indicators
 *
 * All animations run on the UI thread for 60fps performance.
 */

import React, { useMemo } from "react";
import { View, Text, Dimensions, StyleSheet } from "react-native";
import Svg, {
  Circle,
  Line,
  Rect,
  Defs,
  RadialGradient,
  Stop,
} from "react-native-svg";
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
} from "react-native-reanimated";
import {
  useSmoothCents,
  useTunedIndicator,
} from "../hooks/useSmoothAnimations";
import { paletteTokens } from "../utils/theme/color-palette";

// ============================================================================
// ANIMATED COMPONENTS
// ============================================================================

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedText = Animated.createAnimatedComponent(Text);
const AnimatedView = Animated.createAnimatedComponent(View);

// ============================================================================
// CONSTANTS
// ============================================================================

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const DISPLAY_HEIGHT = 180;
const LINE_Y = 110;
const CENTER_X = SCREEN_WIDTH / 2;
const LINE_START = 0;
const LINE_END = SCREEN_WIDTH;
const LINE_LENGTH = LINE_END - LINE_START;

// Colors
const COLORS = {
  tuned: "#00FF88",
  tunedGlow: "#00FF8840",
  warning: "#FFB800",
  neutral: "#888888",
  inactive: "#444444",
  background: "#1A1A1A",
  line: "#333333",
  ghost: "#666666",
};

// ============================================================================
// TYPES
// ============================================================================

export interface SmoothTunerDisplayProps {
  /** Current cents deviation (-50 to +50) */
  cents: number;
  /** Whether tuner is actively detecting */
  isActive: boolean;
  /** Current note name */
  noteName: string;
  /** Current octave */
  octave: number;
  /** Previous note name (for left label) */
  prevNote: string;
  /** Previous note octave */
  prevOctave: number;
  /** Next note name (for right label) */
  nextNote: string;
  /** Next note octave */
  nextOctave: number;
  /** Current frequency in Hz */
  frequency: number;
  /** Whether in ghost mode */
  isGhost?: boolean;
  /** Ghost opacity (0-1) */
  ghostOpacity?: number;
  /** Whether currently tuned */
  isTuned?: boolean;
  /** Detection confidence (0-1) */
  confidence?: number;
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function SmoothTunerDisplay({
  cents,
  isActive,
  noteName,
  octave,
  prevNote,
  prevOctave,
  nextNote,
  nextOctave,
  frequency,
  isGhost = false,
  ghostOpacity = 1,
  isTuned = false,
  confidence = 0,
}: SmoothTunerDisplayProps) {
  // ================================================================
  // SMOOTH ANIMATIONS (UI THREAD)
  // ================================================================

  // Spring-damper animation for cents indicator
  const smoothCents = useSmoothCents(cents, isActive);

  // Tuned state with hysteresis and glow
  const tunedState = useTunedIndicator(cents, isActive);

  // ================================================================
  // DERIVED VALUES (UI THREAD)
  // ================================================================

  // Indicator X position
  const indicatorX = useDerivedValue(() => {
    const clampedCents = Math.max(-50, Math.min(50, smoothCents.value));
    return CENTER_X + (clampedCents / 50) * (LINE_LENGTH / 2);
  });

  // Indicator color based on cents deviation
  const indicatorColor = useDerivedValue(() => {
    const absCents = Math.abs(smoothCents.value);
    if (absCents <= 5) return COLORS.tuned;
    if (absCents <= 15) return COLORS.warning;
    return COLORS.neutral;
  });

  // ================================================================
  // ANIMATED PROPS (UI THREAD)
  // ================================================================

  // Animated circle indicator
  const animatedCircleProps = useAnimatedProps(() => ({
    cx: indicatorX.value,
    fill: indicatorColor.value,
    opacity: isGhost ? ghostOpacity : 1,
  }));

  // Glow effect around indicator when tuned
  const animatedGlowProps = useAnimatedProps(() => ({
    cx: indicatorX.value,
    opacity: tunedState.glowIntensity.value * 0.6,
    r: 30 + tunedState.glowIntensity.value * 10,
  }));

  // ================================================================
  // ANIMATED STYLES (UI THREAD)
  // ================================================================

  // Note text style with scale animation
  const noteTextStyle = useAnimatedStyle(() => {
    const scale = tunedState.pulse.value;
    return {
      transform: [{ scale }],
      opacity: isGhost ? ghostOpacity : 1,
    };
  });

  // Note color style
  const noteColorStyle = useAnimatedStyle(() => {
    const absCents = Math.abs(smoothCents.value);
    const color =
      absCents <= 5 && isActive
        ? COLORS.tuned
        : isActive
        ? COLORS.neutral
        : COLORS.inactive;
    return { color };
  });

  // ================================================================
  // RENDER
  // ================================================================

  return (
    <View className="w-full items-center">
      {/* Note Labels Row */}
      <View className="flex-row justify-between items-center w-full px-5 mb-[12px]">
        {/* Previous Note (left) */}
        <View style={styles.sideNoteContainer}>
          <Text style={styles.sideNoteText}>{prevNote}</Text>
          {prevNote !== "-" && (
            <Text style={styles.sideOctaveText}>{prevOctave}</Text>
          )}
        </View>

        {/* Current Note (center) */}
        <AnimatedView style={[styles.currentNoteContainer, noteTextStyle]}>
          <AnimatedText style={[styles.currentNoteText, noteColorStyle]}>
            {noteName}
          </AnimatedText>
          {noteName !== "-" && (
            <AnimatedText style={[styles.currentOctaveText, noteColorStyle]}>
              {octave}
            </AnimatedText>
          )}
        </AnimatedView>

        {/* Next Note (right) */}
        <View style={styles.sideNoteContainer}>
          <Text style={styles.sideNoteText}>{nextNote}</Text>
          {nextNote !== "-" && (
            <Text style={styles.sideOctaveText}>{nextOctave}</Text>
          )}
        </View>
      </View>

      {/* SVG Tuner Visualization */}
      <Svg
        width={SCREEN_WIDTH}
        height={DISPLAY_HEIGHT - 60}
        viewBox={`0 0 ${SCREEN_WIDTH} ${DISPLAY_HEIGHT - 60}`}
      >
        {/* Gradient definitions */}
        <Defs>
          <RadialGradient id="glowGradient" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={COLORS.tuned} stopOpacity="0.8" />
            <Stop offset="100%" stopColor={COLORS.tuned} stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {/* Main horizontal line */}
        <Line
          x1={LINE_START}
          y1={LINE_Y - 60}
          x2={LINE_END}
          y2={LINE_Y - 60}
          stroke={COLORS.line}
          strokeWidth={4}
          strokeLinecap="round"
        />

        {/* In-tune zone highlight */}
        <Rect
          x={CENTER_X - 20}
          y={LINE_Y - 85}
          width={40}
          height={50}
          fill={COLORS.tunedGlow}
          rx={6}
        />

        {/* Center tick mark (0 cents) */}
        <Line
          x1={CENTER_X}
          y1={LINE_Y - 90}
          x2={CENTER_X}
          y2={LINE_Y - 30}
          stroke={COLORS.tuned}
          strokeWidth={3}
        />

        {/* Quarter tick marks (-25 and +25 cents) */}
        {[-25, 25].map((cent) => {
          const tickX = CENTER_X + (cent / 50) * (LINE_LENGTH / 2);
          return (
            <Line
              key={cent}
              x1={tickX}
              y1={LINE_Y - 75}
              x2={tickX}
              y2={LINE_Y - 45}
              stroke={COLORS.neutral}
              strokeWidth={2}
            />
          );
        })}

        {/* Edge tick marks (-50 and +50 cents) */}
        {[-50, 50].map((cent) => {
          const tickX = CENTER_X + (cent / 50) * (LINE_LENGTH / 2);
          return (
            <Line
              key={`edge-${cent}`}
              x1={tickX}
              y1={LINE_Y - 70}
              x2={tickX}
              y2={LINE_Y - 50}
              stroke={COLORS.inactive}
              strokeWidth={2}
            />
          );
        })}

        {/* Glow effect (only when tuned) */}
        {isActive && (
          <AnimatedCircle
            animatedProps={animatedGlowProps}
            cy={LINE_Y - 60}
            fill="url(#glowGradient)"
          />
        )}

        {/* Main indicator circle */}
        {isActive && (
          <AnimatedCircle
            animatedProps={animatedCircleProps}
            cy={LINE_Y - 60}
            r={16}
            stroke={isGhost ? COLORS.ghost : "#FFFFFF"}
            strokeWidth={2}
          />
        )}
      </Svg>

      {/* Bottom info row */}
      <View style={styles.infoRow}>
        {/* Frequency display */}
        <Text style={[styles.frequencyText, isGhost && styles.ghostText]}>
          {frequency > 0 ? `${frequency.toFixed(1)} Hz` : "-- Hz"}
        </Text>

        {/* Cents display */}
        <Text
          style={[
            styles.centsText,
            Math.abs(cents) <= 5 && isActive
              ? styles.tunedCentsText
              : styles.warningCentsText,
            isGhost && styles.ghostText,
          ]}
        >
          {cents > 0 ? "+" : ""}
          {Math.round(cents)} cents
        </Text>

        {/* Confidence indicator */}
        {isActive && (
          <View style={styles.confidenceContainer}>
            <View
              style={[
                styles.confidenceBar,
                { width: `${confidence * 100}%` },
                confidence > 0.7 ? styles.highConfidence : styles.lowConfidence,
              ]}
            />
          </View>
        )}
      </View>

      {/* Ghost mode indicator */}
      {/* {isGhost && (
        <View style={styles.ghostIndicator}>
          <Text style={styles.ghostIndicatorText}>Ghost</Text>
        </View>
      )} */}

      {/* Tuned indicator */}
      {isTuned && isActive && !isGhost && (
        <View
          className=""
          style={{
            backgroundColor: paletteTokens.primary.surface[2],
            paddingHorizontal: 8,
            paddingVertical: 6,
            borderRadius: 99,
          }}
        >
          <Text style={styles.tunedBadgeText}>✓ IN TUNE</Text>
        </View>
      )}
    </View>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
  sideNoteContainer: {
    flexDirection: "row",
    alignItems: "baseline",
    width: 60,
    justifyContent: "center",
  },
  sideNoteText: {
    fontSize: 24,
    fontWeight: "500",
    color: COLORS.neutral,
  },
  sideOctaveText: {
    fontSize: 14,
    color: COLORS.neutral,
    marginLeft: 2,
  },
  currentNoteContainer: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
  },
  currentNoteText: {
    fontSize: 72,
    fontWeight: "bold",
  },
  currentOctaveText: {
    fontSize: 36,
    marginLeft: 4,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
    paddingHorizontal: 30,
    marginTop: 10,
  },
  frequencyText: {
    fontSize: 16,
    color: COLORS.neutral,
    fontVariant: ["tabular-nums"],
  },
  centsText: {
    fontSize: 18,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  tunedCentsText: {
    color: COLORS.tuned,
  },
  warningCentsText: {
    color: COLORS.warning,
  },
  ghostText: {
    opacity: 0.5,
  },
  confidenceContainer: {
    width: 60,
    height: 4,
    backgroundColor: COLORS.line,
    borderRadius: 2,
    overflow: "hidden",
  },
  confidenceBar: {
    height: "100%",
    borderRadius: 2,
  },
  highConfidence: {
    backgroundColor: COLORS.tuned,
  },
  lowConfidence: {
    backgroundColor: COLORS.warning,
  },
  ghostIndicator: {
    position: "absolute",
    top: 10,
    right: 20,
    backgroundColor: COLORS.ghost + "40",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  ghostIndicatorText: {
    fontSize: 12,
    color: COLORS.ghost,
    fontWeight: "500",
  },

  tunedBadgeText: {
    fontSize: 12,
    color: COLORS.tuned,
    fontWeight: "bold",
  },
});

export default SmoothTunerDisplay;
