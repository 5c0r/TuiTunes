// Fixture stand-in for the yt-dlp caption download arguments used by
// extractYouTubeSrt: [--write-auto-sub --sub-lang en --sub-format srt
// --skip-download -o <base> <videoUrl>]. Writes <base>.en.srt on success.
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const outputIndex = argv.indexOf('-o');
const outputBase = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
const url = argv[argv.length - 1] ?? '';
const videoId = url.split('=').pop() ?? '';

if (videoId === 'FAILVIDEO') {
  await Bun.write(Bun.stderr, 'caption download failed\n');
  process.exitCode = 1;
} else if (videoId === 'NOFILEVIDEO') {
  process.exitCode = 0;
} else if (videoId === 'HANGVIDEO') {
  await new Promise<never>(() => {});
} else if (!outputBase) {
  process.exitCode = 2;
} else {
  writeFileSync(`${outputBase}.en.srt`, '1\n00:00:00,500 --> 00:00:02,000\nHello from fixture\n');
  process.exitCode = 0;
}
