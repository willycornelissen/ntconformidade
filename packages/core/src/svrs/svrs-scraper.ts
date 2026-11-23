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

export interface SvrsSyncOptions {
  readonly baseOrigin?: string;
  readonly fetchFn?: typeof fetch;
  readonly maxRedirects?: number;
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
  const verMatch = /\b(?:v|vers[aã]o)\s*(\d+(?:\.\d+)?)\b/i.exec(text);
  const errataMatch = /errata\s*(\d+)?/i.exec(text);
  const baseVer = verMatch?.[1] ? `v${verMatch[1]}` : 'v1.00';
  const ntVersion = errataMatch ? `${baseVer}-errata${errataMatch[1] ?? '1'}` : baseVer;

  const strippedForNum = text.replace(/\b(?:v|vers[aã]o)\s*\d+(?:\.\d+)?\b/gi, ' ');
  const numMatch = /(\d{4}\.\d{3}|\d+\.\d+)/.exec(strippedForNum);
  const fallback = strippedForNum
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const ntNumber = numMatch?.[1] ?? (fallback || 'sem-numero');
  return { ntNumber, ntVersion };
}

export function parseSvrsHtmlTable(html: string, dfe: DfeCode, pageUrl: string): NtCatalogEntry[] {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const rows = $('table tbody tr');
  if (rows.length === 0) {
    throw new Error(`Tabela SVRS esperada não encontrada para ${dfe}`);
  }

  const fetchedAt = new Date().toISOString();
  const entries: NtCatalogEntry[] = [];
  const seenKeys = new Set<string>();
  rows.each((_, rowEl) => {
    const cells = $(rowEl).find('td');
    if (cells.length < 4) {
      return;
    }
    const title = $(cells[0]).text().replace(/\s+/g, ' ').trim();
    const publishedDate = parseBrazilianDate($(cells[1]).text());
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

  if (entries.length === 0) {
    throw new Error(`Nenhum registro válido de NT extraído para ${dfe}`);
  }
  return entries;
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

async function fetchWithSafeRedirects(
  rawUrl: string,
  fetchFn: typeof fetch,
  maxBytes: number,
  requestedRedirects = 3,
): Promise<Buffer> {
  const maxRedirects = Math.min(Math.max(0, requestedRedirects), MAX_REDIRECT_CAP);
  let currentUrl = assertSafeSvrsUrl(rawUrl).toString();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetchFn(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location || hop === maxRedirects) {
        throw new Error(`Redirect HTTP bloqueado ou limite excedido em ${currentUrl}`);
      }
      currentUrl = assertSafeSvrsUrl(new URL(location, currentUrl).toString()).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Falha HTTP ${response.status} ao consultar ${currentUrl}`);
    }
    return readBoundedResponse(response, maxBytes);
  }
  throw new Error('Limite de redirects excedido');
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
    const htmlBuf = await fetchWithSafeRedirects(pageUrl, fetchFn, MAX_HTML_BYTES, options.maxRedirects);
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
  try {
    if (entry.pdfUrl) {
      const pdfBuf = await fetchWithSafeRedirects(entry.pdfUrl, fetchFn, MAX_DOWNLOAD_BYTES, options.maxRedirects);
      if (!hasPdfMagicHeader(pdfBuf)) {
        throw new Error('Arquivo PDF baixado do SVRS não possui assinatura %PDF-');
      }
      pdfSha256 = crypto.createHash('sha256').update(pdfBuf).digest('hex');
      if (entry.pdfSha256 && entry.pdfSha256 !== pdfSha256) {
        throw new Error('SHA-256 do PDF baixado diverge do valor esperado no catálogo');
      }
      await fsp.writeFile(path.join(stagingDir, 'nt.pdf'), pdfBuf);
      pdfPath = path.join(ntCacheDir, 'nt.pdf');
    }
    if (entry.xsdUrl) {
      const xsdBuf = await fetchWithSafeRedirects(entry.xsdUrl, fetchFn, MAX_DOWNLOAD_BYTES, options.maxRedirects);
      const ext = entry.xsdUrl.toLowerCase().includes('.xsd') && !entry.xsdUrl.toLowerCase().includes('.zip')
        ? 'schema.xsd'
        : 'schemas.zip';
      const stagedBundle = path.join(stagingDir, ext);
      await fsp.writeFile(stagedBundle, xsdBuf);
      await extractSafeXsdBundle(stagedBundle, path.join(stagingDir, 'xsd'));
      await fsp.rm(stagedBundle, { force: true });
      xsdDir = path.join(ntCacheDir, 'xsd');
    }
    await fsp.rm(ntCacheDir, { recursive: true, force: true });
    await fsp.rename(stagingDir, ntCacheDir);
    if (pdfPath && !fs.existsSync(pdfPath)) {
      throw new Error('Falha interna ao persistir PDF baixado');
    }
    return { pdfPath, pdfSha256, xsdDir };
  } catch (err) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
