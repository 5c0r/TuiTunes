import { afterAll, describe, expect, test } from 'bun:test';
import { fetchTranscriptUrl } from '../../src/providers/transcript';

const VTT_MINUTE_ONLY = 'WEBVTT\n\n00:01.000 --> 00:04.000\nMinute only cue\n';
const VTT_BODY_ONLY = '00:02.000 --> 00:04.000\nPathname cue\n';
const SRT_BODY = '1\n00:00:01,000 --> 00:00:04,000\nHello srt\n';

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: async (req) => {
    const { pathname } = new URL(req.url);
    switch (pathname) {
      case '/vtt-header':
        return new Response(VTT_MINUTE_ONLY, {
          headers: { 'content-type': 'text/vtt; charset=utf-8' },
        });
      case '/subs.vtt':
        return new Response(VTT_BODY_ONLY, { headers: { 'content-type': 'text/plain' } });
      case '/content-detect':
        return new Response(VTT_MINUTE_ONLY);
      case '/caption':
        return new Response(SRT_BODY, { headers: { 'content-type': 'text/plain' } });
      case '/html-error':
        return new Response('<!DOCTYPE html><html><body>Rate limited</body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      case '/empty.srt':
        return new Response('', { headers: { 'content-type': 'text/plain' } });
      case '/missing':
        return new Response('gone', { status: 404 });
      case '/slow':
        // Holds the response open; the caller aborts well before this fires.
        await Bun.sleep(300);
        return new Response(SRT_BODY);
      default:
        return new Response('not found', { status: 404 });
    }
  },
});

afterAll(() => {
  server.stop(true);
});

const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

describe('fetchTranscriptUrl', () => {
  test('selects VTT by content-type header and parses minute-only timestamps', async () => {
    const lines = await fetchTranscriptUrl(url('/vtt-header'));
    expect(lines).toEqual([{ time: 1, text: 'Minute only cue' }]);
  });

  test('selects VTT by pathname', async () => {
    const lines = await fetchTranscriptUrl(url('/subs.vtt'));
    expect(lines).toEqual([{ time: 2, text: 'Pathname cue' }]);
  });

  test('selects VTT by WEBVTT content marker', async () => {
    const lines = await fetchTranscriptUrl(url('/content-detect'));
    expect(lines).toEqual([{ time: 1, text: 'Minute only cue' }]);
  });

  test('parses SRT when no VTT signal is present', async () => {
    const lines = await fetchTranscriptUrl(url('/caption'));
    expect(lines).toEqual([{ time: 1, text: 'Hello srt' }]);
  });

  test('rejects HTML error pages served with 200', async () => {
    await expect(fetchTranscriptUrl(url('/html-error'))).rejects.toThrow('HTML document');
  });

  test('rejects empty subtitle bodies', async () => {
    await expect(fetchTranscriptUrl(url('/empty.srt'))).rejects.toThrow('no usable cues');
  });

  test('rejects non-2xx responses', async () => {
    await expect(fetchTranscriptUrl(url('/missing'))).rejects.toThrow('HTTP 404');
  });

  test('rejects when the caller aborts before the request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchTranscriptUrl(url('/slow'), controller.signal)).rejects.toThrow();
  });

  test('rejects when the caller aborts mid-flight', async () => {
    const controller = new AbortController();
    const pending = fetchTranscriptUrl(url('/slow'), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
