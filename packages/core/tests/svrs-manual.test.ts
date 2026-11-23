import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  openDatabase,
  loadDefaultRegistryEntries,
  parseBrazilianDate,
  parseSvrsHtmlTable,
  groupNtPublications,
  syncDfeFromSvrs,
  syncAllSvrsNts,
  downloadNtArtifacts,
  importManualNt,
  extractSafeXsdBundle,
  type NtcDatabase,
  type DfeRepoEntry,
} from '../src/index.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..', '..');
const REGISTRY_PATH = path.join(ROOT_DIR, 'config', 'dfe-registry.default.json');

const tempDirs: string[] = [];
const dbHandles: NtcDatabase[] = [];

async function makeTempEnv(): Promise<{ dir: string; ntcDb: NtcDatabase; repos: DfeRepoEntry[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ntc-svrs-'));
  tempDirs.push(dir);
  const ntcDb = openDatabase(path.join(dir, 'ntc.sqlite'));
  dbHandles.push(ntcDb);
  const repos = await loadDefaultRegistryEntries(REGISTRY_PATH);
  ntcDb.seedDefaultRepos(repos);
  return { dir, ntcDb, repos };
}

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] ?? 0;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface SyntheticZipEntry {
  readonly name: string;
  readonly content: string | Buffer;
  readonly posixMode?: number;
  readonly method?: 0 | 8;
  readonly flags?: number;
  readonly spoofUncompressedSize?: number;
}

function buildSyntheticZip(entries: readonly SyntheticZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawData = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    const method = entry.method ?? 8;
    const flags = entry.flags ?? 0;
    const hasDataDescriptor = (flags & 0x08) !== 0;
    const payload = method === 0 ? rawData : zlib.deflateRawSync(rawData);
    const sum = crc32(rawData);
    const declaredUncompressed = entry.spoofUncompressedSize ?? rawData.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(hasDataDescriptor ? 0 : sum, 14);
    local.writeUInt32LE(hasDataDescriptor ? 0 : payload.length, 18);
    local.writeUInt32LE(hasDataDescriptor ? 0 : declaredUncompressed, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    locals.push(local, payload);
    let descriptorLen = 0;
    if (hasDataDescriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(sum, 4);
      dd.writeUInt32LE(payload.length, 8);
      dd.writeUInt32LE(declaredUncompressed, 12);
      locals.push(dd);
      descriptorLen = dd.length;
    }

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(sum, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(declaredUncompressed, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    const mode = entry.posixMode ?? 0o100644;
    cd.writeUInt32LE((mode << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    centrals.push(cd);

    offset += local.length + payload.length + descriptorLen;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

afterEach(async () => {
  while (dbHandles.length > 0) {
    dbHandles.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('Ciclo 3 — Scraper SVRS e Importação Manual Segura', () => {
  it('SV-01 e SV-02 analisam HTML SVRS, datas dd/MM/yyyy e agrupam versões/erratas', () => {
    expect(parseBrazilianDate('26/10/2026')).toBe('2026-10-26');
    expect(parseBrazilianDate('Implementação Futura')).toBeNull();
    expect(() => parseBrazilianDate('31/02/2026')).toThrow(/Data inválida/i);

    const html = `
      <html><body>
        <table>
          <thead><tr><th>Nota Técnica</th><th>Publicação</th><th>Homologação</th><th>Produção</th><th>Arquivos</th></tr></thead>
          <tbody>
            <tr>
              <td>Nota Técnica 2026.005 v1.00 <script>alert(1)</script></td>
              <td>10/10/2026</td>
              <td>01/11/2026</td>
              <td>Implementação Futura</td>
              <td>
                <a href="/Nfe/Download?file=nt2026_005_v100.pdf">PDF</a>
                <a href="/Nfe/Download?file=PL_009_v100.zip">XSD</a>
              </td>
            </tr>
            <tr>
              <td>Nota Técnica 2026.005 v1.10 - Errata 1</td>
              <td>26/10/2026</td>
              <td>10/11/2026</td>
              <td>01/12/2026</td>
              <td><a href="/Nfe/Download?file=nt2026_005_v110.pdf">PDF</a></td>
            </tr>
          </tbody>
        </table>
      </body></html>
    `;

    const entries = parseSvrsHtmlTable(html, 'NFe', 'https://dfe-portal.svrs.rs.gov.br/Nfe/Documentos');
    expect(entries).toHaveLength(2);
    const [e0, e1] = entries;
    expect(e0?.publishedDate).toBe('2026-10-10');
    expect(e0?.prodDate).toBeNull();
    expect(e0?.pdfUrl).toBe('https://dfe-portal.svrs.rs.gov.br/Nfe/Download?file=nt2026_005_v100.pdf');
    expect(e1?.ntVersion).toBe('v1.10-errata1');
    expect(e1?.prodDate).toBe('2026-12-01');

    const groups = groupNtPublications(entries);
    expect(groups).toHaveLength(1);
    const [g0] = groups;
    expect(g0?.latestVersion).toBe('v1.10-errata1');
    expect(g0?.entries).toHaveLength(2);
  });

  it('SV-03 e SV-04 isolam falhas HTTP/layout por DFe sem quebrar os demais', async () => {
    const { repos } = await makeTempEnv();

    const okHtml = `
      <table><tbody>
        <tr>
          <td>NT 2026.001 v1.00</td><td>05/10/2026</td><td>10/10/2026</td><td>20/10/2026</td>
          <td><a href="/Doc/nt.pdf">PDF</a></td>
        </tr>
      </tbody></table>
    `;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/Bpe/')) {
        return new Response('Service Unavailable', { status: 503 });
      }
      if (url.includes('/Cte/')) {
        return new Response('<html><body><div>Layout alterado sem tabela</div></body></html>', { status: 200 });
      }
      return new Response(okHtml, { status: 200 });
    };

    const results = await syncAllSvrsNts(repos, { fetchFn: mockFetch });
    expect(results).toHaveLength(8);
    expect(results.find((r) => r.dfe === 'NFe')?.entries).toHaveLength(1);
    expect(results.find((r) => r.dfe === 'NFCe')?.entries).toHaveLength(1);
    expect(results.find((r) => r.dfe === 'BPe')?.error).toContain('503');
    expect(results.find((r) => r.dfe === 'CTe')?.error).toBeTruthy();
    expect(results.find((r) => r.dfe === 'GTVe')?.error).toBeTruthy();
    expect(repos.find((r) => r.dfe === 'GTVe')?.svrsRelativePath).toBe('/Cte/Documentos');
  });

  it('SV-05 a SV-08 bloqueiam SSRF em URLs, redirects maliciosos e gravam PDF com SHA-256 exato', async () => {
    const { dir, repos } = await makeTempEnv();
    const nfeRepo = repos.find((r) => r.dfe === 'NFe');
    if (!nfeRepo) {
      throw new Error('NFe ausente');
    }

    let calledCount = 0;
    const trackingFetch: typeof fetch = async () => {
      calledCount++;
      return new Response('should not reach', { status: 200 });
    };

    for (const badHost of [
      'http://dfe-portal.svrs.rs.gov.br',
      'https://evil.example.com',
      'https://dfe-portal.svrs.rs.gov.br.evil.com',
      'https://169.254.169.254',
    ]) {
      const res = await syncDfeFromSvrs(nfeRepo, { baseOrigin: badHost, fetchFn: trackingFetch });
      expect(res.error).toBeTruthy();
    }
    expect(calledCount).toBe(0);

    // Redirect malicioso bloqueado sem seguir
    const redirectFetch: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });

    const redirectRes = await syncDfeFromSvrs(nfeRepo, { fetchFn: redirectFetch });
    expect(redirectRes.error).toMatch(/redirect|SSRF|bloquead/i);

    // Download válido PDF + SHA-256
    const fakePdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8');
    const expectedSha = crypto.createHash('sha256').update(fakePdf).digest('hex');

    const okPdfFetch: typeof fetch = async () =>
      new Response(fakePdf, { status: 200, headers: { 'Content-Type': 'application/pdf' } });

    const downloaded = await downloadNtArtifacts(
      {
        id: 'NFe:2026.005:v1.00',
        dfe: 'NFe',
        ntNumber: '2026.005',
        ntVersion: 'v1.00',
        publishedDate: '2026-10-26',
        homologDate: null,
        prodDate: null,
        pdfUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/Download/nt.pdf',
        xsdUrl: null,
        pdfSha256: null,
        sourceStatus: 'DISCOVERED',
        fetchedAt: '2026-11-19T12:00:00.000Z',
      },
      dir,
      { fetchFn: okPdfFetch },
    );
    expect(downloaded.pdfSha256).toBe(expectedSha);
    expect(downloaded.pdfPath).toBeTruthy();
  });

  it('SV-09 e SV-10 importam par manual PDF+XSD (dir e zip) com SHA-256 e rejeitam entradas inválidas', async () => {
    const { dir, ntcDb } = await makeTempEnv();
    const srcPdf = path.join(dir, 'nt.pdf');
    await fs.writeFile(srcPdf, '%PDF-1.4\n%%EOF\n', 'utf8');

    const srcZip = path.join(dir, 'schemas.zip');
    await fs.writeFile(
      srcZip,
      buildSyntheticZip([
        { name: 'nfe_v4.00.xsd', content: '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>' },
        { name: 'sub/tipos.xsd', content: '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>' },
      ]),
    );

    const res = await importManualNt(
      {
        dfe: 'NFe',
        ntNumber: '2026.010',
        ntVersion: 'v1.00',
        publishedDate: '15/11/2026',
        pdfSourcePath: srcPdf,
        xsdSourcePath: srcZip,
      },
      path.join(dir, 'cache'),
      ntcDb,
    );

    expect(res.entry.sourceStatus).toBe('MANUAL');
    expect(res.entry.publishedDate).toBe('2026-11-15');
    expect(ntcDb.listNtCatalogByDfe('NFe')).toHaveLength(1);
    const extractedXsd = await fs.readFile(path.join(res.xsdDir, 'nfe_v4.00.xsd'), 'utf8');
    expect(extractedXsd).toContain('xs:schema');

    // PDF falso sem header %PDF-
    const badPdf = path.join(dir, 'fake.pdf');
    await fs.writeFile(badPdf, '<html>not a pdf</html>', 'utf8');
    await expect(
      importManualNt(
        {
          dfe: 'NFe',
          ntNumber: '2026.011',
          ntVersion: 'v1.00',
          publishedDate: '2026-11-15',
          pdfSourcePath: badPdf,
          xsdSourcePath: srcZip,
        },
        path.join(dir, 'cache'),
        ntcDb,
      ),
    ).rejects.toThrow(/PDF/i);

    // ZIP sem .xsd
    const emptyZip = path.join(dir, 'no-xsd.zip');
    await fs.writeFile(emptyZip, buildSyntheticZip([{ name: 'readme.txt', content: 'nada' }]));
    await expect(extractSafeXsdBundle(emptyZip, path.join(dir, 'out-empty'))).rejects.toThrow(/xsd/i);
  });

  it('SV-11 a SV-13 bloqueiam Zip-Slip, symlinks em ZIP/diretório, DOCTYPE em XSD e traversal em ntNumber', async () => {
    const { dir, ntcDb } = await makeTempEnv();

    // Zip-Slip
    const zipSlipPath = path.join(dir, 'zipslip.zip');
    await fs.writeFile(
      zipSlipPath,
      buildSyntheticZip([{ name: '../../evil.xsd', content: '<xs:schema/>' }]),
    );
    await expect(extractSafeXsdBundle(zipSlipPath, path.join(dir, 'dest-slip'))).rejects.toThrow(/traversal|Zip-Slip/i);

    // Symlink POSIX dentro do ZIP (0o120777)
    const zipSymlinkPath = path.join(dir, 'zipsym.zip');
    await fs.writeFile(
      zipSymlinkPath,
      buildSyntheticZip([{ name: 'evil.xsd', content: '/etc/passwd', posixMode: 0o120777 }]),
    );
    await expect(extractSafeXsdBundle(zipSymlinkPath, path.join(dir, 'dest-sym'))).rejects.toThrow(/symlink/i);

    // XSD com DOCTYPE XXE dentro do ZIP
    const xxeZip = path.join(dir, 'xxe.zip');
    await fs.writeFile(
      xxeZip,
      buildSyntheticZip([
        {
          name: 'evil.xsd',
          content: '<!DOCTYPE xs:schema [ <!ENTITY x SYSTEM "file:///etc/passwd"> ]><xs:schema/>',
        },
      ]),
    );
    await expect(extractSafeXsdBundle(xxeZip, path.join(dir, 'dest-xxe'))).rejects.toThrow(/DOCTYPE/i);

    // Diretório local com symlink externo
    const xsdDir = path.join(dir, 'local-xsds');
    await fs.mkdir(xsdDir, { recursive: true });
    const outsideFile = path.join(dir, 'outside.xsd');
    await fs.writeFile(outsideFile, '<xs:schema/>', 'utf8');
    await fs.symlink(outsideFile, path.join(xsdDir, 'link.xsd'));
    await expect(extractSafeXsdBundle(xsdDir, path.join(dir, 'dest-local-sym'))).rejects.toThrow(/symlink/i);

    // Traversal em ntNumber no importManualNt
    const okPdf = path.join(dir, 'ok.pdf');
    await fs.writeFile(okPdf, '%PDF-1.4\n%%EOF\n', 'utf8');
    const okXsdDir = path.join(dir, 'ok-xsd');
    await fs.mkdir(okXsdDir, { recursive: true });
    await fs.writeFile(path.join(okXsdDir, 'a.xsd'), '<xs:schema/>', 'utf8');

    await expect(
      importManualNt(
        {
          dfe: 'NFe',
          ntNumber: '../../escape',
          ntVersion: 'v1.00',
          publishedDate: '2026-11-15',
          pdfSourcePath: okPdf,
          xsdSourcePath: okXsdDir,
        },
        path.join(dir, 'cache'),
        ntcDb,
      ),
    ).rejects.toThrow(/inválid|traversal/i);
  });

  it('SV-14 cobre diretório local válido, arquivo .xsd único, ZIP store/pasta e erros de formato/tamanho', async () => {
    const { dir, ntcDb } = await makeTempEnv();
    const okPdf = path.join(dir, 'ok2.pdf');
    await fs.writeFile(okPdf, '%PDF-1.4\n%%EOF\n', 'utf8');

    // Diretório local válido com subpasta e arquivo não-XSD ignorado
    const validXsdDir = path.join(dir, 'valid-dir');
    await fs.mkdir(path.join(validXsdDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(validXsdDir, 'sub', 'a.xsd'), '<xs:schema/>', 'utf8');
    await fs.writeFile(path.join(validXsdDir, 'leiame.txt'), 'ignorar', 'utf8');

    const resDir = await importManualNt(
      {
        dfe: 'BPe',
        ntNumber: '2026.020',
        ntVersion: 'v1.00',
        publishedDate: '2026-11-18',
        homologDate: '20/11/2026',
        prodDate: '2026-12-01',
        pdfSourcePath: okPdf,
        xsdSourcePath: validXsdDir,
      },
      path.join(dir, 'cache'),
      ntcDb,
    );
    expect(await fs.readFile(path.join(resDir.xsdDir, 'sub', 'a.xsd'), 'utf8')).toBe('<xs:schema/>');

    // Arquivo .xsd único e formato inválido
    const singleXsd = path.join(dir, 'single.xsd');
    await fs.writeFile(singleXsd, '<xs:schema/>', 'utf8');
    await extractSafeXsdBundle(singleXsd, path.join(dir, 'dest-single'));
    expect(await fs.readFile(path.join(dir, 'dest-single', 'single.xsd'), 'utf8')).toBe('<xs:schema/>');

    const badExt = path.join(dir, 'bad.txt');
    await fs.writeFile(badExt, 'x', 'utf8');
    await expect(extractSafeXsdBundle(badExt, path.join(dir, 'dest-bad'))).rejects.toThrow(/não suportado/i);

    // ZIP corrompido (sem EOCD)
    const corruptZip = path.join(dir, 'corrupt.zip');
    await fs.writeFile(corruptZip, 'not-a-zip', 'utf8');
    await expect(extractSafeXsdBundle(corruptZip, path.join(dir, 'dest-corrupt'))).rejects.toThrow(/PKZIP/i);

    // SVRS redirect seguro intra-domínio e erros extras (URL malformada, credenciais, non-PDF download, oversized)
    const okHtml = `<table><tbody><tr><td>NT 2026.099</td><td>01/11/2026</td><td>-</td><td>-</td><td></td></tr></tbody></table>`;
    let hops = 0;
    const safeRedirectFetch: typeof fetch = async () => {
      hops++;
      if (hops === 1) {
        return new Response(null, { status: 302, headers: { Location: '/Nfe/DocumentosV2' } });
      }
      return new Response(okHtml, { status: 200 });
    };
    const [nfeRepo] = ntcDb.listDfeRepos().filter((r) => r.dfe === 'NFe');
    if (!nfeRepo) {
      throw new Error('NFe ausente');
    }
    const redirSync = await syncDfeFromSvrs(nfeRepo, { fetchFn: safeRedirectFetch });
    expect(redirSync.entries).toHaveLength(1);
    const [firstRedir] = redirSync.entries;
    if (!firstRedir) {
      throw new Error('Entry ausente');
    }

    expect((await syncDfeFromSvrs(nfeRepo, { baseOrigin: 'not a url' })).error).toBeTruthy();
    expect((await syncDfeFromSvrs(nfeRepo, { baseOrigin: 'https://user:pass@dfe-portal.svrs.rs.gov.br' })).error).toBeTruthy();
    expect((await syncDfeFromSvrs(nfeRepo, { baseOrigin: 'https://dfe-portal.svrs.rs.gov.br:8443' })).error).toBeTruthy();
    expect(() => parseBrazilianDate('2026-10-26')).toThrow(/dd\/MM\/yyyy/);
    const grouped = groupNtPublications([
      { ...firstRedir, ntVersion: 'v1.00', id: 'NFe:2026.099:v1.00' },
      { ...firstRedir, ntVersion: 'v1.10', id: 'NFe:2026.099:v1.10' },
    ]);
    expect(grouped[0]?.latestVersion).toBe('v1.10');

    // Redirect infinito bloqueado (maxRedirects = 0)
    const infiniteRedir = await syncDfeFromSvrs(nfeRepo, {
      maxRedirects: 0,
      fetchFn: async () => new Response(null, { status: 302, headers: { Location: '/Nfe/Next' } }),
    });
    expect(infiniteRedir.error).toMatch(/Redirect/i);

    await expect(
      downloadNtArtifacts(
        {
          id: 'NFe:2026.099:v1.00',
          dfe: 'NFe',
          ntNumber: '2026.099',
          ntVersion: 'v1.00',
          publishedDate: '2026-11-01',
          homologDate: null,
          prodDate: null,
          pdfUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/bad.pdf',
          xsdUrl: null,
          pdfSha256: null,
          sourceStatus: 'DISCOVERED',
          fetchedAt: '2026-11-19T12:00:00.000Z',
        },
        path.join(dir, 'cache'),
        { fetchFn: async () => new Response('not-pdf', { status: 200 }) },
      ),
    ).rejects.toThrow(/%PDF-/i);
  });

  it('SV-15 bloqueia ZIP spoofing, STORED/XXE >64KB/UTF-16 e baixa/extrai xsdUrl real em downloadNtArtifacts', async () => {
    const { dir, ntcDb } = await makeTempEnv();

    // ZIP STORED válido (method === 0) e ZIP com uncompressedSize falsificado (spoofing)
    const storedZip = path.join(dir, 'stored.zip');
    await fs.writeFile(
      storedZip,
      buildSyntheticZip([{ name: 's.xsd', content: '<xs:schema/>', method: 0 }]),
    );
    await extractSafeXsdBundle(storedZip, path.join(dir, 'dest-stored'));
    expect(await fs.readFile(path.join(dir, 'dest-stored', 's.xsd'), 'utf8')).toBe('<xs:schema/>');

    const spoofZip = path.join(dir, 'spoof.zip');
    await fs.writeFile(
      spoofZip,
      buildSyntheticZip([{ name: 'bomb.xsd', content: '<xs:schema/>'.repeat(100), spoofUncompressedSize: 5 }]),
    );
    await expect(extractSafeXsdBundle(spoofZip, path.join(dir, 'dest-spoof'))).rejects.toThrow(/diverge|spoofing/i);

    // XXE após 65 KB de comentários e UTF-16LE BOM bloqueados
    const okPdf = path.join(dir, 'ok-xxe.pdf');
    await fs.writeFile(okPdf, '%PDF-1.4\n%%EOF\n', 'utf8');
    const bigCommentXsd = path.join(dir, 'late-xxe.xsd');
    await fs.writeFile(
      bigCommentXsd,
      `<!-- ${'A'.repeat(70_000)} -->\n<!DOCTYPE xs:schema [<!ENTITY e SYSTEM "file:///etc/passwd">]><xs:schema/>`,
      'utf8',
    );
    await expect(extractSafeXsdBundle(bigCommentXsd, path.join(dir, 'dest-late'))).rejects.toThrow(/DOCTYPE/i);

    const utf16Xsd = path.join(dir, 'utf16.xsd');
    const utf16Body = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('<!DOCTYPE xs:schema><xs:schema/>', 'utf16le'),
    ]);
    await fs.writeFile(utf16Xsd, utf16Body);
    await expect(extractSafeXsdBundle(utf16Xsd, path.join(dir, 'dest-u16'))).rejects.toThrow(/DOCTYPE/i);

    // Link externo na tabela SVRS não aborta o restante e downloadNtArtifacts extrai xsdUrl ZIP
    const mixedHtml = `
      <table><tbody>
        <tr>
          <td>Nota Técnica 2026.500 v1.00</td><td>20/11/2026</td><td>Sem previsão</td><td>-</td>
          <td>
            <a href="https://www.nfe.fazenda.gov.br/portal">Portal Nacional</a>
            <a href="/Nfe/Download/nt500.pdf">PDF</a>
            <a href="/Nfe/Download/PL_500.zip">XSD</a>
          </td>
        </tr>
      </tbody></table>
    `;
    const parsedMixed = parseSvrsHtmlTable(mixedHtml, 'NFe', 'https://dfe-portal.svrs.rs.gov.br/Nfe/Documentos');
    expect(parsedMixed).toHaveLength(1);
    const [ntEntry] = parsedMixed;
    expect(ntEntry?.xsdUrl).toBe('https://dfe-portal.svrs.rs.gov.br/Nfe/Download/PL_500.zip');

    const pdfBytes = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');
    const xsdZipBytes = buildSyntheticZip([
      { name: 'nfe500.xsd', content: '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>' },
    ]);
    if (!ntEntry) {
      throw new Error('NT esperada ausente');
    }
    const downloaded = await downloadNtArtifacts(ntEntry, path.join(dir, 'svrs-dl'), {
      fetchFn: async (input) => {
        const u = String(input);
        return u.endsWith('.zip')
          ? new Response(new Uint8Array(xsdZipBytes), { status: 200 })
          : new Response(new Uint8Array(pdfBytes), { status: 200 });
      },
    });
    expect(downloaded.xsdDir).toBeTruthy();
    if (downloaded.xsdDir) {
      expect(await fs.readFile(path.join(downloaded.xsdDir, 'nfe500.xsd'), 'utf8')).toContain('xs:schema');
    }

    // Falha no importManualNt não deixa arquivos órfãos
    await expect(
      importManualNt(
        {
          dfe: 'NFe',
          ntNumber: '2026.777',
          ntVersion: 'v1.00',
          publishedDate: '2026-11-20',
          pdfSourcePath: okPdf,
          xsdSourcePath: bigCommentXsd,
        },
        path.join(dir, 'atomic-cache'),
        ntcDb,
      ),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(dir, 'atomic-cache', 'svrs', 'NFe', 'manual', '2026.777_v1.00', 'nt.pdf')),
    ).rejects.toThrow();

    // SV-16 Cobertura adicional: schemaLocation externo, UTF-16BE, SHA mismatch, chunked stream overflow, no-URL early return
    const extLocXsd = path.join(dir, 'ext-loc.xsd');
    await fs.writeFile(
      extLocXsd,
      '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:import schemaLocation="https://evil/a.xsd"/></xs:schema>',
      'utf8',
    );
    await expect(extractSafeXsdBundle(extLocXsd, path.join(dir, 'dest-extloc'))).rejects.toThrow(/schemaLocation/i);

    const beBody = Buffer.from('<!DOCTYPE xs:schema><xs:schema/>', 'utf16le');
    beBody.swap16();
    const utf16BeXsd = path.join(dir, 'utf16be.xsd');
    await fs.writeFile(utf16BeXsd, Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]));
    await expect(extractSafeXsdBundle(utf16BeXsd, path.join(dir, 'dest-u16be'))).rejects.toThrow(/DOCTYPE/i);

    const noUrls = await downloadNtArtifacts(
      { ...ntEntry, pdfUrl: null, xsdUrl: null },
      path.join(dir, 'no-urls'),
    );
    expect(noUrls).toEqual({ pdfPath: null, pdfSha256: null, xsdDir: null });

    await expect(
      downloadNtArtifacts(
        { ...ntEntry, xsdUrl: null, pdfSha256: 'c'.repeat(64) },
        path.join(dir, 'sha-mismatch'),
        { fetchFn: async () => new Response(new Uint8Array(pdfBytes), { status: 200 }) },
      ),
    ).rejects.toThrow(/SHA-256/i);

    // Chunked response exceeding maxBytes aborts streaming via reader.cancel()
    const [nfeRepo] = ntcDb.listDfeRepos().filter((r) => r.dfe === 'NFe');
    if (!nfeRepo) {
      throw new Error('NFe ausente');
    }
    const oversizedHtmlRes = await syncDfeFromSvrs(nfeRepo, {
      fetchFn: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(6 * 1024 * 1024));
              controller.enqueue(new Uint8Array(6 * 1024 * 1024));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    });
    expect(oversizedHtmlRes.error).toMatch(/excede o limite/i);
  });

  it('SV-17 analisa layout real de artigos/seções do portal SVRS com download_arquivo_estatico e matching de Schemas', () => {
    const liveStyleHtml = `
      <html><body>
        <table><tbody><tr><td>1°</td><td>SP</td></tr></tbody></table>
        <article class="artigo">
          <header class="artigo__cabecalho"><h1 class="artigo__titulo">Schemas</h1></header>
          <div class="artigo__texto">
            <article class="conteudo-lista__item">
              <header>
                <time class="conteudo-lista__item__datahora" datetime="07/10/2025">07/10/2025</time>
                <h2 class="conteudo-lista__item__titulo">
                  <a href="#" onclick="download_arquivo_estatico('NFE', 2, 'PL_010b_NT2025_002_v1.30.zip');">Pacote de schemas - NT 2025.002 v1.30</a>
                </h2>
              </header>
            </article>
          </div>
        </article>
        <article class="artigo">
          <header class="artigo__cabecalho"><h1 class="artigo__titulo">Notas Técnicas</h1></header>
          <div class="artigo__texto">
            <article class="conteudo-lista__item">
              <header>
                <time class="conteudo-lista__item__datahora" datetime="30/10/2026">30/10/2026</time>
                <h2 class="conteudo-lista__item__titulo">
                  <a href="#" onclick="download_arquivo_estatico('NFE', 3, 'NT_2025.002_v1.30.pdf');">Nota Técnica 2025.002 v1.30 - RTC</a>
                </h2>
              </header>
            </article>
            <article class="conteudo-lista__item">
              <header>
                <time class="conteudo-lista__item__datahora" datetime="20/05/2026">20/05/2026</time>
                <h2 class="conteudo-lista__item__titulo">
                  <a href="#" onclick="download_arquivo_estatico('NFE', 3, 'NT_2026.001_v1.02b.pdf');">Nota Técnica 2026.001 v.1.02b - PAA</a>
                </h2>
              </header>
            </article>
          </div>
        </article>
      </body></html>
    `;

    const entries = parseSvrsHtmlTable(liveStyleHtml, 'NFe', 'https://dfe-portal.svrs.rs.gov.br/Nfe/Documentos');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      dfe: 'NFe',
      ntNumber: '2025.002',
      ntVersion: 'v1.30',
      publishedDate: '2026-10-30',
      pdfUrl: 'https://dfe-portal.svrs.rs.gov.br/NFE/DownloadArquivoEstatico/?sistema=NFE&tipoArquivo=3&nomeArquivo=NT_2025.002_v1.30.pdf',
      xsdUrl: 'https://dfe-portal.svrs.rs.gov.br/NFE/DownloadArquivoEstatico/?sistema=NFE&tipoArquivo=2&nomeArquivo=PL_010b_NT2025_002_v1.30.zip',
    });
    expect(entries[1]).toMatchObject({
      ntNumber: '2026.001',
      ntVersion: 'v1.02b',
      publishedDate: '2026-05-20',
      xsdUrl: null,
    });
  });

  it('SV-18 extrai pacotes ZIP reais com flag de data descriptor (0x08) mantendo bloqueio de entradas criptografadas (0x01)', async () => {
    const { dir } = await makeTempEnv();

    const ddZip = path.join(dir, 'svrs-streaming.zip');
    await fs.writeFile(
      ddZip,
      buildSyntheticZip([
        {
          name: 'PL_CTe/gtve_v4.00.xsd',
          content:
            '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:include schemaLocation="tiposGeralCTe_v4.00.xsd"/></xs:schema>',
          flags: 0x08,
        },
      ]),
    );
    const destDd = path.join(dir, 'dest-dd');
    await extractSafeXsdBundle(ddZip, destDd);
    expect(await fs.readFile(path.join(destDd, 'PL_CTe', 'gtve_v4.00.xsd'), 'utf8')).toContain('xs:include');

    const xincludeXsd = path.join(dir, 'xinclude.xsd');
    await fs.writeFile(
      xincludeXsd,
      '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="file:///etc/passwd"/></xs:schema>',
      'utf8',
    );
    await expect(extractSafeXsdBundle(xincludeXsd, path.join(dir, 'dest-xinc'))).rejects.toThrow(/XInclude/i);

    const encryptedZip = path.join(dir, 'encrypted.zip');
    await fs.writeFile(
      encryptedZip,
      buildSyntheticZip([
        {
          name: 'secret.xsd',
          content: '<xs:schema/>',
          flags: 0x01,
        },
      ]),
    );
    await expect(extractSafeXsdBundle(encryptedZip, path.join(dir, 'dest-enc'))).rejects.toThrow(/criptografadas/i);
  });

  it('SV-19 prioriza Pacote de Liberação (PL_*) completo sobre Schema_Evento_* isolado ao parear NTs SVRS', () => {
    const htmlWithEventFirst = `
      <html><body>
        <article class="artigo">
          <header class="artigo__cabecalho"><h1 class="artigo__titulo">Schemas</h1></header>
          <div class="artigo__texto">
            <article class="conteudo-lista__item">
              <header>
                <time class="conteudo-lista__item__datahora" datetime="23/07/2026">23/07/2026</time>
                <h2 class="conteudo-lista__item__titulo">
                  <a href="#" onclick="download_arquivo_estatico('NFE', 2, 'Schema_Evento_211110_NT2025.002 v1.40.zip');">Evento 211110 - NT 2025.002 v1.40</a>
                </h2>
              </header>
            </article>
            <article class="conteudo-lista__item">
              <header>
                <time class="conteudo-lista__item__datahora" datetime="07/10/2025">07/10/2025</time>
                <h2 class="conteudo-lista__item__titulo">
                  <a href="#" onclick="download_arquivo_estatico('NFE', 2, 'PL_010b_NT2025_002_v1.30.zip');">Pacote de schemas - NT 2025.002 v1.30</a>
                </h2>
              </header>
            </article>
          </div>
        </article>
        <article class="artigo">
          <header class="artigo__cabecalho"><h1 class="artigo__titulo">Notas Técnicas</h1></header>
          <div class="artigo__texto">
            <article class="conteudo-lista__item">
              <header>
                <time class="conteudo-lista__item__datahora" datetime="10/11/2026">10/11/2026</time>
                <h2 class="conteudo-lista__item__titulo">
                  <a href="#" onclick="download_arquivo_estatico('NFE', 3, 'NT_2025.002_v1.53_RTC_NF-e_IBS_CBS_IS.pdf');">Nota Técnica 2025.002 v1.53 - RTC</a>
                </h2>
              </header>
            </article>
            <article class="conteudo-lista__item">
              <header>
                <time class="conteudo-lista__item__datahora" datetime="01/10/2026">01/10/2026</time>
                <h2 class="conteudo-lista__item__titulo">
                  <a href="#" onclick="download_arquivo_estatico('NFE', 3, 'NT_2025.002_v1.40_RTC.pdf');">Nota Técnica 2025.002 v1.40 - RTC</a>
                </h2>
              </header>
            </article>
          </div>
        </article>
      </body></html>
    `;

    const entries = parseSvrsHtmlTable(htmlWithEventFirst, 'NFe', 'https://dfe-portal.svrs.rs.gov.br/Nfe/Documentos');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.xsdUrl).toContain('PL_010b_NT2025_002_v1.30.zip');
    expect(entries[1]?.xsdUrl).toContain('PL_010b_NT2025_002_v1.30.zip');
  });
});
