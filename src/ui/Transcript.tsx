import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { TextAttributes } from '@opentui/core';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useTheme } from './useTheme';
import { lyricsDataAtom, lyricsLoadingAtom } from '../store/lyrics';
import { playerPositionAtom } from '../store/player';
import type { LyricLine } from '../providers/lyrics';

/**
 * Smart paragraph grouping for podcast transcripts.
 *
 * YouTube auto-captions have overlapping segments with NO useful time gaps.
 * Instead, we use sentence-ending punctuation as the primary break signal,
 * with a safety cap to prevent walls of text.
 */
interface Paragraph {
  startTime: number;
  endTime: number;
  segments: LyricLine[];
}

const SENTENCE_ENDINGS = /[.?!]\s*$/;
const MIN_PARA_SEGMENTS = 3;
const MAX_PARA_SEGMENTS = 20;

function groupIntoParagraphs(lines: LyricLine[]): Paragraph[] {
  if (lines.length === 0) return [];

  const paragraphs: Paragraph[] = [];
  let segments: LyricLine[] = [];

  function flush(): void {
    if (segments.length === 0) return;
    paragraphs.push({
      startTime: segments[0].time,
      endTime: segments[segments.length - 1].time,
      segments: [...segments],
    });
    segments = [];
  }

  for (const line of lines) {
    segments.push(line);

    // Primary signal: sentence-ending punctuation (. ? !)
    // but only if paragraph is long enough to avoid tiny fragments
    if (SENTENCE_ENDINGS.test(line.text) && segments.length >= MIN_PARA_SEGMENTS) {
      flush();
      continue;
    }

    // Safety cap: force break if too many segments without punctuation
    if (segments.length >= MAX_PARA_SEGMENTS) {
      flush();
    }
  }

  flush();
  return paragraphs;
}

/** Find which paragraph contains the current playback position. */
function findCurrentParagraph(paragraphs: Paragraph[], position: number): number {
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (paragraphs[i].startTime <= position) return i;
  }
  return -1;
}

/** Find which segment within a paragraph is currently active. */
function findCurrentSegment(segments: LyricLine[], position: number): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].time <= position) return i;
  }
  return -1;
}

/**
 * Podcast transcript display — flowing text with inline phrase highlighting.
 *
 * Renders as readable paragraphs (like a book). The current phrase is
 * highlighted inline with accent color. Past text is slightly dimmed.
 * No timestamps, no borders per block, no visual clutter.
 */
export function Transcript() {
  const t = useTheme();
  const data = useAtomValue(lyricsDataAtom);
  const loading = useAtomValue(lyricsLoadingAtom);
  const position = useAtomValue(playerPositionAtom);
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  const paragraphs = data?.synced ? groupIntoParagraphs(data.lines) : [];
  const currentParaIdx = paragraphs.length > 0 ? findCurrentParagraph(paragraphs, position) : -1;

  // Page-based scroll: use OpenTUI's built-in scrollChildIntoView.
  // It scrolls the minimum amount needed to make the child visible —
  // if already on screen, it doesn't scroll at all (like turning pages).
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb || currentParaIdx < 0) return;
    sb.scrollChildIntoView(`para-${currentParaIdx}`);
  }, [currentParaIdx]);

  if (loading) {
    return (
      <box
        border
        borderStyle="rounded"
        borderColor={t.border}
        title="Transcript"
        flexGrow={1}
        paddingLeft={1}
      >
        <text fg={t.dim}>Loading transcript...</text>
      </box>
    );
  }

  if (!data || data.lines.length === 0) {
    return (
      <box
        border
        borderStyle="rounded"
        borderColor={t.border}
        title="Transcript"
        flexGrow={1}
        paddingLeft={1}
      >
        <text fg={t.dim}>No transcript available</text>
      </box>
    );
  }

  // Unsynced: plain flowing text
  if (!data.synced) {
    return (
      <box
        border
        borderStyle="rounded"
        borderColor={t.border}
        title="Transcript"
        flexGrow={1}
        flexDirection="column"
      >
        <scrollbox ref={scrollRef}>
          <text fg={t.fg} wrapMode="word" paddingLeft={1} paddingRight={1}>
            {data.lines.map((l) => l.text).join(' ')}
          </text>
        </scrollbox>
        <box paddingLeft={1}>
          <text fg={t.border} attributes={TextAttributes.DIM}>
            Source: {data.source}
            {data.sourceUrl ? ` • ${data.sourceUrl}` : ''}
          </text>
        </box>
      </box>
    );
  }

  // Synced: paragraph-level highlighting with inline phrase accent
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={t.accent}
      title="Transcript"
      flexGrow={1}
      flexDirection="column"
    >
      <scrollbox ref={scrollRef}>
        {paragraphs.map((para, paraIdx) => {
          const isPast = currentParaIdx >= 0 && paraIdx < currentParaIdx;
          const isCurrent = currentParaIdx === paraIdx;
          const _isFuture = currentParaIdx >= 0 && paraIdx > currentParaIdx;
          const currentSegIdx = isCurrent ? findCurrentSegment(para.segments, position) : -1;

          // Paragraph-level color
          const paraColor = isCurrent ? t.fg : isPast ? t.dim : t.border;

          return (
            <box
              key={paraIdx}
              id={`para-${paraIdx}`}
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
              paddingBottom={1}
              marginBottom={1}
              backgroundColor={isCurrent ? t.selection : undefined}
            >
              <text wrapMode="word">
                {para.segments.map((seg, segIdx) => {
                  // Current phrase within current paragraph: accent + bold
                  if (isCurrent && segIdx === currentSegIdx) {
                    return (
                      <span key={segIdx} fg={t.accent} attributes={TextAttributes.BOLD}>
                        {seg.text}{' '}
                      </span>
                    );
                  }

                  // Everything else in this paragraph: paragraph-level color
                  return (
                    <span key={segIdx} fg={paraColor}>
                      {seg.text}{' '}
                    </span>
                  );
                })}
              </text>
            </box>
          );
        })}
      </scrollbox>
      {/* Source attribution */}
      <box paddingLeft={1}>
        <text fg={t.border} attributes={TextAttributes.DIM}>
          Source: {data.source}
          {data.sourceUrl ? ` • ${data.sourceUrl}` : ''}
        </text>
      </box>
    </box>
  );
}
