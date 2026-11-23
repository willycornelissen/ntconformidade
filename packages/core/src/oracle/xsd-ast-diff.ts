import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ExtractJavaAstResultSchema,
  ExtractXsdResultSchema,
  OracleRegistryEntrySchema,
  ValidateXmlResultSchema,
  type ExtractJavaAstResult,
  type ExtractXsdResult,
  type OracleRegistryEntry,
  type SetterKeyEntry,
  type StructuralDiffFinding,
  type ValidateXmlResult,
  type XsdNode,
} from '../domain/types.js';
import type { OracleAnalyzerPort } from '../ports/interfaces.js';
import {
  listAllowedRepoFiles,
  readAllowedRepoFile,
  sanitizeLogMessage,
} from '../privacy/dlp-filter.js';
import {
  defaultExecFileAsync,
  extractExecFailureDetails,
  resolveDefaultOracleJarPath,
} from '../toolchain/exec-utils.js';
import { buildSanitizedToolchainEnv } from '../toolchain/host-maven-runner.js';

const ORACLE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_ORACLE_TIMEOUT_MS = 120_000;

/** Signature for injecting execFile in unit tests without spawning a shell. */
export type ExecFileAsyncFn = (
  file: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    shell?: boolean;
    maxBuffer?: number;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr: string }>;

/** Options for instantiating `XsdOracleBridge`. */
export interface XsdOracleBridgeOptions {
  readonly jarPath?: string;
  readonly javaBin?: string;
  readonly execFileFn?: ExecFileAsyncFn;
  readonly tempDirRoot?: string;
  readonly timeoutMs?: number;
}

/** Indexed Java DTO field type hints extracted from domain package source files. */
export interface JavaFieldTypeIndex {
  readonly byClassField: ReadonlyMap<string, string>;
  readonly byField: ReadonlyMap<string, string>;
}

/** Input payload for deterministic XSD-to-AST structural diffing. */
export interface ComputeXsdAstDiffInput {
  readonly xsd: ExtractXsdResult;
  readonly ast: ExtractJavaAstResult;
  readonly registryEntry: OracleRegistryEntry;
  readonly fieldTypes?: JavaFieldTypeIndex;
}

function formatOracleError(command: string, error: unknown): Error {
  const details = extractExecFailureDetails(error);
  const combined = [details.message, details.stderr].filter(Boolean).join(' | ');
  return new Error(`xsd-oracle ${command} failed: ${sanitizeLogMessage(combined)}`);
}

function parseOracleJson(command: string, rawStdout: string): unknown {
  try {
    return JSON.parse(rawStdout);
  } catch (error) {
    throw formatOracleError(command, error);
  }
}

/**
 * Bridge between Node/TypeScript and the standalone Java `xsd-oracle.jar` CLI.
 * Invokes `java -jar` directly with `shell: false` and sanitized toolchain env.
 */
export class XsdOracleBridge implements OracleAnalyzerPort {
  private readonly jarPath: string;
  private readonly javaBin: string;
  private readonly execFileFn: ExecFileAsyncFn;
  private readonly tempDirRoot: string;
  private readonly timeoutMs: number;

  constructor(options: XsdOracleBridgeOptions = {}) {
    this.jarPath = options.jarPath ?? resolveDefaultOracleJarPath();
    this.javaBin = options.javaBin ?? 'java';
    this.execFileFn = options.execFileFn ?? defaultExecFileAsync;
    this.tempDirRoot = options.tempDirRoot ?? os.tmpdir();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS;
  }

  async extractXsd(xsdDir: string): Promise<ExtractXsdResult> {
    const stdout = await this.runOracle('extract-xsd', ['--xsd-dir', xsdDir]);
    return ExtractXsdResultSchema.parse(parseOracleJson('extract-xsd', stdout));
  }

  async extractJavaAst(
    repoDir: string,
    registryEntry: OracleRegistryEntry,
  ): Promise<ExtractJavaAstResult> {
    const validatedEntry = OracleRegistryEntrySchema.parse(registryEntry);
    const tempDir = await mkdtemp(path.join(this.tempDirRoot, 'ntc-oracle-'));
    const entryFile = path.join(tempDir, 'registry-entry.json');
    try {
      await writeFile(entryFile, JSON.stringify(validatedEntry), {
        encoding: 'utf8',
        mode: 0o600,
      });
      const stdout = await this.runOracle('extract-java-ast', [
        '--repo-dir',
        repoDir,
        '--registry-entry',
        `@${entryFile}`,
      ]);
      return ExtractJavaAstResultSchema.parse(parseOracleJson('extract-java-ast', stdout));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async validateXml(xsdDir: string, xmlFilePath: string): Promise<ValidateXmlResult> {
    const args = ['-jar', this.jarPath, 'validate-xml', '--xsd-dir', xsdDir, '--xml', xmlFilePath];
    try {
      const { stdout } = await this.execFileFn(this.javaBin, args, {
        shell: false,
        maxBuffer: ORACLE_MAX_BUFFER_BYTES,
        timeout: this.timeoutMs,
        env: buildSanitizedToolchainEnv(),
      });
      return ValidateXmlResultSchema.parse(parseOracleJson('validate-xml', stdout));
    } catch (error) {
      const details = extractExecFailureDetails(error);
      if (details.code === 1 && details.stdout) {
        try {
          const parsed = ValidateXmlResultSchema.safeParse(JSON.parse(details.stdout));
          if (parsed.success) {
            return parsed.data;
          }
        } catch {
          // Falls through to formatOracleError when stdout is malformed JSON
        }
      }
      throw formatOracleError('validate-xml', error);
    }
  }

  private async runOracle(subcommand: string, subArgs: readonly string[]): Promise<string> {
    try {
      const { stdout } = await this.execFileFn(
        this.javaBin,
        ['-jar', this.jarPath, subcommand, ...subArgs],
        {
          shell: false,
          maxBuffer: ORACLE_MAX_BUFFER_BYTES,
          timeout: this.timeoutMs,
          env: buildSanitizedToolchainEnv(),
        },
      );
      return stdout;
    } catch (error) {
      throw formatOracleError(subcommand, error);
    }
  }
}

const JAVA_FIELD_PATTERN =
  /^\s*(?:private|protected|public)\s+(?:static\s+|final\s+|transient\s+)*([A-Za-z_][A-Za-z0-9_.<>[\],\s?]*?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=[^;]*)?;/gm;

function parseJavaFieldDeclarations(
  className: string,
  javaSource: string,
  byClassField: Map<string, string>,
  fieldCandidates: Map<string, Set<string>>,
): void {
  for (const match of javaSource.matchAll(JAVA_FIELD_PATTERN)) {
    const rawType = match[1]?.trim().replace(/\s+/g, '');
    const fieldName = match[2]?.trim();
    if (rawType && fieldName && !rawType.startsWith('class')) {
      byClassField.set(`${className}.${fieldName}`, rawType);
      const existing = fieldCandidates.get(fieldName) ?? new Set<string>();
      existing.add(rawType);
      fieldCandidates.set(fieldName, existing);
    }
  }
}

/**
 * Extracts Java DTO field types from DLP-allowlisted `src/main/java/<domainPackage>/*.java` files.
 */
export async function extractJavaFieldTypeHints(
  repoDir: string,
  domainPackage: string,
): Promise<JavaFieldTypeIndex> {
  const packageRelDir = `src/main/java/${domainPackage.replace(/\./g, '/')}/`;
  const allowedFiles = await listAllowedRepoFiles(repoDir);
  const domainJavaFiles = allowedFiles.filter(
    (relPath) => relPath.startsWith(packageRelDir) && relPath.endsWith('.java'),
  );

  const loaded = await Promise.all(
    domainJavaFiles.map(async (relPath) => ({
      className: path.basename(relPath, '.java'),
      source: await readAllowedRepoFile(repoDir, relPath),
    })),
  );

  const byClassField = new Map<string, string>();
  const fieldCandidates = new Map<string, Set<string>>();
  for (const file of loaded) {
    parseJavaFieldDeclarations(file.className, file.source, byClassField, fieldCandidates);
  }

  const byField = new Map<string, string>();
  for (const [fieldName, types] of fieldCandidates.entries()) {
    if (types.size === 1) {
      const onlyType = types.values().next().value;
      if (onlyType) {
        byField.set(fieldName, onlyType);
      }
    }
  }
  return { byClassField, byField };
}

function buildContainerPathSet(nodes: readonly XsdNode[]): Set<string> {
  const containers = new Set<string>();
  for (const node of nodes) {
    if (node.isAttribute) {
      continue;
    }
    const upper = node.tagPath.toUpperCase();
    let dotIdx = upper.indexOf('.');
    while (dotIdx > 0) {
      containers.add(upper.slice(0, dotIdx));
      dotIdx = upper.indexOf('.', dotIdx + 1);
    }
  }
  return containers;
}

function isOrderedSegmentSubsequence(
  candidateParents: readonly string[],
  targetParents: readonly string[],
): boolean {
  if (candidateParents.length < 2 || candidateParents.length > targetParents.length) {
    return false;
  }
  let targetIdx = 0;
  for (const seg of candidateParents) {
    while (targetIdx < targetParents.length && targetParents[targetIdx] !== seg) {
      targetIdx += 1;
    }
    if (targetIdx >= targetParents.length) {
      return false;
    }
    targetIdx += 1;
  }
  return true;
}

function findMatchingSetter(
  xsdTagPath: string,
  exactByPath: ReadonlyMap<string, SetterKeyEntry>,
  byLeafTag: ReadonlyMap<string, readonly SetterKeyEntry[]>,
): SetterKeyEntry | undefined {
  const normalizedXsd = xsdTagPath.trim().toUpperCase();
  const exact = exactByPath.get(normalizedXsd);
  if (exact) {
    return exact;
  }

  const xsdSegments = normalizedXsd.split('.');
  const leaf = xsdSegments[xsdSegments.length - 1];
  if (!leaf) {
    return undefined;
  }

  const xsdParents = xsdSegments.slice(0, -1);
  const candidates = byLeafTag.get(leaf) ?? [];
  return candidates.find((candidate) => {
    const astParents = candidate.fullTagPath.toUpperCase().split('.').slice(0, -1);
    return isOrderedSegmentSubsequence(astParents, xsdParents);
  });
}

function resolveJavaTypeForSetter(
  setter: SetterKeyEntry,
  fieldTypes?: JavaFieldTypeIndex,
): string | undefined {
  if (!fieldTypes) {
    return undefined;
  }
  const dtoClass = setter.mapperClass.replace(/Mapper$/, '');
  return (
    fieldTypes.byClassField.get(`${dtoClass}.${setter.targetDtoField}`) ??
    fieldTypes.byField.get(setter.targetDtoField)
  );
}

function isCollectionJavaType(javaType: string): boolean {
  return /^(?:java\.util\.)?(?:List|Set|Collection|Iterable|ArrayList|LinkedList)<|\[\]$/.test(
    javaType.trim(),
  );
}

function unwrapCollectionInnerType(javaType: string): string {
  const trimmed = javaType.trim();
  const genericMatch = /^(?:java\.util\.)?(?:List|Set|Collection|Iterable|ArrayList|LinkedList)<(.+)>$/.exec(
    trimmed,
  );
  if (genericMatch?.[1]) {
    return genericMatch[1].trim();
  }
  if (trimmed.endsWith('[]')) {
    return trimmed.slice(0, -2).trim();
  }
  return trimmed;
}

function classifyExpectedXsdFamily(
  xsdType: string,
): 'decimal' | 'integer' | 'date' | 'datetime' | 'boolean' | null {
  const trimmed = xsdType.trim();
  const colonIdx = trimmed.indexOf(':');
  const base = colonIdx >= 0 ? trimmed.slice(colonIdx + 1) : trimmed;
  if (/^TDec_/i.test(base) || /^(?:decimal|float|double)$/i.test(base)) {
    return 'decimal';
  }
  if (/^(?:integer|int|long|short|positiveInteger|nonNegativeInteger|negativeInteger|unsignedInt)$/i.test(base)) {
    return 'integer';
  }
  if (/^(?:date|TData)$/i.test(base)) {
    return 'date';
  }
  if (/^(?:dateTime|TDateTimeUTC|TDataHora)$/i.test(base)) {
    return 'datetime';
  }
  if (/^boolean$/i.test(base)) {
    return 'boolean';
  }
  return null;
}

function isJavaTypeCompatible(
  family: 'decimal' | 'integer' | 'date' | 'datetime' | 'boolean',
  scalarJavaType: string,
): boolean {
  const simple = scalarJavaType.includes('.')
    ? scalarJavaType.split('.').pop() ?? scalarJavaType
    : scalarJavaType;
  switch (family) {
    case 'decimal':
      return /^(?:BigDecimal|Double|double|Float|float|Number)$/.test(simple);
    case 'integer':
      return /^(?:Integer|int|Long|long|Short|short|BigInteger)$/.test(simple);
    case 'date':
      return /^(?:LocalDate|Date|XMLGregorianCalendar|LocalDateTime|OffsetDateTime|ZonedDateTime)$/.test(simple);
    case 'datetime':
      return /^(?:LocalDateTime|OffsetDateTime|ZonedDateTime|Instant|Date|XMLGregorianCalendar)$/.test(simple);
    case 'boolean':
      return /^(?:Boolean|boolean)$/.test(simple);
  }
}

function evaluateNodeDiff(
  node: XsdNode,
  setter: SetterKeyEntry | undefined,
  fieldTypes?: JavaFieldTypeIndex,
): StructuralDiffFinding | null {
  if (!setter) {
    return {
      kind: 'MISSING_TAG',
      tagPath: node.tagPath,
      expectedXsdType: node.xsdType,
      actualJavaDetail: null,
      message: `XSD tag '${node.tagPath}' (${node.xsdType}) has no matching mapper setter key in Java AST.`,
    };
  }

  const javaType = resolveJavaTypeForSetter(setter, fieldTypes);
  if (!javaType) {
    return null;
  }

  const xsdRepeating = node.maxOccurs === 'unbounded' || node.maxOccurs > 1;
  if (xsdRepeating !== isCollectionJavaType(javaType)) {
    return {
      kind: 'CARDINALITY_MISMATCH',
      tagPath: node.tagPath,
      expectedXsdType: `${node.xsdType} (maxOccurs=${String(node.maxOccurs)})`,
      actualJavaDetail: `${setter.mapperClass}.${setter.targetDtoField}: ${javaType}`,
      message: `Cardinality mismatch on '${node.tagPath}': XSD maxOccurs=${String(node.maxOccurs)}, Java field '${setter.targetDtoField}' is '${javaType}'.`,
    };
  }

  const family = classifyExpectedXsdFamily(node.xsdType);
  if (family && !isJavaTypeCompatible(family, unwrapCollectionInnerType(javaType))) {
    return {
      kind: 'TYPE_MISMATCH',
      tagPath: node.tagPath,
      expectedXsdType: node.xsdType,
      actualJavaDetail: `${setter.mapperClass}.${setter.targetDtoField}: ${javaType}`,
      message: `Type mismatch on '${node.tagPath}': expected ${family} (${node.xsdType}), found Java type '${javaType}'.`,
    };
  }
  return null;
}

/**
 * Computes deterministic structural gaps (`MISSING_TAG`, `CARDINALITY_MISMATCH`, `TYPE_MISMATCH`)
 * between extracted XSD nodes and Java parser AST setter keys plus DTO field type hints.
 */
export function computeXsdAstDiff(
  input: ComputeXsdAstDiffInput,
): readonly StructuralDiffFinding[] {
  const exactByPath = new Map<string, SetterKeyEntry>();
  const byLeafTag = new Map<string, SetterKeyEntry[]>();

  for (const setter of input.ast.setterKeys) {
    const upperFullPath = setter.fullTagPath.toUpperCase();
    if (!exactByPath.has(upperFullPath)) {
      exactByPath.set(upperFullPath, setter);
    }
    const upperLeaf = setter.leafTag.toUpperCase();
    const list = byLeafTag.get(upperLeaf) ?? [];
    list.push(setter);
    byLeafTag.set(upperLeaf, list);
  }

  const containerPaths = buildContainerPathSet(input.xsd.nodes);
  const findings: StructuralDiffFinding[] = [];

  for (const node of input.xsd.nodes) {
    if (containerPaths.has(node.tagPath.toUpperCase())) {
      continue;
    }
    const setter = findMatchingSetter(node.tagPath, exactByPath, byLeafTag);
    const finding = evaluateNodeDiff(node, setter, input.fieldTypes);
    if (finding) {
      findings.push(finding);
    }
  }
  return findings;
}
