import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { SurefireSummarySchema, type SurefireSummary } from '../domain/types.js';
import type { ExecFileAsyncFn } from '../oracle/xsd-ast-diff.js';
import type { MavenTestRunResult } from '../ports/interfaces.js';
import { sanitizeLogMessage } from '../privacy/dlp-filter.js';
import {
  defaultExecFileAsync,
  extractExecFailureDetails,
  getErrnoCode,
  readNoFollowUtf8,
  resolveContainedNoSymlinkPath,
} from './exec-utils.js';

const MAVEN_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAVEN_TIMEOUT_MS = 180_000;
const DISALLOWED_MAVEN_OPTS_RE = /[\r\n\0]|-(?:javaagent|agentpath|agentlib)\s*:/i;

const SAFE_TOOLCHAIN_ENV_KEYS: readonly string[] = [
  'PATH',
  'JAVA_HOME',
  'M2_HOME',
  'MAVEN_HOME',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'COMSPEC',
  'WINDIR',
  'TMP',
  'TMPDIR',
  'TEMP',
  'LANG',
  'LC_ALL',
];

/** Options for instantiating `HostMavenRunner`. */
export interface HostMavenRunnerOptions {
  readonly mavenBin?: string;
  readonly execFileFn?: ExecFileAsyncFn;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/** Input options for executing Maven tests inside an isolated worktree. */
export interface RunMavenTestsInput {
  readonly worktreeDir: string;
  readonly useRelease8Flag?: boolean;
  readonly mavenOffline?: boolean;
  readonly createdTestFiles?: readonly string[];
  readonly mavenOpts?: string;
}

/** Builds a minimal allowlisted environment excluding LLM, Gitea, and cloud credentials. */
export function buildSanitizedToolchainEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  mavenOpts?: string,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const key of SAFE_TOOLCHAIN_ENV_KEYS) {
    const val = baseEnv[key];
    if (typeof val === 'string' && val.length > 0) {
      sanitized[key] = val;
    }
  }
  if (mavenOpts && mavenOpts.trim().length > 0) {
    const trimmed = mavenOpts.trim();
    if (DISALLOWED_MAVEN_OPTS_RE.test(trimmed)) {
      throw new Error('MAVEN_OPTS contém flag ou caractere proibido');
    }
    sanitized.MAVEN_OPTS = trimmed;
  }
  return sanitized;
}

async function collectSurefireXmlFiles(worktreeDir: string): Promise<string[]> {
  const results: string[] = [];
  let reportsDir: string;
  try {
    reportsDir = await resolveContainedNoSymlinkPath(worktreeDir, 'target/surefire-reports');
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }

  try {
    const entries = await readdir(reportsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && !entry.isSymbolicLink() && /^TEST-.*\.xml$/i.test(entry.name)) {
        results.push(path.join(reportsDir, entry.name));
      }
    }
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') {
      throw error;
    }
  }
  return results.sort();
}

function parseNonNegativeInt(raw: string | undefined): number {
  if (!raw) {
    return 0;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Parses `target/surefire-reports/TEST-*.xml` files via `cheerio` XML mode (XXE-safe). */
export async function parseSurefireReports(worktreeDir: string): Promise<SurefireSummary> {
  const xmlFiles = await collectSurefireXmlFiles(worktreeDir);
  const xmlContents = await Promise.all(xmlFiles.map((xmlPath) => readNoFollowUtf8(xmlPath)));

  let total = 0;
  let errors = 0;
  let failures = 0;
  let skipped = 0;
  const failedClassSet = new Set<string>();

  for (const xml of xmlContents) {
    const $ = cheerio.load(xml, { xmlMode: true });
    $('testsuite').each((_idx, suiteEl) => {
      const suite = $(suiteEl);
      total += parseNonNegativeInt(suite.attr('tests'));
      errors += parseNonNegativeInt(suite.attr('errors'));
      failures += parseNonNegativeInt(suite.attr('failures'));
      skipped += parseNonNegativeInt(suite.attr('skipped'));
      const suiteName = suite.attr('name')?.trim();

      suite.find('testcase').each((_tcIdx, tcEl) => {
        const tc = $(tcEl);
        if (tc.find('failure, error').length > 0) {
          const className = tc.attr('classname')?.trim() || suiteName;
          if (className) {
            failedClassSet.add(className);
          }
        }
      });
    });
  }

  return SurefireSummarySchema.parse({
    total,
    errors,
    failures,
    skipped,
    failedClasses: [...failedClassSet],
  });
}

const INFRA_ERROR_PATTERNS: readonly RegExp[] = [
  /Non-resolvable parent POM/i,
  /Could not transfer artifact/i,
  /Unresolveable build extension/i,
  /maven-default-http-blocker/i,
  /status code:\s*(?:401|403|5\d\d)/i,
  /UnsupportedClassVersionError/i,
  /ExceptionInInitializerError[\s\S]*lombok/i,
  /UnknownHostException/i,
  /Connection timed out/i,
  /JAVA_HOME is not defined correctly/i,
  /Cannot run program/i,
  /\b(?:ENOENT|EACCES|command not found)\b/i,
];

const COMPILE_ERROR_PATTERNS: readonly RegExp[] = [
  /COMPILATION ERROR/i,
  /maven-compiler-plugin:[^:]*:compile/i,
  /maven-compiler-plugin:[^:]*:testCompile/i,
  /cannot find symbol/i,
  /package [^\s]+ does not exist/i,
];

function extractTestClassSimpleNames(items: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const item of items) {
    if (item.endsWith('.java')) {
      names.add(path.basename(item, '.java'));
      continue;
    }
    const simple = item.includes('.') ? item.split('.').pop() ?? item : item;
    if (simple) {
      names.add(simple);
    }
  }
  return names;
}

function matchesCreatedTestClass(failedClass: string, createdSimpleNames: ReadonlySet<string>): boolean {
  const simple = failedClass.includes('.') ? failedClass.split('.').pop() ?? failedClass : failedClass;
  return createdSimpleNames.has(failedClass) || createdSimpleNames.has(simple);
}

/** Deterministic 3-way classifier prioritizing infra and legacy test protection over repair. */
export function classifyMavenFailure(input: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly surefireSummary: SurefireSummary;
  readonly createdTestClassNames: readonly string[];
}): MavenTestRunResult['classification'] {
  const combined = `${input.stdout}\n${input.stderr}`;
  const hasSurefireFailures = input.surefireSummary.errors + input.surefireSummary.failures > 0;

  if (input.exitCode === 0 && !hasSurefireFailures) {
    return 'PASSED';
  }
  if (INFRA_ERROR_PATTERNS.some((pattern) => pattern.test(combined))) {
    return 'INFRA_ERROR';
  }

  const createdSet = extractTestClassSimpleNames(input.createdTestClassNames);
  const hasLegacyFailure = input.surefireSummary.failedClasses.some(
    (cls) => !matchesCreatedTestClass(cls, createdSet),
  );
  if (hasLegacyFailure) {
    return 'LEGACY_TEST_FAILURE';
  }

  if (COMPILE_ERROR_PATTERNS.some((pattern) => pattern.test(combined))) {
    return 'SYNTHETIC_OR_COMPILE_ERROR';
  }
  if (hasSurefireFailures) {
    return 'SYNTHETIC_OR_COMPILE_ERROR';
  }
  return 'INFRA_ERROR';
}

function formatMavenSummary(
  classification: MavenTestRunResult['classification'],
  surefire: SurefireSummary,
): string {
  switch (classification) {
    case 'PASSED':
      return `Maven tests PASSED (${surefire.total} executed, ${surefire.skipped} skipped).`;
    case 'INFRA_ERROR':
      return 'Maven aborted due to environment/dependency infrastructure error.';
    case 'LEGACY_TEST_FAILURE':
      return `Legacy test regression in: ${surefire.failedClasses.join(', ')}`;
    case 'SYNTHETIC_OR_COMPILE_ERROR':
      return surefire.failedClasses.length > 0
        ? `Synthetic/compile failure in: ${surefire.failedClasses.join(', ')}`
        : 'Java compilation failure detected.';
  }
}

/** Executes host `mvn test` in an isolated worktree using `shell: false` and sanitized env. */
export class HostMavenRunner {
  private readonly mavenBin: string;
  private readonly execFileFn: ExecFileAsyncFn;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(options: HostMavenRunnerOptions = {}) {
    this.mavenBin = options.mavenBin ?? 'mvn';
    this.execFileFn = options.execFileFn ?? defaultExecFileAsync;
    this.baseEnv = options.baseEnv ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MAVEN_TIMEOUT_MS;
  }

  async runMavenTests(input: RunMavenTestsInput): Promise<MavenTestRunResult> {
    const reportsPath = path.join(input.worktreeDir, 'target', 'surefire-reports');
    await rm(reportsPath, { recursive: true, force: true }).catch(() => undefined);

    const args = [
      'test',
      '-B',
      ...(input.useRelease8Flag ? ['-Dmaven.compiler.release=8'] : []),
      ...(input.mavenOffline ? ['-o'] : []),
    ];

    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    try {
      const output = await this.execFileFn(this.mavenBin, args, {
        cwd: input.worktreeDir,
        shell: false,
        maxBuffer: MAVEN_MAX_BUFFER_BYTES,
        timeout: this.timeoutMs,
        env: buildSanitizedToolchainEnv(this.baseEnv, input.mavenOpts),
      });
      stdout = output.stdout;
      stderr = output.stderr;
    } catch (error) {
      const details = extractExecFailureDetails(error);
      exitCode = details.code ?? 1;
      stdout = details.stdout;
      stderr = details.stderr || details.message;
    }

    const surefireSummary = await parseSurefireReports(input.worktreeDir);
    const classification = classifyMavenFailure({
      exitCode,
      stdout,
      stderr,
      surefireSummary,
      createdTestClassNames: input.createdTestFiles ?? [],
    });

    return {
      passed: classification === 'PASSED',
      classification,
      summary: formatMavenSummary(classification, surefireSummary),
      failedTestClasses: surefireSummary.failedClasses,
      sanitizedLog: sanitizeLogMessage(`${stdout}\n${stderr}`.trim()),
      surefireSummary,
    };
  }
}
