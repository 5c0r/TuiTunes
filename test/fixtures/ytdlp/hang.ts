// Never-exiting child for timeout/abort/killAll tests. Writes its PID to the
// path given as the first argument so the parent can verify it was reaped.
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}
await new Promise<never>(() => {});
