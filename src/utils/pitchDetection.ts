// Note frequencies (A4 = 440Hz)
const NOTE_STRINGS = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

export function frequencyToNote(frequency: number) {
  const noteNum = 12 * (Math.log(frequency / 440) / Math.log(2));
  const roundedNote = Math.round(noteNum) + 69;
  const cents = Math.floor((noteNum - Math.round(noteNum)) * 100);

  const octave = Math.floor(roundedNote / 12) - 1;
  const noteName = NOTE_STRINGS[roundedNote % 12];

  // Calculate previous and next notes
  const prevNoteIndex = (roundedNote - 1 + 12) % 12;
  const nextNoteIndex = (roundedNote + 1) % 12;
  const prevOctave = Math.floor((roundedNote - 1) / 12) - 1;
  const nextOctave = Math.floor((roundedNote + 1) / 12) - 1;

  return {
    noteName,
    octave,
    cents,
    frequency: frequency.toFixed(1),
    prevNote: NOTE_STRINGS[prevNoteIndex],
    prevOctave,
    nextNote: NOTE_STRINGS[nextNoteIndex],
    nextOctave,
  };
}
