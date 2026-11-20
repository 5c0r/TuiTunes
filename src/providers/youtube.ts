import { AsyncLocalStorage } from 'node:async_hooks';
import {
  GridContinuation,
  Innertube,
  MusicPlaylistShelfContinuation,
  MusicShelfContinuation,
  Platform,
  SectionListContinuation,
  YTNodes,
} from 'youtubei.js';
import type { YTMusic } from 'youtubei.js';
import { Logger } from '../utils/logger';
import type { LyricLine } from './lyrics';
import type {
  AlbumDetail,
  AlbumSummary,
  ArtistDetail,
  ArtistSummary,
  CatalogContinuation,
  CatalogPage,
  IProvider,
  SearchContinuation,
  SearchOptions,
  SearchResult,
  Track,
} from './types';

// youtubei.js v17 requires a custom JS evaluator for URL deciphering.
// We don't actually need it — mpv + yt-dlp handles playback — but
// set it up anyway so getInfo() doesn't throw if called.
Platform.shim.eval = async (code, env) => {
  const keys = Object.keys(env);
  const values = Object.values(env);
  const fn = new Function(...keys, code.output);
  return fn(...values);
};

// ---------------------------------------------------------------------------
// Shared single-flight Innertube client with a real cancellation scope
// ---------------------------------------------------------------------------

const operationSignals = new AsyncLocalStorage<AbortSignal>();
const trackedOperations = new Set<Promise<unknown>>();
const trackedRequests = new Set<Promise<unknown>>();
const DEFAULT_REQUEST_DEADLINE_MS = 30_000;

let clientPromise: Promise<Innertube> | null = null;
let clientShutdown: AbortController | null = null;
let requestDeadlineMs = DEFAULT_REQUEST_DEADLINE_MS;
let createOptionsOverride: InnertubeCreateOptions | null = null;

/** youtubei.js accepts the standard fetch signature as its transport. */
type InnertubeCreateOptions = NonNullable<Parameters<typeof Innertube.create>[0]>;

/**
 * Compose the operation signal (AsyncLocalStorage), the client generation's
 * shutdown signal, the original request signal and the request deadline into
 * the one signal the real fetch call uses.
 */
function composedRequestSignal(
  original: AbortSignal | null | undefined,
  clientSignal: AbortSignal | null,
): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(requestDeadlineMs)];
  const operation = operationSignals.getStore();
  if (operation) signals.push(operation);
  if (clientSignal) signals.push(clientSignal);
  if (original) signals.push(original);
  return AbortSignal.any(signals);
}

/** Track a request or body-read lifetime independently until it settles. */
function trackRequest(promise: Promise<unknown>): void {
  trackedRequests.add(promise);
  const release = () => {
    trackedRequests.delete(promise);
  };
  void promise.then(release, release);
}

/** Expose body reads (json/text/…) as tracked lifetimes, not just headers. */
function withTrackedBody(response: Response): Response {
  const read = (method: 'json' | 'text' | 'arrayBuffer' | 'blob') => {
    const promise = response[method]();
    trackRequest(promise);
    return promise;
  };
  return new Proxy(response, {
    get(target, property) {
      if (
        property === 'json' ||
        property === 'text' ||
        property === 'arrayBuffer' ||
        property === 'blob'
      ) {
        return () => read(property);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The fetch input shape of the active runtime (Bun libs name no RequestInfo). */
type FetchInput = Parameters<typeof fetch>[0];

/**
 * Custom fetch installed on the shared client. Every SDK HTTP request —
 * including session creation — runs through here, so per-operation aborts,
 * the client generation's shutdown signal and the request deadline are
 * enforced on the wire.
 */
function sdkFetch(
  input: FetchInput,
  init: RequestInit | undefined,
  clientSignal: AbortSignal | null,
): Promise<Response> {
  const original = init?.signal ?? (input instanceof Request ? input.signal : null);
  // Bun's Request overloads accept string | Request; normalize URL inputs.
  const request =
    input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  const fetched = globalThis.fetch(request, {
    signal: composedRequestSignal(original, clientSignal),
  });
  trackRequest(fetched);
  return fetched.then(withTrackedBody);
}

/** A structurally complete fetch adapter bound to one client generation. */
function sdkFetchAdapter(clientSignal: AbortSignal | null): typeof fetch {
  return Object.assign(
    (input: FetchInput, init?: RequestInit) => sdkFetch(input, init, clientSignal),
    {
      preconnect: (...args: Parameters<typeof fetch.preconnect>) =>
        globalThis.fetch.preconnect(...args),
    },
  );
}

/**
 * Shared single-flight youtubei.js client. All YouTube SDK access (search,
 * suggestions, info, transcripts, lyrics, catalog) goes through this accessor
 * so the process never creates duplicate Innertube sessions. Initialization
 * is single-flight, independent of any one caller's cancellation, bounded by
 * the per-request deadline and abortable by client shutdown; a rejected
 * initialization clears the in-flight promise so a later request retries.
 */
export function getYouTubeClient(): Promise<Innertube> {
  // No new generation may start while a shutdown drain has outstanding work.
  if (shuttingDown) {
    return Promise.reject(new Error('youtubei.js client is shutting down'));
  }
  if (!clientPromise) {
    // One shutdown scope per client generation, captured by this generation's
    // fetch closure: in-flight follow-up requests can never escape their own
    // abort by reading a mutable global.
    const shutdown = new AbortController();
    clientShutdown = shutdown;
    clientPromise = Innertube.create({
      lang: 'en',
      location: 'US',
      ...createOptionsOverride,
      fetch: sdkFetchAdapter(shutdown.signal),
    }).then((client) => {
      Logger.info('youtubei.js client initialized');
      return client;
    });
    clientPromise.catch(() => {
      clientPromise = null;
      clientShutdown = null;
    });
  }
  return clientPromise;
}

/** @internal Test seam: offline creation options and a shorter deadline. */
export function configureYouTubeClientForTests(
  options: InnertubeCreateOptions | null,
  deadlineMs: number = DEFAULT_REQUEST_DEADLINE_MS,
): void {
  createOptionsOverride = options;
  requestDeadlineMs = deadlineMs;
}

/** Keep the tracked set bounded; the tracked promise still rejects to awaiters. */
function trackOperation<T>(operation: Promise<T>): Promise<T> {
  trackedOperations.add(operation);
  const release = () => {
    trackedOperations.delete(operation);
  };
  void operation.then(release, release);
  return operation;
}

/** runYouTubeOperation against a caller-supplied client accessor. */
function runScopedOperation<T>(
  getClient: () => Promise<Innertube>,
  signal: AbortSignal | undefined,
  operation: (client: Innertube) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  // No new generation may start while a shutdown is draining; the old,
  // already-aborted scope stays in effect until the drain completes.
  if (shuttingDown) {
    return Promise.reject(new Error('youtubei.js client is shutting down'));
  }
  return trackOperation(
    Promise.resolve(getClient()).then((client) => {
      // Re-check after shared initialization: an already-aborted signal must
      // not rely on a future abort event of the underlying fetch.
      signal?.throwIfAborted();
      return operationSignals.run(signal ?? new AbortController().signal, () => operation(client));
    }),
  );
}

/**
 * Run one SDK operation inside a real cancellation scope. The operation's
 * signal, client shutdown and the request deadline abort the underlying HTTP
 * requests through the custom fetch; the returned promise settles only after
 * the SDK finished parsing response bodies, not at header arrival.
 */
export function runYouTubeOperation<T>(
  signal: AbortSignal | undefined,
  operation: (client: Innertube) => Promise<T>,
): Promise<T> {
  return runScopedOperation(getYouTubeClient, signal, operation);
}

let shuttingDown = false;
let shutdownDrain: Promise<void> | null = null;

const SHUTDOWN_DRAIN_TIMEOUT_MS = 5000;

/** A cancellable hard bound for one drain round. */
function drainBound(ms: number): { bounded: Promise<boolean>; cancel: () => void } {
  let cancel: () => void = () => {};
  const bounded = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    cancel = () => clearTimeout(timer);
  });
  return { bounded, cancel };
}

/**
 * Abort every in-flight SDK request of the current client generation, then
 * drain the retained initialization promise, tracked operations (which settle
 * only after response bodies are parsed) and independently tracked
 * request/body lifetimes — including follow-ups added while draining. The
 * aborted scope stays in effect and new generations stay blocked until
 * drainage is verified; only then are the shared refs reset so later use
 * recreates the client. A hard drain timeout rejects explicitly and keeps the
 * client closed; retrying shutdown re-attempts the drain. Bootstrap calls
 * this before exit.
 */
export function shutdownYouTubeClient(): Promise<void> {
  if (shutdownDrain) return shutdownDrain;
  shuttingDown = true;
  clientShutdown?.abort();
  // Retain the in-flight initialization promise for the drain; reopening
  // happens only after verified drainage.
  const init = clientPromise;
  clientPromise = null;
  const drain = (async () => {
    // Yield once so the caller registers this drain before it can complete.
    await Promise.resolve();
    try {
      const drained = new Set<Promise<unknown>>();
      for (;;) {
        const pending = [init, ...trackedOperations, ...trackedRequests].filter(
          (promise): promise is Promise<unknown> => promise !== null && !drained.has(promise),
        );
        if (pending.length === 0) break;
        for (const promise of pending) drained.add(promise);
        const { bounded, cancel } = drainBound(SHUTDOWN_DRAIN_TIMEOUT_MS);
        try {
          const verified = await Promise.race([
            Promise.allSettled(pending).then(() => true),
            bounded,
          ]);
          if (!verified) {
            throw new Error('youtubei.js shutdown drain timed out with outstanding SDK work');
          }
        } finally {
          // Always clear the deadline timer; unref alone is not cleanup.
          cancel();
        }
      }
      clientShutdown = null;
      shuttingDown = false;
      Logger.info('youtubei.js client shut down');
    } finally {
      // Success reopens for later generations; a timeout keeps the client
      // closed (shuttingDown stays true) but lets a retry re-attempt the drain.
      shutdownDrain = null;
    }
  })();
  shutdownDrain = drain;
  return drain;
}

// ---------------------------------------------------------------------------
// Typed search helpers
// ---------------------------------------------------------------------------

/** Page returned by a fresh music search. */
type MusicSearchPage = YTMusic.Search;

/**
 * Structural view of the SDK page returned by `MusicSearchPage.getContinuation()`.
 * The SDK class is not exported from the package root, so this names exactly
 * the surface the provider consumes.
 */
interface MusicSearchContinuationPage {
  contents?: MusicShelfContinuation;
  has_continuation: boolean;
  getContinuation(): Promise<MusicSearchContinuationPage>;
}

/**
 * Extract tracks from a MusicShelf's MusicResponsiveListItem entries.
 * The search response nests items inside ItemSection/MusicShelf containers.
 */
function trackFromItem(item: YTNodes.MusicResponsiveListItem): Track | null {
  const id = item.id;
  if (!id) return null;
  // First parsed artist only, matching the singular Track.artist display.
  const artist = item.artists?.[0];

  return {
    id,
    provider: 'youtube',
    source: { kind: 'youtube', videoId: id },
    title: item.title ?? 'Unknown',
    artist: artist?.name ?? 'Unknown Artist',
    // Actual browse endpoints from the parsed row, never author-name guesses.
    artistId: artist?.channel_id,
    album: item.album?.name,
    albumId: item.album?.id,
    duration: item.duration?.seconds ?? 0,
    thumbnailUrl: item.thumbnails?.[0]?.url,
  };
}

/** Extract tracks from a fresh search page (items wrapped in MusicShelf sections). */
function tracksFromFirstPage(page: MusicSearchPage): Track[] {
  const tracks: Track[] = [];
  for (const section of page.contents ?? []) {
    if (!(section instanceof YTNodes.MusicShelf)) continue;
    for (const item of section.contents) {
      const track = trackFromItem(item);
      if (track) tracks.push(track);
    }
  }
  return tracks;
}

/** Extract tracks from a continuation page (flat MusicResponsiveListItem contents). */
function tracksFromContinuationPage(page: MusicSearchContinuationPage): Track[] {
  const tracks: Track[] = [];
  for (const item of page.contents?.contents ?? []) {
    if (!(item instanceof YTNodes.MusicResponsiveListItem)) continue;
    const track = trackFromItem(item);
    if (track) tracks.push(track);
  }
  return tracks;
}

/**
 * Wrap a typed SDK search page in the domain continuation handle. App and
 * controllers only ever see this handle, never the SDK response shape. The
 * signal aborts the underlying HTTP request through the custom fetch.
 */
function wrapSearchContinuation(
  page: MusicSearchPage | MusicSearchContinuationPage,
): SearchContinuation {
  return {
    next: async (signal?: AbortSignal): Promise<SearchResult> => {
      signal?.throwIfAborted();
      const next = await runYouTubeOperation(signal, () => page.getContinuation());
      const tracks = tracksFromContinuationPage(next);
      Logger.info(`YouTube search continuation: ${tracks.length} results`);
      return {
        tracks,
        hasMore: next.has_continuation,
        continuation: next.has_continuation ? wrapSearchContinuation(next) : undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Typed suggestion / transcript-language helpers (tested against real SDK
// parser-node fixtures)
// ---------------------------------------------------------------------------

/**
 * Flatten music search suggestion sections into suggestion strings.
 * `SearchSuggestion` and `HistorySuggestion` nodes are both accepted; order
 * is preserved, empty values are dropped, and identical strings are
 * deduplicated so React keys remain unique. Empty sections yield [].
 */
export function extractSuggestions(
  sections: readonly YTNodes.SearchSuggestionsSection[],
): string[] {
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const section of sections) {
    for (const node of section.contents) {
      if (!(node instanceof YTNodes.SearchSuggestion)) continue;
      // Text.toString() renders empty text as 'N/A'; drop empties on the raw
      // value so the SDK fallback never leaks into suggestions.
      if (!node.suggestion.text) continue;
      const text = node.suggestion.toString();
      if (seen.has(text)) continue;
      seen.add(text);
      suggestions.push(text);
    }
  }
  return suggestions;
}

/**
 * Map a requested ISO language code to the display name that
 * `TranscriptInfo.selectLanguage()` expects.
 *
 * The code is looked up in `info.captions.translation_languages` first, then
 * in the original caption-track metadata. The resulting display name must
 * exist in `TranscriptInfo.languages`; otherwise null is returned so callers
 * fall back to the external translation provider. ISO codes are never passed
 * to selectLanguage directly.
 */
export function transcriptLanguageName(
  code: string,
  captions: YTNodes.PlayerCaptionsTracklist | undefined,
  availableNames: readonly string[],
): string | null {
  const available = new Set(availableNames);
  const candidates: string[] = [];

  const translation = captions?.translation_languages?.find(
    (language) => language.language_code === code,
  );
  if (translation) candidates.push(translation.language_name.toString());

  const track = captions?.caption_tracks?.find((entry) => entry.language_code === code);
  if (track) candidates.push(track.name.toString());

  for (const name of candidates) {
    if (name && available.has(name)) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Catalog paging (feature 11): artist releases, top songs and album tracks
// ---------------------------------------------------------------------------

/**
 * Structural view of the parsed /browse responses the catalog consumes. The
 * concrete SDK response types are not exported from the package root, so this
 * names exactly the fields read here; every node is narrowed with instanceof
 * against real SDK classes.
 */
interface ParsedBrowsePage {
  contents?: { item(): unknown } | null;
  contents_memo?: MemoLike | null;
  continuation_contents?: unknown;
  on_response_received_actions?: readonly unknown[];
}

/** Structural view of the parser Memo's typed lookup. */
interface MemoLike {
  getType(...types: readonly unknown[]): readonly unknown[];
}

/** Structural view of the unexported parser/ytmusic/Artist page wrapper. */
interface ArtistPage {
  header?: YTNodes.MusicImmersiveHeader | YTNodes.MusicVisualHeader | YTNodes.MusicHeader;
  sections: readonly (YTNodes.MusicCarouselShelf | YTNodes.MusicShelf)[];
  getAllSongs(): Promise<YTNodes.MusicPlaylistShelf | undefined>;
}

/** Structural view of the unexported parser/ytmusic/Album page wrapper. */
interface AlbumPage {
  header?: YTNodes.MusicDetailHeader | YTNodes.MusicResponsiveHeader;
  contents: readonly YTNodes.MusicResponsiveListItem[];
  page: { contents_memo?: MemoLike | null };
}

/** SDK-accepted artist browse ID prefixes (channel or private-library artist). */
export function isValidArtistId(id: string): boolean {
  return id.startsWith('UC') || id.startsWith('FEmusic_library_privately_owned_artist');
}

/** SDK-accepted release browse ID prefixes (album/single or private release). */
export function isValidReleaseId(id: string): boolean {
  return id.startsWith('MPR') || id.startsWith('FEmusic_library_privately_owned_release');
}

/** Plain text of an SDK Text node; never leaks the 'N/A' placeholder. */
function textString(text: { isEmpty(): boolean; toString(): string } | undefined | null): string {
  return !text || text.isEmpty() ? '' : text.toString();
}

function parseYear(value: string | undefined): number | undefined {
  const match = value?.match(/\b(19|20)\d{2}\b/);
  return match ? Number.parseInt(match[0], 10) : undefined;
}

/** Album/release card mapping; only album and single cards are releases. */
function albumFromTwoRowItem(item: YTNodes.MusicTwoRowItem): AlbumSummary | null {
  if (item.item_type !== 'album' && item.item_type !== 'single') return null;
  if (!item.id) return null;
  const artist = item.artists?.[0] ?? item.author;
  return {
    id: item.id,
    title: textString(item.title),
    artist: artist?.name ?? '',
    artistId: artist?.channel_id,
    thumbnailUrl: item.thumbnail[0]?.url,
  };
}

/**
 * Private continuation handle state. SDK endpoint objects and tokens never
 * leave the provider; `key` is the opaque loop-detection identity.
 */
type ContinuationStep =
  | { kind: 'token'; key: string }
  | { kind: 'endpoint'; key: string; endpoint: YTNodes.NavigationEndpoint };

interface RowFamily<T extends { id: string }> {
  isRow(node: unknown): boolean;
  mapRow(node: unknown): T | null;
}

/** Responsive album row (shelf listing of releases; no 'single' item type). */
function albumFromListItem(item: YTNodes.MusicResponsiveListItem): AlbumSummary | null {
  if (item.item_type !== 'album') return null;
  if (!item.id) return null;
  const author = item.author ?? item.artists?.[0];
  return {
    id: item.id,
    title: item.title ?? '',
    artist: author?.name ?? '',
    artistId: author?.channel_id,
    thumbnailUrl: item.thumbnail?.contents[0]?.url,
  };
}

const releaseRowFamily: RowFamily<AlbumSummary> = {
  // Two-row cards and responsive album rows are release rows; unsupported
  // row cards inside the collection mark the list partial when skipped.
  isRow: (node) =>
    node instanceof YTNodes.MusicTwoRowItem || node instanceof YTNodes.MusicResponsiveListItem,
  mapRow: (node) =>
    node instanceof YTNodes.MusicTwoRowItem
      ? albumFromTwoRowItem(node)
      : node instanceof YTNodes.MusicResponsiveListItem
        ? albumFromListItem(node)
        : null,
};

const trackRowFamily: RowFamily<Track> = {
  isRow: (node) => node instanceof YTNodes.MusicResponsiveListItem,
  mapRow: (node) => (node instanceof YTNodes.MusicResponsiveListItem ? trackFromItem(node) : null),
};

/** One parsed page of rows before ownership bookkeeping. */
interface ParsedRows<T extends { id: string }> {
  items: T[];
  step: ContinuationStep | null;
  /** The response implied more rows but offered no usable continuation. */
  truncated: boolean;
  /** Recognized rows were dropped because they lacked a stable ID. */
  dropped: boolean;
  /** No expected container shape was present at all. */
  unrecognized: boolean;
}

function endpointKey(endpoint: YTNodes.NavigationEndpoint): string {
  return JSON.stringify(endpoint.payload ?? {});
}

function unrecognizedRows<T extends { id: string }>(): ParsedRows<T> {
  return { items: [], step: null, truncated: false, dropped: false, unrecognized: true };
}

/**
 * Map a node list in provider order. A typed ContinuationItem is followed as
 * the actual continuation representation when no string token exists.
 */
function rowsFromNodes<T extends { id: string }>(
  family: RowFamily<T>,
  nodes: readonly unknown[],
  token: string | null,
): ParsedRows<T> {
  const items: T[] = [];
  let dropped = false;
  let endpoint: YTNodes.NavigationEndpoint | null = null;
  for (const node of nodes) {
    if (node instanceof YTNodes.ContinuationItem) {
      endpoint = node.endpoint;
      continue;
    }
    if (!family.isRow(node)) continue;
    const item = family.mapRow(node);
    if (item) items.push(item);
    else dropped = true;
  }
  return {
    items,
    step: token
      ? { kind: 'token', key: token }
      : endpoint
        ? { kind: 'endpoint', key: endpointKey(endpoint), endpoint }
        : null,
    truncated: false,
    dropped,
    unrecognized: false,
  };
}

function isReleaseContainer(node: unknown): node is YTNodes.Grid | YTNodes.MusicShelf {
  return node instanceof YTNodes.Grid || node instanceof YTNodes.MusicShelf;
}

/**
 * Normalize possibly-null SDK child arrays to a plain unknown array so
 * type-guard filters narrow (a raw `?? []` union poisons overload inference).
 */
function childNodes(nodes: readonly unknown[] | null | undefined): readonly unknown[] {
  return nodes ?? [];
}

function safeRootItem(page: ParsedBrowsePage): unknown {
  try {
    return page.contents?.item() ?? null;
  } catch {
    return null;
  }
}

function appendActionContents(page: ParsedBrowsePage): readonly unknown[] | null {
  const actions = page.on_response_received_actions ?? [];
  const append = actions.find(
    (action): action is YTNodes.AppendContinuationItemsAction =>
      action instanceof YTNodes.AppendContinuationItemsAction,
  );
  return append ? append.contents : null;
}

/**
 * The initial release-list container: a primary Grid or MusicShelf, or a
 * SectionList wrapping exactly one unambiguous expected collection. Anything
 * else is unavailable or ambiguous, never an empty completed catalog.
 */
function initialReleaseContainer(page: ParsedBrowsePage): {
  container: YTNodes.Grid | YTNodes.MusicShelf | null;
  /** Validated wrapper token, used when the sole child carries none. */
  token: string | null;
  ambiguous: boolean;
} {
  const root = safeRootItem(page);
  if (isReleaseContainer(root)) {
    return { container: root, token: root.continuation ?? null, ambiguous: false };
  }
  if (root instanceof YTNodes.SectionList) {
    const collections = root.contents.filter(isReleaseContainer);
    return collections.length === 1
      ? {
          container: collections[0],
          token: collections[0].continuation ?? root.continuation ?? null,
          ambiguous: false,
        }
      : { container: null, token: null, ambiguous: collections.length > 1 };
  }
  const memoed = [
    ...(page.contents_memo?.getType(YTNodes.Grid) ?? []),
    ...(page.contents_memo?.getType(YTNodes.MusicShelf) ?? []),
  ];
  const containers = memoed.filter(isReleaseContainer);
  return containers.length === 1
    ? { container: containers[0], token: containers[0].continuation ?? null, ambiguous: false }
    : { container: null, token: null, ambiguous: containers.length > 1 };
}

/** Continuation response → rows for release lists (Grid/MusicShelf family). */
function releaseContinuationRows(page: ParsedBrowsePage): ParsedRows<AlbumSummary> {
  const contents = page.continuation_contents;
  if (contents instanceof GridContinuation) {
    return rowsFromNodes(releaseRowFamily, contents.items ?? [], contents.continuation);
  }
  if (contents instanceof MusicShelfContinuation) {
    return rowsFromNodes(releaseRowFamily, contents.contents, contents.continuation);
  }
  if (contents instanceof SectionListContinuation) {
    // Unwrap only when exactly one expected collection is present; the
    // wrapper's validated token is preserved when the child carries none.
    const collections = childNodes(contents.contents).filter(isReleaseContainer);
    if (collections.length !== 1) return unrecognizedRows();
    return rowsFromNodes(
      releaseRowFamily,
      collections[0].contents,
      collections[0].continuation ?? contents.continuation ?? null,
    );
  }
  if (contents !== undefined && contents !== null) return unrecognizedRows();
  const appended = appendActionContents(page);
  if (appended) return rowsFromNodes(releaseRowFamily, appended, null);
  return unrecognizedRows();
}

/** Continuation response → rows for track shelves. */
function trackContinuationRows(page: ParsedBrowsePage): ParsedRows<Track> {
  const contents = page.continuation_contents;
  if (
    contents instanceof MusicPlaylistShelfContinuation ||
    contents instanceof MusicShelfContinuation
  ) {
    return rowsFromNodes(trackRowFamily, contents.contents ?? [], contents.continuation);
  }
  if (contents instanceof GridContinuation) {
    return rowsFromNodes(trackRowFamily, contents.items ?? [], contents.continuation);
  }
  if (contents instanceof SectionListContinuation) {
    // Unwrap only when exactly one expected collection is present; the
    // wrapper's validated token is preserved when the child carries none.
    const shelves = childNodes(contents.contents).filter(
      (node): node is YTNodes.MusicShelf => node instanceof YTNodes.MusicShelf,
    );
    if (shelves.length !== 1) return unrecognizedRows();
    return rowsFromNodes(
      trackRowFamily,
      shelves[0].contents,
      shelves[0].continuation ?? contents.continuation ?? null,
    );
  }
  if (contents !== undefined && contents !== null) return unrecognizedRows();
  // Action-based appends (live-observed Top songs shape): rows plus the next
  // ContinuationItem inside AppendContinuationItemsAction.contents; no
  // continuation_contents is required on such responses.
  const appended = appendActionContents(page);
  if (appended) return rowsFromNodes(trackRowFamily, appended, null);
  return unrecognizedRows();
}

/** Per-collection ownership: client source, loop detection and dedupe policy. */
interface PagingState<T extends { id: string }> {
  getClient(): Promise<Innertube>;
  seenKeys: Set<string>;
  /** Artist releases and Top songs dedupe by stable ID; album rows never do. */
  seenIds: Set<string> | null;
  rows(page: ParsedBrowsePage): ParsedRows<T>;
  /** Missing-field context (fetched album metadata) applied to mapped rows. */
  fillContext?: (item: T) => T;
}

function unavailablePage<T>(message: string): CatalogPage<T> {
  return { items: [], next: null, limitation: { kind: 'unavailable', message } };
}

/**
 * Apply ownership bookkeeping to one parsed page: first-occurrence dedupe,
 * cyclic-continuation detection and dropped/truncated-row reporting. A
 * continuation key is consumed here only after the page mapped successfully.
 */
function buildCatalogPage<T extends { id: string }>(
  state: PagingState<T>,
  rows: ParsedRows<T>,
): CatalogPage<T> {
  const collected: T[] = [];
  let duplicated = false;
  if (state.seenIds) {
    for (const item of rows.items) {
      if (item.id.length === 0) continue;
      if (state.seenIds.has(item.id)) {
        duplicated = true;
        continue;
      }
      state.seenIds.add(item.id);
      collected.push(item);
    }
  } else {
    collected.push(...rows.items);
  }
  const items = state.fillContext ? collected.map(state.fillContext) : collected;

  const repeated = rows.step !== null && state.seenKeys.has(rows.step.key);
  let next: CatalogContinuation<T> | null = null;
  if (rows.step && !repeated) {
    state.seenKeys.add(rows.step.key);
    next = continuationHandle(state, rows.step);
  }

  const problems: string[] = [];
  if (rows.unrecognized) problems.push('unexpected response shape');
  if (rows.dropped) problems.push('unsupported or ID-less rows were skipped');
  if (duplicated) problems.push('duplicate rows were skipped');
  if (rows.truncated) problems.push('more rows exist but no usable continuation was returned');
  if (repeated) problems.push('the continuation repeated');
  return {
    items,
    next,
    limitation:
      problems.length > 0
        ? { kind: 'partial', message: `Incomplete list: ${problems.join('; ')}.` }
        : null,
  };
}

/**
 * One continuation handle. A successful page is cached and replayed verbatim
 * so retried traversals (a failed later page, a repeated whole-album action
 * from the same frame cursor) cannot poison the shared dedupe/loop state; a
 * failed fetch stays retryable. Cycle detection still applies because each
 * key is only ever wrapped once per collection state.
 */
function continuationHandle<T extends { id: string }>(
  state: PagingState<T>,
  step: ContinuationStep,
): CatalogContinuation<T> {
  let cached: Promise<CatalogPage<T>> | null = null;
  return {
    key: step.key,
    next: (signal?: AbortSignal): Promise<CatalogPage<T>> => {
      if (!cached) {
        cached = runScopedOperation(state.getClient, signal, async (client) => {
          const page: ParsedBrowsePage =
            step.kind === 'token'
              ? await client.actions.execute('/browse', {
                  client: 'YTMUSIC',
                  continuation: step.key,
                  parse: true,
                })
              : await step.endpoint.call(client.actions, { client: 'YTMUSIC', parse: true });
          return buildCatalogPage(state, state.rows(page));
        });
        cached.catch(() => {
          cached = null;
        });
      }
      return cached;
    },
  };
}

function artistSummary(id: string, header: ArtistPage['header']): ArtistSummary {
  const name =
    header instanceof YTNodes.MusicImmersiveHeader || header instanceof YTNodes.MusicVisualHeader
      ? textString(header.title)
      : header instanceof YTNodes.MusicHeader
        ? textString(header.title)
        : '';
  const thumbnailUrl =
    header instanceof YTNodes.MusicImmersiveHeader
      ? header.thumbnail?.contents[0]?.url
      : header instanceof YTNodes.MusicVisualHeader
        ? header.thumbnail[0]?.url
        : undefined;
  return { id, name: name.length > 0 ? name : 'Unknown Artist', thumbnailUrl };
}

/** The carousel with the exact English header title, if present. */
function carouselByTitle(artist: ArtistPage, title: string): YTNodes.MusicCarouselShelf | null {
  return (
    artist.sections.find(
      (section): section is YTNodes.MusicCarouselShelf =>
        section instanceof YTNodes.MusicCarouselShelf &&
        section.header !== null &&
        textString(section.header?.title) === title,
    ) ?? null
  );
}

function releasePaging(getClient: () => Promise<Innertube>): PagingState<AlbumSummary> {
  return { getClient, seenKeys: new Set(), seenIds: new Set(), rows: releaseContinuationRows };
}

function trackPaging(
  getClient: () => Promise<Innertube>,
  dedupe: boolean,
  fillContext?: (track: Track) => Track,
): PagingState<Track> {
  return {
    getClient,
    seenKeys: new Set(),
    seenIds: dedupe ? new Set() : null,
    rows: trackContinuationRows,
    fillContext,
  };
}

/**
 * Fetched album metadata applied as missing-field context to album track
 * rows: album ID/title and header artist links fill absent fields only,
 * never overwriting explicit (compilation) per-track artists.
 */
function albumTrackContext(albumId: string, summary: AlbumSummary): (track: Track) => Track {
  return (track) => ({
    ...track,
    albumId: track.albumId ?? albumId,
    album: track.album ?? (summary.title.length > 0 ? summary.title : undefined),
    artistId: track.artistId ?? summary.artistId,
    artist:
      track.artist === 'Unknown Artist' && summary.artist.length > 0
        ? summary.artist
        : track.artist,
  });
}

/**
 * Full initial release-list page: the carousel's more-content endpoint, a
 * primary Grid or MusicShelf container (a SectionList only when it wraps one
 * unambiguous expected collection). Missing sections and absent more-content
 * endpoints are explicit limitations; retained carousel cards never pose as a
 * complete discography.
 */
function releaseCollection(
  getClient: () => Promise<Innertube>,
  signal: AbortSignal | undefined,
  artist: ArtistPage,
  title: string,
): Promise<CatalogPage<AlbumSummary>> {
  const carousel = carouselByTitle(artist, title);
  if (!carousel) {
    return Promise.resolve(unavailablePage(`${title} are not available for this artist.`));
  }
  const endpoint = carousel.header?.more_content?.endpoint;
  if (!endpoint) {
    const page = buildCatalogPage(
      releasePaging(getClient),
      rowsFromNodes(releaseRowFamily, carousel.contents, null),
    );
    return Promise.resolve({
      ...page,
      limitation: page.limitation ?? {
        kind: 'partial',
        message: `Only the first ${page.items.length} entries of ${title} are shown; the full list is unavailable.`,
      },
    });
  }
  return runScopedOperation(getClient, signal, async (client) => {
    const page: ParsedBrowsePage = await endpoint.call(client.actions, {
      client: 'YTMUSIC',
      parse: true,
    });
    const { container, token, ambiguous } = initialReleaseContainer(page);
    if (!container) {
      return unavailablePage(
        ambiguous
          ? `The ${title} list was ambiguous and cannot be shown completely.`
          : `${title} list is unavailable.`,
      );
    }
    return buildCatalogPage(
      releasePaging(getClient),
      rowsFromNodes(releaseRowFamily, container.contents, token),
    );
  });
}

/**
 * Top songs: Artist.getAllSongs() resolves the 'Top songs' shelf into its
 * full first MusicPlaylistShelf page; the shelf name does not mean all pages
 * are loaded. collapsed_item_count above the mapped rows without a usable
 * continuation marks the page incomplete.
 */
async function topSongsCollection(
  getClient: () => Promise<Innertube>,
  signal: AbortSignal | undefined,
  artist: ArtistPage,
): Promise<CatalogPage<Track>> {
  const shelf = await runScopedOperation(getClient, signal, () => artist.getAllSongs());
  if (!shelf) return unavailablePage('Top songs are not available for this artist.');
  const rows = rowsFromNodes(trackRowFamily, shelf.contents, shelf.continuation);
  if (shelf.collapsed_item_count > rows.items.length && rows.step === null) rows.truncated = true;
  return buildCatalogPage(trackPaging(getClient, true), rows);
}

/** The album tracklist shelf (first MusicShelf); related shelves are carousels. */
function albumTracklistShelf(album: AlbumPage): YTNodes.MusicShelf | null {
  const shelves = album.page.contents_memo?.getType(YTNodes.MusicShelf) ?? [];
  return (
    shelves.find((node): node is YTNodes.MusicShelf => node instanceof YTNodes.MusicShelf) ?? null
  );
}

/**
 * Album header metadata. Header artist/year/thumbnail fill missing summary
 * fields only; explicit per-track artists are never overwritten.
 */
function albumSummaryFromHeader(id: string, header: AlbumPage['header']): AlbumSummary {
  if (!header) return { id, title: '', artist: '' };
  const detail = header instanceof YTNodes.MusicDetailHeader ? header : null;
  const responsive = header instanceof YTNodes.MusicResponsiveHeader ? header : null;
  const author = detail?.author;
  const strapline = responsive?.strapline_text_one;
  const artistId =
    author?.channel_id ??
    (strapline?.endpoint
      ? (strapline.endpoint.payload?.browseId as string | undefined)
      : undefined);
  return {
    id,
    title: textString(detail?.title ?? responsive?.title),
    artist: author?.name ?? textString(strapline),
    artistId,
    thumbnailUrl: detail?.thumbnails[0]?.url ?? responsive?.thumbnail?.contents[0]?.url,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class YouTubeProvider implements IProvider {
  readonly id = 'youtube';
  readonly name = 'YouTube Music';
  readonly icon = '▶';

  /**
   * Injectable client accessor lets catalog tests run against real
   * parser-node fixtures; production shares the single-flight client and
   * therefore real fetch-level cancellation.
   */
  constructor(private readonly getClient: () => Promise<Innertube> = getYouTubeClient) {}

  async search(query: string, opts?: SearchOptions): Promise<SearchResult> {
    // Page 2+: the continuation handle owns the SDK page and its signal.
    if (opts?.continuation) return opts.continuation.next(opts.signal);

    const page = await runYouTubeOperation(opts?.signal, (yt) =>
      yt.music.search(query, { type: 'song' }),
    );
    const tracks = tracksFromFirstPage(page);
    Logger.info(`YouTube search '${query}': ${tracks.length} results`);

    return {
      tracks,
      hasMore: page.has_continuation,
      continuation: page.has_continuation ? wrapSearchContinuation(page) : undefined,
    };
  }

  async getTrack(id: string, signal?: AbortSignal): Promise<Track> {
    const info = await runYouTubeOperation(signal, (yt) => yt.music.getInfo(id));

    const meta = info.basic_info;
    // The player response carries no music browse metadata: artist/album
    // links stay unavailable rather than being guessed from the author name.
    return {
      id,
      provider: 'youtube',
      source: { kind: 'youtube', videoId: id },
      title: meta.title ?? 'Unknown',
      artist: meta.author ?? 'Unknown Artist',
      duration: meta.duration ?? 0,
      thumbnailUrl: meta.thumbnail?.[0]?.url,
    };
  }

  /**
   * Return a YouTube Music URL that mpv + yt-dlp can play directly.
   * No URL deciphering needed — yt-dlp handles it.
   */
  async getStreamUrl(track: Track): Promise<string> {
    return `https://music.youtube.com/watch?v=${track.id}`;
  }

  async getSearchSuggestions(query: string, signal?: AbortSignal): Promise<string[]> {
    try {
      const sections = await runYouTubeOperation(signal, (yt) =>
        yt.music.getSearchSuggestions(query),
      );
      return extractSuggestions(sections);
    } catch (err) {
      if (signal?.aborted) throw err;
      return [];
    }
  }

  async getArtist(id: string, signal?: AbortSignal): Promise<ArtistDetail> {
    if (!isValidArtistId(id)) throw new Error(`Not a YouTube artist browse ID: ${id}`);
    signal?.throwIfAborted();
    const artist = await runScopedOperation(this.getClient, signal, (client) =>
      client.music.getArtist(id),
    );
    const summary = artistSummary(id, artist.header);
    const description =
      artist.header instanceof YTNodes.MusicImmersiveHeader && !artist.header.description.isEmpty()
        ? artist.header.description.toString()
        : undefined;

    // Full first page of every supported collection, concurrently after the
    // metadata arrives. A missing or failed section is an explicit limitation,
    // not a fatal failure of the other sections; cancellation rethrows.
    const section = async <T>(
      title: string,
      load: () => Promise<CatalogPage<T>>,
    ): Promise<CatalogPage<T>> => {
      try {
        return await load();
      } catch (value) {
        if (signal?.aborted) throw value;
        return unavailablePage(
          `${title} could not be loaded: ${value instanceof Error ? value.message : String(value)}`,
        );
      }
    };
    const [albums, singles, topTracks] = await Promise.all([
      section('Albums', () => releaseCollection(this.getClient, signal, artist, 'Albums')),
      section('Singles & EPs', () =>
        releaseCollection(this.getClient, signal, artist, 'Singles & EPs'),
      ),
      section('Top songs', () => topSongsCollection(this.getClient, signal, artist)),
    ]);

    return { ...summary, description, albums, singles, topTracks };
  }

  async getAlbum(id: string, signal?: AbortSignal): Promise<AlbumDetail> {
    if (!isValidReleaseId(id)) throw new Error(`Not a YouTube release browse ID: ${id}`);
    signal?.throwIfAborted();
    const album = await runScopedOperation(this.getClient, signal, (client) =>
      client.music.getAlbum(id),
    );
    const summary = albumSummaryFromHeader(id, album.header);
    const year =
      parseYear(
        album.header instanceof YTNodes.MusicDetailHeader ? album.header.year : undefined,
      ) ??
      parseYear(
        album.header instanceof YTNodes.MusicResponsiveHeader
          ? textString(album.header.second_subtitle)
          : undefined,
      );
    const shelf = albumTracklistShelf(album);
    const tracks = shelf
      ? buildCatalogPage(
          trackPaging(this.getClient, false, albumTrackContext(id, summary)),
          rowsFromNodes(trackRowFamily, shelf.contents, shelf.continuation ?? null),
        )
      : unavailablePage<Track>('The album track list is unavailable.');
    return { ...summary, year, tracks };
  }
}

// ---------------------------------------------------------------------------
// Native transcript translation
// ---------------------------------------------------------------------------

/**
 * Fetch a translated transcript for a YouTube video using the youtubei.js
 * captions API. Returns translated LyricLine[] with synced timestamps, or
 * null when the language is unavailable (callers then fall back to the
 * external translation provider). The signal aborts the underlying HTTP
 * requests through the custom fetch; an aborted call rethrows.
 */
export async function getTranslatedTranscript(
  videoId: string,
  targetLang: string,
  signal?: AbortSignal,
): Promise<LyricLine[] | null> {
  try {
    const info = await runYouTubeOperation(signal, (yt) => yt.getInfo(videoId));
    const transcriptInfo = await runYouTubeOperation(signal, () => info.getTranscript());

    // Map the ISO code to the display name selectLanguage() compares against.
    const languageName = transcriptLanguageName(
      targetLang,
      info.captions,
      transcriptInfo.languages,
    );
    if (!languageName) {
      Logger.info(`YouTube transcript translation to '${targetLang}' not available for ${videoId}`);
      return null;
    }

    // Selecting the language returns a TranscriptInfo with translated segments.
    const translated = await runYouTubeOperation(signal, () =>
      transcriptInfo.selectLanguage(languageName),
    );
    const panel = translated.transcript.content;
    if (!panel) return null;

    const body = panel.body;
    if (!body) return null;

    const segments = body.initial_segments;
    if (!segments || segments.length === 0) return null;

    const lines: LyricLine[] = [];
    for (const seg of segments) {
      // Only TranscriptSegment carries timing/snippet; skip section headers.
      if (!(seg instanceof YTNodes.TranscriptSegment)) continue;
      const text = seg.snippet.toString();
      if (!text) continue;
      lines.push({
        time: Number.parseInt(seg.start_ms, 10) / 1000,
        text,
      });
    }

    Logger.info(`YouTube translated transcript: ${lines.length} lines (${targetLang})`);
    return lines;
  } catch (err) {
    if (signal?.aborted) throw err;
    Logger.error(`YouTube transcript translation failed: ${err}`);
    return null;
  }
}

/**
 * Merge a native YouTube caption translation into source lyrics lines by
 * timestamp (stage 4 alignment rules). Timestamps are matched normalized to
 * integer milliseconds and nonempty source lines must align completely and
 * one-to-one; blank source/native lines never pair. Untimed sources (all
 * nonempty lines sharing one timestamp) and missing or ambiguous timestamps
 * return null so the caller falls back to translating the entire document
 * externally — unrelated captions are never zipped by array index.
 */
export function alignNativeTranslation(
  sourceLines: readonly LyricLine[],
  translatedLines: readonly LyricLine[],
): LyricLine[] | null {
  // Nonempty translated lines keyed by integer milliseconds; duplicate keys
  // make the pairing ambiguous.
  const translatedByTime = new Map<number, string>();
  for (const line of translatedLines) {
    if (line.text.trim().length === 0) continue;
    const time = Math.round(line.time * 1000);
    if (translatedByTime.has(time)) return null;
    translatedByTime.set(time, line.text);
  }

  // Every nonempty source line needs a unique timestamp present in the
  // translated captions. Duplicate source timestamps (including the shared
  // zero timestamp of untimed lyrics) make one-to-one alignment impossible.
  const sourceTimes = new Set<number>();
  for (const line of sourceLines) {
    if (line.text.trim().length === 0) continue;
    const time = Math.round(line.time * 1000);
    if (sourceTimes.has(time)) return null;
    sourceTimes.add(time);
    if (!translatedByTime.has(time)) return null;
  }

  return sourceLines.map((line) => {
    if (line.text.trim().length === 0) return { ...line, translatedText: '' };
    // Membership was verified above; the fallback is unreachable.
    const translatedText = translatedByTime.get(Math.round(line.time * 1000)) ?? '';
    return { ...line, translatedText };
  });
}
