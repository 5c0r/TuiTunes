import { expect, test } from 'bun:test';
import { createStore } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import { createPlaybackSession, type PlaybackSession } from '../../src/application/playback';
import type { PlayerLoadOptions } from '../../src/player/types';
import { mediaKey } from '../../src/providers/media';
import type { Episode } from '../../src/providers/podcast-types';
import type {
  PlaybackSourcePreference,
  PlaybackTarget,
  ResolvedPlaybackSource,
  Track,
} from '../../src/providers/types';
import { playerErrorAtom, playerPlaybackAtom, playerStateAtom } from '../../src/store/player';
import { queueStateAtom } from '../../src/store/queue';
import { createTestPlayer, type TestPlayer } from '../helpers/player';

const track = (id: string): Track => ({
  id,
  provider: 'youtube',
  source: { kind: 'youtube', videoId: id },
  title: id,
  artist: 'Artist',
  duration: 1,
});
const episode = (id: string): Episode => ({
  id,
  podcastId: 'feed',
  podcastTitle: 'Podcast',
  title: `Episode ${id}`,
  audioUrl: `https://audio.test/${id}`,
  transcriptUrl: `https://transcript.test/${id}`,
  duration: 10,
  publishDate: '2026-01-01',
});
const episodeTrack = (id: string): Track => ({
  id,
  provider: 'podcast',
  source: { kind: 'podcast', episode: episode(id) },
  title: `Episode ${id}`,
  artist: 'Podcast',
  duration: 10,
});
const youtube = (
  videoId: string,
  selection: ResolvedPlaybackSource['selection'] = 'auto',
): ResolvedPlaybackSource => ({
  kind: 'youtube',
  videoId,
  url: `https://www.youtube.com/watch?v=${videoId}`,
  selection,
});
type Resolve = (
  value: Track,
  signal: AbortSignal,
  preference: PlaybackSourcePreference,
) => Promise<ResolvedPlaybackSource>;
const defaultResolve: Resolve = async (value) => youtube(value.id);
/** Resolver that honors explicit policies like the real provider resolver. */
const honoringResolve: Resolve = async (value, _signal, preference) => {
  if (preference.mode === 'youtube-video') return youtube(preference.videoId, 'youtube-video');
  if (preference.mode === 'rss' && value.source?.kind === 'podcast')
    return {
      kind: 'rss',
      url: value.source.episode.audioUrl,
      transcriptUrl: value.source.episode.transcriptUrl,
      selection: 'rss',
    };
  return youtube(value.id);
};
interface Harness {
  store: Store;
  fake: TestPlayer;
  history: string[];
  preferences: Map<string, PlaybackSourcePreference>;
  requested: { key: string; preference: PlaybackSourcePreference }[];
  session: PlaybackSession;
  ids: string[];
}
function setup(resolve: Resolve = defaultResolve, failingSaves = new Set<string>()): Harness {
  const store = createStore(),
    fake = createTestPlayer(store);
  const history: string[] = [];
  const preferences = new Map<string, PlaybackSourcePreference>();
  const requested: { key: string; preference: PlaybackSourcePreference }[] = [];
  const session = createPlaybackSession(store, fake.player, {
    resolve: (value, signal, preference) => {
      const policy = preference ?? { mode: 'auto' };
      requested.push({ key: mediaKey(value), preference: policy });
      return resolve(value, signal, policy);
    },
    onLoaded: (target) => {
      history.push(target.track.id);
    },
    getSourcePreference: (key) => preferences.get(key) ?? { mode: 'auto' },
    saveSourcePreference: (key, pref) => {
      if (failingSaves.has(key)) throw new Error('preference write failed');
      preferences.set(key, pref);
    },
  });
  for (const id of ['a', 'b', 'c']) session.enqueue(track(id));
  return {
    store,
    fake,
    history,
    preferences,
    requested,
    session,
    ids: store.get(queueStateAtom).order,
  };
}
/** Records every player.play call including its load options. */
function capturePlay(fake: TestPlayer): { target: PlaybackTarget; options?: PlayerLoadOptions }[] {
  const calls: { target: PlaybackTarget; options?: PlayerLoadOptions }[] = [];
  const original = fake.player.play.bind(fake.player);
  fake.player.play = async (target, options) => {
    calls.push({ target, options });
    return original(target, options);
  };
  return calls;
}

test('shuffled selection advances by entry identity and direct playback never resumes queue', async () => {
  const { store, fake, session, ids } = setup();
  store.set(queueStateAtom, (state) => ({
    ...state,
    shuffle: true,
    order: [ids[2], ids[0], ids[1]],
  }));
  await session.playQueueEntry(ids[0]);
  await session.next();
  expect(fake.played.map((target) => target.track.id)).toEqual(['a', 'b']);
  await session.playDirect(track('podcast-direct'));
  await session.next();
  fake.emitEnd(fake.played.at(-1)!);
  expect(fake.played.map((target) => target.track.id)).toEqual(['a', 'b', 'podcast-direct']);
  await session.dispose();
});
test('current removal advances immediately and removal of sole entry stops', async () => {
  const { store, fake, session, ids } = setup();
  await session.playQueueEntry(ids[1]);
  await session.remove(ids[1]);
  expect(fake.played.at(-1)?.track.id).toBe('c');
  await session.remove(ids[0]);
  await session.remove(ids[2]);
  expect(store.get(queueStateAtom).cursorId).toBeNull();
  expect(fake.stopCalls).toBe(2);
  await session.dispose();
});
test('late resolutions cannot play or overwrite a newer error; recovery history deduplicates', async () => {
  const requests = new Map<string, PromiseWithResolvers<ResolvedPlaybackSource>>();
  const { fake, session, history } = setup((value) => {
    const deferred = Promise.withResolvers<ResolvedPlaybackSource>();
    requests.set(value.id, deferred);
    return deferred.promise;
  });
  const a = session.playDirect(track('a')),
    b = session.playDirect(track('b'));
  requests.get('b')!.resolve(youtube('b'));
  await b;
  requests.get('a')!.resolve(youtube('a'));
  await a;
  expect(fake.played.map((target) => target.track.id)).toEqual(['b']);
  fake.emitLoaded(fake.played[0]);
  fake.emitLoaded(fake.played[0]);
  expect(history).toEqual(['b']);
  await session.dispose();
});
test('failed resolution restores committed origin and its recovery/EOF callbacks; unsupported items preserve queue', async () => {
  let bRequests = 0;
  const { store, fake, history, session, ids } = setup(async (value) => {
    if (value.id === 'b' && ++bRequests === 1) throw new Error('lookup failed');
    return youtube(value.id);
  });
  try {
    await session.playQueueEntry(ids[0]);
    const a = fake.played[0];
    await session.playQueueEntry(ids[1]);
    expect(store.get(queueStateAtom).cursorId).toBe(ids[0]);

    const advanced = Promise.withResolvers<void>();
    const play = fake.player.play;
    fake.player.play = async (target) => {
      await play(target);
      if (target.track.id === 'b') advanced.resolve();
    };
    fake.emitLoaded(a);
    fake.emitLoaded(a);
    fake.emitEnd(a);
    expect(bRequests).toBe(2);
    expect(history).toEqual(['a']);
    await advanced.promise;
    expect(fake.played.map((target) => target.track.id)).toEqual(['a', 'b']);
    expect(store.get(queueStateAtom).cursorId).toBe(ids[1]);

    const b = fake.played[1];
    fake.emitLoaded({ ...b });
    fake.emitLoaded(b);
    fake.emitLoaded(a);
    fake.emitEnd(a);
    expect(history).toEqual(['a', 'b']);
    expect(store.get(queueStateAtom).cursorId).toBe(ids[1]);

    const before = store.get(queueStateAtom);
    await session.playDirect({ ...track('legacy'), source: null });
    session.enqueue({ ...track('legacy'), source: null });
    expect(store.get(queueStateAtom)).toBe(before);
    expect(store.get(playerErrorAtom)).toBe('This saved item has no supported playback source.');
  } finally {
    await session.dispose();
  }
});

test('removing audible A preserves pending B, while removing pending C prevents its late start', async () => {
  const pending = new Map<
    string,
    { promise: Promise<ResolvedPlaybackSource>; resolve: (value: ResolvedPlaybackSource) => void }
  >();
  const { store, fake, session, ids } = setup((value) => {
    if (value.id === 'a') return Promise.resolve(youtube(value.id));
    const work = Promise.withResolvers<ResolvedPlaybackSource>();
    pending.set(value.id, work);
    return work.promise;
  });
  await session.playQueueEntry(ids[0]);
  const b = session.playQueueEntry(ids[1]);
  fake.emitEnd(fake.played[0]);
  expect(store.get(queueStateAtom).cursorId).toBe(ids[1]);
  await session.remove(ids[0]);
  pending.get('b')!.resolve(youtube('b'));
  await b;
  expect(fake.played.map((value) => value.track.id)).toEqual(['a', 'b']);
  const c = session.playQueueEntry(ids[2]);
  await session.remove(ids[2]);
  pending.get('c')!.resolve(youtube('c'));
  await c;
  expect(fake.played.map((value) => value.track.id)).toEqual(['a', 'b']);
  await session.dispose();
});

test('every ordinary play reads the episode saved preference', async () => {
  const { fake, requested, preferences, session } = setup(honoringResolve);
  const ep = episodeTrack('e1');
  preferences.set(mediaKey(ep), { mode: 'rss' });
  await session.playDirect(ep);
  expect(requested.at(-1)).toEqual({ key: mediaKey(ep), preference: { mode: 'rss' } });
  expect(fake.played[0].source.selection).toBe('rss');
  await session.dispose();
});

test('future-only saves persist policy without touching audio; equal saves are unchanged', async () => {
  const { store, fake, preferences, session } = setup();
  await session.playDirect(track('a'));
  const ep = episodeTrack('e1');
  expect(await session.setSourcePreference(ep, { mode: 'rss' }, null)).toEqual({ status: 'saved' });
  expect(preferences.get(mediaKey(ep))).toEqual({ mode: 'rss' });
  expect(await session.setSourcePreference(ep, { mode: 'rss' }, null)).toEqual({
    status: 'unchanged',
  });
  expect(fake.played.map((target) => target.track.id)).toEqual(['a']);
  expect(store.get(playerErrorAtom)).toBeNull();
  await session.dispose();
});

test('same-audio policy change saves without reload, seek, history or committed rewrite', async () => {
  const { store, fake, history, preferences, session } = setup(honoringResolve);
  const ep = episodeTrack('e1');
  await session.playDirect(ep);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  store.set(playerStateAtom, 'playing');
  expect(
    await session.setSourcePreference(
      ep,
      { mode: 'youtube-video', videoId: 'e1' },
      committed.requestId,
    ),
  ).toEqual({ status: 'saved' });
  expect(fake.played).toHaveLength(1);
  expect(history).toEqual(['e1']);
  expect(store.get(playerPlaybackAtom)).toBe(committed);
  expect(preferences.get(mediaKey(ep))).toEqual({ mode: 'youtube-video', videoId: 'e1' });
  expect(
    await session.setSourcePreference(
      ep,
      { mode: 'youtube-video', videoId: 'e1' },
      committed.requestId,
    ),
  ).toEqual({ status: 'unchanged' });
  await session.dispose();
});

test('genuine switch keeps origin and queue identity, preserves pause, commits on its loaded event', async () => {
  const harness = setup(honoringResolve);
  const { store, fake, history, preferences, session } = harness;
  const ep = episodeTrack('e1');
  session.enqueue(ep);
  const order = store.get(queueStateAtom).order;
  const entryId = order[3];
  await session.playQueueEntry(entryId);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  const playCalls = capturePlay(fake);
  expect(
    await session.setSourcePreference(
      ep,
      { mode: 'youtube-video', videoId: 'vidswitch01' },
      committed.requestId,
    ),
  ).toEqual({ status: 'loading' });
  const switched = fake.played.at(-1)!;
  expect(switched.requestId).toBe(committed.requestId + 1);
  expect(switched.origin).toEqual(committed.origin);
  expect(switched.source).toEqual(youtube('vidswitch01', 'youtube-video'));
  expect(playCalls.at(-1)?.options).toEqual({ preservePause: true });
  const queue = store.get(queueStateAtom);
  expect(queue.order).toEqual(order);
  expect(queue.cursorId).toBe(entryId);
  // `loading` is an accepted load command, not a durable preference yet.
  expect(preferences.get(mediaKey(ep))).toBeUndefined();
  fake.emitLoaded(switched);
  expect(preferences.get(mediaKey(ep))).toEqual({ mode: 'youtube-video', videoId: 'vidswitch01' });
  // A successful source reload is one new history event; duplicates dedupe.
  expect(history).toEqual(['e1', 'e1']);
  fake.emitLoaded(switched);
  expect(history).toEqual(['e1', 'e1']);
  await session.dispose();
});

test('a stale loaded event cannot commit a superseded preference', async () => {
  const { fake, history, preferences, session } = setup(honoringResolve);
  const ep = episodeTrack('e1');
  await session.playDirect(ep);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  expect(
    await session.setSourcePreference(
      ep,
      { mode: 'youtube-video', videoId: 'vidswitch01' },
      committed.requestId,
    ),
  ).toEqual({ status: 'loading' });
  const switched = fake.played.at(-1)!;
  await session.playDirect(track('b'));
  fake.emitLoaded(switched);
  expect(preferences.get(mediaKey(ep))).toBeUndefined();
  expect(history).toEqual(['e1']);
  await session.dispose();
});

test('a stale expected request saves for future playback only', async () => {
  const { fake, preferences, session } = setup(honoringResolve);
  await session.playDirect(episodeTrack('e1'));
  const stale = fake.played[0].requestId;
  await session.playDirect(episodeTrack('e2'));
  expect(await session.setSourcePreference(episodeTrack('e1'), { mode: 'rss' }, stale)).toEqual({
    status: 'saved',
  });
  expect(preferences.get(mediaKey(episodeTrack('e1')))).toEqual({ mode: 'rss' });
  expect(fake.played.map((target) => target.track.id)).toEqual(['e1', 'e2']);
  await session.dispose();
});

test('removing the originating queue entry downgrades the switch to a future-only save', async () => {
  const harness = setup(honoringResolve);
  const { store, fake, preferences, session } = harness;
  const ep = episodeTrack('e1');
  session.enqueue(ep);
  const entryId = store.get(queueStateAtom).order[3];
  await session.playQueueEntry(entryId);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  await session.remove(entryId);
  expect(
    await session.setSourcePreference(
      ep,
      { mode: 'youtube-video', videoId: 'vidswitch01' },
      committed.requestId,
    ),
  ).toEqual({ status: 'saved' });
  expect(preferences.get(mediaKey(ep))).toEqual({ mode: 'youtube-video', videoId: 'vidswitch01' });
  expect(fake.played).toHaveLength(1);
  await session.dispose();
});

test('entry removal during switch resolution supersedes without loading or saving', async () => {
  const deferred = Promise.withResolvers<ResolvedPlaybackSource>();
  const harness = setup((_value, _signal, preference) =>
    preference.mode === 'youtube-video' ? deferred.promise : Promise.resolve(youtube('e1')),
  );
  const { store, fake, preferences, session } = harness;
  const ep = episodeTrack('e1');
  session.enqueue(ep);
  const entryId = store.get(queueStateAtom).order[3];
  await session.playQueueEntry(entryId);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  const outcome = session.setSourcePreference(
    ep,
    { mode: 'youtube-video', videoId: 'vidswitch01' },
    committed.requestId,
  );
  await session.remove(entryId);
  deferred.resolve(youtube('vidswitch01', 'youtube-video'));
  expect(await outcome).toEqual({ status: 'superseded' });
  expect(preferences.get(mediaKey(ep))).toBeUndefined();
  expect(fake.played).toHaveLength(1);
  expect(store.get(playerErrorAtom)).toBeNull();
  await session.dispose();
});

test('resolution failure keeps old audio, queue and old preference intact', async () => {
  const harness = setup((_value, _signal, preference) =>
    preference.mode === 'youtube-match'
      ? Promise.reject(new Error('match failed'))
      : Promise.resolve(youtube('e1')),
  );
  const { store, fake, preferences, session } = harness;
  const ep = episodeTrack('e1');
  session.enqueue(ep);
  const entryId = store.get(queueStateAtom).order[3];
  await session.playQueueEntry(entryId);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  expect(
    await session.setSourcePreference(ep, { mode: 'youtube-match' }, committed.requestId),
  ).toEqual({ status: 'failed', message: 'match failed' });
  expect(preferences.get(mediaKey(ep))).toBeUndefined();
  expect(fake.played).toHaveLength(1);
  expect(store.get(queueStateAtom).cursorId).toBe(entryId);
  expect(store.get(playerErrorAtom)).toBeNull();
  await session.dispose();
});

test('load failure after a genuine switch reports failure and keeps the old preference', async () => {
  const { store, fake, preferences, session } = setup(honoringResolve);
  const ep = episodeTrack('e1');
  session.enqueue(ep);
  await session.playQueueEntry(store.get(queueStateAtom).order[3]);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  const original = fake.player.play.bind(fake.player);
  fake.player.play = async (target) => {
    if (target.requestId !== committed.requestId) throw new Error('load failed');
    return original(target);
  };
  expect(
    await session.setSourcePreference(
      ep,
      { mode: 'youtube-video', videoId: 'vidswitch01' },
      committed.requestId,
    ),
  ).toEqual({ status: 'failed', message: 'load failed' });
  expect(preferences.get(mediaKey(ep))).toBeUndefined();
  await session.dispose();
});

test('a later future-only save invalidates the pending same-key write without undoing audio', async () => {
  const { fake, history, preferences, session } = setup(honoringResolve);
  const ep = episodeTrack('e1');
  await session.playDirect(ep);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  expect(
    await session.setSourcePreference(
      ep,
      { mode: 'youtube-video', videoId: 'vidswitch01' },
      committed.requestId,
    ),
  ).toEqual({ status: 'loading' });
  const switched = fake.played.at(-1)!;
  expect(await session.setSourcePreference(ep, { mode: 'rss' }, null)).toEqual({ status: 'saved' });
  fake.emitLoaded(switched);
  expect(preferences.get(mediaKey(ep))).toEqual({ mode: 'rss' });
  expect(history).toEqual(['e1', 'e1']);
  await session.dispose();
});

test('a DB failure after audio loads leaves playback running and reports the unsaved preference', async () => {
  const failing = new Set<string>();
  const harness = setup(honoringResolve, failing);
  const { store, fake, history, preferences, session } = harness;
  const ep = episodeTrack('e1');
  await session.playDirect(ep);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  failing.add(mediaKey(ep));
  expect(
    await session.setSourcePreference(
      ep,
      { mode: 'youtube-video', videoId: 'vidswitch01' },
      committed.requestId,
    ),
  ).toEqual({ status: 'loading' });
  const switched = fake.played.at(-1)!;
  fake.emitLoaded(switched);
  expect(preferences.get(mediaKey(ep))).toBeUndefined();
  expect(store.get(playerErrorAtom)).toBe('preference write failed');
  expect(store.get(playerPlaybackAtom)).toBe(switched);
  expect(history).toEqual(['e1', 'e1']);
  await session.dispose();
});

test('loaded event racing the load command still commits the pending preference', async () => {
  const harness = setup(honoringResolve);
  const { fake, preferences, session } = harness;
  const ep = episodeTrack('e1');
  await session.playDirect(ep);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  const original = fake.player.play.bind(fake.player);
  fake.player.play = async (target, options) => {
    const accepted = original(target, options);
    // The controller commits its target before the loadfile ACK settles; a
    // file-loaded event may arrive inside that window.
    if (target.requestId !== committed.requestId) fake.emitLoaded(target);
    return accepted;
  };
  expect(
    await session.setSourcePreference(
      ep,
      { mode: 'youtube-video', videoId: 'vidswitch01' },
      committed.requestId,
    ),
  ).toEqual({ status: 'loading' });
  expect(preferences.get(mediaKey(ep))).toEqual({ mode: 'youtube-video', videoId: 'vidswitch01' });
  await session.dispose();
});

test('a loaded old request during a newer deferred intent writes history but no preference', async () => {
  const deferred = Promise.withResolvers<ResolvedPlaybackSource>();
  const harness = setup((value, signal, preference) =>
    value.id === 'b' ? deferred.promise : honoringResolve(value, signal, preference),
  );
  const { fake, history, preferences, session } = harness;
  const ep = episodeTrack('e1');
  await session.playDirect(ep);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  expect(
    await session.setSourcePreference(
      ep,
      { mode: 'youtube-video', videoId: 'vidswitch01' },
      committed.requestId,
    ),
  ).toEqual({ status: 'loading' });
  const switched = fake.played.at(-1)!;
  const newer = session.playDirect(track('b'));
  fake.emitLoaded(switched);
  // The still-committed target's history callback survives, but the newer
  // reserved intent must keep the superseded preference from committing.
  expect(history).toEqual(['e1', 'e1']);
  expect(preferences.get(mediaKey(ep))).toBeUndefined();
  deferred.resolve(youtube('b'));
  await newer;
  expect(fake.played.at(-1)!.track.id).toBe('b');
  await session.dispose();
});

test('a future-only save during switch resolution keeps the newer policy after the load', async () => {
  const deferred = Promise.withResolvers<ResolvedPlaybackSource>();
  const harness = setup((_value, _signal, preference) =>
    preference.mode === 'youtube-video' ? deferred.promise : Promise.resolve(youtube('e1')),
  );
  const { fake, preferences, session } = harness;
  const ep = episodeTrack('e1');
  await session.playDirect(ep);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  const outcome = session.setSourcePreference(
    ep,
    { mode: 'youtube-video', videoId: 'vidswitch01' },
    committed.requestId,
  );
  expect(await session.setSourcePreference(ep, { mode: 'rss' }, null)).toEqual({ status: 'saved' });
  deferred.resolve(youtube('vidswitch01', 'youtube-video'));
  expect(await outcome).toEqual({ status: 'loading' });
  const switched = fake.played.at(-1)!;
  fake.emitLoaded(switched);
  // The switch finished its audio load, but the newer saved policy wins.
  expect(preferences.get(mediaKey(ep))).toEqual({ mode: 'rss' });
  await session.dispose();
});

test('a stopped or ended target with identical audio reloads instead of no-op', async () => {
  const harness = setup(honoringResolve);
  const { store, fake, history, preferences, session } = harness;
  const ep = episodeTrack('e1');
  await session.playDirect(ep);
  const committed = fake.played[0];
  fake.emitLoaded(committed);
  store.set(playerStateAtom, 'stopped');
  expect(
    await session.setSourcePreference(
      ep,
      { mode: 'youtube-video', videoId: 'e1' },
      committed.requestId,
    ),
  ).toEqual({ status: 'loading' });
  const reloaded = fake.played.at(-1)!;
  expect(reloaded.requestId).toBe(committed.requestId + 1);
  expect(reloaded.origin).toEqual(committed.origin);
  fake.emitLoaded(reloaded);
  expect(preferences.get(mediaKey(ep))).toEqual({ mode: 'youtube-video', videoId: 'e1' });
  expect(history).toEqual(['e1', 'e1']);
  await session.dispose();
});

test('enqueueMany appends one atomic batch with fresh identities for repeated media', async () => {
  const { store, session, ids } = setup();
  const appended = session.enqueueMany([track('x1'), track('x2'), track('x1')]);
  expect(appended).toHaveLength(3);
  expect(new Set(appended).size).toBe(3);
  const state = store.get(queueStateAtom);
  expect(state.order).toEqual([...ids, ...appended]);
  expect(state.cursorId).toBeNull();
  expect(state.entries.at(-1)?.track.id).toBe('x1');
  expect(session.enqueueMany([])).toEqual([]);
  await session.dispose();
});

test('enqueueMany rejects unsupported rows before any mutation', async () => {
  const { store, session } = setup();
  const before = store.get(queueStateAtom);
  expect(session.enqueueMany([track('y1'), { ...track('y2'), source: null }])).toEqual([]);
  expect(store.get(queueStateAtom)).toBe(before);
  expect(store.get(playerErrorAtom)).toBe('This saved item has no supported playback source.');
  await session.dispose();
});

test('playAlbum collects, appends atomically, then plays the first entry through the queue', async () => {
  const { store, fake, session, ids } = setup();
  await session.playAlbum(async () => [track('al1'), track('al2'), track('al3')]);
  const state = store.get(queueStateAtom);
  expect(state.entries).toHaveLength(6);
  const appended = state.order.slice(3);
  expect(appended).toHaveLength(3);
  expect(state.cursorId).toBe(appended[0]);
  const played = fake.played.at(-1)!;
  expect(played.track.id).toBe('al1');
  expect(played.origin).toEqual({ kind: 'queue', entryId: appended[0] });
  expect(ids).toEqual(state.order.slice(0, 3));
  await session.dispose();
});

test('playAlbum collector failure leaves queue and audio untouched', async () => {
  const { store, fake, session } = setup();
  const before = store.get(queueStateAtom);
  await session.playAlbum(async () => {
    throw new Error('fetch failed');
  });
  expect(store.get(queueStateAtom)).toBe(before);
  expect(fake.played).toHaveLength(0);
  expect(store.get(playerErrorAtom)).toBe('fetch failed');
  await session.dispose();
});

test('a newer playback intent supersedes a slow album collector', async () => {
  const { store, fake, session } = setup();
  const collector = Promise.withResolvers<readonly Track[]>();
  const album = session.playAlbum(() => collector.promise);
  await session.playDirect(track('b'));
  collector.resolve([track('al1'), track('al2')]);
  await album;
  expect(store.get(queueStateAtom).entries).toHaveLength(3);
  expect(fake.played.map((target) => target.track.id)).toEqual(['b']);
  await session.dispose();
});

test('first-track failure after append retains the album rows and reports the failure', async () => {
  const harness = setup((value) =>
    value.id === 'al1'
      ? Promise.reject(new Error('resolve al1 failed'))
      : Promise.resolve(youtube(value.id)),
  );
  const { store, fake, session } = harness;
  await session.playAlbum(async () => [track('al1'), track('al2')]);
  const state = store.get(queueStateAtom);
  expect(state.entries).toHaveLength(5);
  expect(fake.played).toHaveLength(0);
  expect(store.get(playerErrorAtom)).toBe('resolve al1 failed');
  expect(state.cursorId).toBeNull();
  await session.dispose();
});

test('empty or unsupported album data reports without touching the queue', async () => {
  const { store, session } = setup();
  const before = store.get(queueStateAtom);
  await session.playAlbum(async () => []);
  expect(store.get(queueStateAtom)).toBe(before);
  expect(store.get(playerErrorAtom)).toBe('This album has no supported tracks.');
  await session.playAlbum(async () => [{ ...track('u1'), source: null }]);
  expect(store.get(queueStateAtom)).toBe(before);
  expect(store.get(playerErrorAtom)).toBe('This saved item has no supported playback source.');
  await session.dispose();
});
