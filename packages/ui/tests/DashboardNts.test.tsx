import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NtCatalogEntry } from '@ntc/core';
import { DashboardNts } from '../src/pages/DashboardNts.js';
import { makeMockApi } from './mock-api.js';

const SAMPLE_NTS: readonly NtCatalogEntry[] = [
  {
    id: 'NFe:2025.002:1.30',
    dfe: 'NFe',
    ntNumber: '2025.002',
    ntVersion: '1.30',
    publishedDate: '2025-10-15',
    homologDate: '2025-11-01',
    prodDate: '2025-11-10',
    pdfUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/NT2025.pdf',
    xsdUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/XSD.zip',
    pdfSha256: 'a'.repeat(64),
    sourceStatus: 'DOWNLOADED',
    fetchedAt: '2026-11-19T12:00:00.000Z',
  },
  {
    id: 'NFCe:2025.001:1.00',
    dfe: 'NFCe',
    ntNumber: '2025.001',
    ntVersion: '1.00',
    publishedDate: '2025-09-01',
    homologDate: null,
    prodDate: null,
    pdfUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfce/NT2025.pdf',
    xsdUrl: null,
    pdfSha256: null,
    sourceStatus: 'DISCOVERED',
    fetchedAt: '2026-11-19T12:00:00.000Z',
  },
];

describe('DashboardNts (CUJ 1)', () => {
  it('UI-DN-01: loads cached NTs immediately and filters by DFe and text query', async () => {
    const user = userEvent.setup();
    const api = makeMockApi({
      listNts: vi.fn(async () => [...SAMPLE_NTS]),
    });

    render(
      <DashboardNts
        api={api}
        byokConfig={{ provider: 'gemini', modelId: 'gemini-2.5-pro', operatorName: 'Op', secretKeyRef: 'ntc:llm:gemini' }}
        onDraftReady={() => undefined}
      />,
    );

    expect(await screen.findByText('2025.002')).toBeInTheDocument();
    expect(screen.getByText('2025.001')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/Filtrar por DFe/i), 'NFCe');
    expect(screen.queryByText('2025.002')).not.toBeInTheDocument();
    expect(screen.getByText('2025.001')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/Filtrar por DFe/i), 'ALL');
    await user.type(screen.getByLabelText(/Buscar NT/i), '2025.002');
    expect(screen.getByText('2025.002')).toBeInTheDocument();
    expect(screen.queryByText('2025.001')).not.toBeInTheDocument();
  });

  it('UI-DN-02: isolates per-DFe SVRS sync errors and imports manual PDF+XSD pair cleanly', async () => {
    const user = userEvent.setup();
    const importManualNt = vi.fn(async (req) => ({
      entry: {
        id: `${req.dfe}:${req.ntNumber}:${req.ntVersion}`,
        dfe: req.dfe,
        ntNumber: req.ntNumber,
        ntVersion: req.ntVersion,
        publishedDate: '2026-11-19',
        homologDate: null,
        prodDate: null,
        pdfUrl: null,
        xsdUrl: null,
        pdfSha256: 'b'.repeat(64),
        sourceStatus: 'MANUAL' as const,
        fetchedAt: '2026-11-19T12:00:00.000Z',
      },
      xsdDir: '/tmp/cache/xsd',
    }));

    const api = makeMockApi({
      listNts: vi.fn(async () => [...SAMPLE_NTS]),
      syncSvrs: vi.fn(async () => [
        { dfe: 'NFe' as const, entries: [...SAMPLE_NTS], groups: [], error: null },
        { dfe: 'CTe' as const, entries: [], groups: [], error: 'HTTP 503 no portal SVRS' },
      ]),
      importManualNt,
    });

    render(
      <DashboardNts
        api={api}
        byokConfig={{ provider: 'gemini', modelId: 'gemini-2.5-pro', operatorName: 'Op', secretKeyRef: 'ntc:llm:gemini' }}
        onDraftReady={() => undefined}
      />,
    );

    await user.click(await screen.findByRole('button', { name: /Sincronizar SVRS/i }));
    expect(await screen.findByText(/CTe: HTTP 503/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Importar NT Manual/i }));
    await user.type(screen.getByLabelText(/Número NT/i), '2026.001');
    await user.type(screen.getByLabelText(/Versão NT/i), '1.00');
    await user.type(screen.getByLabelText(/Data Publicação/i), '19/11/2026');
    await user.type(screen.getByLabelText(/Caminho PDF/i), '/tmp/nt.pdf');
    await user.type(screen.getByLabelText(/Caminho XSD/i), '/tmp/xsd.zip');
    await user.click(screen.getByRole('button', { name: /Confirmar Importação/i }));

    expect(importManualNt).toHaveBeenCalledWith(
      expect.objectContaining({
        ntNumber: '2026.001',
        ntVersion: '1.00',
        pdfSourcePath: '/tmp/nt.pdf',
        xsdSourcePath: '/tmp/xsd.zip',
      }),
    );
  });

  it('UI-DN-03: triggers checkCompliance for selected NT and forwards draft to parent', async () => {
    const user = userEvent.setup();
    const onDraftReady = vi.fn();
    const checkCompliance = vi.fn(async () => ({
      run: {
        runId: 'run-new-1',
        dfe: 'NFe' as const,
        ntId: 'NFe:2025.002:1.30',
        status: 'DRAFT' as const,
        failedStep: null,
        errorMessage: null,
        operatorName: 'Op',
        provider: 'gemini' as const,
        modelId: 'gemini-2.5-pro',
        baseCommitSha: '1'.repeat(40),
        branchName: null,
        ncJsonPath: 'NFe/NC-2025.002-v1.30.json',
        prUrl: null,
        tokenUsage: null,
        createdAt: '2026-11-19T12:00:00.000Z',
        updatedAt: '2026-11-19T12:00:00.000Z',
      },
      nc: {
        nc_id: 'NC-1',
        nt_ref: { dfe: 'NFe' as const, nt_number: '2025.002', nt_version: '1.30', published_date: '2025-10-15', pdf_sha256: 'a'.repeat(64) },
        base_commit_sha: '1'.repeat(40),
        no_structural_gaps: false,
        items: [],
        created_at: '2026-11-19T12:00:00.000Z',
        updated_at: '2026-11-19T12:00:00.000Z',
      },
      xsdDir: '/tmp/cache/xsd',
    }));

    const api = makeMockApi({
      listNts: vi.fn(async () => [SAMPLE_NTS[0]!]),
      checkCompliance,
    });

    render(
      <DashboardNts
        api={api}
        byokConfig={{ provider: 'gemini', modelId: 'gemini-2.5-pro', operatorName: 'Op', secretKeyRef: 'ntc:llm:gemini' }}
        onDraftReady={onDraftReady}
      />,
    );

    await user.click(await screen.findByRole('button', { name: /Verificar conformidade/i }));
    expect(checkCompliance).toHaveBeenCalledTimes(1);
    expect(onDraftReady).toHaveBeenCalledWith('run-new-1', '/tmp/cache/xsd');
  });

  it('UI-DN-04: opens DRAFT runs in NcReview and TESTED runs in DiffAndPr', async () => {
    const user = userEvent.setup();
    const onDraftReady = vi.fn();
    const onOpenRunDiff = vi.fn();
    const baseRun = {
      dfe: 'NFe' as const,
      ntId: 'NFe:2025.002:1.30',
      failedStep: null,
      errorMessage: null,
      operatorName: 'Op',
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-pro',
      baseCommitSha: '1'.repeat(40),
      branchName: null,
      ncJsonPath: 'NFe/NC.json',
      prUrl: null,
      tokenUsage: null,
      createdAt: '2026-11-19T12:00:00.000Z',
      updatedAt: '2026-11-19T12:00:00.000Z',
    };

    const api = makeMockApi({
      listNts: vi.fn(async () => [{ ...SAMPLE_NTS[0]!, sourceStatus: 'PARSE_ERROR' as const }]),
      listRuns: vi.fn(async () => [
        { ...baseRun, runId: 'run-draft', status: 'DRAFT' as const },
        { ...baseRun, runId: 'run-tested', status: 'TESTED' as const },
      ]),
    });

    render(
      <DashboardNts
        api={api}
        byokConfig={{ provider: 'gemini', modelId: 'gemini-2.5-pro', operatorName: 'Op', secretKeyRef: 'ntc:llm:gemini' }}
        onDraftReady={onDraftReady}
        onOpenRunDiff={onOpenRunDiff}
      />,
    );

    const openButtons = await screen.findAllByRole('button', { name: /Abrir/i });
    await user.click(openButtons[0]!);
    expect(onDraftReady).toHaveBeenCalledWith('run-draft', '');

    await user.click(openButtons[1]!);
    expect(onOpenRunDiff).toHaveBeenCalledWith('run-tested');
  });
});
