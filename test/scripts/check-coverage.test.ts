import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  COVERAGE_THRESHOLD,
  LcovSyntaxError,
  checkCoverage,
  computeTotals,
  crossCheckFileSummary,
  isTypeOnlyModule,
  normalizeLcovPath,
  parseLcov,
} from '../../scripts/check-coverage';

const roots: string[] = [];

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-coverage-test-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RUNTIME_MODULE = 'export function greet() {\n  return 1;\n}\n';
const OTHER_RUNTIME_MODULE = 'export const value = 2;\n';
const TYPE_ONLY_MODULE = 'import type { Greeter } from "./greet";\n\nexport interface Options {\n  greeter: Greeter;\n}\n\nexport type Mode = "a" | "b";\n';

function lcovForApp(hitLines: number[], lineCount: number, fnHits: number[] = [1, 1]): string {
  const da = Array.from({ length: lineCount }, (_, i) => `DA:${i + 1},${hitLines.includes(i + 1) ? 1 : 0}`);
  return [
    'SF:src/app.ts',
    'FN:1,greet',
    `FNDA:${fnHits[0]},greet`,
    'FN:2,helper',
    `FNDA:${fnHits[1] ?? 0},helper`,
    ...da,
    'end_of_record',
    '',
  ].join('\n');
}

describe('parseLcov and computeTotals', () => {
  test('aggregates DA/FN/FNDA records without requiring summaries', () => {
    const files = parseLcov(lcovForApp([1, 2], 4, [3, 0]));
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file.sourceFile).toBe('src/app.ts');
    expect(file.summary).toBeNull();
    expect(file.lines).toEqual([
      { line: 1, count: 1 },
      { line: 2, count: 1 },
      { line: 3, count: 0 },
      { line: 4, count: 0 },
    ]);
    expect(file.functions).toEqual([
      { name: 'greet', line: 1, hitCount: 3 },
      { name: 'helper', line: 2, hitCount: 0 },
    ]);
    const totals = computeTotals(files);
    expect(totals.executableLines).toBe(4);
    expect(totals.hitLines).toBe(2);
    expect(totals.definedFunctions).toBe(2);
    expect(totals.hitFunctions).toBe(1);
    expect(totals.lineCoverage).toBe(0.5);
    expect(totals.functionCoverage).toBe(0.5);
  });

  test('merges duplicate SF sections for the same file', () => {
    const merged = parseLcov(
      ['SF:src/app.ts', 'DA:1,1', 'FN:1,a', 'FNDA:1,a', 'end_of_record', 'SF:src/app.ts', 'DA:1,2', 'DA:2,0', 'end_of_record', ''].join(
        '\n',
      ),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].lines).toEqual([
      { line: 1, count: 3 },
      { line: 2, count: 0 },
    ]);
    expect(merged[0].functions).toEqual([{ name: 'a', line: 1, hitCount: 1 }]);
  });

  test('rejects malformed records with location details', () => {
    expect(() => parseLcov('SF:src/app.ts\nDA:one,1\nend_of_record\n')).toThrow(LcovSyntaxError);
    expect(() => parseLcov('SF:src/app.ts\nDA:one,1\nend_of_record\n')).toThrow('line 2');
    expect(() => parseLcov('DA:1,1\n')).toThrow('outside of an SF: section');
    expect(() => parseLcov('SF:src/app.ts\nDA:1,1\n')).toThrow('unterminated SF: section');
    expect(() => parseLcov('SF:src/app.ts\nFNDA:3,greet\nend_of_record\n')).toThrow('without a preceding FN record');
  });

  test('cross-checks optional summaries instead of counting them twice', () => {
    const matching = parseLcov(
      'SF:src/app.ts\nFN:1,a\nFNDA:1,a\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nFNF:1\nFNH:1\nend_of_record\n',
    )[0];
    expect(crossCheckFileSummary(matching)).toBeNull();

    const lying = parseLcov(
      'SF:src/app.ts\nFN:1,a\nFNDA:1,a\nDA:1,1\nDA:2,0\nLF:3\nLH:2\nFNF:1\nFNH:1\nend_of_record\n',
    )[0];
    expect(crossCheckFileSummary(lying)).toContain('LF 3 != DA 2');

    // Totals come from records, so a lying summary does not inflate them.
    expect(computeTotals([lying]).executableLines).toBe(2);
    expect(() =>
      parseLcov('SF:src/app.ts\nDA:1,1\nLF:1\nend_of_record\n'),
    ).toThrow('expected LF/LH/FNF/FNH together');
  });

  test('uses complete FNF/FNH summaries as function totals when FN/FNDA records are absent', () => {
    // Exact record shape Bun 1.3.14 emits: DA + LF/LH/FNF/FNH, no FN/FNDA.
    const bunShaped = [
      'TN:',
      'SF:src/app.ts',
      'FNF:84',
      'FNH:35',
      'DA:1,1',
      'DA:2,0',
      'DA:3,2',
      'DA:4,1',
      'LF:4',
      'LH:3',
      'end_of_record',
      '',
    ].join('\n');
    const files = parseLcov(bunShaped);
    expect(files).toHaveLength(1);
    expect(files[0].functions).toEqual([]);
    expect(files[0].summary).toEqual({ linesFound: 4, linesHit: 3, functionsFound: 84, functionsHit: 35 });
    // No FN records exist to disagree with; LF/LH still cross-check against DA.
    expect(crossCheckFileSummary(files[0])).toBeNull();
    const totals = computeTotals(files);
    expect(totals.executableLines).toBe(4);
    expect(totals.hitLines).toBe(3);
    expect(totals.definedFunctions).toBe(84);
    expect(totals.hitFunctions).toBe(35);
    expect(totals.functionCoverage).toBe(35 / 84);
  });

  test('still detects a lying line summary next to summary-only function counters', () => {
    const lyingLines = [
      'SF:src/app.ts',
      'FNF:2',
      'FNH:2',
      'DA:1,1',
      'DA:2,0',
      'LF:9',
      'LH:9',
      'end_of_record',
      '',
    ].join('\n');
    const [file] = parseLcov(lyingLines);
    expect(crossCheckFileSummary(file)).toContain('LF 9 != DA 2');
    // Function totals still come from the summary; line totals from records.
    const totals = computeTotals([file]);
    expect(totals.executableLines).toBe(2);
    expect(totals.definedFunctions).toBe(2);
    expect(totals.hitFunctions).toBe(2);
  });

  test('gates summary-derived function coverage and passes a clean Bun-shaped report', () => {
    const root = makeRoot({ 'src/app.ts': RUNTIME_MODULE });
    const bunReport = (fnh: number): string =>
      [
        'TN:',
        'SF:src/app.ts',
        'FNF:10',
        `FNH:${fnh}`,
        'DA:1,1',
        'DA:2,1',
        'LF:2',
        'LH:2',
        'end_of_record',
        '',
      ].join('\n');
    const failing = checkCoverage(bunReport(5), root);
    expect(failing.ok).toBe(false);
    expect(failing.totals.definedFunctions).toBe(10);
    expect(failing.totals.hitFunctions).toBe(5);
    expect(failing.failures.map(f => f.kind)).toEqual(['threshold']);
    expect(failing.failures.find(f => f.kind === 'threshold')?.message).toContain('function coverage');

    const passing = checkCoverage(bunReport(10), root);
    expect(passing.ok).toBe(true);
    expect(passing.totals.functionCoverage).toBe(1);
  });
});

describe('module inventory', () => {
  test('exempts type-only modules, declarations, and the smoke-covered entrypoint', () => {
    const root = makeRoot({
      'src/index.tsx': 'console.log("entry");\n',
      'src/greet.ts': RUNTIME_MODULE,
      'src/options.ts': TYPE_ONLY_MODULE,
      'src/legacy.d.ts': 'declare const legacy: number;\n',
    });
    const report = checkCoverage(lcovForApp([1, 2], 2), root);
    expect(report.partition.entrypoint).toEqual(['src/index.tsx']);
    expect(report.partition.typeOnly).toEqual(['src/legacy.d.ts', 'src/options.ts']);
    expect(report.partition.runtime).toEqual(['src/greet.ts']);
    expect(report.missingModules).toEqual(['src/greet.ts']);
    expect(report.failures.map(f => f.kind)).toEqual(['missing-modules']);
  });

  test('classifies emit-erased statements as type-only and everything else as runtime', () => {
    expect(isTypeOnlyModule('a.ts', 'export interface A {}\nexport type B = 1;\nimport type { A } from "./a";\n')).toBe(true);
    expect(isTypeOnlyModule('a.ts', 'export const x = 1;\n')).toBe(false);
    expect(isTypeOnlyModule('a.ts', 'export function f() {}\n')).toBe(false);
    expect(isTypeOnlyModule('a.ts', 'export enum E { A }\n')).toBe(false);
    expect(isTypeOnlyModule('a.ts', 'import { A } from "./a";\nexport type B = A;\n')).toBe(false);
    expect(isTypeOnlyModule('a.d.ts', 'declare const x: number;\n')).toBe(true);
  });

  test('normalizes SF paths relative to the root', () => {
    const root = makeRoot({ 'src/app.ts': RUNTIME_MODULE });
    expect(normalizeLcovPath('src/app.ts', root)).toBe('src/app.ts');
    expect(normalizeLcovPath(`${root}/src/app.ts`, root)).toBe('src/app.ts');
    expect(normalizeLcovPath(`file://${root}/src/app.ts`, root)).toBe('src/app.ts');
    expect(normalizeLcovPath('../outside.ts', root)).toBeNull();
  });
});

describe('checkCoverage gate', () => {
  test('passes a fully covered report without summaries', () => {
    const root = makeRoot({ 'src/app.ts': RUNTIME_MODULE });
    const report = checkCoverage(lcovForApp([1, 2], 2), root);
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.filesConsidered).toBe(1);
    expect(report.totals.lineCoverage).toBe(1);
    expect(report.totals.functionCoverage).toBe(1);
  });

  test('fails uncovered entries below both thresholds', () => {
    const root = makeRoot({ 'src/app.ts': RUNTIME_MODULE });
    const report = checkCoverage(lcovForApp([1], 4, [1, 0]), root);
    expect(report.ok).toBe(false);
    const failures = report.failures.map(f => f.kind);
    expect(failures).toContain('threshold');
    expect(report.totals.hitLines).toBe(1);
    expect(report.totals.executableLines).toBe(4);
    expect(report.totals.hitFunctions).toBe(1);
    expect(report.totals.definedFunctions).toBe(2);
    expect(report.failures.filter(f => f.kind === 'threshold')).toHaveLength(2);
  });

  test('reports a lying summary as a failure without double counting', () => {
    const root = makeRoot({ 'src/app.ts': RUNTIME_MODULE });
    const lcov = 'SF:src/app.ts\nFN:1,a\nFNDA:1,a\nDA:1,1\nDA:2,1\nLF:9\nLH:9\nFNF:9\nFNH:9\nend_of_record\n';
    const report = checkCoverage(lcov, root);
    expect(report.ok).toBe(false);
    expect(report.failures.map(f => f.kind)).toEqual(['summary-mismatch']);
    expect(report.totals.executableLines).toBe(2);
  });

  test('rejects zero aggregate totals', () => {
    const root = makeRoot({ 'src/app.ts': RUNTIME_MODULE });
    const report = checkCoverage('SF:src/app.ts\nDA:1,1\nend_of_record\n', root);
    expect(report.ok).toBe(false);
    expect(report.failures.map(f => f.kind)).toContain('zero-totals');
  });

  test('turns malformed LCOV into a failure instead of throwing', () => {
    const root = makeRoot({ 'src/app.ts': RUNTIME_MODULE });
    const report = checkCoverage('SF:src/app.ts\nDA:oops,1\nend_of_record\n', root);
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      { kind: 'malformed', message: expect.stringContaining('malformed LCOV') },
    ]);
  });

  test('ignores records outside src for totals and thresholds', () => {
    const root = makeRoot({ 'src/app.ts': RUNTIME_MODULE, 'test/app.test.ts': RUNTIME_MODULE });
    const lcov = [
      lcovForApp([1], 4, [1, 1]),
      'SF:test/app.test.ts',
      'FN:1,check',
      'FNDA:1,check',
      'DA:1,1',
      'DA:2,1',
      'end_of_record',
      '',
    ].join('\n');
    const report = checkCoverage(lcov, root);
    expect(report.filesConsidered).toBe(1);
    expect(report.totals.executableLines).toBe(4);
    expect(report.failures.map(f => f.kind)).toEqual(['threshold']);
  });

  test('lists every missing runtime module exactly', () => {
    const root = makeRoot({
      'src/app.ts': RUNTIME_MODULE,
      'src/deep/other.ts': OTHER_RUNTIME_MODULE,
    });
    const report = checkCoverage(lcovForApp([1, 2], 2), root);
    expect(report.missingModules).toEqual(['src/deep/other.ts']);
    const failure = report.failures.find(f => f.kind === 'missing-modules');
    expect(failure && failure.kind === 'missing-modules' && failure.modules).toEqual(['src/deep/other.ts']);
    expect(COVERAGE_THRESHOLD).toBe(0.6);
  });

  test('gates both weighted metrics at the configured thresholds', () => {
    const root = makeRoot({ 'src/app.ts': RUNTIME_MODULE });
    // 3/4 lines (75%) passes the line gate but 1/2 functions (50%) fails the function gate.
    const linesOnlyPassing = checkCoverage(lcovForApp([1, 2, 3], 4, [1, 0]), root, {
      lineThreshold: 0.7,
      functionThreshold: 0.6,
    });
    expect(linesOnlyPassing.ok).toBe(false);
    expect(linesOnlyPassing.failures.filter(f => f.kind === 'threshold')).toHaveLength(1);
    expect(linesOnlyPassing.failures.find(f => f.kind === 'threshold')?.message).toContain('function coverage');

    const relaxed = checkCoverage(lcovForApp([1, 2, 3], 4, [1, 0]), root, {
      lineThreshold: 0.7,
      functionThreshold: 0.5,
    });
    expect(relaxed.ok).toBe(true);
  });
});
