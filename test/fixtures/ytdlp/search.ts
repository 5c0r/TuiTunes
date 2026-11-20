// Fixture stand-in for `yt-dlp --dump-json --default-search ytsearch1 <query>`.
// Receives its argv from runYtDlp's command seam; query is the last arg.
// Optional --marker <file> appends one line per invocation for cache tests.
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const markerIndex = argv.indexOf('--marker');
const markerFile = markerIndex >= 0 ? argv[markerIndex + 1] : undefined;
if (markerFile) {
  appendFileSync(markerFile, 'call\n');
}

const query = argv[argv.length - 1] ?? '';
// The production query is "<podcastTitle> <title>"; branch on the title token.
const title = query.split(' ').pop() ?? '';

if (title === 'HANG') {
  await new Promise<never>(() => {});
} else if (title === 'NOHIT') {
  await Bun.write(Bun.stderr, 'no results\n');
  process.exitCode = 1;
} else if (title === 'GARBAGE') {
  await Bun.write(Bun.stdout, 'definitely not json\n');
  process.exitCode = 0;
} else if (title === 'EMPTY') {
  process.exitCode = 0;
} else {
  await Bun.write(
    Bun.stdout,
    `${JSON.stringify({ id: query.replace(/[^a-zA-Z0-9]+/g, '_') })}\n`,
  );
  process.exitCode = 0;
}
