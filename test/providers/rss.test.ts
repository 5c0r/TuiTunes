import { describe, test, expect } from 'bun:test';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseFeed } from '../../src/providers/rss';

mkdirSync(join(homedir(), '.config', 'tuimusic'), { recursive: true });

const wrap = (items: string) =>
  `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;

const item = (inner: string) =>
  `<item>${inner}</item>`;

const enclosure = (url = 'https://example.com/ep.mp3') =>
  `<enclosure url="${url}" type="audio/mpeg" />`;

describe('parseFeed', () => {
  test('parses basic feed with one item', () => {
    const xml = wrap(item(`
      <title>Episode One</title>
      ${enclosure()}
      <guid>guid-1</guid>
      <itunes:duration>1:00:00</itunes:duration>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    `));
    const eps = parseFeed(xml, 'pod-1', 'My Podcast');
    expect(eps).toHaveLength(1);
    expect(eps[0].title).toBe('Episode One');
    expect(eps[0].audioUrl).toBe('https://example.com/ep.mp3');
    expect(eps[0].id).toBe('guid-1');
    expect(eps[0].duration).toBe(3600);
    expect(eps[0].publishDate).toContain('2024');
  });

  test('parses feed with multiple items', () => {
    const items = [1, 2, 3]
      .map(n => item(`<title>Ep ${n}</title>${enclosure(`https://example.com/${n}.mp3`)}<guid>g-${n}</guid><itunes:duration>60</itunes:duration>`))
      .join('');
    const eps = parseFeed(wrap(items), 'pod-1', 'P');
    expect(eps).toHaveLength(3);
    expect(eps.map(e => e.title)).toEqual(['Ep 1', 'Ep 2', 'Ep 3']);
  });

  test('skips items without enclosure', () => {
    const xml = wrap(
      item(`<title>No Audio</title><guid>g-skip</guid>`) +
      item(`<title>Has Audio</title>${enclosure()}<guid>g-keep</guid>`)
    );
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps).toHaveLength(1);
    expect(eps[0].title).toBe('Has Audio');
  });

  test('handles CDATA in title', () => {
    const xml = wrap(item(`
      <title><![CDATA[Episode & Title]]></title>
      ${enclosure()}
      <guid>g-cdata</guid>
    `));
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps[0].title).toBe('Episode & Title');
  });

  test('decodes HTML entities in title', () => {
    const xml = wrap(item(`
      <title>A &amp; B &lt; C &gt; D</title>
      ${enclosure()}
      <guid>g-ent</guid>
    `));
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps[0].title).toBe('A & B < C > D');
  });

  test('strips HTML from description', () => {
    const xml = wrap(item(`
      <title>Ep</title>
      ${enclosure()}
      <guid>g-html</guid>
      <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
    `));
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps[0].description).toBe('Hello world');
  });

  test('truncates description to 200 chars', () => {
    const longText = 'A'.repeat(300);
    const xml = wrap(item(`
      <title>Ep</title>
      ${enclosure()}
      <guid>g-long</guid>
      <description>${longText}</description>
    `));
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps[0].description!.length).toBe(200);
  });

  test('parses HH:MM:SS duration', () => {
    const xml = wrap(item(`
      <title>Ep</title>${enclosure()}<guid>g-d1</guid>
      <itunes:duration>1:30:00</itunes:duration>
    `));
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps[0].duration).toBe(5400);
  });

  test('parses MM:SS duration', () => {
    const xml = wrap(item(`
      <title>Ep</title>${enclosure()}<guid>g-d2</guid>
      <itunes:duration>45:00</itunes:duration>
    `));
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps[0].duration).toBe(2700);
  });

  test('parses plain seconds duration', () => {
    const xml = wrap(item(`
      <title>Ep</title>${enclosure()}<guid>g-d3</guid>
      <itunes:duration>3600</itunes:duration>
    `));
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps[0].duration).toBe(3600);
  });

  test('handles missing duration', () => {
    const xml = wrap(item(`
      <title>Ep</title>${enclosure()}<guid>g-nodur</guid>
    `));
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps[0].duration).toBe(0);
  });

  test('parses pubDate to ISO', () => {
    const xml = wrap(item(`
      <title>Ep</title>${enclosure()}<guid>g-pub</guid>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    `));
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps[0].publishDate).toBe('2024-01-01T00:00:00.000Z');
  });

  test('uses guid as id', () => {
    const xml = wrap(item(`
      <title>Ep</title>${enclosure()}<guid>my-unique-guid</guid>
    `));
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps[0].id).toBe('my-unique-guid');
  });

  test('generates hash id when no guid', () => {
    const xml = wrap(item(`
      <title>Ep</title>${enclosure()}
    `));
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps[0].id).toBeTruthy();
    expect(typeof eps[0].id).toBe('string');
    expect(eps[0].id.length).toBeGreaterThan(0);
  });

  test('extracts podcast:transcript url', () => {
    const xml = wrap(item(`
      <title>Ep</title>${enclosure()}<guid>g-tx</guid>
      <podcast:transcript url="https://example.com/t.vtt" type="text/vtt" />
    `));
    const eps = parseFeed(xml, 'pod-1', 'P');
    expect(eps[0].transcriptUrl).toBe('https://example.com/t.vtt');
  });

  test('passes podcastId and podcastTitle through', () => {
    const xml = wrap(
      item(`<title>A</title>${enclosure('https://a.mp3')}<guid>g-a</guid>`) +
      item(`<title>B</title>${enclosure('https://b.mp3')}<guid>g-b</guid>`)
    );
    const eps = parseFeed(xml, 'pod-99', 'Great Show');
    for (const ep of eps) {
      expect(ep.podcastId).toBe('pod-99');
      expect(ep.podcastTitle).toBe('Great Show');
    }
  });
});
