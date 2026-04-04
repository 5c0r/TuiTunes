import type { LyricLine } from './lyrics';

/** Parse SRT subtitle format to timed lines. */
export function parseSrt(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const blocks = text.trim().split(/\n\n+/);
  for (const block of blocks) {
    const parts = block.split('\n');
    if (parts.length < 3) continue;
    // parts[0] = sequence number, parts[1] = timestamps, parts[2..] = text
    const timeMatch = parts[1].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!timeMatch) continue;
    const time =
      parseInt(timeMatch[1], 10) * 3600 +
      parseInt(timeMatch[2], 10) * 60 +
      parseInt(timeMatch[3], 10) +
      parseInt(timeMatch[4], 10) / 1000;
    const lineText = parts.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
    if (lineText) lines.push({ time, text: lineText });
  }
  return lines;
}

/** Parse WebVTT subtitle format to timed lines. */
export function parseVtt(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const blocks = text.trim().split(/\n\n+/);
  for (const block of blocks) {
    // Skip header and metadata blocks
    if (block.startsWith('WEBVTT') || block.startsWith('Kind:') || block.startsWith('Language:')) continue;
    const parts = block.split('\n');
    // Find the timestamp line — may or may not have an index before it
    let timeLine = '';
    let textStartIdx = 0;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].includes('-->')) {
        timeLine = parts[i];
        textStartIdx = i + 1;
        break;
      }
    }
    if (!timeLine) continue;
    const timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
    if (!timeMatch) continue;
    const time =
      parseInt(timeMatch[1], 10) * 3600 +
      parseInt(timeMatch[2], 10) * 60 +
      parseInt(timeMatch[3], 10) +
      parseInt(timeMatch[4], 10) / 1000;
    const lineText = parts.slice(textStartIdx).join(' ').replace(/<[^>]+>/g, '').trim();
    if (lineText) lines.push({ time, text: lineText });
  }
  return lines;
}
