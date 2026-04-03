import * as os from 'node:os';
import * as path from 'node:path';
import { parseFile } from 'music-metadata';
import type { IProvider, SearchResult, Track } from './types';
import { Logger } from '../utils/logger';

export class LocalProvider implements IProvider {
  readonly id = 'local';
  readonly name = 'Local Files';
  readonly icon = '♪';

  private tracks: Track[] = [];
  private dirs: string[];
  private scanned = false;

  constructor(dirs: string[]) {
    this.dirs = dirs.map((d) =>
      d.startsWith('~') ? path.join(os.homedir(), d.slice(1)) : d
    );
  }

  async scan(): Promise<void> {
    const glob = new Bun.Glob('**/*.{mp3,flac,ogg,opus,m4a,wav,aac,wma}');
    const tracks: Track[] = [];

    for (const dir of this.dirs) {
      for await (const relPath of glob.scan({ cwd: dir, onlyFiles: true })) {
        const fullPath = path.join(dir, relPath);
        try {
          const meta = await parseFile(fullPath);
          const filename = path.basename(fullPath, path.extname(fullPath));
          tracks.push({
            id: fullPath,
            provider: 'local',
            title: meta.common.title ?? filename,
            artist: meta.common.artist ?? 'Unknown Artist',
            album: meta.common.album,
            duration: Math.round(meta.format.duration ?? 0),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          Logger.error(`Failed to parse ${fullPath}: ${msg}`);
        }
      }
    }

    this.tracks = tracks;
    this.scanned = true;
    Logger.info(`Scanned ${tracks.length} tracks from ${this.dirs.length} dirs`);
  }

  private async ensureScanned(): Promise<void> {
    if (!this.scanned) {
      await this.scan();
    }
  }

  async search(query: string): Promise<SearchResult> {
    await this.ensureScanned();

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = terms.length === 0
      ? this.tracks
      : this.tracks.filter((t) => {
          const haystack = `${t.title} ${t.artist} ${t.album ?? ''}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        });

    return {
      tracks: matched.slice(0, 50),
      hasMore: matched.length > 50,
    };
  }

  async getTrack(id: string): Promise<Track> {
    await this.ensureScanned();
    const track = this.tracks.find((t) => t.id === id);
    if (!track) {
      throw new Error(`Track not found: ${id}`);
    }
    return track;
  }

  async getStreamUrl(track: Track): Promise<string> {
    return track.id;
  }

  async getAllTracks(): Promise<Track[]> {
    await this.ensureScanned();
    return this.tracks;
  }
}
