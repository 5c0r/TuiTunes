#!/usr/bin/env bun
/**
 * Weighted coverage gate for the source tree.
 *
 * Computes executable/hit line totals from DA records and defined/hit
 * function totals from FN/FNDA records per source file. For a metric whose
 * records are absent (Bun emits FNF/FNH summaries with no FN/FNDA), a
 * complete LH/LF/FNH/FNF summary is the source of truth instead; summaries
 * that accompany records are cross-checked against them, never counted
 * twice.
 *
 * Enumerates every TS/TSX module under src, exempts type-only modules
 * plus src/index.tsx (covered by the compiled smoke test), and fails when
 * any remaining runtime module is absent from the LCOV report.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/** Coverage gate for both weighted metrics. */
export const COVERAGE_THRESHOLD = 0.6;

/** Entry point excluded from LCOV requirements: proven by scripts/smoke-compiled.ts. */
export const SMOKE_COVERED_ENTRYPOINT = 'src/index.tsx';

/** Only records under this prefix contribute to weighted totals and the module inventory. */
export const SOURCE_ROOT = 'src';

export interface LcovLineRecord {
  line: number;
  count: number;
}

export interface LcovFunctionRecord {
  name: string;
  line: number;
  hitCount: number | null;
}

export interface LcovSummaryRecord {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
}

/** One `SF:` … `end_of_record` section, with duplicate sections for the same path merged. */
export interface LcovFileRecord {
  sourceFile: string;
  lines: LcovLineRecord[];
  functions: LcovFunctionRecord[];
  summary: LcovSummaryRecord | null;
}

export interface CoverageTotals {
  executableLines: number;
  hitLines: number;
  definedFunctions: number;
  hitFunctions: number;
  lineCoverage: number;
  functionCoverage: number;
}

export type CoverageFailure =
  | { kind: 'malformed'; message: string }
  | { kind: 'zero-totals'; message: string }
  | { kind: 'summary-mismatch'; message: string }
  | { kind: 'missing-modules'; message: string; modules: string[] }
  | { kind: 'threshold'; message: string };

export interface ModulePartition {
  /** Runtime modules that must appear in the LCOV report. */
  runtime: string[];
  /** Type-only modules (AST-verified) and .d.ts declarations; nothing to execute. */
  typeOnly: string[];
  /** The compiled-smoke-covered entrypoint. */
  entrypoint: string[];
}

export interface CheckCoverageOptions {
  lineThreshold?: number;
  functionThreshold?: number;
}

export interface CoverageReport {
  ok: boolean;
  totals: CoverageTotals;
  /** Number of src/ files whose records were aggregated. */
  filesConsidered: number;
  missingModules: string[];
  partition: ModulePartition;
  failures: CoverageFailure[];
}

/** Thrown by parseLcov on structurally invalid LCOV input. */
export class LcovSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LcovSyntaxError';
  }
}

const EMPTY_TOTALS: CoverageTotals = {
  executableLines: 0,
  hitLines: 0,
  definedFunctions: 0,
  hitFunctions: 0,
  lineCoverage: 0,
  functionCoverage: 0,
};

function parseCount(raw: string, context: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new LcovSyntaxError(`${context}: expected a nonnegative integer, got "${raw}"`);
  }
  return Number(raw);
}

function parseLine(raw: string, context: string): number {
  const value = parseCount(raw, context);
  if (value === 0) {
    throw new LcovSyntaxError(`${context}: line numbers start at 1`);
  }
  return value;
}

interface FileSection {
  lines: Map<number, number>;
  functions: Map<string, LcovFunctionRecord>;
  summary: Partial<LcovSummaryRecord>;
}

function mergeFunction(section: FileSection, record: LcovFunctionRecord): void {
  const existing = section.functions.get(record.name);
  if (!existing) {
    section.functions.set(record.name, record);
    return;
  }
  if (existing.line === 0) existing.line = record.line;
  if (record.hitCount !== null) {
    existing.hitCount = existing.hitCount === null ? record.hitCount : existing.hitCount + record.hitCount;
  }
}

function fail(lineNumber: number, line: string, reason: string): never {
  throw new LcovSyntaxError(`line ${lineNumber} (${line.trim()}): ${reason}`);
}

/**
 * Parse LCOV text into per-file records. Duplicate SF sections for the same
 * path are merged (line counts summed, FNDA counts summed). Throws
 * LcovSyntaxError on malformed records. BRDA/BRF/BRH and TN: records are
 * ignored; LH/LF/FNH/FNF are captured for the optional cross-check.
 */
export function parseLcov(text: string): LcovFileRecord[] {
  const sections = new Map<string, FileSection>();
  let current: FileSection | null = null;
  let currentPath: string | null = null;

  // fail is declared at module scope so TypeScript treats calls to it as never-returning.

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (raw.trim() === '' || raw.startsWith('#')) continue;
    const record = raw.trimEnd();
    const at = index + 1;

    if (record === 'end_of_record') {
      if (!current) fail(at, record, 'end_of_record without SF:');
      current = null;
      currentPath = null;
      continue;
    }

    if (record.startsWith('SF:')) {
      const path = record.slice(3).trim();
      if (path === '') fail(at, record, 'SF: with empty path');
      if (current) fail(at, record, 'nested SF: record');
      currentPath = path;
      current = sections.get(path) ?? { lines: new Map(), functions: new Map(), summary: {} };
      sections.set(path, current);
      continue;
    }

    // Records that belong to a file section.
    const sectionRecord = (): FileSection => {
      if (!current) fail(at, record, 'record outside of an SF: section');
      return current;
    };

    if (record.startsWith('DA:')) {
      const parts = record.slice(3).split(',');
      if (parts.length < 2 || parts.length > 3) fail(at, record, 'DA: expects "<line>,<count>[,<checksum>]"');
      const line = parseLine(parts[0], `line ${at} DA`);
      const count = parseCount(parts[1], `line ${at} DA`);
      const section = sectionRecord();
      section.lines.set(line, (section.lines.get(line) ?? 0) + count);
      continue;
    }

    if (record.startsWith('FN:')) {
      const rest = record.slice(3);
      const comma = rest.indexOf(',');
      if (comma < 0) fail(at, record, 'FN: expects "<line>,<name>"');
      const line = parseLine(rest.slice(0, comma), `line ${at} FN`);
      const name = rest.slice(comma + 1);
      if (name === '') fail(at, record, 'FN: with empty function name');
      mergeFunction(sectionRecord(), { name, line, hitCount: null });
      continue;
    }

    if (record.startsWith('FNDA:')) {
      const rest = record.slice(5);
      const comma = rest.indexOf(',');
      if (comma < 0) fail(at, record, 'FNDA: expects "<count>,<name>"');
      const count = parseCount(rest.slice(0, comma), `line ${at} FNDA`);
      const name = rest.slice(comma + 1);
      if (name === '') fail(at, record, 'FNDA: with empty function name');
      const section = sectionRecord();
      const existing = section.functions.get(name);
      if (!existing) fail(at, record, 'FNDA: for a function without a preceding FN record');
      existing.hitCount = (existing.hitCount ?? 0) + count;
      continue;
    }

    const summaryField = (prefix: string): number | undefined => {
      if (!record.startsWith(prefix)) return undefined;
      return parseCount(record.slice(prefix.length), `line ${at} ${prefix}`);
    };

    const lf = summaryField('LF:');
    const lh = summaryField('LH:');
    const fnf = summaryField('FNF:');
    const fnh = summaryField('FNH:');
    const value = lf ?? lh ?? fnf ?? fnh;
    if (value !== undefined) {
      const summary = sectionRecord().summary;
      if (lf !== undefined) summary.linesFound = lf;
      if (lh !== undefined) summary.linesHit = lh;
      if (fnf !== undefined) summary.functionsFound = fnf;
      if (fnh !== undefined) summary.functionsHit = fnh;
      continue;
    }

    // TN:, BRDA:, BRF:, BRH: and any other record is not needed by this gate.
  }

  if (current) {
    throw new LcovSyntaxError(`unterminated SF: section for "${currentPath}"`);
  }

  return [...sections.entries()].map(([sourceFile, section]) => {
    const summaryKeys = Object.keys(section.summary);
    if (summaryKeys.length > 0 && summaryKeys.length < 4) {
      throw new LcovSyntaxError(
        `incomplete summary for "${sourceFile}": expected LF/LH/FNF/FNH together, got ${summaryKeys.join(',')}`,
      );
    }
    const hasSummary = summaryKeys.length === 4;
    return {
      sourceFile,
      lines: [...section.lines.entries()].map(([line, count]) => ({ line, count })),
      functions: [...section.functions.values()],
      summary: hasSummary
        ? {
            linesFound: section.summary.linesFound!,
            linesHit: section.summary.linesHit!,
            functionsFound: section.summary.functionsFound!,
            functionsHit: section.summary.functionsHit!,
          }
        : null,
    };
  });
}

/**
 * Sum per-file records into weighted totals. Records are authoritative when
 * present (DA for lines, FN/FNDA for functions); a complete summary is used
 * as the source of truth for whichever metric has no records — the shape
 * Bun emits, which carries FNF/FNH (and LF/LH) but no FN/FNDA records.
 * Pure; callers decide which files count.
 */
export function computeTotals(files: readonly LcovFileRecord[]): CoverageTotals {
  let executableLines = 0;
  let hitLines = 0;
  let definedFunctions = 0;
  let hitFunctions = 0;
  for (const file of files) {
    if (file.lines.length > 0) {
      for (const { count } of file.lines) {
        executableLines += 1;
        if (count > 0) hitLines += 1;
      }
    } else if (file.summary) {
      executableLines += file.summary.linesFound;
      hitLines += file.summary.linesHit;
    }
    if (file.functions.length > 0) {
      for (const fn of file.functions) {
        definedFunctions += 1;
        if ((fn.hitCount ?? 0) > 0) hitFunctions += 1;
      }
    } else if (file.summary) {
      definedFunctions += file.summary.functionsFound;
      hitFunctions += file.summary.functionsHit;
    }
  }
  return {
    executableLines,
    hitLines,
    definedFunctions,
    hitFunctions,
    lineCoverage: executableLines === 0 ? 0 : hitLines / executableLines,
    functionCoverage: definedFunctions === 0 ? 0 : hitFunctions / definedFunctions,
  };
}

/**
 * Cross-check a file's optional LH/LF/FNH/FNF summary against the values
 * computed from its records, but only for metrics whose records exist:
 * summary counters for a metric with no records are the source of truth
 * (nothing to check them against). Returns a mismatch description or null
 * when the summary agrees (or is absent).
 */
export function crossCheckFileSummary(file: LcovFileRecord): string | null {
  if (!file.summary) return null;
  const { summary } = file;
  const mismatches: string[] = [];
  if (file.lines.length > 0) {
    const computedLines = file.lines.length;
    const computedHitLines = file.lines.filter(({ count }) => count > 0).length;
    if (summary.linesFound !== computedLines) mismatches.push(`LF ${summary.linesFound} != DA ${computedLines}`);
    if (summary.linesHit !== computedHitLines) mismatches.push(`LH ${summary.linesHit} != DA hits ${computedHitLines}`);
  }
  if (file.functions.length > 0) {
    const computedFunctions = file.functions.length;
    const computedHitFunctions = file.functions.filter(fn => (fn.hitCount ?? 0) > 0).length;
    if (summary.functionsFound !== computedFunctions) {
      mismatches.push(`FNF ${summary.functionsFound} != FN ${computedFunctions}`);
    }
    if (summary.functionsHit !== computedHitFunctions) {
      mismatches.push(`FNH ${summary.functionsHit} != FNDA hits ${computedHitFunctions}`);
    }
  }
  return mismatches.length === 0 ? null : `${file.sourceFile}: ${mismatches.join('; ')}`;
}

/** Normalize an SF: path to a root-relative POSIX path, or null when it lies outside root. */
export function normalizeLcovPath(sourceFile: string, root: string): string | null {
  const withoutScheme = sourceFile.startsWith('file://') ? sourceFile.slice('file://'.length) : sourceFile;
  const absolute = resolve(root, withoutScheme);
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..')) return null;
  return rel.split(sep).join('/');
}

/** True when every statement in the file is erased at emit time (interfaces, type aliases, type-only imports). */
export function isTypeOnlyModule(fileName: string, source: string): boolean {
  if (fileName.endsWith('.d.ts')) return true;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  return sourceFile.statements.every(statement => {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true;
    switch (statement.kind) {
      case ts.SyntaxKind.InterfaceDeclaration:
      case ts.SyntaxKind.TypeAliasDeclaration:
      case ts.SyntaxKind.EmptyStatement:
        return true;
      case ts.SyntaxKind.ImportDeclaration:
        return (statement as ts.ImportDeclaration).importClause?.isTypeOnly ?? false;
      case ts.SyntaxKind.ExportDeclaration:
        return (statement as ts.ExportDeclaration).isTypeOnly;
      default:
        return false;
    }
  });
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(fullPath);
    }
  };
  walk(join(root, SOURCE_ROOT));
  return out.map(fullPath => relative(root, fullPath).split(sep).join('/')).sort();
}

/** Classify the src/ inventory into runtime, type-only, and smoke-covered entrypoint modules. */
export function partitionModules(root: string): ModulePartition {
  const partition: ModulePartition = { runtime: [], typeOnly: [], entrypoint: [] };
  for (const rel of listSourceFiles(root)) {
    if (rel === SMOKE_COVERED_ENTRYPOINT) {
      partition.entrypoint.push(rel);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(join(root, rel), 'utf8');
    } catch {
      // Unreadable files still count as runtime so they cannot silently vanish.
      partition.runtime.push(rel);
      continue;
    }
    if (isTypeOnlyModule(rel, content)) partition.typeOnly.push(rel);
    else partition.runtime.push(rel);
  }
  return partition;
}

/** Run the full gate: parse, cross-check, inventory, aggregate, threshold. */
export function checkCoverage(
  lcovText: string,
  root: string,
  options: CheckCoverageOptions = {},
): CoverageReport {
  const lineThreshold = options.lineThreshold ?? COVERAGE_THRESHOLD;
  const functionThreshold = options.functionThreshold ?? COVERAGE_THRESHOLD;
  const failures: CoverageFailure[] = [];

  let files: LcovFileRecord[] = [];
  try {
    files = parseLcov(lcovText);
  } catch (error) {
    const message = error instanceof LcovSyntaxError ? error.message : String(error);
    return {
      ok: false,
      totals: EMPTY_TOTALS,
      filesConsidered: 0,
      missingModules: [],
      partition: partitionModules(root),
      failures: [{ kind: 'malformed', message: `malformed LCOV: ${message}` }],
    };
  }

  const partition = partitionModules(root);
  const byRelative = new Map<string, LcovFileRecord>();
  for (const file of files) {
    const rel = normalizeLcovPath(file.sourceFile, root);
    if (rel === null) continue;
    const existing = byRelative.get(rel);
    if (existing) {
      // Duplicate sections for the same file were already merged by path in parseLcov
      // only when the SF string matched; merge distinct spellings here.
      const merged: LcovFileRecord = {
        sourceFile: rel,
        lines: [...mergeLineMaps(existing, file)].map(([line, count]) => ({ line, count })),
        functions: mergeFunctionLists(existing, file),
        summary: existing.summary ?? file.summary,
      };
      byRelative.set(rel, merged);
    } else {
      byRelative.set(rel, { ...file, sourceFile: rel });
    }
  }

  const sourceFiles = [...byRelative.values()].filter(file => file.sourceFile.startsWith(`${SOURCE_ROOT}/`));
  const totals = computeTotals(sourceFiles);

  for (const file of sourceFiles) {
    const mismatch = crossCheckFileSummary(file);
    if (mismatch) failures.push({ kind: 'summary-mismatch', message: `LCOV summary disagrees with records: ${mismatch}` });
  }

  if (totals.executableLines === 0 || totals.definedFunctions === 0) {
    failures.push({
      kind: 'zero-totals',
      message: `zero aggregate totals: ${totals.executableLines} executable lines, ${totals.definedFunctions} functions — refusing to pass an empty report`,
    });
  }

  const missingModules = partition.runtime.filter(rel => !byRelative.has(rel));
  if (missingModules.length > 0) {
    failures.push({
      kind: 'missing-modules',
      message: `${missingModules.length} runtime module(s) absent from LCOV`,
      modules: missingModules,
    });
  }

  const format = (hit: number, total: number): string => `${hit}/${total} (${(total === 0 ? 0 : (hit / total) * 100).toFixed(2)}%)`;
  if (totals.lineCoverage < lineThreshold) {
    failures.push({
      kind: 'threshold',
      message: `weighted line coverage ${format(totals.hitLines, totals.executableLines)} is below the required ${(lineThreshold * 100).toFixed(2)}%`,
    });
  }
  if (totals.functionCoverage < functionThreshold) {
    failures.push({
      kind: 'threshold',
      message: `weighted function coverage ${format(totals.hitFunctions, totals.definedFunctions)} is below the required ${(functionThreshold * 100).toFixed(2)}%`,
    });
  }

  return {
    ok: failures.length === 0,
    totals,
    filesConsidered: sourceFiles.length,
    missingModules,
    partition,
    failures,
  };
}

function mergeLineMaps(a: LcovFileRecord, b: LcovFileRecord): Map<number, number> {
  const merged = new Map<number, number>();
  for (const { line, count } of a.lines) merged.set(line, (merged.get(line) ?? 0) + count);
  for (const { line, count } of b.lines) merged.set(line, (merged.get(line) ?? 0) + count);
  return merged;
}

function mergeFunctionLists(a: LcovFileRecord, b: LcovFileRecord): LcovFunctionRecord[] {
  const merged = new Map<string, LcovFunctionRecord>();
  for (const fn of [...a.functions, ...b.functions]) mergeFunction({ functions: merged, lines: new Map(), summary: {} }, fn);
  return [...merged.values()];
}

export function formatReport(report: CoverageReport): string {
  const { totals, partition } = report;
  const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
  const lines: string[] = [
    `Weighted coverage over ${SOURCE_ROOT}/** (${report.filesConsidered} file(s) in LCOV):`,
    `  lines:     ${totals.hitLines}/${totals.executableLines} (${pct(totals.lineCoverage)}) — required ${(COVERAGE_THRESHOLD * 100).toFixed(2)}%`,
    `  functions: ${totals.hitFunctions}/${totals.definedFunctions} (${pct(totals.functionCoverage)}) — required ${(COVERAGE_THRESHOLD * 100).toFixed(2)}%`,
    `  type-only modules exempt: ${partition.typeOnly.length}${partition.typeOnly.length > 0 ? ` (${partition.typeOnly.join(', ')})` : ''}`,
    `  entrypoint exempt (compiled smoke): ${partition.entrypoint.join(', ') || 'none'}`,
  ];
  for (const failure of report.failures) {
    lines.push(`FAIL [${failure.kind}] ${failure.message}`);
    if (failure.kind === 'missing-modules') {
      for (const module of failure.modules) lines.push(`  missing from LCOV: ${module}`);
    }
  }
  if (report.ok) lines.push('Coverage gate passed.');
  return lines.join('\n');
}

function main(argv: string[]): number {
  const [lcovPath, rootArg] = argv;
  if (!lcovPath || argv.length > 2) {
    process.stderr.write('usage: bun scripts/check-coverage.ts <coverage/lcov.info> [repo-root]\n');
    return 2;
  }
  const root = resolve(rootArg ?? process.cwd());
  let text: string;
  try {
    text = readFileSync(lcovPath, 'utf8');
  } catch (error) {
    process.stderr.write(`cannot read LCOV report "${lcovPath}": ${error}\n`);
    return 2;
  }
  const report = checkCoverage(text, root);
  process.stdout.write(`${formatReport(report)}\n`);
  return report.ok ? 0 : 1;
}

if (import.meta.main) {
  // exitCode (not process.exit) so pending stdout writes flush before exit.
  process.exitCode = main(process.argv.slice(2));
}
