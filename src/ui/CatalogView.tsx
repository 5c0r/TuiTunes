import { useAtomValue } from 'jotai';
import { TextAttributes } from '@opentui/core';
import { mediaKey } from '../providers/media';
import type { AlbumSummary, Track } from '../providers/types';
import {
  catalogFrameAtom,
  catalogIndexAtom,
  catalogListLengthAtom,
  catalogStateAtom,
  type CatalogCollectionState,
} from '../store/catalog';
import { formatTime, truncateText } from '../utils/format';
import { AlbumList } from './AlbumList';
import { usePresentation } from './usePresentation';
import { useTheme } from './useTheme';
import { TrackList } from './TrackList';

export interface CatalogViewProps {
  focused: boolean;
  /** Highlight the currently playing row in song/track lists. */
  playingTrackId?: string;
  /** Favorite mediaKey set, used for the Top songs status line. */
  favoritesSet?: Set<string>;
}

const TAB_LABELS: ReadonlyArray<{ id: 'albums' | 'singles' | 'songs'; label: string }> = [
  { id: 'albums', label: 'Albums' },
  { id: 'singles', label: 'Singles & EPs' },
  { id: 'songs', label: 'Top songs' },
];

function playingIndexFor(tracks: readonly Track[], playingTrackId: string | undefined): number {
  if (!playingTrackId) return -1;
  return tracks.findIndex((track) => track.id === playingTrackId);
}

/**
 * Presentation-only artist/album detail view. The catalog controller owns the
 * frame stack, indices, tabs and paging; this renderer subscribes to the
 * agreed selectors and reuses TrackList for song/album-track rows. All chrome
 * glyphs route through the shared ASCII presentation profile; user/provider
 * text is never transliterated.
 */
export function CatalogView({ focused, playingTrackId, favoritesSet }: CatalogViewProps) {
  const t = useTheme();
  const p = usePresentation();
  const state = useAtomValue(catalogStateAtom);
  const frame = useAtomValue(catalogFrameAtom);
  const selectedIndex = useAtomValue(catalogIndexAtom);
  const count = useAtomValue(catalogListLengthAtom);

  if (!frame) return null;

  const crumbs = state.frames
    .map((entry) =>
      entry.kind === 'artist' ? (entry.detail?.name ?? 'Artist') : (entry.detail?.title ?? 'Album'),
    )
    .join(` ${p.text('›')} `);

  const collection: CatalogCollectionState<AlbumSummary | Track> | null =
    frame.kind === 'album' ? frame.tracks : frame[frame.activeTab];
  const songList: readonly Track[] | null =
    frame.kind === 'album'
      ? frame.tracks.items
      : frame.activeTab === 'songs'
        ? frame.songs.items
        : null;

  let statusText: string;
  let statusFg: string;
  if (frame.error !== null) {
    statusText = `${frame.error} (palette: Retry Music Browser)`;
    statusFg = t.red;
  } else if (collection?.loading === true) {
    statusText = p.text('Loading more…');
    statusFg = t.dim;
  } else if (frame.loading) {
    statusText = p.text('Loading…');
    statusFg = t.dim;
  } else if (collection?.error != null) {
    statusText = `${collection.error} (palette: Retry Music Browser)`;
    statusFg = t.red;
  } else if (collection?.limitation != null) {
    statusText = collection.limitation.message;
    statusFg = t.yellow;
  } else {
    statusText = `${count} loaded`;
    if (collection?.continuation) statusText += ` ${p.text('·')} [shift+l] more`;
    if (songList) {
      const favorites =
        favoritesSet && favoritesSet.size > 0
          ? songList.reduce(
              (total, track) => total + (favoritesSet.has(mediaKey(track)) ? 1 : 0),
              0,
            )
          : 0;
      if (favorites > 0) statusText += ` ${p.text('·')} ${favorites} favorites`;
      if (frame.kind === 'album') {
        const total = frame.tracks.items.reduce((sum, track) => sum + track.duration, 0);
        if (total > 0) statusText += ` ${p.text('·')} ${formatTime(total)}`;
      }
    }
    statusFg = t.dim;
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box paddingLeft={1} paddingRight={1} flexDirection="row">
        <text fg={t.dim} truncate flexGrow={1}>
          {crumbs}
        </text>
      </box>

      {frame.kind === 'artist' ? (
        <>
          <box paddingLeft={1} paddingRight={1} flexDirection="row">
            <text fg={t.fg} attributes={TextAttributes.BOLD} truncate flexGrow={1}>
              {frame.detail?.name ?? 'Artist'}
            </text>
          </box>
          {frame.description && (
            <box paddingLeft={1} paddingRight={1} flexDirection="row">
              <text fg={t.dim} truncate flexGrow={1}>
                {truncateText(frame.description, 120)}
              </text>
            </box>
          )}
          <box paddingLeft={1} paddingRight={1} flexDirection="row">
            {TAB_LABELS.map((tab) => {
              const active = frame.activeTab === tab.id;
              return (
                <text
                  key={tab.id}
                  fg={active ? t.accent : t.dim}
                  attributes={active ? TextAttributes.BOLD : 0}
                >
                  {active ? `${p.text('▸')} ` : ''}
                  {tab.label}
                  {'   '}
                </text>
              );
            })}
          </box>
        </>
      ) : (
        <>
          <box paddingLeft={1} paddingRight={1} flexDirection="row">
            <text fg={t.fg} attributes={TextAttributes.BOLD} truncate flexGrow={1}>
              {frame.detail?.title ?? 'Album'}
            </text>
          </box>
          <box paddingLeft={1} paddingRight={1} flexDirection="row">
            <text fg={t.dim} truncate flexGrow={1}>
              {frame.detail?.artist || 'Unknown artist'}
              {frame.year !== null ? ` ${p.text('·')} ${frame.year}` : ''}
            </text>
          </box>
          {frame.actionPending !== null && (
            <box paddingLeft={1} paddingRight={1} flexDirection="row">
              <text fg={t.dim}>
                {frame.actionPending === 'play'
                  ? p.text('Playing album…')
                  : p.text('Adding album to queue…')}
              </text>
            </box>
          )}
        </>
      )}

      <box paddingLeft={1} paddingRight={1} flexDirection="row">
        <text fg={statusFg} truncate flexGrow={1}>
          {statusText}
        </text>
      </box>

      <box flexGrow={1} flexDirection="column">
        {frame.kind === 'album' ? (
          <TrackList
            tracks={frame.tracks.items}
            focused={focused}
            selectedIndex={selectedIndex}
            playingIndex={playingIndexFor(frame.tracks.items, playingTrackId)}
          />
        ) : frame.activeTab === 'songs' ? (
          <TrackList
            tracks={frame.songs.items}
            focused={focused}
            selectedIndex={selectedIndex}
            playingIndex={playingIndexFor(frame.songs.items, playingTrackId)}
          />
        ) : (
          <AlbumList
            albums={frame.activeTab === 'albums' ? frame.albums.items : frame.singles.items}
            selectedIndex={selectedIndex}
            focused={focused}
          />
        )}
      </box>
    </box>
  );
}
