export interface Podcast {
  id: string;          // iTunes collectionId or feed URL hash
  title: string;
  author: string;
  description?: string;
  feedUrl: string;
  artworkUrl?: string;
}

export interface Episode {
  id: string;          // GUID from RSS or generated
  podcastId: string;
  podcastTitle: string;
  title: string;
  description?: string;
  audioUrl: string;    // enclosure URL
  duration: number;    // seconds
  publishDate: string; // ISO date string
  transcriptUrl?: string; // from <podcast:transcript>
}
