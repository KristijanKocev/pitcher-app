/**
 * Hooks Index
 *
 * Export all tuner-related hooks for easy importing
 */

// Smooth animation hooks (UI thread)
export {
  useSmoothCents,
  useSmoothNoteTransition,
  useTunedIndicator,
  useSmoothSignalLevel,
  useSmoothConfidence,
  useTunerAnimations,
  SPRING_CONFIG,
  NOTE_TIMING_CONFIG,
  type SmoothPitchConfig,
  type NoteTransitionState,
  type TunedIndicatorState,
  type TunerAnimationState,
} from "./useSmoothAnimations";

// Pitch stabilization hooks (JS thread)
export {
  usePitchStabilization,
  useStableNote,
  useGhostPitch,
  STABILIZATION_CONFIG,
  type PitchReading,
  type StabilizedPitch,
  type UsePitchStabilizationOptions,
  type UsePitchStabilizationResult,
} from "./usePitchStabilization";
