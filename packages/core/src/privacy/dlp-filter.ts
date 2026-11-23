import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isSafeRelativeRepoPath, normalizeRepoRelativePath } from '../domain/validators.js';

const ALLOWED_PREFIXES = [
  'src/main/java/',
  'src/test/java/',
  'src/test/resources/synthetic/',
] as const;

const FISCAL_ROOT_TAGS = new Set([
  'nfeproc',
  'nfe',
  'infnfe',
  'protnfe',
  'envinfe',
  'retenvinfe',
  'conssitnfe',
  'retconssitnfe',
  'proceventonfe',
  'evento',
  'cteproc',
  'cte',
  'infcte',
  'protcte',
  'envicte',
  'mdfeproc',
  'mdfe',
  'infmdfe',
  'protmdfe',
  'envimdfe',
  'bpeproc',
  'bpe',
  'infbpe',
  'nf3eproc',
  'nf3e',
  'infnf3e',
  'nfcomproc',
  'nfcom',
  'infnfcom',
  'gtveproc',
  'gtve',
  'infgtve',
  'emit',
  'enderemit',
  'dest',
  'enderdest',
  'ide',
  'det',
  'imposto',
  'cnpj',
  'cpf',
  'chave',
  'chnfe',
  'chcte',
  'chmdfe',
  'chbpe',
  'chnf3e',
  'chnfcom',
  'chgtve',
  'xnome',
  'ie',
  'email',
  'fone',
]);

const MAX_READ_BYTES = 512 * 1024;
const OPEN_TAG_RE = /^<((?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*))(?:\s[^>]*)?>/;

export class DlpBlockedPathError extends Error {
  readonly blockedPath: string;

  constructor(blockedPath: string, message: string) {
    super(message);
    this.name = 'DlpBlockedPathError';
    this.blockedPath = blockedPath;
  }
}

export class DlpViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DlpViolationError';
  }
}

export function isAllowedRepoPath(rawPath: string): boolean {
  const normalized = normalizeRepoRelativePath(rawPath);
  if (!isSafeRelativeRepoPath(normalized)) {
    return false;
  }
  const lower = normalized.toLowerCase();
  return ALLOWED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

async function assertNoSymlinkAlongRelativePath(realRepoRoot: string, relPosixPath: string): Promise<string> {
  const segments = relPosixPath.split('/');
  let cursor = realRepoRoot;
  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    const stat = await fsp.lstat(cursor);
    if (stat.isSymbolicLink()) {
      throw new DlpBlockedPathError(relPosixPath, `Symlink bloqueado pela política DLP: ${relPosixPath}`);
    }
  }
  const realTarget = await fsp.realpath(cursor);
  if (!realTarget.startsWith(realRepoRoot + path.sep)) {
    throw new DlpBlockedPathError(relPosixPath, `Caminho fora da raiz do repositório: ${relPosixPath}`);
  }
  const realRel = normalizeRepoRelativePath(path.relative(realRepoRoot, realTarget));
  if (!isAllowedRepoPath(realRel)) {
    throw new DlpBlockedPathError(relPosixPath, `Alvo resolvido fora da allowlist DLP: ${realRel}`);
  }
  return realTarget;
}

function sanitizeByRepoPath(relativePath: string, content: string): string {
  const normalized = normalizeRepoRelativePath(relativePath).toLowerCase();
  if (normalized.startsWith('src/test/resources/synthetic/')) {
    return redactSecrets(redactFiscalNumbers(content));
  }
  return sanitizeForExternalLlm(content);
}

export async function readAllowedRepoFile(repoRoot: string, rawRelativePath: string): Promise<string> {
  if (!isAllowedRepoPath(rawRelativePath)) {
    throw new DlpBlockedPathError(
      rawRelativePath,
      `Leitura bloqueada pela allowlist DLP (test-files/fora do escopo): ${rawRelativePath}`,
    );
  }
  const normalized = normalizeRepoRelativePath(rawRelativePath);
  const realRepoRoot = await fsp.realpath(repoRoot);
  const targetAbs = await assertNoSymlinkAlongRelativePath(realRepoRoot, normalized);

  const handle = await fsp.open(targetAbs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new DlpBlockedPathError(normalized, `Recurso não é um arquivo regular: ${normalized}`);
    }
    if (stat.size > MAX_READ_BYTES) {
      throw new DlpBlockedPathError(normalized, `Arquivo excede limite DLP de leitura (${MAX_READ_BYTES} bytes)`);
    }
    const content = await handle.readFile({ encoding: 'utf8' });
    return sanitizeByRepoPath(normalized, content);
  } finally {
    await handle.close();
  }
}

async function assertPrefixChainNoSymlink(realRepoRoot: string, prefixDirRel: string): Promise<string | null> {
  let cursor = realRepoRoot;
  for (const seg of prefixDirRel.split('/')) {
    cursor = path.join(cursor, seg);
    if (!fs.existsSync(cursor)) {
      return null;
    }
    const stat = await fsp.lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return null;
    }
  }
  const realDir = await fsp.realpath(cursor);
  return realDir.startsWith(realRepoRoot + path.sep) ? realDir : null;
}

async function collectFilesUnderPrefix(realRepoRoot: string, realDir: string): Promise<string[]> {
  const collected: string[] = [];
  const entries = await fsp.readdir(realDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const childAbs = path.join(realDir, entry.name);
    const rel = normalizeRepoRelativePath(path.relative(realRepoRoot, childAbs));
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() !== 'test-files') {
        collected.push(...(await collectFilesUnderPrefix(realRepoRoot, childAbs)));
      }
    } else if (entry.isFile() && isAllowedRepoPath(rel)) {
      collected.push(rel);
    }
  }
  return collected;
}

export async function listAllowedRepoFiles(repoRoot: string): Promise<string[]> {
  const realRepoRoot = await fsp.realpath(repoRoot);
  const nested = await Promise.all(
    ALLOWED_PREFIXES.map(async (prefix) => {
      const safeDir = await assertPrefixChainNoSymlink(realRepoRoot, prefix.slice(0, -1));
      return safeDir ? collectFilesUnderPrefix(realRepoRoot, safeDir) : [];
    }),
  );
  return nested.flat().sort();
}

function isIdentCharBefore(text: string, idx: number): boolean {
  if (idx <= 0) {
    return false;
  }
  return /[A-Za-z0-9_$]/.test(text.charAt(idx - 1));
}

function findMatchingClosingTagEnd(text: string, searchFrom: number, fullTagName: string): number {
  const closeToken = `</${fullTagName}>`;
  const lowerText = text.toLowerCase();
  const idx = lowerText.indexOf(closeToken.toLowerCase(), searchFrom);
  return idx >= 0 ? idx + closeToken.length : -1;
}

function findTruncatedEnd(text: string, fromIdx: number): number {
  const blankLine = text.indexOf('\n\n', fromIdx);
  return blankLine >= 0 ? blankLine : text.length;
}

function tryConsumeFiscalXmlAt(text: string, idx: number): number {
  if (isIdentCharBefore(text, idx)) {
    return -1;
  }
  const slice = text.slice(idx);
  if (/^<\?xml\b/i.test(slice)) {
    const declEnd = slice.indexOf('?>');
    if (declEnd < 0) {
      return -1;
    }
    const afterDecl = idx + declEnd + 2;
    let scanOffset = afterDecl;
    const commentOrWs = /^(?:\s+|<!--[\s\S]*?-->)+/.exec(text.slice(scanOffset));
    if (commentOrWs?.[0]) {
      scanOffset += commentOrWs[0].length;
    }
    const rootMatch = OPEN_TAG_RE.exec(text.slice(scanOffset));
    if (!rootMatch?.[1]) {
      return afterDecl;
    }
    const closeEnd = findMatchingClosingTagEnd(text, scanOffset + rootMatch[0].length, rootMatch[1]);
    return closeEnd >= 0 ? closeEnd : findTruncatedEnd(text, scanOffset);
  }

  const tagMatch = OPEN_TAG_RE.exec(slice);
  if (!tagMatch?.[1] || !tagMatch[2]) {
    return -1;
  }
  if (!FISCAL_ROOT_TAGS.has(tagMatch[2].toLowerCase())) {
    return -1;
  }
  const closeEnd = findMatchingClosingTagEnd(text, idx + tagMatch[0].length, tagMatch[1]);
  return closeEnd >= 0 ? closeEnd : findTruncatedEnd(text, idx);
}

/**
 * Remove payloads XML fiscais em passagem linear O(N) (incluindo prefixos de namespace
 * e XMLs truncados multilinha) preservando assinaturas de genéricos Java como Map<K, V>.
 */
function stripFiscalXmlPayloads(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const ltIdx = text.indexOf('<', cursor);
    if (ltIdx < 0) {
      parts.push(text.slice(cursor));
      break;
    }
    const skipEnd = tryConsumeFiscalXmlAt(text, ltIdx);
    if (skipEnd > ltIdx) {
      parts.push(text.slice(cursor, ltIdx), '[REDACTED_XML]');
      cursor = skipEnd;
    } else {
      parts.push(text.slice(cursor, ltIdx + 1));
      cursor = ltIdx + 1;
    }
  }
  return parts.join('');
}

function redactFiscalNumbers(text: string): string {
  return text
    .replace(/(?<!\d)\d{44}(?!\d)/g, '[REDACTED_CHAVE_ACESSO]')
    .replace(/(?<!\d)\d{4}(?:[ -]\d{4}){10}(?!\d)/g, '[REDACTED_CHAVE_ACESSO]')
    .replace(/(?<![A-Za-z0-9])[A-Z0-9]{2}\.[A-Z0-9]{3}\.[A-Z0-9]{3}\/[A-Z0-9]{4}-\d{2}(?!\d)/g, '[REDACTED_CNPJ]')
    .replace(/(?<!\d)\d{8}\/\d{4}-\d{2}(?!\d)/g, '[REDACTED_CNPJ]')
    .replace(/(?<!\d)\d{14}(?!\d)/g, '[REDACTED_CNPJ]')
    .replace(/(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g, '[REDACTED_CPF]')
    .replace(/(?<!\d)\d{9}-\d{2}(?!\d)/g, '[REDACTED_CPF]')
    .replace(/(?<!\d)\d{11}(?!\d)/g, '[REDACTED_CPF]');
}

function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_SECRET]')
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED_SECRET]')
    .replace(/((?:https?|ssh|git):\/\/)[^\s/@]+@/gi, '$1[REDACTED_SECRET]@')
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{12,})\b/g,
      '[REDACTED_SECRET]',
    )
    .replace(
      /\b([A-Za-z0-9_-]*(?:token|api[-_]?key|secret|password|pat)[A-Za-z0-9_-]*)\s*([=:])\s*(?!\[REDACTED_SECRET\])(?:"[^"]*"|'[^']*'|[^\s;,)\]}]+)/gi,
      '$1$2[REDACTED_SECRET]',
    );
}

export function sanitizeLogMessage(rawLog: string): string {
  if (!rawLog) {
    return '';
  }
  return redactSecrets(redactFiscalNumbers(stripFiscalXmlPayloads(rawLog)));
}

export function sanitizeForExternalLlm(rawText: string): string {
  return sanitizeLogMessage(rawText);
}

export function assertNoDlpViolations(
  files: ReadonlyArray<{ readonly filePath: string; readonly content: string }>,
): void {
  for (const file of files) {
    if (!isAllowedRepoPath(file.filePath)) {
      throw new DlpViolationError(`Violação DLP de caminho não permitido: ${file.filePath}`);
    }
    const sanitized = sanitizeByRepoPath(file.filePath, file.content);
    if (sanitized !== file.content) {
      throw new DlpViolationError(`Violação DLP: conteúdo sensível não redigido em ${file.filePath}`);
    }
  }
}
