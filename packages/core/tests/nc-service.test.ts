import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NcDocument } from '../src/domain/types.js';
import {
  buildNcFilePaths,
  checkNcReadiness,
  confirmNoStructuralGaps,
  loadNcDocument,
  renderNcMarkdown,
  saveNcDocument,
  updateNcItemDecision,
} from '../src/nc/nc-service.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ntc-nc-service-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeNc(overrides: Partial<NcDocument> = {}): NcDocument {
  return {
    nc_id: 'NC-2025.002-v1.30',
    nt_ref: {
      dfe: 'NFe',
      nt_number: '2025.002',
      nt_version: '1.30',
      published_date: '2025-10-15',
      pdf_sha256: 'a'.repeat(64),
    },
    base_commit_sha: '1'.repeat(40),
    no_structural_gaps: false,
    summary: 'Adaptação Reforma Tributária',
    semantic_notes: ['Regra W16 valida somatório no autorizador SEFAZ'],
    items: [
      {
        id: 'NC-1',
        category: 'STRUCTURAL_DTO',
        decision: 'APPROVE',
        title: 'Campo vIBSCBS em ICMSTot',
        description: 'Adicionar BigDecimal vIBSCBS em Nfe.java',
        tagPath: 'NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VIBSCBS',
        targetPackage: 'domain',
        targetClass: 'Nfe',
        diffKind: 'MISSING_TAG',
        pdfCitations: ['p. 3'],
        suggestedChange: 'private BigDecimal vIBSCBS;',
        editedNotes: null,
        blockerReason: null,
      },
      {
        id: 'NC-2',
        category: 'SHARED_XML_PARSER_BLOCKER',
        decision: 'APPROVE',
        title: 'Atributo XML em tag raiz exige suporte em xml-parser',
        description: 'Parser compartilhado não expõe atributo novo.',
        tagPath: 'NFEPROC.VERSAO_SCHEMA',
        targetPackage: 'xml-parser',
        targetClass: null,
        diffKind: 'MISSING_TAG',
        pdfCitations: ['p. 5'],
        suggestedChange: null,
        editedNotes: null,
        blockerReason: 'Necessário evoluir lib compartilhada xml-parser antes.',
      },
    ],
    created_at: '2026-11-19T12:00:00.000Z',
    updated_at: '2026-11-19T12:00:00.000Z',
    ...overrides,
  };
}

describe('NC-<NT> Service', () => {
  it('NC-01: saveNcDocument writes atomic .json source-of-truth and one-way .md preview', async () => {
    const dir = createTempDir();
    const nc = makeNc();
    const saved = await saveNcDocument(dir, nc);

    expect(saved.jsonPath.endsWith('NC-2025.002-v1.30.json')).toBe(true);
    expect(saved.markdownPath.endsWith('NC-2025.002-v1.30.md')).toBe(true);

    const reloaded = await loadNcDocument(saved.jsonPath);
    expect(reloaded).toEqual(nc);

    const md = readFileSync(saved.markdownPath, 'utf8');
    expect(md).toContain('# NC-2025.002-v1.30');
    expect(md).toContain('NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VIBSCBS');
    expect(md).toContain('[p. 3]');
    expect(md).toContain('BLOQUEIO SHARED_XML_PARSER_BLOCKER');
  });

  it('NC-02: updateNcItemDecision mutates immutably and unblocks when SHARED_XML_PARSER_BLOCKER is SKIPped', () => {
    const original = makeNc();
    const updated = updateNcItemDecision(
      original,
      'NC-2',
      'SKIP',
      'Descartado após alinhamento com equipe xml-parser',
    );

    expect(original.items[1]?.decision).toBe('APPROVE');
    expect(updated.items[1]?.decision).toBe('SKIP');
    expect(updated.items[1]?.editedNotes).toBe('Descartado após alinhamento com equipe xml-parser');

    const checkBefore = checkNcReadiness(original, '1'.repeat(40), 'a'.repeat(64));
    expect(checkBefore.hasBlocker).toBe(true);
    expect(checkBefore.ready).toBe(false);

    const checkAfter = checkNcReadiness(updated, '1'.repeat(40), 'a'.repeat(64));
    expect(checkAfter.hasBlocker).toBe(false);
    expect(checkAfter.ready).toBe(true);
  });

  it('NC-03: throws when updating an unknown item id or confirming no_structural_gaps on gap-bearing NC', () => {
    const nc = makeNc();
    expect(() => updateNcItemDecision(nc, 'UNKNOWN-99', 'APPROVE')).toThrow(/UNKNOWN-99/);
    expect(() => confirmNoStructuralGaps(nc)).toThrow(/no_structural_gaps/);
  });

  it('NC-04: requires explicit operator confirmation when no_structural_gaps is true', () => {
    const noGapNc = makeNc({
      no_structural_gaps: true,
      items: [],
      confirmed_no_gaps: false,
      confirmed_at: null,
    });

    const beforeConfirm = checkNcReadiness(noGapNc, '1'.repeat(40), 'a'.repeat(64));
    expect(beforeConfirm.needsNoGapConfirmation).toBe(true);
    expect(beforeConfirm.ready).toBe(false);

    const confirmed = confirmNoStructuralGaps(noGapNc);
    expect(confirmed.confirmed_no_gaps).toBe(true);
    expect(confirmed.confirmed_at).toBeTruthy();

    const afterConfirm = checkNcReadiness(confirmed, '1'.repeat(40), 'a'.repeat(64));
    expect(afterConfirm.needsNoGapConfirmation).toBe(false);
    expect(afterConfirm.ready).toBe(true);
  });

  it('NC-05: detects stale base_commit_sha and stale pdf_sha256 forcing re-analysis', () => {
    const nc = makeNc({
      items: [makeNc().items[0]!],
    });

    const staleCommit = checkNcReadiness(nc, '2'.repeat(40), 'a'.repeat(64));
    expect(staleCommit.staleCommit).toBe(true);
    expect(staleCommit.stalePdf).toBe(false);
    expect(staleCommit.ready).toBe(false);

    const stalePdf = checkNcReadiness(nc, '1'.repeat(40), 'b'.repeat(64));
    expect(stalePdf.staleCommit).toBe(false);
    expect(stalePdf.stalePdf).toBe(true);
    expect(stalePdf.ready).toBe(false);
  });

  it('NC-06: buildNcFilePaths sanitizes unsafe characters against path traversal', () => {
    const paths = buildNcFilePaths('/tmp/workspace', '../../etc/2025.002', '1.30/../../x');
    expect(path.dirname(paths.jsonPath)).toBe(path.resolve('/tmp/workspace'));
    expect(path.basename(paths.jsonPath)).not.toContain('..');
    expect(renderNcMarkdown(makeNc({ items: [], no_structural_gaps: true }))).toContain(
      'Sem gaps estruturais',
    );
  });
});
