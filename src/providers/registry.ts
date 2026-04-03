import type { IProvider } from './types';
import type { TuiTunesConfig } from '../utils/config';
import { YouTubeProvider } from './youtube';

const providers: Map<string, IProvider> = new Map();

export function registerProvider(provider: IProvider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: string): IProvider | undefined {
  return providers.get(id);
}

export function getActiveProvider(): IProvider {
  const first = providers.values().next();
  if (first.done) {
    throw new Error('No providers registered');
  }
  return first.value;
}

export function getAllProviders(): IProvider[] {
  return Array.from(providers.values());
}

export function initProviders(_config: TuiTunesConfig): void {
  registerProvider(new YouTubeProvider());
}
