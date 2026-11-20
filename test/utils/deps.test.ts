import { expect, test } from 'bun:test';
import { checkDependencies, type DependencyProbe } from '../../src/utils/deps';

test('both mpv and yt-dlp are mandatory before startup', async () => {
  for (const missing of ['mpv', 'yt-dlp']) {
    const probe: DependencyProbe = {
      which: (name) => (name === missing ? null : `/bin/${name}`),
      version: async () => 'mpv 0.41.0',
    };
    expect(await checkDependencies(probe)).toBe(false);
  }
});
test('unexecutable dependencies and old or unreadable mpv fail; supported versions succeed', async () => {
  const probe: DependencyProbe = {
    which: (name) => `/bin/${name}`,
    version: async () => {
      throw new Error('permission denied');
    },
  };
  expect(await checkDependencies(probe)).toBe(false);
  for (const version of ['mpv 0.34.0', 'garbage'])
    expect(await checkDependencies({ ...probe, version: async () => version })).toBe(false);
  expect(
    await checkDependencies({
      ...probe,
      version: async (path) => (path.endsWith('mpv') ? 'mpv v0.41.0' : '2026.01.01'),
    }),
  ).toBe(true);
});
