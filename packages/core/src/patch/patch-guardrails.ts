import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PatchPayloadSchema,
  type DfeRepoEntry,
  type PatchCreate,
  type PatchEdit,
  type PatchPayload,
} from '../domain/types.js';
import { normalizeRepoRelativePath } from '../domain/validators.js';
import type { OracleAnalyzerPort } from '../ports/interfaces.js';
import { isAllowedRepoPath } from '../privacy/dlp-filter.js';
import { assertSafeXsdContent } from '../svrs/manual-import.js';
import {
  getErrnoCode,
  readNoFollowUtf8,
  resolveContainedNoSymlinkPath,
} from '../toolchain/exec-utils.js';

const DEFAULT_MAX_TOUCHED_FILES = 12;
const DEFAULT_MAX_CHANGED_LINES = 600;
const TEST_FILES_PATTERN = /\btest-files\b/i;

/** Error thrown when a generated patch violates security, package, Java 8, or XSD guardrails. */
export class PatchGuardrailError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`Guardrail de patch bloqueou aplicação: ${violations.join('; ')}`);
    this.name = 'PatchGuardrailError';
    this.violations = Object.freeze([...violations]);
  }
}

/** Input options for validating a `PatchPayload` against repository and XSD guardrails. */
export interface ValidatePatchGuardrailsInput {
  readonly payload: PatchPayload;
  readonly repo: DfeRepoEntry;
  readonly worktreeDir: string;
  readonly xsdDir?: string;
  readonly oracle?: Pick<OracleAnalyzerPort, 'validateXml'>;
  readonly maxTouchedFiles?: number;
  readonly maxTotalChangedLines?: number;
}

/** Result of `validatePatchGuardrails`. */
export interface PatchGuardrailResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
  readonly totalLinesChanged: number;
  readonly touchedFileCount: number;
}

const JAVA_11_PLUS_RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
  { pattern: /(?:^|[;{]\s*)(?:final\s+)?var\s+[a-z_][A-Za-z0-9_]*\s*=/m, reason: 'inferência `var` (Java 10+)' },
  { pattern: /"""/, reason: 'text block `"""` (Java 15+)' },
  { pattern: /(?:^|\s)(?:public\s+|private\s+|protected\s+)?record\s+[A-Z][A-Za-z0-9_]*\s*\(/m, reason: '`record` (Java 16+)' },
  { pattern: /\b(?:sealed\s+(?:class|interface)|non-sealed\s+class)\b/, reason: 'sealed class/interface (Java 17+)' },
  { pattern: /\bcase\s+[^:\n]+->/, reason: 'switch expression `->` (Java 14+)' },
];

const FORBIDDEN_CODE_RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
  { pattern: /\bjava\.lang\.Runtime\b|\bRuntime\s*\.\s*getRuntime\s*\(|\bProcessBuilder\b/, reason: 'execução de processo proibida' },
  { pattern: /\bjava\.net\.|\bjava\.net\.http\.|\bnew\s+(?:Server)?Socket\b|\bopenConnection\b|\bopenStream\b|\bDatagramSocket\b|\bSocketChannel\b/, reason: 'acesso de rede proibido' },
  { pattern: /\bjava\.lang\.reflect\.|\bClass\s*\.\s*forName\b|\bsetAccessible\s*\(|\bjavax\.script\./, reason: 'reflexão/script dinâmico proibido' },
  { pattern: /\bSystem\s*\.\s*(?:exit|getenv|load|loadLibrary)\b/, reason: 'System API restrita proibida' },
  { pattern: /\bFiles\s*\.\s*write\b|\bnew\s+(?:FileWriter|FileOutputStream|PrintWriter|RandomAccessFile)\b/, reason: 'escrita de arquivo em código/teste proibida' },
  { pattern: TEST_FILES_PATTERN, reason: 'referência proibida a test-files' },
  { pattern: /\bsrc[\\/]test[\\/]resources[\\/](?!synthetic(?:[\\/]|$))/i, reason: 'acesso a test resources fora de synthetic/ proibido' },
];

function packageToSrcPrefix(pkg: string): string {
  return `src/main/java/${pkg.replace(/\./g, '/')}/`;
}

function isDefaultTableParserFile(normalizedPath: string, parserPrefix: string): boolean {
  if (!normalizedPath.toLowerCase().startsWith(parserPrefix.toLowerCase())) {
    return false;
  }
  return /^Default[A-Za-z0-9_]*TableParser\.java$/.test(path.posix.basename(normalizedPath));
}

function isEditableJavaTarget(normalizedPath: string, repo: DfeRepoEntry): boolean {
  if (!normalizedPath.endsWith('.java')) {
    return false;
  }
  const lowerPath = normalizedPath.toLowerCase();
  const parserPrefix = packageToSrcPrefix(repo.parserPackage);
  if (isDefaultTableParserFile(normalizedPath, parserPrefix)) {
    return true;
  }

  const blockedPrefixes = [
    parserPrefix.toLowerCase(),
    ...(repo.utilPackage ? [packageToSrcPrefix(repo.utilPackage).toLowerCase()] : []),
  ];
  if (blockedPrefixes.some((prefix) => lowerPath.startsWith(prefix))) {
    return false;
  }

  const allowedPrefixes = [
    packageToSrcPrefix(repo.domainPackage).toLowerCase(),
    packageToSrcPrefix(repo.mapperPackage).toLowerCase(),
    packageToSrcPrefix(repo.tablePackage).toLowerCase(),
    'src/test/java/',
  ];
  return allowedPrefixes.some((prefix) => lowerPath.startsWith(prefix));
}

function validateJavaSnippetSafety(label: string, content: string, violations: string[]): void {
  for (const rule of JAVA_11_PLUS_RULES) {
    if (rule.pattern.test(content)) {
      violations.push(`${label}: sintaxe incompatível com Java 8 (${rule.reason})`);
    }
  }
  for (const rule of FORBIDDEN_CODE_RULES) {
    if (rule.pattern.test(content)) {
      violations.push(`${label}: padrão proibido (${rule.reason})`);
    }
  }
}

function extractJsonPropertyAnnotations(javaCode: string): string[] {
  const matches = javaCode.matchAll(/@JsonProperty\s*\(\s*"([^"]+)"\s*\)/g);
  return [...matches].map((m) => m[1] ?? '').filter(Boolean);
}

function validateJsonPropertyAndTestPreservation(
  relPath: string,
  edit: PatchEdit,
  violations: string[],
): void {
  for (const prop of extractJsonPropertyAnnotations(edit.searchBlock)) {
    const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stillPresent = new RegExp(`@JsonProperty\\s*\\(\\s*"${escaped}"\\s*\\)`).test(edit.replaceBlock);
    if (!stillPresent) {
      violations.push(`${relPath}: alteração removeu ou modificou @JsonProperty("${prop}") existente`);
    }
  }

  if (relPath.startsWith('src/test/java/')) {
    if (/@(?:Disabled|Ignore)\b/.test(edit.replaceBlock)) {
      violations.push(`${relPath}: @Disabled/@Ignore proibido em testes`);
    }
    const beforeTests = (edit.searchBlock.match(/@Test\b/g) ?? []).length;
    const afterTests = (edit.replaceBlock.match(/@Test\b/g) ?? []).length;
    if (afterTests < beforeTests) {
      violations.push(`${relPath}: alteração removeu método(s) @Test existente(s)`);
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (pos <= haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) {
      break;
    }
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

async function validateSingleEdit(
  edit: PatchEdit,
  repo: DfeRepoEntry,
  worktreeDir: string,
  virtualFiles: Map<string, string>,
  violations: string[],
): Promise<number> {
  const relPath = normalizeRepoRelativePath(edit.filePath);
  if (!isAllowedRepoPath(relPath) || !isEditableJavaTarget(relPath, repo)) {
    violations.push(`Edição fora da allowlist permitida (Java domain/mapper/table/DefaultTableParser/test): '${relPath}'`);
    return 0;
  }

  validateJavaSnippetSafety(relPath, edit.replaceBlock, violations);
  validateJsonPropertyAndTestPreservation(relPath, edit, violations);

  let currentContent = virtualFiles.get(relPath);
  if (currentContent === undefined) {
    try {
      const absPath = await resolveContainedNoSymlinkPath(worktreeDir, relPath);
      currentContent = await readNoFollowUtf8(absPath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      violations.push(`Arquivo alvo inválido '${relPath}': ${msg}`);
      return 0;
    }
  }

  const hits = countOccurrences(currentContent, edit.searchBlock);
  if (hits === 0) {
    violations.push(`searchBlock não encontrado em '${relPath}'`);
    return 0;
  }
  if (hits > 1) {
    violations.push(`searchBlock ambíguo (${hits} múltiplas ocorrências) em '${relPath}'`);
    return 0;
  }

  const idx = currentContent.indexOf(edit.searchBlock);
  virtualFiles.set(
    relPath,
    `${currentContent.slice(0, idx)}${edit.replaceBlock}${currentContent.slice(idx + edit.searchBlock.length)}`,
  );
  return Math.max(edit.searchBlock.split('\n').length, edit.replaceBlock.split('\n').length);
}

async function validateSyntheticXmlCreate(
  create: PatchCreate,
  xsdDir: string | undefined,
  oracle: Pick<OracleAnalyzerPort, 'validateXml'> | undefined,
  violations: string[],
): Promise<void> {
  try {
    assertSafeXsdContent(Buffer.from(create.content, 'utf8'), create.filePath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    violations.push(`XML sintético rejeitado (XXE/entity): ${msg}`);
    return;
  }

  if (TEST_FILES_PATTERN.test(create.content)) {
    violations.push(`${create.filePath}: referência proibida a test-files`);
  }

  if (xsdDir && oracle) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ntc-synxml-'));
    const tempXmlPath = path.join(tempDir, path.basename(create.filePath));
    try {
      await writeFile(tempXmlPath, create.content, 'utf8');
      const validation = await oracle.validateXml(xsdDir, tempXmlPath);
      if (!validation.valid) {
        const firstErr = validation.errors[0]?.message ?? 'falha de schema XSD';
        violations.push(`XML sintético '${create.filePath}' inválido contra XSD: ${firstErr}`);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function validateSingleCreate(
  create: PatchCreate,
  worktreeDir: string,
  seenCreates: Set<string>,
  xsdDir: string | undefined,
  oracle: Pick<OracleAnalyzerPort, 'validateXml'> | undefined,
  violations: string[],
): Promise<number> {
  const relPath = normalizeRepoRelativePath(create.filePath);
  if (!isAllowedRepoPath(relPath) || seenCreates.has(relPath)) {
    violations.push(`Arquivo criado inválido ou duplicado: '${relPath}'`);
    return 0;
  }
  seenCreates.add(relPath);

  try {
    const absPath = await resolveContainedNoSymlinkPath(worktreeDir, relPath);
    await lstat(absPath);
    violations.push(`Arquivo '${relPath}' já existe no repositório`);
    return 0;
  } catch (error) {
    const code = getErrnoCode(error);
    if (code && code !== 'ENOENT') {
      violations.push(`Falha ao validar destino '${relPath}': ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
    if (!code) {
      violations.push(error instanceof Error ? error.message : String(error));
      return 0;
    }
  }

  if (relPath.endsWith('.java')) {
    validateJavaSnippetSafety(relPath, create.content, violations);
    if (/@(?:Disabled|Ignore)\b/.test(create.content)) {
      violations.push(`${relPath}: @Disabled/@Ignore proibido em testes sintéticos`);
    }
  } else if (relPath.endsWith('.xml')) {
    await validateSyntheticXmlCreate(create, xsdDir, oracle, violations);
  }
  return create.content.split('\n').length;
}

/** Runs static, Java 8, contract preservation, blast-radius, XXE, and XSD guardrails on a candidate patch. */
export async function validatePatchGuardrails(
  input: ValidatePatchGuardrailsInput,
): Promise<PatchGuardrailResult> {
  const parsed = PatchPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    return {
      valid: false,
      violations: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`),
      totalLinesChanged: 0,
      touchedFileCount: 0,
    };
  }

  const payload = parsed.data;
  const maxFiles = input.maxTouchedFiles ?? DEFAULT_MAX_TOUCHED_FILES;
  const maxLines = input.maxTotalChangedLines ?? DEFAULT_MAX_CHANGED_LINES;
  const violations: string[] = [];
  const virtualFiles = new Map<string, string>();
  const seenCreates = new Set<string>();
  const touchedFiles = new Set<string>();
  let totalLinesChanged = 0;

  for (const edit of payload.edits) {
    touchedFiles.add(normalizeRepoRelativePath(edit.filePath));
    totalLinesChanged += await validateSingleEdit(edit, input.repo, input.worktreeDir, virtualFiles, violations);
  }
  for (const [relPath, assembledJava] of virtualFiles.entries()) {
    validateJavaSnippetSafety(relPath, assembledJava, violations);
  }
  for (const create of payload.creates) {
    touchedFiles.add(normalizeRepoRelativePath(create.filePath));
    totalLinesChanged += await validateSingleCreate(create, input.worktreeDir, seenCreates, input.xsdDir, input.oracle, violations);
  }

  if (touchedFiles.size > maxFiles) {
    violations.push(`Limite de arquivos modificados excedido (${touchedFiles.size} > ${maxFiles})`);
  }
  if (totalLinesChanged > maxLines) {
    violations.push(`Limite de linhas modificadas excedido (${totalLinesChanged} > ${maxLines})`);
  }
  return {
    valid: violations.length === 0,
    violations,
    totalLinesChanged,
    touchedFileCount: touchedFiles.size,
  };
}

/** Asserts guardrails pass or throws `PatchGuardrailError`. */
export async function assertPatchGuardrails(
  input: ValidatePatchGuardrailsInput,
): Promise<PatchGuardrailResult> {
  const result = await validatePatchGuardrails(input);
  if (!result.valid) {
    throw new PatchGuardrailError(result.violations);
  }
  return result;
}
