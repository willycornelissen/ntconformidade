import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import {
  DfeCodeSchema,
  hasPdfMagicHeader,
  isPrivateOrReservedHost,
  NtCatalogEntrySchema,
  type DfeCode,
  type DfeRepoEntry,
  type NtCatalogEntry,
  type NtPublicationGroup,
  type SvrsDfeSyncResult,
} from '../domain/types.js';
import type { DownloadedNtArtifacts } from '../ports/interfaces.js';
import { extractSafeXsdBundle } from './manual-import.js';

export const SVRS_DEFAULT_ORIGIN = 'https://dfe-portal.svrs.rs.gov.br';
const ALLOWED_SVRS_HOSTS = new Set(['dfe-portal.svrs.rs.gov.br']);
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECT_CAP = 5;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 1500];
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

export interface SvrsSyncOptions {
  readonly baseOrigin?: string;
  readonly fetchFn?: typeof fetch;
  readonly maxRedirects?: number;
  readonly retryDelaysMs?: readonly number[];
}

class SvrsFetchError extends Error {
  readonly retryableForCacheFallback: boolean;

  constructor(message: string, retryableForCacheFallback: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SvrsFetchError';
    this.retryableForCacheFallback = retryableForCacheFallback;
  }
}

export function assertSafeSvrsUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`URL SVRS inválida: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Protocolo não HTTPS bloqueado (SSRF): ${rawUrl}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Credenciais em URL bloqueadas: ${rawUrl}`);
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new Error(`Porta não padrão bloqueada (SSRF): ${rawUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_SVRS_HOSTS.has(host) || isPrivateOrReservedHost(host)) {
    throw new Error(`Host não permitido (SSRF): ${host}`);
  }
  return parsed;
}

export function parseBrazilianDate(raw: string): string | null {
  const cleaned = raw.trim();
  if (!cleaned || cleaned === '-' || /futura|definir/i.test(cleaned)) {
    return null;
  }
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(cleaned);
  if (!match) {
    throw new Error(`Data inválida no formato dd/MM/yyyy: ${raw}`);
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new Error(`Data inválida de calendário: ${raw}`);
  }
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseOptionalCellDate(raw: string): string | null {
  try {
    return parseBrazilianDate(raw);
  } catch {
    return null;
  }
}

export function parseNtIdentifier(rawTitle: string): { ntNumber: string; ntVersion: string } {
  const text = rawTitle.trim();
  const verMatch = /\b(?:v|vers[aã]o)[.\s]*(\d+(?:\.\d+)?[a-z]?)\b/i.exec(text);
  const errataMatch = /errata\s*(\d+)?/i.exec(text);
  const baseVer = verMatch?.[1] ? `v${verMatch[1]}` : 'v1.00';
  const ntVersion = errataMatch ? `${baseVer}-errata${errataMatch[1] ?? '1'}` : baseVer;

  const strippedForNum = text.replace(/\b(?:v|vers[aã]o)[.\s]*\d+(?:\.\d+)?[a-z]?\b/gi, ' ');
  const numMatch = /(\d{4}\.\d{2,3}|\d+\.\d+)/.exec(strippedForNum);
  const fallback = strippedForNum
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const ntNumber = numMatch?.[1] ?? (fallback || 'sem-numero');
  return { ntNumber, ntVersion };
}

const SVRS_STATIC_DOWNLOAD_RE =
  /download_arquivo_estatico\(\s*['"]([^'"]+)['"]\s*,\s*(\d+)\s*,\s*['"]([^'"]+)['"]\s*\)/i;

function resolveSvrsStaticDownloadUrl(
  linkEl: ReturnType<cheerio.CheerioAPI>,
  pageUrl: string,
): { url: string | null; fileName: string } {
  const onclick = linkEl.attr('onclick') ?? '';
  const staticMatch = SVRS_STATIC_DOWNLOAD_RE.exec(onclick);
  if (staticMatch?.[1] && staticMatch[2] && staticMatch[3]) {
    const [, sistema, tipo, nome] = staticMatch;
    const rel = `/${encodeURIComponent(sistema)}/DownloadArquivoEstatico/?sistema=${encodeURIComponent(sistema)}&tipoArquivo=${encodeURIComponent(tipo)}&nomeArquivo=${encodeURIComponent(nome)}`;
    try {
      return {
        url: assertSafeSvrsUrl(new URL(rel, pageUrl).toString()).toString(),
        fileName: nome,
      };
    } catch {
      return { url: null, fileName: nome };
    }
  }
  const href = (linkEl.attr('href') ?? '').trim();
  if (!href || href.startsWith('#') || /^javascript:/i.test(href)) {
    return { url: null, fileName: '' };
  }
  try {
    return {
      url: assertSafeSvrsUrl(new URL(href, pageUrl).toString()).toString(),
      fileName: href,
    };
  } catch {
    return { url: null, fileName: href };
  }
}

function parseClassicTableEntries(
  $: cheerio.CheerioAPI,
  dfe: DfeCode,
  pageUrl: string,
  fetchedAt: string,
): { hasTables: boolean; entries: NtCatalogEntry[] } {
  const rows = $('table tbody tr');
  if (rows.length === 0) {
    return { hasTables: false, entries: [] };
  }
  const entries: NtCatalogEntry[] = [];
  const seenKeys = new Set<string>();
  rows.each((_, rowEl) => {
    const cells = $(rowEl).find('td');
    if (cells.length < 4) {
      return;
    }
    const title = $(cells[0]).text().replace(/\s+/g, ' ').trim();
    let publishedDate: string | null = null;
    try {
      publishedDate = parseBrazilianDate($(cells[1]).text());
    } catch {
      publishedDate = null;
    }
    if (!title || !publishedDate) {
      return;
    }
    const homologDate = parseOptionalCellDate($(cells[2]).text());
    const prodDate = parseOptionalCellDate($(cells[3]).text());
    const { pdfUrl, xsdUrl } = extractLinks($, cells, pageUrl);
    const { ntNumber, ntVersion } = parseNtIdentifier(title);
    const uniqueKey = `${dfe}:${ntNumber}:${ntVersion}`;
    if (seenKeys.has(uniqueKey)) {
      return;
    }
    seenKeys.add(uniqueKey);
    entries.push(
      NtCatalogEntrySchema.parse({
        id: uniqueKey,
        dfe,
        ntNumber,
        ntVersion,
        publishedDate,
        homologDate,
        prodDate,
        pdfUrl,
        xsdUrl,
        pdfSha256: null,
        sourceStatus: 'DISCOVERED',
        fetchedAt,
      }),
    );
  });
  return { hasTables: true, entries };
}

function classifySchemaPriority(title: string, fileName: string): number {
  const isEventOrBulletin =
    /^(?:Schema_Evento|Eventos?_|BT[\s_])/i.test(fileName) ||
    /^(?:Evento|BT)\b/i.test(title) ||
    /eventos?\s+d[aeo]/i.test(title);
  if (/^PL_/i.test(fileName) && !isEventOrBulletin) {
    return 3;
  }
  return isEventOrBulletin ? 1 : 2;
}

function extractAllNtNumbers(title: string, fileName: string): string[] {
  const combined = `${title} ${fileName.replace(/[_-]+/g, ' ')}`;
  const found = new Set<string>();
  for (const m of combined.matchAll(/\b(20\d{2})[.\s]+(\d{3})\b/g)) {
    if (m[1] && m[2]) {
      found.add(`${m[1]}.${m[2]}`);
    }
  }
  return [...found];
}

function setSchemaIfHigherPriority(
  target: Map<string, { url: string; priority: number }>,
  key: string,
  url: string,
  priority: number,
): void {
  const existing = target.get(key);
  if (!existing || priority > existing.priority) {
    target.set(key, { url, priority });
  }
}

function parsePortalArticleEntries(
  $: cheerio.CheerioAPI,
  dfe: DfeCode,
  pageUrl: string,
  fetchedAt: string,
): { hasSections: boolean; entries: NtCatalogEntry[] } {
  const headings = $('h1.artigo__titulo');
  if (headings.length === 0) {
    return { hasSections: false, entries: [] };
  }

  const schemaByExactKey = new Map<string, { url: string; priority: number }>();
  const schemaByNumber = new Map<string, { url: string; priority: number }>();
  const rawNts: Array<{ title: string; publishedDate: string; pdfUrl: string | null }> = [];

  headings.each((_, h1) => {
    const sectionTitle = $(h1).text().replace(/\s+/g, ' ').trim();
    const isSchemas = /^schemas$/i.test(sectionTitle);
    const isNotasTecnicas = /^notas\s+t[eé]cnicas$/i.test(sectionTitle);
    if (!isSchemas && !isNotasTecnicas) {
      return;
    }
    const articles = $(h1).closest('.artigo__cabecalho').next().find('article.conteudo-lista__item');
    articles.each((__, art) => {
      const linkEl = $(art).find('a').first();
      const title = linkEl.text().replace(/\s+/g, ' ').trim();
      const dateRaw =
        $(art).find('time.conteudo-lista__item__datahora').first().text().trim() ||
        ($(art).find('time').first().attr('datetime') ?? '').trim();
      if (!title || !dateRaw) {
        return;
      }
      const publishedDate = parseOptionalCellDate(dateRaw);
      if (!publishedDate) {
        return;
      }
      const { url, fileName } = resolveSvrsStaticDownloadUrl(linkEl, pageUrl);
      if (isSchemas && url && (fileName.toLowerCase().includes('.zip') || /schema|pacote/i.test(title))) {
        const priority = classifySchemaPriority(title, fileName);
        const { ntNumber, ntVersion } = parseNtIdentifier(title);
        setSchemaIfHigherPriority(schemaByExactKey, `${ntNumber}:${ntVersion}`, url, priority);
        setSchemaIfHigherPriority(schemaByNumber, ntNumber, url, priority);
        for (const extraNum of extractAllNtNumbers(title, fileName)) {
          setSchemaIfHigherPriority(schemaByNumber, extraNum, url, priority);
        }
        return;
      }
      if (isNotasTecnicas) {
        rawNts.push({ title, publishedDate, pdfUrl: url });
      }
    });
  });

  const entries: NtCatalogEntry[] = [];
  const seenKeys = new Set<string>();
  for (const item of rawNts) {
    const { ntNumber, ntVersion } = parseNtIdentifier(item.title);
    const uniqueKey = `${dfe}:${ntNumber}:${ntVersion}`;
    if (seenKeys.has(uniqueKey)) {
      continue;
    }
    seenKeys.add(uniqueKey);
    const exactMatch = schemaByExactKey.get(`${ntNumber}:${ntVersion}`);
    const numberMatch = schemaByNumber.get(ntNumber);
    const xsdUrl =
      exactMatch && (!numberMatch || exactMatch.priority >= numberMatch.priority)
        ? exactMatch.url
        : (numberMatch?.url ?? exactMatch?.url ?? null);
    entries.push(
      NtCatalogEntrySchema.parse({
        id: uniqueKey,
        dfe,
        ntNumber,
        ntVersion,
        publishedDate: item.publishedDate,
        homologDate: null,
        prodDate: null,
        pdfUrl: item.pdfUrl,
        xsdUrl,
        pdfSha256: null,
        sourceStatus: 'DISCOVERED',
        fetchedAt,
      }),
    );
  }
  return { hasSections: true, entries };
}

export function parseSvrsHtmlTable(html: string, dfe: DfeCode, pageUrl: string): NtCatalogEntry[] {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  const fetchedAt = new Date().toISOString();

  const tableResult = parseClassicTableEntries($, dfe, pageUrl, fetchedAt);
  if (tableResult.entries.length > 0) {
    return tableResult.entries;
  }

  const portalResult = parsePortalArticleEntries($, dfe, pageUrl, fetchedAt);
  if (portalResult.entries.length > 0) {
    return portalResult.entries;
  }

  if (!tableResult.hasTables && !portalResult.hasSections) {
    throw new Error(`Tabela SVRS esperada não encontrada para ${dfe}`);
  }
  throw new Error(`Nenhum registro válido de NT extraído para ${dfe}`);
}

function extractLinks(
  $: cheerio.CheerioAPI,
  cells: ReturnType<cheerio.CheerioAPI>,
  pageUrl: string,
): { pdfUrl: string | null; xsdUrl: string | null } {
  let pdfUrl: string | null = null;
  let xsdUrl: string | null = null;
  cells.find('a[href]').each((_, linkEl) => {
    const href = ($(linkEl).attr('href') ?? '').trim();
    if (!href || href.startsWith('#')) {
      return;
    }
    let resolved: string;
    try {
      resolved = assertSafeSvrsUrl(new URL(href, pageUrl).toString()).toString();
    } catch {
      return;
    }
    const label = $(linkEl).text().toLowerCase();
    if (!pdfUrl && (label.includes('pdf') || href.toLowerCase().includes('.pdf'))) {
      pdfUrl = resolved;
    } else if (!xsdUrl && (label.includes('xsd') || label.includes('esquema') || href.toLowerCase().includes('.zip'))) {
      xsdUrl = resolved;
    }
  });
  return { pdfUrl, xsdUrl };
}

export function groupNtPublications(entries: readonly NtCatalogEntry[]): NtPublicationGroup[] {
  const byKey = new Map<string, NtCatalogEntry[]>();
  for (const entry of entries) {
    const key = `${entry.dfe}:${entry.ntNumber}`;
    const bucket = byKey.get(key) ?? [];
    bucket.push(entry);
    byKey.set(key, bucket);
  }
  const groups: NtPublicationGroup[] = [];
  for (const bucket of byKey.values()) {
    const sorted = [...bucket].sort(compareNtVersionsDesc);
    const head = sorted[0];
    if (!head) {
      continue;
    }
    groups.push({
      dfe: head.dfe,
      ntNumber: head.ntNumber,
      latestVersion: head.ntVersion,
      latestPublishedDate: head.publishedDate,
      entries: sorted,
    });
  }
  return groups.sort((a, b) => b.latestPublishedDate.localeCompare(a.latestPublishedDate));
}

function compareNtVersionsDesc(a: NtCatalogEntry, b: NtCatalogEntry): number {
  const byDate = b.publishedDate.localeCompare(a.publishedDate);
  if (byDate !== 0) {
    return byDate;
  }
  return b.ntVersion.localeCompare(a.ntVersion, undefined, { numeric: true });
}

function delayMs(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSvrsHttpErrorMessage(status: number, currentUrl: string): string {
  if (status === 502 || status === 503 || status === 504) {
    return `Falha HTTP ${status} (serviço SVRS temporariamente indisponível) ao consultar ${currentUrl}. Tente novamente mais tarde ou utilize a Importação Manual Offline (PDF + XSD).`;
  }
  return `Falha HTTP ${status} ao consultar ${currentUrl}`;
}

async function fetchSingleAttemptWithRedirects(
  safeStartUrl: string,
  fetchFn: typeof fetch,
  maxBytes: number,
  maxRedirects: number,
): Promise<{ readonly kind: 'ok'; readonly buffer: Buffer } | { readonly kind: 'retry'; readonly error: SvrsFetchError }> {
  let currentUrl = safeStartUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let response: Response;
    try {
      response = await fetchFn(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: 'retry',
        error: new SvrsFetchError(`Falha de rede ao consultar ${currentUrl}: ${msg}`, true, { cause: err }),
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location || hop === maxRedirects) {
        throw new SvrsFetchError(`Redirect HTTP bloqueado ou limite excedido em ${currentUrl}`, false);
      }
      currentUrl = assertSafeSvrsUrl(new URL(location, currentUrl).toString()).toString();
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const isRetryable = RETRYABLE_HTTP_STATUSES.has(response.status);
      const isServerUnavailable = response.status >= 500 || response.status === 429;
      const err = new SvrsFetchError(buildSvrsHttpErrorMessage(response.status, currentUrl), isServerUnavailable);
      if (isRetryable) {
        return { kind: 'retry', error: err };
      }
      throw err;
    }

    return { kind: 'ok', buffer: await readBoundedResponse(response, maxBytes) };
  }
  throw new SvrsFetchError('Limite de redirects excedido', false);
}

async function fetchWithSafeRedirects(
  rawUrl: string,
  fetchFn: typeof fetch,
  maxBytes: number,
  requestedRedirects = 3,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<Buffer> {
  const maxRedirects = Math.min(Math.max(0, requestedRedirects), MAX_REDIRECT_CAP);
  const safeStartUrl = assertSafeSvrsUrl(rawUrl).toString();
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    const result = await fetchSingleAttemptWithRedirects(safeStartUrl, fetchFn, maxBytes, maxRedirects);
    if (result.kind === 'ok') {
      return result.buffer;
    }
    const waitMs = retryDelaysMs[attempt];
    if (waitMs === undefined) {
      throw result.error;
    }
    await delayMs(waitMs);
  }
  throw new SvrsFetchError(`Falha ao consultar ${safeStartUrl}`, true);
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const headerLen = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(headerLen) && headerLen > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Payload SVRS excede o limite de ${maxBytes} bytes`);
  }
  if (!response.body) {
    const arr = new Uint8Array(await response.arrayBuffer());
    if (arr.byteLength > maxBytes) {
      throw new Error(`Payload SVRS excede o limite de ${maxBytes} bytes`);
    }
    return Buffer.from(arr);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Payload SVRS excede o limite de ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

export async function syncDfeFromSvrs(
  repo: DfeRepoEntry,
  options: SvrsSyncOptions = {},
): Promise<SvrsDfeSyncResult> {
  try {
    const origin = options.baseOrigin ?? SVRS_DEFAULT_ORIGIN;
    const pageUrl = assertSafeSvrsUrl(new URL(repo.svrsRelativePath, origin).toString()).toString();
    const fetchFn = options.fetchFn ?? fetch;
    const htmlBuf = await fetchWithSafeRedirects(
      pageUrl,
      fetchFn,
      MAX_HTML_BYTES,
      options.maxRedirects,
      options.retryDelaysMs,
    );
    const entries = parseSvrsHtmlTable(htmlBuf.toString('utf8'), repo.dfe, pageUrl);
    return {
      dfe: repo.dfe,
      entries,
      groups: groupNtPublications(entries),
      error: null,
    };
  } catch (err) {
    return {
      dfe: repo.dfe,
      entries: [],
      groups: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function syncAllSvrsNts(
  repos: readonly DfeRepoEntry[],
  options: SvrsSyncOptions = {},
): Promise<SvrsDfeSyncResult[]> {
  return Promise.all(repos.map((repo) => syncDfeFromSvrs(repo, options)));
}

async function tryLoadCachedPdf(
  ntCacheDir: string,
  expectedSha256: string | null,
): Promise<{ readonly pdfPath: string; readonly pdfSha256: string } | null> {
  const cachedPdfPath = path.join(ntCacheDir, 'nt.pdf');
  try {
    const stat = await fsp.lstat(cachedPdfPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_DOWNLOAD_BYTES) {
      return null;
    }
    const buf = await fsp.readFile(cachedPdfPath);
    if (!hasPdfMagicHeader(buf)) {
      return null;
    }
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    if (expectedSha256 && expectedSha256 !== sha256) {
      return null;
    }
    return { pdfPath: cachedPdfPath, pdfSha256: sha256 };
  } catch {
    return null;
  }
}

async function containsValidXsdTree(dir: string): Promise<boolean> {
  const dirStat = await fsp.lstat(dir);
  if (!dirStat.isDirectory()) {
    return false;
  }
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  let foundXsd = false;
  for (const item of entries) {
    if (item.isSymbolicLink()) {
      return false;
    }
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (await containsValidXsdTree(fullPath)) {
        foundXsd = true;
      }
      continue;
    }
    if (item.isFile() && item.name.toLowerCase().endsWith('.xsd')) {
      foundXsd = true;
    }
  }
  return foundXsd;
}

async function findValidCachedXsdDir(ntCacheDir: string): Promise<string | null> {
  const cachedXsdDir = path.join(ntCacheDir, 'xsd');
  try {
    return (await containsValidXsdTree(cachedXsdDir)) ? cachedXsdDir : null;
  } catch {
    return null;
  }
}

function isCacheFallbackEligibleError(err: unknown): boolean {
  return err instanceof SvrsFetchError && err.retryableForCacheFallback;
}

export async function downloadNtArtifacts(
  entry: NtCatalogEntry,
  cacheRootDir: string,
  options: SvrsSyncOptions = {},
): Promise<DownloadedNtArtifacts> {
  if (!entry.pdfUrl && !entry.xsdUrl) {
    return { pdfPath: null, pdfSha256: null, xsdDir: null };
  }
  const dfe = DfeCodeSchema.parse(entry.dfe);
  const fetchFn = options.fetchFn ?? fetch;
  const safeKey = `${entry.ntNumber}_${entry.ntVersion}`.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\.+/g, '_');
  const svrsDfeDir = path.join(path.resolve(cacheRootDir), 'svrs', dfe);
  await fsp.mkdir(svrsDfeDir, { recursive: true });
  const ntCacheDir = path.join(svrsDfeDir, safeKey);
  const stagingDir = await fsp.mkdtemp(path.join(svrsDfeDir, `.staging-${safeKey}-`));

  let pdfPath: string | null = null;
  let pdfSha256: string | null = null;
  let xsdDir: string | null = null;
  let reusedCachedPdf = false;
  let reusedCachedXsd = false;
  let downloadedAnyFresh = false;
  try {
    if (entry.pdfUrl) {
      try {
        const pdfBuf = await fetchWithSafeRedirects(
          entry.pdfUrl,
          fetchFn,
          MAX_DOWNLOAD_BYTES,
          options.maxRedirects,
          options.retryDelaysMs,
        );
        if (!hasPdfMagicHeader(pdfBuf)) {
          throw new Error('Arquivo PDF baixado do SVRS não possui assinatura %PDF-');
        }
        pdfSha256 = crypto.createHash('sha256').update(pdfBuf).digest('hex');
        if (entry.pdfSha256 && entry.pdfSha256 !== pdfSha256) {
          throw new Error('SHA-256 do PDF baixado diverge do valor esperado no catálogo');
        }
        await fsp.writeFile(path.join(stagingDir, 'nt.pdf'), pdfBuf);
        pdfPath = path.join(ntCacheDir, 'nt.pdf');
        downloadedAnyFresh = true;
      } catch (err) {
        const cached = isCacheFallbackEligibleError(err)
          ? await tryLoadCachedPdf(ntCacheDir, entry.pdfSha256)
          : null;
        if (!cached) {
          throw err;
        }
        pdfPath = cached.pdfPath;
        pdfSha256 = cached.pdfSha256;
        reusedCachedPdf = true;
      }
    }
    if (entry.xsdUrl) {
      try {
        const xsdBuf = await fetchWithSafeRedirects(
          entry.xsdUrl,
          fetchFn,
          MAX_DOWNLOAD_BYTES,
          options.maxRedirects,
          options.retryDelaysMs,
        );
        const ext = entry.xsdUrl.toLowerCase().includes('.xsd') && !entry.xsdUrl.toLowerCase().includes('.zip')
          ? 'schema.xsd'
          : 'schemas.zip';
        const stagedBundle = path.join(stagingDir, ext);
        await fsp.writeFile(stagedBundle, xsdBuf);
        await extractSafeXsdBundle(stagedBundle, path.join(stagingDir, 'xsd'));
        await fsp.rm(stagedBundle, { force: true });
        xsdDir = path.join(ntCacheDir, 'xsd');
        downloadedAnyFresh = true;
      } catch (err) {
        const cachedXsd = isCacheFallbackEligibleError(err)
          ? await findValidCachedXsdDir(ntCacheDir)
          : null;
        if (!cachedXsd) {
          throw err;
        }
        xsdDir = cachedXsd;
        reusedCachedXsd = true;
      }
    }

    if (!downloadedAnyFresh) {
      await fsp.rm(stagingDir, { recursive: true, force: true });
    } else {
      if (reusedCachedPdf && pdfPath) {
        await fsp.copyFile(pdfPath, path.join(stagingDir, 'nt.pdf'));
      }
      if (reusedCachedXsd && xsdDir) {
        await fsp.cp(xsdDir, path.join(stagingDir, 'xsd'), { recursive: true });
      }
      await fsp.rm(ntCacheDir, { recursive: true, force: true });
      await fsp.rename(stagingDir, ntCacheDir);
    }

    if (pdfPath && !fs.existsSync(pdfPath)) {
      throw new Error('Falha interna ao persistir PDF baixado');
    }
    return { pdfPath, pdfSha256, xsdDir };
  } catch (err) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
