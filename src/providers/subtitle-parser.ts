import type { LyricLine } from './lyrics';

const SRT_TIME_LINE = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})\s*-->/;
const VTT_TIME_LINE = /^(?:(\d{2,}):)?(\d{2,}):(\d{2})\.(\d{3})\s*-->/;
// Header, comment, and style/region declaration blocks carry no cues.
const VTT_METADATA_BLOCK = /^(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)/;

/**
 * Split into blocks of consecutive nonblank lines, normalizing a leading BOM
 * and CRLF/bare-CR line endings to LF first. A separator line may be empty or
 * whitespace-only; repeated separators produce no empty blocks.
 */
function splitBlocks(text: string): string[][] {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of withoutBom.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim().length === 0) {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** Locate the timestamp line; it is first or preceded by one cue identifier. */
function timestampIndex(block: readonly string[]): number {
  const timeIndex = block.findIndex((line) => line.includes('-->'));
  return timeIndex >= 0 && timeIndex <= 1 ? timeIndex : -1;
}

/** Parse SRT subtitle format to timed lines. */
export function parseSrt(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const block of splitBlocks(text)) {
    const timeIndex = timestampIndex(block);
    if (timeIndex < 0) continue;
    const match = SRT_TIME_LINE.exec(block[timeIndex]!);
    if (!match) continue;
    const minutes = Number.parseInt(match[2]!, 10);
    const seconds = Number.parseInt(match[3]!, 10);
    if (minutes > 59 || seconds > 59) continue;
    const cueText = block
      .slice(timeIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (cueText.length === 0) continue;
    const hours = Number.parseInt(match[1]!, 10);
    const millis = Number.parseInt(match[4]!, 10);
    lines.push({ time: hours * 3600 + minutes * 60 + seconds + millis / 1000, text: cueText });
  }
  return lines;
}

/** Parse WebVTT subtitle format to timed lines. */
export function parseVtt(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const block of splitBlocks(text)) {
    if (VTT_METADATA_BLOCK.test(block[0]!)) continue;
    const timeIndex = timestampIndex(block);
    if (timeIndex < 0) continue;
    const match = VTT_TIME_LINE.exec(block[timeIndex]!);
    if (!match) continue;
    const minutes = Number.parseInt(match[2]!, 10);
    const seconds = Number.parseInt(match[3]!, 10);
    if (minutes > 59 || seconds > 59) continue;
    const cueText = block
      .slice(timeIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (cueText.length === 0) continue;
    const hours = match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
    const millis = Number.parseInt(match[4]!, 10);
    lines.push({ time: hours * 3600 + minutes * 60 + seconds + millis / 1000, text: cueText });
  }
  return lines;
}
