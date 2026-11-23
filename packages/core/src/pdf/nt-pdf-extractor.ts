import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  ExtractedNtPdfSchema,
  hasPdfMagicHeader,
  type ExtractedNtPdf,
  type PdfComplexityWarning,
  type PdfGroupSegment,
} from '../domain/types.js';

const DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 250;
const DEFAULT_TOKEN_WARN_THRESHOLD = 40_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SEGMENT_CHARS = 12_000;

export type PdfExtractionErrorCode =
  | 'INVALID_PDF_HEADER'
  | 'CORRUPT_OR_TRUNCATED_PDF'
  | 'EMPTY_TEXT_PDF'
  | 'PDF_LIMIT_EXCEEDED'
  | 'PDF_TIMEOUT';

export class PdfExtractionError extends Error {
  readonly code: PdfExtractionErrorCode;

  constructor(code: PdfExtractionErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'PdfExtractionError';
    this.code = code;
  }
}

export interface ExtractNtPdfOptions {
  readonly cacheDir?: string;
  readonly maxBytes?: number;
  readonly maxPages?: number;
  readonly maxTokenWarningThreshold?: number;
  readonly timeoutMs?: number;
  readonly onPdfEngineParse?: () => void;
}

interface PageTextEntry {
  readonly pageNumber: number;
  readonly lines: readonly string[];
}

interface PositionedWord {
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

const PDFJS_ASSETS = resolvePdfJsAssetPaths();
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_ASSETS.workerSrc;

function resolvePdfJsAssetPaths(): { workerSrc: string; standardFontDataUrl: string; cMapUrl: string } {
  const require = createRequire(import.meta.url);
  const pkgRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return {
    workerSrc: pathToFileURL(path.join(pkgRoot, 'legacy', 'build', 'pdf.worker.mjs')).href,
    standardFontDataUrl: path.join(pkgRoot, 'standard_fonts') + path.sep,
    cMapUrl: path.join(pkgRoot, 'cmaps') + path.sep,
  };
}

async function readPdfFileSafely(pdfPath: string, maxBytes: number): Promise<Buffer> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(pdfPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    throw new PdfExtractionError(
      'INVALID_PDF_HEADER',
      `Arquivo PDF inacessível ou symlink bloqueado: ${pdfPath}`,
      err,
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) {
      throw new PdfExtractionError(
        'PDF_LIMIT_EXCEEDED',
        `Arquivo PDF vazio, não regular ou excede limite de ${maxBytes} bytes`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function validatePdfBytes(bytes: Buffer): void {
  if (!hasPdfMagicHeader(bytes)) {
    throw new PdfExtractionError('INVALID_PDF_HEADER', 'Assinatura %PDF- ausente no arquivo informado');
  }
  const tail = bytes.subarray(Math.max(0, bytes.length - 2048)).toString('latin1');
  if (!tail.includes('%%EOF')) {
    throw new PdfExtractionError(
      'CORRUPT_OR_TRUNCATED_PDF',
      'Marcador %%EOF ausente; o PDF parece truncado ou corrompido',
    );
  }
}

async function readCachedPdf(cacheDir: string | undefined, sha256: string): Promise<ExtractedNtPdf | null> {
  if (!cacheDir) {
    return null;
  }
  const cacheFile = path.join(path.resolve(cacheDir), `${sha256}.v1.json`);
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(cacheFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const raw = await handle.readFile({ encoding: 'utf8' });
    const parsed = ExtractedNtPdfSchema.parse(JSON.parse(raw));
    if (parsed.pdfSha256 !== sha256) {
      return null;
    }
    return { ...parsed, cached: true };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function writeCachedPdf(cacheDir: string | undefined, sha256: string, doc: ExtractedNtPdf): Promise<void> {
  if (!cacheDir) {
    return;
  }
  const resolvedDir = path.resolve(cacheDir);
  await fsp.mkdir(resolvedDir, { recursive: true });
  const target = path.join(resolvedDir, `${sha256}.v1.json`);
  const tmpFile = path.join(resolvedDir, `.${sha256}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmpFile, JSON.stringify({ ...doc, cached: false }, null, 2), 'utf8');
  await fsp.rename(tmpFile, target);
}

function extractPositionedWords(items: ReadonlyArray<unknown>): PositionedWord[] {
  const words: PositionedWord[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('str' in item)) {
      continue;
    }
    const rawStr = (item as { str: unknown }).str;
    if (typeof rawStr !== 'string') {
      continue;
    }
    const clean = rawStr.replaceAll('\0', '').trim();
    if (!clean) {
      continue;
    }
    const tr = 'transform' in item && Array.isArray((item as { transform: unknown }).transform)
      ? (item as { transform: unknown[] }).transform
      : [];
    const x = typeof tr[4] === 'number' ? tr[4] : 0;
    const y = typeof tr[5] === 'number' ? tr[5] : 0;
    words.push({ x, y, text: clean });
  }
  return words;
}

function reconstructLinesFromItems(items: ReadonlyArray<unknown>): string[] {
  const words = extractPositionedWords(items).sort((a, b) => b.y - a.y);
  const buckets: PositionedWord[][] = [];
  let anchorY: number | null = null;

  for (const word of words) {
    if (anchorY === null || Math.abs(word.y - anchorY) > 2) {
      buckets.push([word]);
      anchorY = word.y;
    } else {
      buckets[buckets.length - 1]?.push(word);
    }
  }

  return buckets.map((lineWords) =>
    [...lineWords]
      .sort((a, b) => a.x - b.x)
      .map((w) => w.text)
      .join(' '),
  );
}

async function extractSinglePageText(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
): Promise<{ entry: PageTextEntry; charCount: number }> {
  const page = await doc.getPage(pageNumber);
  try {
    const textContent = await page.getTextContent();
    const lines = reconstructLinesFromItems(textContent.items);
    const charCount = lines.join(' ').trim().length;
    return { entry: { pageNumber, lines }, charCount };
  } finally {
    await Promise.resolve(page.cleanup()).catch(() => undefined);
  }
}

async function readPagesFromDocument(
  doc: pdfjsLib.PDFDocumentProxy,
  maxPages: number,
  deadlineMs: number,
): Promise<{ totalPages: number; pages: PageTextEntry[]; pageWarnings: PdfComplexityWarning[] }> {
  const totalPages = doc.numPages;
  if (totalPages > maxPages) {
    throw new PdfExtractionError(
      'PDF_LIMIT_EXCEEDED',
      `PDF possui ${totalPages} páginas, excedendo o limite de páginas (${maxPages})`,
    );
  }
  const pages: PageTextEntry[] = [];
  const pageWarnings: PdfComplexityWarning[] = [];
  let nonEmptyChars = 0;

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    if (Date.now() > deadlineMs) {
      throw new PdfExtractionError('PDF_TIMEOUT', 'Tempo limite excedido ao processar PDF');
    }
    const { entry, charCount } = await extractSinglePageText(doc, pageNumber);
    nonEmptyChars += charCount;
    if (charCount === 0) {
      pageWarnings.push({
        code: 'BLANK_PAGE_DETECTED',
        message: `Página ${pageNumber} sem texto extraível`,
        page: pageNumber,
      });
    }
    pages.push(entry);
  }

  if (nonEmptyChars === 0) {
    throw new PdfExtractionError(
      'EMPTY_TEXT_PDF',
      'Nenhum texto extraível encontrado no PDF (possível documento escaneado/imagem)',
    );
  }
  return { totalPages, pages, pageWarnings };
}

async function loadPagesViaPdfJs(
  bytes: Buffer,
  maxPages: number,
  timeoutMs: number,
): Promise<{ totalPages: number; pages: PageTextEntry[]; pageWarnings: PdfComplexityWarning[] }> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: PDFJS_ASSETS.standardFontDataUrl,
    cMapUrl: PDFJS_ASSETS.cMapUrl,
    cMapPacked: true,
    useSystemFonts: false,
    disableFontFace: true,
    useWasm: false,
    enableXfa: false,
    stopAtErrors: true,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    maxImageSize: 0,
    verbosity: 0,
  });

  try {
    const doc = await loadingTask.promise;
    return await readPagesFromDocument(doc, maxPages, Date.now() + timeoutMs);
  } catch (err) {
    if (err instanceof PdfExtractionError) {
      throw err;
    }
    throw new PdfExtractionError(
      'CORRUPT_OR_TRUNCATED_PDF',
      `Falha ao processar PDF via pdfjs-dist: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

function detectXmlHeading(line: string): { title: string; xmlGroupHint: string | null } | null {
  const groupMatch = /^(Grupo\s+[A-Z0-9]{1,8})(?:\s*[-–:]\s*(.+))?$/.exec(line);
  if (groupMatch?.[1]) {
    return { title: line, xmlGroupHint: groupMatch[1] };
  }
  if (/^Regras?\s+de\s+Valida[cç][aã]o/i.test(line)) {
    return { title: line, xmlGroupHint: 'Regras de Validacao' };
  }
  return null;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface TaggedLine {
  readonly page: number;
  readonly text: string;
}

function splitTaggedLinesIntoChunks(
  idPrefix: string,
  title: string,
  xmlGroupHint: string | null,
  taggedLines: readonly TaggedLine[],
): PdfGroupSegment[] {
  if (taggedLines.length === 0) {
    return [];
  }
  const chunks: PdfGroupSegment[] = [];
  let bucket: TaggedLine[] = [];
  let bucketChars = 0;

  const flushBucket = (): void => {
    if (bucket.length === 0) {
      return;
    }
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    if (!first || !last) {
      return;
    }
    const firstHasMarker = first.text.startsWith('[p. ');
    const bodyLines = bucket.map((l, i) => (i === 0 && !firstHasMarker ? `[p. ${l.page}] ${l.text}` : l.text));
    const citedText = bodyLines.join('\n').trim();
    chunks.push({
      id: `${idPrefix}-${chunks.length + 1}`,
      title,
      xmlGroupHint,
      pageStart: first.page,
      pageEnd: last.page,
      citedText,
      estimatedTokens: estimateTokens(citedText),
    });
    bucket = [];
    bucketChars = 0;
  };

  for (const line of taggedLines) {
    if (bucket.length > 0 && bucketChars + line.text.length + 1 > MAX_SEGMENT_CHARS) {
      flushBucket();
    }
    bucket.push(line);
    bucketChars += line.text.length + 1;
  }
  flushBucket();
  return chunks;
}

function segmentPagesByXmlGroup(pages: readonly PageTextEntry[]): PdfGroupSegment[] {
  interface MutableSection {
    title: string;
    xmlGroupHint: string | null;
    lines: TaggedLine[];
  }
  const sections: MutableSection[] = [];
  let current: MutableSection | null = null;

  for (const page of pages) {
    let pagePrefixApplied = false;
    for (const rawLine of page.lines) {
      const heading = detectXmlHeading(rawLine);
      if (heading) {
        if (current && current.lines.length > 0) {
          sections.push(current);
        }
        current = {
          title: heading.title,
          xmlGroupHint: heading.xmlGroupHint,
          lines: [{ page: page.pageNumber, text: `[p. ${page.pageNumber}] ${rawLine}` }],
        };
        pagePrefixApplied = true;
        continue;
      }
      if (!current) {
        current = { title: 'GENERAL', xmlGroupHint: null, lines: [] };
      }
      const formatted = pagePrefixApplied ? rawLine : `[p. ${page.pageNumber}] ${rawLine}`;
      pagePrefixApplied = true;
      current.lines.push({ page: page.pageNumber, text: formatted });
    }
  }
  if (current && current.lines.length > 0) {
    sections.push(current);
  }
  return sections.flatMap((sec, idx) =>
    splitTaggedLinesIntoChunks(`seg-${idx + 1}`, sec.title, sec.xmlGroupHint, sec.lines),
  );
}

function buildComplexityWarnings(
  totalPages: number,
  segments: readonly PdfGroupSegment[],
  tokenThreshold: number,
): PdfComplexityWarning[] {
  const warnings: PdfComplexityWarning[] = [];
  if (totalPages > 40) {
    warnings.push({
      code: 'LARGE_PDF_PAGE_COUNT',
      message: `PDF extenso com ${totalPages} páginas; aplicar seleção por grupo XML`,
    });
  }
  const totalTokens = segments.reduce((sum, s) => sum + s.estimatedTokens, 0);
  if (totalTokens > tokenThreshold) {
    warnings.push({
      code: 'HIGH_TOKEN_ESTIMATE',
      message: `Estimativa de ${totalTokens} tokens supera o alerta configurado (${tokenThreshold})`,
    });
  }
  const pipeLines = segments
    .flatMap((s) => s.citedText.split('\n'))
    .filter((l) => (l.match(/\|/g) ?? []).length >= 2);
  if (pipeLines.length >= 5) {
    warnings.push({
      code: 'COMPLEX_TABLE_OR_REVISION_RISK',
      message: 'Tabelas extensas ou marcas de revisão detectadas; validar itens via XSD determinístico',
    });
  }
  return warnings;
}

export async function extractNtPdf(pdfPath: string, options: ExtractNtPdfOptions = {}): Promise<ExtractedNtPdf> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PDF_BYTES;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const tokenThreshold = options.maxTokenWarningThreshold ?? DEFAULT_TOKEN_WARN_THRESHOLD;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const bytes = await readPdfFileSafely(pdfPath, maxBytes);
  validatePdfBytes(bytes);
  const pdfSha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  const cached = await readCachedPdf(options.cacheDir, pdfSha256);
  if (cached) {
    return cached;
  }

  options.onPdfEngineParse?.();
  const { totalPages, pages, pageWarnings } = await loadPagesViaPdfJs(bytes, maxPages, timeoutMs);
  const segments = segmentPagesByXmlGroup(pages);
  const complexityWarnings = buildComplexityWarnings(totalPages, segments, tokenThreshold);

  const result = ExtractedNtPdfSchema.parse({
    pdfSha256,
    totalPages,
    segments,
    warnings: [...pageWarnings, ...complexityWarnings],
    cached: false,
  });
  await writeCachedPdf(options.cacheDir, pdfSha256, result);
  return result;
}
