import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createStore } from 'jotai';
import type { Store } from 'jotai/vanilla/store';
import {
  createEpisodeProgress,
  episodeProgressErrorAtom,
  episodeProgressRevisionAtom,
  type EpisodeProgress,
} from '../../src/application/episode-progress';
import { runMigrations } from '../../src/db/index';
import { mediaKey } from '../../src/providers/media';
import type { Episode } from '../../src/providers/podcast-types';
import type { PlaybackTarget, ResolvedPlaybackSource, Track } from '../../src/providers/types';
import {
  playerDurationAtom,
  playerPositionAtom,
  playerSeekableRequestAtom,
  playerStateAtom,
} from '../../src/store/player';
import { createTestPlayer, type TestPlayer } from '../helpers/player';

/** Same digest contract as the owner's RSS audio key. */
const rssAudioKey = (url: string) => `rss:${createHash('sha256').update(url).digest('hex')}`;
const ytAudioKey = (videoId: string) => `youtube:${videoId}`;

const episode = (podcastId: string, id: string): Episode => ({
  id,
  podcastId,
  podcastTitle: `Podcast ${podcastId}`,
  title: `Episode ${id}`,
  audioUrl: `https://audio.test/${podcastId}/${id}.mp3`,
  duration: 600,
  publishDate: '2026-01-01',
});
const trackOf = (podcastId: string, id: string): Track => ({
  id,
  provider: 'podcast',
  source: { kind: 'podcast', episode: episode(podcastId, id) },
  title: `Episode ${id}`,
  artist: `Podcast ${podcastId}`,
  duration: 600,
});
const musicTrack = (id: string): Track => ({
  id,
  provider: 'youtube',
  source: { kind: 'youtube', videoId: id },
  title: id,
  artist: 'Artist',
  duration: 200,
});
const rssSource = (url: string): ResolvedPlaybackSource => ({ kind: 'rss', url, selection: 'rss' });
const youtubeSource = (videoId: string): ResolvedPlaybackSource => ({
  kind: 'youtube',
  videoId,
  url: `https://www.youtube.com/watch?v=${videoId}`,
  selection: 'auto',
});
let requestSeq = 0;
const targetFor = (track: Track, source: ResolvedPlaybackSource): PlaybackTarget => ({
  track: { ...track, resolvedSource: source },
  source,
  requestId: ++requestSeq,
  origin: { kind: 'direct' },
});

/** Stable enclosure URL of an episode track ('' for non-podcast fixtures). */
const enclosureOf = (track: Track): string => {
  const source = track.source;
  return source?.kind === 'podcast' ? source.episode.audioUrl : '';
};

interface Harness {
  store: Store;
  db: Database;
  fake: TestPlayer;
  progress: EpisodeProgress;
}
function setup(): Harness {
  const store = createStore();
  const db = new Database(':memory:');
  runMigrations(db);
  const fake = createTestPlayer(store);
  const progress = createEpisodeProgress(store, db, fake.player);
  return { store, db, fake, progress };
}
function teardown(h: Harness): void {
  h.progress.dispose();
  h.db.close();
}
/** Emulate the controller's post-seek readiness plus one live sample. */
function confirmAt(h: Harness, target: PlaybackTarget, seconds: number, duration = 600): void {
  h.store.set(playerSeekableRequestAtom, target.requestId);
  h.store.set(playerDurationAtom, duration);
  h.store.set(playerPositionAtom, seconds);
}
interface Row {
  media_key: string;
  audio_key: string;
  position_ms: number;
  duration_ms: number;
  completed: number;
}
function rows(h: Harness, key?: string, audio?: string): Row[] {
  const sql = `SELECT media_key, audio_key, position_ms, duration_ms, completed FROM episode_progress${
    key && audio ? ' WHERE media_key = ? AND audio_key = ?' : key ? ' WHERE media_key = ?' : ''
  }`;
  const stmt = h.db.prepare(sql);
  return (key && audio ? stmt.all(key, audio) : key ? stmt.all(key) : stmt.all()) as Row[];
}
function seedProgress(
  h: Harness,
  key: string,
  audio: string,
  positionMs: number,
  durationMs: number,
  completed = 0,
): void {
  h.db
    .prepare(
      'INSERT INTO episode_progress (media_key, audio_key, position_ms, duration_ms, completed, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(key, audio, positionMs, durationMs, completed, Date.now());
}

function clearProgress(h: Harness): void {
  h.db.prepare('DELETE FROM episode_progress').run();
}

test('episode identity stays separate across feeds, audio variants, and URL forms', async () => {
  const h = setup();
  try {
    const a = trackOf('feed-a', 'ep1');
    const b = trackOf('feed-b', 'ep1'); // same GUID, different feed
    const enclosure = enclosureOf(a);
    const resolved = 'https://cdn.test/redirected-enclosure.mp3';

    // Resolved URL differs from the enclosure; identity still keys on the
    // stable enclosure, so the later plain-enclosure target resumes.
    const t = targetFor(a, rssSource(resolved));
    await h.fake.player.play(t, { startPosition: 300 });
    h.fake.emitLoaded(t);
    confirmAt(h, t, 300);
    expect(rows(h, mediaKey(a), rssAudioKey(enclosure))).toHaveLength(1);
    const plain = targetFor(a, rssSource(enclosure));
    expect(h.progress.prepareStart(plain)).toBe(300);

    // Same GUID in another feed never resumes or summarizes from feed A.
    expect(h.progress.prepareStart(targetFor(b, rssSource(enclosureOf(b))))).toBeUndefined();
    // Same episode through a matched YouTube video is a distinct audio row.
    expect(h.progress.prepareStart(targetFor(a, youtubeSource('vid111')))).toBeUndefined();
    const summaries = h.progress.summaries([a, b]);
    expect(summaries.get(mediaKey(a))).toBe('Resume at 5:00 [RSS]');
    expect(summaries.has(mediaKey(b))).toBe(false);
  } finally {
    teardown(h);
  }
});

test('resume eligibility follows the approved thresholds', async () => {
  const h = setup();
  try {
    const track = trackOf('feed', 'ep1');
    const enclosure = enclosureOf(track);
    const audio = rssAudioKey(enclosure);
    const target = () => targetFor(track, rssSource(enclosure));

    expect(h.progress.prepareStart(target())).toBeUndefined(); // no row at all
    expect(() => h.progress.prepareStart(target(), { kind: 'resume' })).toThrow(
      'No eligible resume position for this episode.',
    );

    seedProgress(h, mediaKey(track), audio, 300_000, 600_000);
    expect(h.progress.prepareStart(target())).toBe(300);
    expect(h.progress.prepareStart(target(), { kind: 'resume' })).toBe(300);

    // Below the 15-second floor.
    clearProgress(h);
    seedProgress(h, mediaKey(track), audio, 10_000, 600_000);
    expect(h.progress.prepareStart(target())).toBeUndefined();
    expect(() => h.progress.prepareStart(target(), { kind: 'resume' })).toThrow(
      'No eligible resume position',
    );

    // Inside the 30-second end guard of a 600-second episode.
    clearProgress(h);
    seedProgress(h, mediaKey(track), audio, 585_000, 600_000);
    expect(h.progress.prepareStart(target())).toBeUndefined();

    // A short episode shrinks the guard to 5% (5 s of 100 s).
    clearProgress(h);
    seedProgress(h, mediaKey(track), audio, 94_000, 100_000);
    expect(h.progress.prepareStart(target())).toBe(94);
    clearProgress(h);
    seedProgress(h, mediaKey(track), audio, 96_000, 100_000);
    expect(h.progress.prepareStart(target())).toBeUndefined();

    // Completed episodes restart from zero; only natural EOF completes.
    clearProgress(h);
    seedProgress(h, mediaKey(track), audio, 300_000, 600_000, 1);
    expect(h.progress.prepareStart(target())).toBeUndefined();
    expect(() => h.progress.prepareStart(target(), { kind: 'resume' })).toThrow(
      'No eligible resume position',
    );

    // Unknown duration trusts the position alone.
    clearProgress(h);
    seedProgress(h, mediaKey(track), audio, 60_000, 0);
    expect(h.progress.prepareStart(target())).toBe(60);
  } finally {
    teardown(h);
  }
});

test('bookmarks jump only within the same episode and audio source', async () => {
  const h = setup();
  try {
    const track = trackOf('feed', 'ep1');
    const other = trackOf('feed', 'ep2');
    const enclosure = enclosureOf(track);
    const t = targetFor(track, rssSource(enclosure));
    await h.fake.player.play(t);
    h.fake.emitLoaded(t);
    confirmAt(h, t, 90);
    const saved = h.progress.addBookmark('  Intro  ', t.requestId);
    expect(saved.label).toBe('Intro');
    expect(saved.positionMs).toBe(90_000);
    expect(h.progress.listBookmarks(track).map((bookmark) => bookmark.id)).toEqual([saved.id]);

    // Same episode via YouTube: different audio, refuses the jump.
    expect(() =>
      h.progress.prepareStart(targetFor(track, youtubeSource('vid7')), {
        kind: 'bookmark',
        bookmark: saved,
      }),
    ).toThrow('This bookmark belongs to a different audio source. Select RSS first.');
    // Same audio: jumps to the persisted row position.
    expect(
      h.progress.prepareStart(targetFor(track, rssSource(enclosure)), {
        kind: 'bookmark',
        bookmark: saved,
      }),
    ).toBe(90);
    // Another episode's scope never sees the row.
    expect(() =>
      h.progress.prepareStart(targetFor(other, rssSource(enclosure)), {
        kind: 'bookmark',
        bookmark: { ...saved, mediaKey: mediaKey(other) },
      }),
    ).toThrow('This bookmark no longer exists.');
    // Deleted between listing and jumping.
    h.progress.deleteBookmark(track, saved.id);
    expect(() =>
      h.progress.prepareStart(targetFor(track, rssSource(enclosure)), {
        kind: 'bookmark',
        bookmark: saved,
      }),
    ).toThrow('This bookmark no longer exists.');
  } finally {
    teardown(h);
  }
});

test('checkpoints follow forward and backward movement and flush on pause, retire, and quit', async () => {
  const h = setup();
  try {
    const track = trackOf('feed', 'ep1');
    const enclosure = enclosureOf(track);
    const audio = rssAudioKey(enclosure);
    const key = mediaKey(track);
    const t = targetFor(track, rssSource(enclosure));
    await h.fake.player.play(t);
    h.fake.emitLoaded(t);

    confirmAt(h, t, 5); // below the write threshold
    expect(rows(h, key, audio)).toHaveLength(0);
    confirmAt(h, t, 20); // first threshold crossing
    expect(rows(h, key, audio).map((row) => row.position_ms)).toEqual([20_000]);
    confirmAt(h, t, 25); // progress without a full threshold step
    expect(rows(h, key, audio).map((row) => row.position_ms)).toEqual([20_000]);

    h.store.set(playerStateAtom, 'paused'); // user pause flushes 25 s
    expect(rows(h, key, audio).map((row) => row.position_ms)).toEqual([25_000]);

    h.store.set(playerStateAtom, 'playing');
    confirmAt(h, t, 12); // rewind far enough to replace the durable checkpoint
    expect(rows(h, key, audio).map((row) => row.position_ms)).toEqual([12_000]);
    confirmAt(h, t, 14);

    const next = targetFor(trackOf('feed', 'ep2'), rssSource('https://audio.test/feed/ep2.mp3'));
    await h.fake.player.play(next); // retire flush
    expect(rows(h, key, audio).map((row) => [row.position_ms, row.duration_ms])).toEqual([
      [14_000, 600_000],
    ]);

    confirmAt(h, next, 40);
    confirmAt(h, next, 44);
    h.progress.dispose(); // quit write
    expect(rows(h, mediaKey(next.track)).map((row) => row.position_ms)).toEqual([44_000]);
  } finally {
    h.progress.dispose();
    h.db.close();
  }
});

test('natural EOF completes before advance handlers; a mere stop never does', async () => {
  const h = setup();
  try {
    const track = trackOf('feed', 'ep1');
    const enclosure = enclosureOf(track);
    const t = targetFor(track, rssSource(enclosure));
    await h.fake.player.play(t);
    h.fake.emitLoaded(t);
    confirmAt(h, t, 300);

    // Registered after the progress owner: its view must already be complete.
    let observed: Row | undefined;
    h.fake.player.onTrackEnd(() => {
      observed = rows(h, mediaKey(track), rssAudioKey(enclosure))[0];
    });
    h.fake.emitEnd(t);
    expect(observed).toMatchObject({ position_ms: 600_000, duration_ms: 600_000, completed: 1 });
    expect(h.progress.summaries([track]).get(mediaKey(track))).toBe('Played');

    // Stopped state without an EOF event is a disconnect/reset, not completion.
    const t2 = targetFor(trackOf('feed', 'ep2'), rssSource('https://audio.test/feed/ep2.mp3'));
    await h.fake.player.play(t2);
    h.fake.emitLoaded(t2);
    confirmAt(h, t2, 300);
    h.store.set(playerStateAtom, 'stopped');
    expect(rows(h, mediaKey(t2.track))[0].completed).toBe(0);
  } finally {
    teardown(h);
  }
});

test('start over clears only on the matching committed load and only that variant', async () => {
  const h = setup();
  try {
    const track = trackOf('feed', 'ep1');
    const enclosure = enclosureOf(track);
    const key = mediaKey(track);
    const rssAudio = rssAudioKey(enclosure);
    const ytAudio = ytAudioKey('vid9');

    // Resolution or load failure keeps the checkpoint.
    seedProgress(h, key, rssAudio, 300_000, 600_000);
    const failing = targetFor(track, rssSource(enclosure));
    expect(h.progress.prepareStart(failing, { kind: 'start' })).toBeUndefined();
    expect(rows(h, key, rssAudio)).toHaveLength(1);

    // A committed load clears this episode's row for the same audio variant,
    // but never a checkpoint belonging to another audio source.
    seedProgress(h, key, ytAudio, 480_000, 600_000);
    await h.fake.player.play(failing);
    h.fake.emitLoaded(failing);
    expect(rows(h, key, rssAudio)).toHaveLength(0);
    expect(rows(h, key, ytAudio).map((row) => row.position_ms)).toEqual([480_000]);

    // Retire flush then clear: the flushed checkpoint of the same audio dies.
    const first = targetFor(track, rssSource(enclosure));
    await h.fake.player.play(first);
    h.fake.emitLoaded(first);
    confirmAt(h, first, 200);
    expect(rows(h, key, rssAudio).map((row) => row.position_ms)).toEqual([200_000]);
    const second = targetFor(track, rssSource(enclosure));
    expect(h.progress.prepareStart(second, { kind: 'start' })).toBeUndefined();
    await h.fake.player.play(second); // retires `first`, flushing 200 s again
    expect(rows(h, key, rssAudio).map((row) => row.position_ms)).toEqual([200_000]);
    h.fake.emitLoaded(second);
    expect(rows(h, key, rssAudio)).toHaveLength(0);
    expect(rows(h, key, ytAudio)).toHaveLength(1);
  } finally {
    teardown(h);
  }
});

test('reset zeroes and reconnect windows never corrupt the cached checkpoint', async () => {
  const h = setup();
  try {
    const track = trackOf('feed', 'ep1');
    const enclosure = enclosureOf(track);
    const key = mediaKey(track);
    const audio = rssAudioKey(enclosure);
    seedProgress(h, key, audio, 300_000, 600_000);

    // Auto-resume: the player's pre-seek reset zeroes must not be persisted.
    const resuming = targetFor(track, rssSource(enclosure));
    expect(h.progress.prepareStart(resuming)).toBe(300);
    await h.fake.player.play(resuming, { startPosition: 300 });
    h.store.set(playerPositionAtom, 0);
    h.store.set(playerPositionAtom, 5);
    await h.fake.player.play(
      targetFor(trackOf('feed', 'ep9'), rssSource('https://audio.test/feed/ep9.mp3')),
    );
    expect(rows(h, key, audio).map((row) => row.position_ms)).toEqual([300_000]);

    // Once readiness lands, live samples persist again.
    const landed = targetFor(track, rssSource(enclosure));
    expect(h.progress.prepareStart(landed)).toBe(300);
    await h.fake.player.play(landed, { startPosition: 300 });
    h.fake.emitLoaded(landed);
    confirmAt(h, landed, 305);
    expect(rows(h, key, audio).map((row) => row.position_ms)).toEqual([305_000]);

    // Disconnect: readiness invalidated, position and duration reset to zero.
    h.store.set(playerSeekableRequestAtom, null);
    h.store.set(playerPositionAtom, 0);
    h.store.set(playerDurationAtom, 0);
    h.progress.dispose(); // quit flush uses the last confirmed sample
    expect(rows(h, key, audio).map((row) => [row.position_ms, row.duration_ms])).toEqual([
      [305_000, 600_000],
    ]);
  } finally {
    h.progress.dispose();
    h.db.close();
  }
});

test('bookmark operations validate requests and labels while allowing duplicates', async () => {
  const h = setup();
  try {
    const track = trackOf('feed', 'ep1');
    const other = trackOf('feed', 'ep2');
    const enclosure = enclosureOf(track);
    const t = targetFor(track, rssSource(enclosure));
    await h.fake.player.play(t);
    h.fake.emitLoaded(t);
    confirmAt(h, t, 90);

    let revision = h.store.get(episodeProgressRevisionAtom);
    const bump = () => {
      const next = h.store.get(episodeProgressRevisionAtom);
      expect(next).toBeGreaterThan(revision);
      revision = next;
    };
    expect(() => h.progress.addBookmark('   ', t.requestId)).toThrow('cannot be empty');
    expect(() => h.progress.addBookmark('Intro', t.requestId + 999)).toThrow(
      'Playback position is not confirmed yet',
    );
    const first = h.progress.addBookmark('Intro', t.requestId);
    bump();
    const duplicate = h.progress.addBookmark('Intro', t.requestId); // same label + cue allowed
    bump();
    confirmAt(h, t, 50); // earlier cue sorts first
    h.progress.addBookmark('Cold open', t.requestId);
    bump();
    expect(
      h.progress.listBookmarks(track).map((bookmark) => [bookmark.positionMs, bookmark.label]),
    ).toEqual([
      [50_000, 'Cold open'],
      [90_000, 'Intro'],
      [90_000, 'Intro'],
    ]);
    expect(duplicate.id).not.toBe(first.id);

    h.progress.renameBookmark(track, duplicate.id, '  Second take  ');
    bump();
    expect(() => h.progress.renameBookmark(track, duplicate.id, '  ')).toThrow('cannot be empty');
    expect(() => h.progress.renameBookmark(other, duplicate.id, 'Elsewhere')).toThrow(
      'Bookmark not found for this episode.',
    );
    expect(() => h.progress.renameBookmark(track, crypto.randomUUID(), 'Missing')).toThrow(
      'Bookmark not found for this episode.',
    );
    const labels = h.progress.listBookmarks(track).map((bookmark) => bookmark.label);
    expect(labels[0]).toBe('Cold open'); // earlier cue first
    // Equal cues are allowed; their relative order is not part of the contract.
    expect(labels.slice(1).sort()).toEqual(['Intro', 'Second take']);

    h.progress.deleteBookmark(track, first.id);
    bump();
    expect(() => h.progress.deleteBookmark(track, first.id)).toThrow(
      'Bookmark not found for this episode.',
    );
    expect(h.progress.listBookmarks(track)).toHaveLength(2);

    // A request that never reached seekable readiness cannot be bookmarked.
    const loading = targetFor(track, rssSource(enclosure));
    await h.fake.player.play(loading);
    expect(() => h.progress.addBookmark('Too early', loading.requestId)).toThrow(
      'Playback position is not confirmed yet',
    );
  } finally {
    teardown(h);
  }
});

test('read failures start ordinary playback at zero and reject explicit intents', async () => {
  const h = setup();
  try {
    const track = trackOf('feed', 'ep1');
    const enclosure = enclosureOf(track);
    seedProgress(h, mediaKey(track), rssAudioKey(enclosure), 300_000, 600_000);
    h.db.close();

    const target = targetFor(track, rssSource(enclosure));
    expect(h.progress.prepareStart(target)).toBeUndefined();
    expect(h.store.get(episodeProgressErrorAtom)).toMatch(/Could not read saved progress/);
    expect(() => h.progress.prepareStart(target, { kind: 'resume' })).toThrow(
      /Could not read saved progress/,
    );
    // Pure summary reads log and degrade to an empty map without atom writes.
    h.store.set(episodeProgressErrorAtom, null);
    expect(h.progress.summaries([track]).size).toBe(0);
    expect(h.store.get(episodeProgressErrorAtom)).toBeNull();
  } finally {
    h.progress.dispose();
  }
});

test('non-podcast playback passes through untouched', async () => {
  const h = setup();
  try {
    const t = targetFor(musicTrack('music1'), youtubeSource('music1'));
    expect(h.progress.prepareStart(t)).toBeUndefined();
    expect(h.progress.prepareStart(t, { kind: 'resume' })).toBeUndefined();
    await h.fake.player.play(t);
    h.fake.emitLoaded(t);
    confirmAt(h, t, 30, 200);
    h.fake.emitEnd(t);
    expect(rows(h)).toHaveLength(0);
  } finally {
    teardown(h);
  }
});

test('summaries label only completed episodes as Played', async () => {
  const h = setup();
  try {
    const finished = trackOf('feed', 'done');
    const resuming = trackOf('feed', 'half');
    const nearEnd = trackOf('feed', 'tail');
    const short = trackOf('feed', 'start');
    const ytVariant = trackOf('feed', 'yt');
    const multi = trackOf('feed', 'multi');
    const fresh = trackOf('feed', 'fresh');

    seedProgress(h, mediaKey(finished), rssAudioKey(enclosureOf(finished)), 600_000, 600_000, 1);
    seedProgress(h, mediaKey(resuming), rssAudioKey(enclosureOf(resuming)), 120_000, 600_000);
    seedProgress(h, mediaKey(nearEnd), rssAudioKey(enclosureOf(nearEnd)), 585_000, 600_000);
    seedProgress(h, mediaKey(short), rssAudioKey(enclosureOf(short)), 10_000, 600_000);
    seedProgress(h, mediaKey(ytVariant), ytAudioKey('vid3'), 240_000, 600_000);
    // Most-recent eligible checkpoint wins for a multi-variant episode.
    const rssRow = h.db.prepare(
      'INSERT INTO episode_progress (media_key, audio_key, position_ms, duration_ms, completed, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    rssRow.run(mediaKey(multi), rssAudioKey(enclosureOf(multi)), 100_000, 600_000, 0, 1_000);
    rssRow.run(mediaKey(multi), ytAudioKey('vid4'), 200_000, 600_000, 0, 2_000);

    const summaries = h.progress.summaries([
      finished,
      resuming,
      nearEnd,
      short,
      ytVariant,
      multi,
      fresh,
    ]);
    expect(summaries.get(mediaKey(finished))).toBe('Played');
    expect(summaries.get(mediaKey(resuming))).toBe('Resume at 2:00 [RSS]');
    expect(summaries.has(mediaKey(nearEnd))).toBe(false); // near end is not Played
    expect(summaries.has(mediaKey(short))).toBe(false);
    expect(summaries.get(mediaKey(ytVariant))).toBe('Resume at 4:00 [YT]');
    expect(summaries.get(mediaKey(multi))).toBe('Resume at 3:20 [YT]');
    expect(summaries.has(mediaKey(fresh))).toBe(false);
    expect(h.progress.summaries([]).size).toBe(0);
  } finally {
    teardown(h);
  }
});
