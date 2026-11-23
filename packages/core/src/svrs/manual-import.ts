import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  DfeCodeSchema,
  hasPdfMagicHeader,
  isValidCalendarIsoDate,
  ManualNtImportRequestSchema,
  NtCatalogEntrySchema,
  type NtCatalogEntry,
} from '../domain/types.js';
import type { ManualNtImportRequest } from '../ports/interfaces.js';
import type { NtcDatabase } from '../storage/sqlite.js';
import { parseBrazilianDate } from './svrs-scraper.js';

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

interface ZipCentralEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly isSymlink: boolean;
  readonly isDirectory: boolean;
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertSafeIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('..') || /[\\/\0]/.test(trimmed) || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Parâmetro ${label} inválido ou potencial path traversal: ${value}`);
  }
  return trimmed;
}

function normalizeManualDate(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (isValidCalendarIsoDate(trimmed)) {
    return trimmed;
  }
  return parseBrazilianDate(trimmed);
}

async function readRegularFileBounded(filePath: string, maxBytes: number, label: string): Promise<Buffer> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    throw new Error(`Arquivo ${label} inválido, inacessível ou symlink bloqueado: ${filePath}`, { cause: err });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`${label} não é um arquivo regular: ${filePath}`);
    }
    if (stat.size <= 0 || stat.size > maxBytes) {
      throw new Error(`Tamanho de ${label} inválido (${stat.size} bytes): ${filePath}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function validateAndReadPdf(pdfSourcePath: string): Promise<{ bytes: Buffer; sha256: string }> {
  const bytes = await readRegularFileBounded(pdfSourcePath, MAX_PDF_BYTES, 'PDF');
  if (!hasPdfMagicHeader(bytes)) {
    throw new Error(`Arquivo informado não é um PDF válido (%PDF- ausente): ${pdfSourcePath}`);
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256 };
}

function assertSafeArchiveRelativePath(rawName: string, destRoot: string): string {
  if (!rawName || rawName.includes('\0') || rawName.includes('\\')) {
    throw new Error(`Entrada ZIP inválida (Zip-Slip/separador proibido): ${rawName}`);
  }
  if (rawName.startsWith('/') || /^[A-Za-z]:/.test(rawName)) {
    throw new Error(`Entrada ZIP com caminho absoluto proibida (Zip-Slip): ${rawName}`);
  }
  const segments = rawName.split('/');
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new Error(`Path traversal (Zip-Slip) detectado em entrada ZIP: ${rawName}`);
  }
  const resolvedDest = path.resolve(destRoot);
  const candidate = path.resolve(resolvedDest, rawName);
  if (!candidate.startsWith(resolvedDest + path.sep)) {
    throw new Error(`Saída fora do diretório alvo (Zip-Slip): ${rawName}`);
  }
  return candidate;
}

function decodeXsdText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    if (swapped.length % 2 === 0) {
      swapped.swap16();
    }
    return swapped.toString('utf16le');
  }
  return bytes.toString('utf8');
}

export function assertSafeXsdContent(bytes: Buffer, label: string): void {
  const decoded = decodeXsdText(bytes);
  if (
    /<!DOCTYPE\b|<!ENTITY\b/i.test(decoded) ||
    /<\s*(?:[A-Za-z_][\w.-]*:)?include\b/i.test(decoded) ||
    /http:\/\/www\.w3\.org\/2001\/XInclude/i.test(decoded)
  ) {
    throw new Error(`XSD contém DOCTYPE/ENTITY/XInclude proibido (XXE): ${label}`);
  }
  if (/(?:noNamespace)?schemaLocation\s*=\s*["']\s*(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|\\\\)/i.test(decoded)) {
    throw new Error(`XSD contém schemaLocation externo proibido: ${label}`);
  }
}

function findEocdInfo(zipBuf: Buffer): { cdOffset: number; cdSize: number; entryCount: number; eocdOffset: number } {
  const minOffset = Math.max(0, zipBuf.length - 65_557);
  for (let i = zipBuf.length - 22; i >= minOffset; i--) {
    if (zipBuf.readUInt32LE(i) !== 0x06054b50) {
      continue;
    }
    const commentLen = zipBuf.readUInt16LE(i + 20);
    if (i + 22 + commentLen !== zipBuf.length) {
      continue;
    }
    const entryCount = zipBuf.readUInt16LE(i + 10);
    const cdSize = zipBuf.readUInt32LE(i + 12);
    const cdOffset = zipBuf.readUInt32LE(i + 16);
    if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      throw new Error('Pacotes ZIP64 não são suportados para esquemas XSD');
    }
    if (cdOffset + cdSize > i) {
      throw new Error('Diretório central PKZIP fora dos limites do arquivo');
    }
    return { cdOffset, cdSize, entryCount, eocdOffset: i };
  }
  throw new Error('Assinatura PKZIP (EOCD) não encontrada no pacote XSD');
}

function parseZipCentralDirectory(zipBuf: Buffer): { entries: ZipCentralEntry[]; cdOffset: number } {
  const { cdOffset, cdSize, entryCount } = findEocdInfo(zipBuf);
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error(`Pacote ZIP excede limite de ${MAX_ZIP_ENTRIES} entradas`);
  }
  const cdEnd = cdOffset + cdSize;
  const entries: ZipCentralEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > cdEnd || zipBuf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Cabeçalho central PKZIP corrompido ou truncado');
    }
    const flags = zipBuf.readUInt16LE(cursor + 8);
    if ((flags & 0x01) !== 0 || (flags & 0x08) !== 0) {
      throw new Error('Entradas ZIP criptografadas ou com data descriptor não são permitidas');
    }
    const nameLen = zipBuf.readUInt16LE(cursor + 28);
    const extraLen = zipBuf.readUInt16LE(cursor + 30);
    const commentLen = zipBuf.readUInt16LE(cursor + 32);
    const recordEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (recordEnd > cdEnd) {
      throw new Error('Entrada do diretório central PKZIP ultrapassa o limite');
    }
    const extAttr = zipBuf.readUInt32LE(cursor + 38);
    const name = zipBuf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    entries.push({
      name,
      flags,
      method: zipBuf.readUInt16LE(cursor + 10),
      crc32: zipBuf.readUInt32LE(cursor + 16),
      compressedSize: zipBuf.readUInt32LE(cursor + 20),
      uncompressedSize: zipBuf.readUInt32LE(cursor + 24),
      localHeaderOffset: zipBuf.readUInt32LE(cursor + 42),
      isSymlink: ((extAttr >>> 16) & 0o170000) === 0o120000,
      isDirectory: name.endsWith('/'),
    });
    cursor = recordEnd;
  }
  return { entries, cdOffset };
}

function readZipEntryBytes(zipBuf: Buffer, entry: ZipCentralEntry, cdOffset: number): Buffer {
  const off = entry.localHeaderOffset;
  if (off + 30 > cdOffset || zipBuf.readUInt32LE(off) !== 0x04034b50) {
    throw new Error(`Local header ZIP inválido para ${entry.name}`);
  }
  if (entry.compressedSize > MAX_ZIP_ENTRY_BYTES || entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
    throw new Error(`Entrada ZIP excede limite de tamanho (${MAX_ZIP_ENTRY_BYTES} bytes): ${entry.name}`);
  }
  const nameLen = zipBuf.readUInt16LE(off + 26);
  const extraLen = zipBuf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  if (dataStart + entry.compressedSize > cdOffset) {
    throw new Error(`Dados ZIP truncados ou fora dos limites em ${entry.name}`);
  }
  const compressedSlice = zipBuf.subarray(dataStart, dataStart + entry.compressedSize);
  let raw: Buffer;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw new Error(`Tamanho inconsistente em entrada STORED ${entry.name}`);
    }
    raw = Buffer.from(compressedSlice);
  } else if (entry.method === 8) {
    raw = zlib.inflateRawSync(compressedSlice, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
  } else {
    throw new Error(`Método de compressão ZIP não suportado (${entry.method}) em ${entry.name}`);
  }
  validateDecompressedEntry(raw, entry);
  return raw;
}

function validateDecompressedEntry(data: Buffer, entry: ZipCentralEntry): void {
  if (data.length !== entry.uncompressedSize) {
    throw new Error(`Tamanho real diverge do cabeçalho ZIP (spoofing) em ${entry.name}`);
  }
  if (entry.compressedSize === 0 && data.length > 0) {
    throw new Error(`Entrada ZIP inconsistente com compressedSize=0 em ${entry.name}`);
  }
  if (entry.compressedSize > 0 && data.length / entry.compressedSize > MAX_COMPRESSION_RATIO) {
    throw new Error(`Taxa de compressão suspeita (zip-bomb): ${entry.name}`);
  }
  if (computeCrc32(data) !== entry.crc32) {
    throw new Error(`Checksum CRC-32 inválido em ${entry.name}`);
  }
}

async function extractZipSafely(zipPath: string, destDir: string): Promise<number> {
  const zipBuf = await readRegularFileBounded(zipPath, MAX_ZIP_TOTAL_BYTES, 'ZIP');
  const { entries, cdOffset } = parseZipCentralDirectory(zipBuf);
  let actualTotalBytes = 0;
  let xsdCount = 0;

  for (const entry of entries) {
    if (entry.isSymlink) {
      throw new Error(`Symlink dentro do pacote ZIP bloqueado: ${entry.name}`);
    }
    if (entry.isDirectory || !entry.name.toLowerCase().endsWith('.xsd')) {
      continue;
    }
    const targetPath = assertSafeArchiveRelativePath(entry.name, destDir);
    const data = readZipEntryBytes(zipBuf, entry, cdOffset);
    actualTotalBytes += data.length;
    if (actualTotalBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('Pacote ZIP excede limite total real descompactado');
    }
    assertSafeXsdContent(data, entry.name);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, data);
    xsdCount++;
  }
  return xsdCount;
}

async function copyDirectoryXsdsSafely(realRoot: string, currentRealDir: string, destDir: string): Promise<number> {
  const items = await fsp.readdir(currentRealDir, { withFileTypes: true });
  let count = 0;
  for (const item of items) {
    if (item.isSymbolicLink()) {
      throw new Error(`Symlink não permitido no diretório XSD: ${path.join(currentRealDir, item.name)}`);
    }
    const absItem = path.join(currentRealDir, item.name);
    const realItem = await fsp.realpath(absItem);
    if (realItem !== realRoot && !realItem.startsWith(realRoot + path.sep)) {
      throw new Error(`Caminho XSD fora do diretório raiz: ${absItem}`);
    }
    if (item.isDirectory()) {
      count += await copyDirectoryXsdsSafely(realRoot, realItem, destDir);
    } else if (item.isFile() && item.name.toLowerCase().endsWith('.xsd')) {
      const rel = path.relative(realRoot, realItem).replace(/\\/g, '/');
      const target = assertSafeArchiveRelativePath(rel, destDir);
      const data = await readRegularFileBounded(realItem, MAX_ZIP_ENTRY_BYTES, 'XSD');
      assertSafeXsdContent(data, rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data);
      count++;
    }
  }
  return count;
}

export async function extractSafeXsdBundle(xsdSourcePath: string, destDir: string): Promise<string> {
  const stat = await fsp.lstat(xsdSourcePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Fonte XSD não pode ser symlink: ${xsdSourcePath}`);
  }
  await fsp.mkdir(destDir, { recursive: true });

  let xsdCount = 0;
  if (stat.isDirectory()) {
    const realRoot = await fsp.realpath(xsdSourcePath);
    xsdCount = await copyDirectoryXsdsSafely(realRoot, realRoot, destDir);
  } else if (stat.isFile() && xsdSourcePath.toLowerCase().endsWith('.zip')) {
    xsdCount = await extractZipSafely(xsdSourcePath, destDir);
  } else if (stat.isFile() && xsdSourcePath.toLowerCase().endsWith('.xsd')) {
    const data = await readRegularFileBounded(xsdSourcePath, MAX_ZIP_ENTRY_BYTES, 'XSD');
    assertSafeXsdContent(data, path.basename(xsdSourcePath));
    await fsp.writeFile(path.join(destDir, path.basename(xsdSourcePath)), data);
    xsdCount = 1;
  } else {
    throw new Error(`Formato XSD não suportado: ${xsdSourcePath}`);
  }

  if (xsdCount === 0) {
    throw new Error(`Nenhum arquivo .xsd encontrado em: ${xsdSourcePath}`);
  }
  return destDir;
}

export async function importManualNt(
  rawRequest: ManualNtImportRequest,
  cacheRootDir: string,
  db?: NtcDatabase,
): Promise<{ entry: NtCatalogEntry; xsdDir: string }> {
  const request = ManualNtImportRequestSchema.parse(rawRequest);
  const dfe = DfeCodeSchema.parse(request.dfe);
  const safeNtNumber = assertSafeIdentifier(request.ntNumber, 'ntNumber');
  const safeNtVersion = assertSafeIdentifier(request.ntVersion, 'ntVersion');
  const publishedDate = normalizeManualDate(request.publishedDate);
  if (!publishedDate) {
    throw new Error(`Data de publicação obrigatória inválida: ${request.publishedDate}`);
  }
  const homologDate = normalizeManualDate(request.homologDate);
  const prodDate = normalizeManualDate(request.prodDate);

  const { bytes: pdfBytes, sha256 } = await validateAndReadPdf(request.pdfSourcePath);
  const cacheBase = path.join(path.resolve(cacheRootDir), 'svrs', dfe, 'manual');
  await fsp.mkdir(cacheBase, { recursive: true });

  const manualRoot = path.join(cacheBase, `${safeNtNumber}_${safeNtVersion}`);
  const xsdDestDir = path.join(manualRoot, 'xsd');
  const stagingDir = await fsp.mkdtemp(path.join(cacheBase, `.staging-${safeNtNumber}-`));

  try {
    await fsp.writeFile(path.join(stagingDir, 'nt.pdf'), pdfBytes);
    await extractSafeXsdBundle(request.xsdSourcePath, path.join(stagingDir, 'xsd'));
    await fsp.rm(manualRoot, { recursive: true, force: true });
    await fsp.rename(stagingDir, manualRoot);
  } catch (err) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  const entry = NtCatalogEntrySchema.parse({
    id: `${dfe}:${safeNtNumber}:${safeNtVersion}`,
    dfe,
    ntNumber: safeNtNumber,
    ntVersion: safeNtVersion,
    publishedDate,
    homologDate,
    prodDate,
    pdfUrl: null,
    xsdUrl: null,
    pdfSha256: sha256,
    sourceStatus: 'MANUAL',
    fetchedAt: new Date().toISOString(),
  });

  if (db) {
    db.upsertNtCatalogEntries([entry]);
  }
  return { entry, xsdDir: xsdDestDir };
}
