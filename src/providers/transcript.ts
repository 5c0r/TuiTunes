import type { LyricLine } from './lyrics';
import { parseSrt, parseVtt } from './subtitle-parser';

const TRANSCRIPT_TIMEOUT_MS = 10_000;

/** One deadline covering connection, headers, and the full body read. */
function deadlineSignal(callerSignal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TRANSCRIPT_TIMEOUT_MS);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

function looksLikeHtml(text: string): boolean {
  const leading = text.trimStart().slice(0, 256).toLowerCase();
  return leading.startsWith('<!doctype html') || leading.startsWith('<html');
}

/**
 * Fetch a subtitle document from a transcript URL and parse it to timed
 * lines. VTT is selected by pathname, content type, or a leading WEBVTT
 * marker; anything else is parsed as SRT. Non-2xx responses, HTML error
 * pages, and empty or unparseable documents are rejected, never returned as
 * an empty success.
 */
export async function fetchTranscriptUrl(url: string, signal?: AbortSignal): Promise<LyricLine[]> {
  const response = await fetch(url, { signal: deadlineSignal(signal) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching transcript from ${url}`);
  }
  const text = await response.text();
  if (looksLikeHtml(text)) {
    throw new Error(`Transcript at ${url} is an HTML document, not subtitles`);
  }

  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Relative or malformed URL — fall back to header and content detection.
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const isVtt =
    pathname.toLowerCase().endsWith('.vtt') ||
    contentType.includes('vtt') ||
    text.trimStart().startsWith('WEBVTT');
  const lines = isVtt ? parseVtt(text) : parseSrt(text);
  if (lines.length === 0) {
    throw new Error(`Transcript at ${url} contained no usable cues`);
  }
  return lines;
}
