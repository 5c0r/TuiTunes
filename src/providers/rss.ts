import type { Episode } from './podcast-types';

const NAMED_XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

// Longest supported entity body is "#x10FFFF" (8 chars); anything past this
// window is literal text, not an entity reference.
const MAX_ENTITY_LENGTH = 12;

function decodeEntityBody(body: string): string | undefined {
  const named = NAMED_XML_ENTITIES[body];
  if (named !== undefined) return named;
  if (!body.startsWith('#')) return undefined;
  const digits = body.slice(1);
  const hex = digits.startsWith('x') || digits.startsWith('X');
  const numerals = hex ? digits.slice(1) : digits;
  if (numerals.length === 0) return undefined;
  const validNumerals = hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/;
  if (!validNumerals.test(numerals)) return undefined;
  const codePoint = Number.parseInt(numerals, hex ? 16 : 10);
  if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return undefined;
  return String.fromCodePoint(codePoint);
}

/**
 * Single-pass XML entity decoder. Named entities plus decimal/hex numeric
 * character references are decoded once; unknown or malformed references are
 * preserved literally. `&amp;lt;` therefore decodes to `&lt;`, not `<`.
 */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  let result = '';
  let cursor = 0;
  for (;;) {
    const ampersand = text.indexOf('&', cursor);
    if (ampersand === -1) {
      return result + text.slice(cursor);
    }
    result += text.slice(cursor, ampersand);
    const semicolon = text.indexOf(';', ampersand + 1);
    if (semicolon === -1 || semicolon - ampersand > MAX_ENTITY_LENGTH) {
      result += '&';
      cursor = ampersand + 1;
      continue;
    }
    const decoded = decodeEntityBody(text.slice(ampersand + 1, semicolon));
    result += decoded ?? text.slice(ampersand, semicolon + 1);
    cursor = semicolon + 1;
  }
}

/**
 * Extract text content from the first matching XML tag, handling CDATA
 * sections. The tag name must match on token boundaries. Returns '' if absent.
 */
function extractTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, 'i').exec(xml);
  if (!match) return '';
  const content = match[1]!;
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(content);
  return (cdata?.[1] ?? content).trim();
}

/**
 * Extract an attribute value from the first matching tag. Tag and attribute
 * names must match on token boundaries; the value is returned still encoded.
 */
function extractAttr(xml: string, tag: string, attr: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*?\\s${attr}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(
    xml,
  );
  return match?.[2] ?? '';
}

/**
 * Parse duration string into seconds.
 * Handles plain seconds ("3600"), HH:MM:SS ("1:00:00"), MM:SS ("30:00").
 */
function parseDuration(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const parts = trimmed.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return 0;
}

/** Strip HTML tags, decode entities once, and collapse whitespace. */
function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
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
  const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi;

  for (;;) {
    const itemMatch = itemRegex.exec(xml);
    if (!itemMatch) break;
    const itemXml = itemMatch[1]!;

    // Audio URL from enclosure is required — skip episodes without one
    const audioUrl = decodeEntities(extractAttr(itemXml, 'enclosure', 'url'));
    if (!audioUrl) continue;

    const title = decodeEntities(extractTag(itemXml, 'title'));
    const guid = extractTag(itemXml, 'guid');
    const id = guid || simpleHash(title + audioUrl);

    const duration = parseDuration(extractTag(itemXml, 'itunes:duration'));

    const pubDate = extractTag(itemXml, 'pubDate');
    let publishDate = '';
    if (pubDate) {
      const parsed = new Date(pubDate);
      publishDate = Number.isNaN(parsed.getTime()) ? pubDate : parsed.toISOString();
    }

    const description = stripHtml(extractTag(itemXml, 'description')).slice(0, 200) || undefined;

    const transcriptUrl = decodeEntities(extractAttr(itemXml, 'podcast:transcript', 'url'));

    episodes.push({
      id,
      podcastId,
      podcastTitle,
      title,
      audioUrl,
      duration,
      publishDate,
      description,
      transcriptUrl: transcriptUrl || undefined,
    });
  }

  return episodes;
}
