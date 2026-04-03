import type { Episode } from './podcast-types';

/**
 * Extract text content from an XML tag, handling CDATA sections.
 * Returns empty string if the tag is not found.
 */
function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, 'i');
  const match = xml.match(re);
  if (!match) return '';
  return (match[1] ?? match[2] ?? '').trim();
}

/**
 * Extract an attribute value from a self-closing or open tag.
 */
function extractAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*?${attr}\\s*=\\s*["']([^"']*)["']`, 'i');
  const match = xml.match(re);
  return match?.[1] ?? '';
}

/**
 * Parse duration string into seconds.
 * Handles plain seconds ("3600"), HH:MM:SS ("1:00:00"), MM:SS ("30:00").
 */
function parseDuration(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const parts = trimmed.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

/** Decode common HTML entities. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8211;/g, '\u2013')
    .replace(/&#038;/g, '&')
    .replace(/&#\d+;/g, (m) => String.fromCharCode(parseInt(m.slice(2, -1), 10)));
}

/** Strip HTML tags and collapse whitespace. */
function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Simple hash for generating episode IDs when no GUID is present. */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Parse an RSS feed XML string into Episode objects.
 * Uses regex-based parsing (no XML library dependency).
 */
export function parseFeed(xml: string, podcastId: string, podcastTitle: string): Episode[] {
  const episodes: Episode[] = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const itemXml = itemMatch[1];

    // Audio URL from enclosure is required — skip episodes without one
    const audioUrl = extractAttr(itemXml, 'enclosure', 'url');
    if (!audioUrl) continue;

    const title = decodeEntities(extractTag(itemXml, 'title'));
    const guid = extractTag(itemXml, 'guid');
    const id = guid || simpleHash(title + audioUrl);

    const rawDuration = extractTag(itemXml, 'itunes:duration');
    const duration = parseDuration(rawDuration);

    const pubDate = extractTag(itemXml, 'pubDate');
    let publishDate = '';
    if (pubDate) {
      const parsed = new Date(pubDate);
      publishDate = isNaN(parsed.getTime()) ? pubDate : parsed.toISOString();
    }

    const rawDesc = extractTag(itemXml, 'description');
    const description = stripHtml(rawDesc).slice(0, 200) || undefined;

    const transcriptUrl = extractAttr(itemXml, 'podcast:transcript', 'url') || undefined;

    episodes.push({
      id,
      podcastId,
      podcastTitle,
      title,
      audioUrl,
      duration,
      publishDate,
      description,
      transcriptUrl,
    });
  }

  return episodes;
}
