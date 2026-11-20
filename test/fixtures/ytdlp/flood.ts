// Large-output child for pipe-drain and bounded-diagnostics tests.
// Args: <stdoutBytes> <stderrBytes> <exitCode>
const argv = process.argv.slice(2);
const stdoutBytes = Number(argv[0] ?? '65536');
const stderrBytes = Number(argv[1] ?? '4096');
const exitCode = Number(argv[2] ?? '0');

export {}; // module: enables top-level await

await Bun.write(Bun.stdout, 'a'.repeat(stdoutBytes));
await Bun.write(Bun.stderr, 'e'.repeat(stderrBytes));
process.exitCode = exitCode;
