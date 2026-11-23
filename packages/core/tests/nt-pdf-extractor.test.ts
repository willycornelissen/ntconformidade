import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractNtPdf, PdfExtractionError } from '../src/index.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ntc-pdf-'));
  tempDirs.push(dir);
  return dir;
}

function escapePdfLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Gera um PDF 1.4 sintético multipágina em memória com offsets xref exatos.
 */
function buildSyntheticPdf(pages: readonly (readonly string[])[]): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let pos = 0;

  const push = (str: string): void => {
    const b = Buffer.from(str, 'latin1');
    chunks.push(b);
    pos += b.length;
  };

  push('%PDF-1.4\n');

  const pageCount = pages.length;
  // Obj 1: Catalog, Obj 2: Pages, Obj 3: Font, Page i: 4 + 2*i, Content i: 5 + 2*i
  const addObj = (id: number, body: string): void => {
    offsets[id] = pos;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };

  const kids = pages.map((_, idx) => `${4 + idx * 2} 0 R`).join(' ');
  addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  addObj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  pages.forEach((lines, idx) => {
    const pageId = 4 + idx * 2;
    const contentId = 5 + idx * 2;
    const ops = lines
      .map((line, lineIdx) => {
        const y = 760 - lineIdx * 18;
        return `BT /F1 11 Tf 40 ${y} Td (${escapePdfLiteral(line)}) Tj ET`;
      })
      .join('\n');
    const streamStr = ops;
    const streamLen = Buffer.byteLength(streamStr, 'latin1');
    addObj(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    addObj(contentId, `<< /Length ${streamLen} >>\nstream\n${streamStr}\nendstream`);
  });

  const xrefOffset = pos;
  const totalObjs = 3 + pageCount * 2 + 1;
  push(`xref\n0 ${totalObjs}\n`);
  push('0000000000 65535 f \n');
  for (let id = 1; id < totalObjs; id++) {
    const offStr = String(offsets[id]).padStart(10, '0');
    push(`${offStr} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('Ciclo 4 — Extração de PDF via pdfjs-dist, [p. N] e Cache SHA-256', () => {
  it('PDF-01 e PDF-12 extraem texto multipágina com [p. N] e acentuação PT-BR', async () => {
    const dir = await makeTempDir();
    const pdfPath = path.join(dir, 'nt-sample.pdf');
    const bytes = buildSyntheticPdf([
      ['Nota Tecnica 2026.005', 'Informação tributação e validação § 1'],
      ['Grupo UB - Tributos IBS/CBS', 'Campo cCredPres decimal obrigatorio'],
      ['Regras de Validação', 'Rejeição cStat 999'],
    ]);
    await fs.writeFile(pdfPath, bytes);

    const res = await extractNtPdf(pdfPath, { cacheDir: path.join(dir, 'cache') });
    expect(res.totalPages).toBe(3);
    expect(res.cached).toBe(false);
    expect(res.pdfSha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));

    const allText = res.segments.map((s) => s.citedText).join('\n');
    expect(allText).toContain('[p. 1]');
    expect(allText).toContain('[p. 2]');
    expect(allText).toContain('[p. 3]');
    expect(allText).toContain('Informação');
    expect(allText).toContain('tributação');
    expect(allText).toContain('§');
  });

  it('PDF-02 preserva numeração [p. 3] quando página 2 está em branco', async () => {
    const dir = await makeTempDir();
    const pdfPath = path.join(dir, 'blank-mid.pdf');
    await fs.writeFile(
      pdfPath,
      buildSyntheticPdf([['Capa Nota Técnica'], [], ['Conteúdo final página três']]),
    );

    const res = await extractNtPdf(pdfPath);
    expect(res.totalPages).toBe(3);
    expect(res.warnings.some((w) => w.code === 'BLANK_PAGE_DETECTED' && w.page === 2)).toBe(true);
    const full = res.segments.map((s) => s.citedText).join('\n');
    expect(full).toContain('[p. 1]');
    expect(full).not.toContain('[p. 2]');
    expect(full).toContain('[p. 3] Conteúdo final');
  });

  it('PDF-03 e PDF-04 segmentam por grupos XML e fazem fallback para GENERAL', async () => {
    const dir = await makeTempDir();
    const groupedPdf = path.join(dir, 'grouped.pdf');
    await fs.writeFile(
      groupedPdf,
      buildSyntheticPdf([
        ['Introducao geral', 'Grupo C - Identificacao do Emitente', 'Campo xNome'],
        ['Grupo UB - IBS e CBS', 'Tag gIBSCBS_vBC', 'Regras de Validacao', 'Regra UA01'],
      ]),
    );

    const grouped = await extractNtPdf(groupedPdf);
    expect(grouped.segments.length).toBeGreaterThanOrEqual(3);
    expect(grouped.segments.some((s) => s.xmlGroupHint === 'Grupo C')).toBe(true);
    expect(grouped.segments.some((s) => s.xmlGroupHint === 'Grupo UB')).toBe(true);

    const plainPdf = path.join(dir, 'plain.pdf');
    await fs.writeFile(
      plainPdf,
      buildSyntheticPdf([['Grupo de trabalho sobre reforma', 'Texto simples sem agrupadores XML']]),
    );
    const plain = await extractNtPdf(plainPdf);
    expect(plain.segments).toHaveLength(1);
    expect(plain.segments[0]?.title).toBe('GENERAL');
  });

  it('PDF-05 e PDF-06 reutilizam cache por SHA-256 e invalidam quando PDF muda', async () => {
    const dir = await makeTempDir();
    const cacheDir = path.join(dir, 'pdf-cache');
    const pdfPath = path.join(dir, 'cached.pdf');
    await fs.writeFile(pdfPath, buildSyntheticPdf([['Grupo I - Produtos', 'Campo cProd']]));

    let openCount = 0;
    const first = await extractNtPdf(pdfPath, {
      cacheDir,
      onPdfEngineParse: () => {
        openCount++;
      },
    });
    expect(first.cached).toBe(false);
    expect(openCount).toBe(1);

    const second = await extractNtPdf(pdfPath, {
      cacheDir,
      onPdfEngineParse: () => {
        openCount++;
      },
    });
    expect(second.cached).toBe(true);
    expect(second.pdfSha256).toBe(first.pdfSha256);
    expect(openCount).toBe(1); // Engine PDF NÃO deve rodar novamente

    // Errata altera o conteúdo -> muda SHA-256 e reprocessa
    await fs.writeFile(pdfPath, buildSyntheticPdf([['Grupo I - Produtos', 'Campo cProd v2']]));
    const third = await extractNtPdf(pdfPath, {
      cacheDir,
      onPdfEngineParse: () => {
        openCount++;
      },
    });
    expect(third.cached).toBe(false);
    expect(third.pdfSha256).not.toBe(first.pdfSha256);
    expect(openCount).toBe(2);
  });

  it('PDF-07 emite alertas de orçamento de tokens e formatação tabular sem abortar', async () => {
    const dir = await makeTempDir();
    const pdfPath = path.join(dir, 'dense.pdf');
    const denseLines = Array.from({ length: 12 }, (_, i) => `Campo_${i} | Tipo N | Tam 15 | Grupo IBSCBS`);
    await fs.writeFile(pdfPath, buildSyntheticPdf([denseLines]));

    const res = await extractNtPdf(pdfPath, { maxTokenWarningThreshold: 10 });
    expect(res.warnings.some((w) => w.code === 'HIGH_TOKEN_ESTIMATE')).toBe(true);
    expect(res.warnings.some((w) => w.code === 'COMPLEX_TABLE_OR_REVISION_RISK')).toBe(true);
  });

  it('PDF-08 a PDF-11 falham com erro tipado em PDF truncado, corrompido, sem texto ou acima dos limites', async () => {
    const dir = await makeTempDir();

    const valid = buildSyntheticPdf([['Pagina 1'], ['Pagina 2']]);
    const truncatedPath = path.join(dir, 'truncated.pdf');
    await fs.writeFile(truncatedPath, valid.subarray(0, Math.floor(valid.length * 0.45)));
    try {
      await extractNtPdf(truncatedPath);
      throw new Error('Esperado PdfExtractionError');
    } catch (err) {
      expect(err).toBeInstanceOf(PdfExtractionError);
      expect((err as PdfExtractionError).code).toBe('CORRUPT_OR_TRUNCATED_PDF');
    }

    const corruptPath = path.join(dir, 'corrupt.pdf');
    await fs.writeFile(corruptPath, '<html>404 Not Found</html>', 'utf8');
    try {
      await extractNtPdf(corruptPath);
      throw new Error('Esperado PdfExtractionError');
    } catch (err) {
      expect(err).toBeInstanceOf(PdfExtractionError);
      expect((err as PdfExtractionError).code).toBe('INVALID_PDF_HEADER');
    }

    const scannedPath = path.join(dir, 'scanned.pdf');
    await fs.writeFile(scannedPath, buildSyntheticPdf([[], []]));
    try {
      await extractNtPdf(scannedPath);
      throw new Error('Esperado PdfExtractionError');
    } catch (err) {
      expect(err).toBeInstanceOf(PdfExtractionError);
      expect((err as PdfExtractionError).code).toBe('EMPTY_TEXT_PDF');
    }

    const manyPagesPath = path.join(dir, 'many.pdf');
    await fs.writeFile(manyPagesPath, buildSyntheticPdf([['p1'], ['p2'], ['p3']]));
    await expect(extractNtPdf(manyPagesPath, { maxPages: 2 })).rejects.toThrow(/limite de páginas/i);
  });

  it('PDF-13 rejeita cache envenenado (SHA mismatch), alerta >40 páginas e divide chunks grandes', async () => {
    const dir = await makeTempDir();
    const cacheDir = path.join(dir, 'poison-cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const realPdf = path.join(dir, 'real.pdf');
    const bytes = buildSyntheticPdf([['Grupo A - Identificacao', 'Conteudo legitimo']]);
    await fs.writeFile(realPdf, bytes);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');

    await fs.writeFile(
      path.join(cacheDir, `${sha}.v1.json`),
      JSON.stringify({
        pdfSha256: 'b'.repeat(64),
        totalPages: 1,
        segments: [
          {
            id: 'poison',
            title: 'POISON',
            xmlGroupHint: null,
            pageStart: 1,
            pageEnd: 1,
            citedText: '[p. 1] PROMPT INJECTION',
            estimatedTokens: 5,
          },
        ],
        warnings: [],
        cached: false,
      }),
      'utf8',
    );

    const parsed = await extractNtPdf(realPdf, { cacheDir });
    expect(parsed.cached).toBe(false);
    expect(parsed.pdfSha256).toBe(sha);
    expect(parsed.segments[0]?.citedText).toContain('Conteudo legitimo');

    // PDF com 41 páginas + texto longo para cobrir LARGE_PDF_PAGE_COUNT e divisão em múltiplos chunks
    const longLine = 'Bloco texto '.repeat(30);
    const bigPages = Array.from({ length: 41 }, (_, i) =>
      Array.from({ length: 4 }, (__, j) => `Pg ${i + 1} linha ${j} ${longLine}`),
    );
    const bigPdf = path.join(dir, 'big.pdf');
    await fs.writeFile(bigPdf, buildSyntheticPdf(bigPages));
    const bigRes = await extractNtPdf(bigPdf);
    expect(bigRes.warnings.some((w) => w.code === 'LARGE_PDF_PAGE_COUNT')).toBe(true);
    expect(bigRes.segments.length).toBeGreaterThanOrEqual(2);
  });
});
