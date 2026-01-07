/**
 * Spring-Damper Animation Hooks
 *
 * These hooks implement the smooth animation system from Universal Tuner.
 * All animations run on the UI thread via Reanimated for 60fps performance.
 *
 * Key concepts:
 * 1. Spring-damper system: Critically damped spring for smooth, non-oscillating transitions
 * 2. Position animator: Accelerate/decelerate smoothly towards target
 * 3. All state updates happen on UI thread to avoid JS bridge latency
 */

import { useEffect, useCallback } from "react";
import {
  useSharedValue,
  useDerivedValue,
  withSpring,
  withTiming,
  Easing,
  SharedValue,
  runOnJS,
  useAnimatedReaction,
} from "react-native-reanimated";

// ============================================================================
// SPRING CONFIGURATION (from Universal Tuner's U.f class)
// ============================================================================

/**
 * Spring configuration for pitch indicator movement
 * These values are tuned to match Universal Tuner's feel
 */
export const SPRING_CONFIG = {
  // Stiffness: How quickly the spring pulls towards target (higher = faster)
  stiffness: 180,
  // Damping: How much the spring resists oscillation (higher = less bouncy)
  // For critical damping: damping = 2 * sqrt(stiffness)
  damping: 26,
  // Mass: Affects momentum (lower = more responsive)
  mass: 1,
  // Velocity: Initial velocity (usually 0)
  velocity: 0,
  // Rest thresholds
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 0.01,
};

/**
 * Timing configuration for note text changes
 */
export const NOTE_TIMING_CONFIG = {
  duration: 150,
  easing: Easing.out(Easing.cubic),
};

// ============================================================================
// SMOOTH PITCH HOOK
// ============================================================================

export interface SmoothPitchConfig {
  /** Spring stiffness (default: 180) */
  stiffness?: number;
  /** Spring damping (default: 26) */
  damping?: number;
  /** Mass (default: 1) */
  mass?: number;
}

/**
 * Hook that provides smooth spring-damper animation for pitch values.
 * Runs entirely on the UI thread for 60fps performance.
 *
 * @param targetCents - The target cents value to animate towards
 * @param isActive - Whether the tuner is actively detecting
 * @param config - Optional spring configuration
 * @returns SharedValue<number> that smoothly animates to target
 */
export function useSmoothCents(
  targetCents: number,
  isActive: boolean,
  config?: SmoothPitchConfig
): SharedValue<number> {
  const smoothCents = useSharedValue(0);

  const springConfig = {
    stiffness: config?.stiffness ?? SPRING_CONFIG.stiffness,
    damping: config?.damping ?? SPRING_CONFIG.damping,
    mass: config?.mass ?? SPRING_CONFIG.mass,
    restDisplacementThreshold: SPRING_CONFIG.restDisplacementThreshold,
    restSpeedThreshold: SPRING_CONFIG.restSpeedThreshold,
  };

  useEffect(() => {
    if (isActive) {
      // Clamp cents to [-50, 50] range
      const clampedCents = Math.max(-50, Math.min(50, targetCents));
      smoothCents.value = withSpring(clampedCents, springConfig);
    } else {
      // When inactive, smoothly return to center
      smoothCents.value = withSpring(0, {
        ...springConfig,
        stiffness: springConfig.stiffness * 0.5, // Slower return
      });
    }
  }, [targetCents, isActive]);

  return smoothCents;
}

// ============================================================================
// SMOOTH NOTE TRANSITION HOOK
// ============================================================================

export interface NoteTransitionState {
  /** Current note name (animated opacity) */
  currentNote: string;
  /** Current octave */
  currentOctave: number;
  /** Opacity for fade transitions */
  opacity: SharedValue<number>;
  /** Scale for pop-in effect */
  scale: SharedValue<number>;
}

/**
 * Hook that provides smooth note transitions with fade/scale effects.
 *
 * @param noteName - Current detected note name
 * @param octave - Current detected octave
 * @param isActive - Whether tuner is actively detecting
 */
export function useSmoothNoteTransition(
  noteName: string,
  octave: number,
  isActive: boolean
): NoteTransitionState {
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.8);

  useEffect(() => {
    if (isActive && noteName !== "-") {
      // Fade in and scale up
      opacity.value = withTiming(1, NOTE_TIMING_CONFIG);
      scale.value = withSpring(1, {
        stiffness: 300,
        damping: 20,
      });
    } else {
      // Fade out
      opacity.value = withTiming(0.3, { duration: 200 });
      scale.value = withTiming(0.95, { duration: 200 });
    }
  }, [noteName, octave, isActive]);

  return {
    currentNote: noteName,
    currentOctave: octave,
    opacity,
    scale,
  };
}

// ============================================================================
// TUNED INDICATOR HOOK
// ============================================================================

export interface TunedIndicatorState {
  /** Whether currently in tune */
  isTuned: SharedValue<boolean>;
  /** Glow intensity (0-1) for tuned state */
  glowIntensity: SharedValue<number>;
  /** Pulse animation value */
  pulse: SharedValue<number>;
}

/**
 * Hook that manages the "tuned" indicator with glow and pulse effects.
 * Implements hysteresis: requires sustained accuracy to show tuned,
 * and sustained deviation to hide it.
 *
 * @param cents - Current cents deviation
 * @param isActive - Whether tuner is actively detecting
 * @param tunedThreshold - Cents threshold to be considered in tune (default: 5)
 * @param untunedThreshold - Cents threshold to leave tuned state (default: 8)
 */
export function useTunedIndicator(
  cents: number,
  isActive: boolean,
  tunedThreshold: number = 5,
  untunedThreshold: number = 8
): TunedIndicatorState {
  const isTuned = useSharedValue(false);
  const glowIntensity = useSharedValue(0);
  const pulse = useSharedValue(1);

  // Track consecutive frames for hysteresis
  const tunedFrames = useSharedValue(0);
  const untunedFrames = useSharedValue(0);

  // Thresholds for state changes (from Universal Tuner)
  const FRAMES_TO_TUNE = 4; // Need 4 consistent readings to show tuned
  const FRAMES_TO_UNTUNE = 8; // Need 8 consistent readings to hide tuned

  useEffect(() => {
    if (!isActive) {
      // Reset when inactive
      isTuned.value = false;
      glowIntensity.value = withTiming(0, { duration: 300 });
      tunedFrames.value = 0;
      untunedFrames.value = 0;
      return;
    }

    const absCents = Math.abs(cents);

    if (absCents <= tunedThreshold) {
      // Within tuned threshold
      tunedFrames.value++;
      untunedFrames.value = 0;

      if (tunedFrames.value >= FRAMES_TO_TUNE && !isTuned.value) {
        // Transition to tuned state
        isTuned.value = true;
        glowIntensity.value = withSpring(1, {
          stiffness: 200,
          damping: 15,
        });
        // Pulse effect
        pulse.value = withSpring(1.1, { stiffness: 400, damping: 10 }, () => {
          pulse.value = withSpring(1, { stiffness: 200, damping: 15 });
        });
      }
    } else if (absCents >= untunedThreshold) {
      // Outside untuned threshold (hysteresis)
      untunedFrames.value++;
      tunedFrames.value = 0;

      if (untunedFrames.value >= FRAMES_TO_UNTUNE && isTuned.value) {
        // Transition out of tuned state
        isTuned.value = false;
        glowIntensity.value = withTiming(0, { duration: 300 });
      }
    } else {
      // In between thresholds - maintain current state
      tunedFrames.value = 0;
      untunedFrames.value = 0;
    }
  }, [cents, isActive]);

  return {
    isTuned,
    glowIntensity,
    pulse,
  };
}

/**
 * Hook for animating detection confidence level
 *
 * @param confidence - Detection confidence (0-1)
 * @param isActive - Whether tuner is active
 */
export function useSmoothConfidence(
  confidence: number,
  isActive: boolean
): SharedValue<number> {
  const smoothConfidence = useSharedValue(0);

  useEffect(() => {
    if (isActive) {
      smoothConfidence.value = withSpring(confidence, {
        stiffness: 100,
        damping: 15,
      });
    } else {
      smoothConfidence.value = withTiming(0, { duration: 200 });
    }
  }, [confidence, isActive]);

  return smoothConfidence;
}

// ============================================================================
// COMBINED TUNER ANIMATION STATE
// ============================================================================

export interface TunerAnimationState {
  /** Smoothly animated cents value */
  smoothCents: SharedValue<number>;
  /** Tuned indicator state */
  tunedState: TunedIndicatorState;
  /** Detection confidence (0-1) */
  confidence: SharedValue<number>;
  /** Note transition state */
  noteTransition: NoteTransitionState;
}

/**
 * Combined hook that provides all animation state for the tuner display.
 * This is the main hook to use in your TunerDisplay component.
 */
export function useTunerAnimations(
  cents: number,
  noteName: string,
  octave: number,
  detectionConfidence: number,
  isActive: boolean
): TunerAnimationState {
  const smoothCents = useSmoothCents(cents, isActive);
  const tunedState = useTunedIndicator(cents, isActive);
  const confidence = useSmoothConfidence(detectionConfidence, isActive);
  const noteTransition = useSmoothNoteTransition(noteName, octave, isActive);

  return {
    smoothCents,
    tunedState,
    confidence,
    noteTransition,
  };
}
