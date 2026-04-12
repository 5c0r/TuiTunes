import type { LyricLine } from '../providers/lyrics';

export interface TranscriptMatch {
  text: string;
  time: number;
  idx: number;
}

/**
 * Search transcript lines for text matches.
 * Returns matching lines with their timestamps and original indices.
 * Case-insensitive substring matching.
 */
export function searchTranscript(lines: LyricLine[], query: string): TranscriptMatch[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  return lines
    .map((line, idx) => ({ text: line.text, time: line.time, idx }))
    .filter(({ text }) => text.toLowerCase().includes(q));
}
