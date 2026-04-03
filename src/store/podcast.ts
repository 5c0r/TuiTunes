import { atom } from 'jotai';
import type { Podcast, Episode } from '../providers/podcast-types';

/** Podcast search results from iTunes. */
export const podcastSearchResultsAtom = atom<Podcast[]>([]);

/** Whether a podcast search is in progress. */
export const podcastSearchLoadingAtom = atom(false);

/** The currently selected podcast (to browse episodes). */
export const selectedPodcastAtom = atom<Podcast | null>(null);

/** Episodes for the selected podcast. */
export const podcastEpisodesAtom = atom<Episode[]>([]);

/** Whether episodes are loading. */
export const episodesLoadingAtom = atom(false);

/** User's subscribed podcast feeds (loaded from DB). */
export const subscribedFeedsAtom = atom<Podcast[]>([]);

