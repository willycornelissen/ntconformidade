import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NtCatalogEntry } from '@ntc/core';
import { DashboardNts } from '../src/pages/DashboardNts.js';
import { makeMockApi } from './mock-api.js';

const SAMPLE_NTS: readonly NtCatalogEntry[] = [
  {
    id: 'NFe:2024.001:1.00',
    dfe: 'NFe',
    ntNumber: '2024.001',
    ntVersion: '1.00',
    publishedDate: '2024-08-01',
    homologDate: null,
    prodDate: null,
    pdfUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/NT2024.pdf',
    xsdUrl: null,
    pdfSha256: null,
    sourceStatus: 'DISCOVERED',
    fetchedAt: '2026-11-19T12:00:00.000Z',
  },
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
  it('UI-DN-01: displays NTs grouped by DFe on home screen, drills into NT list on click, and supports filtering and back navigation', async () => {
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

    const nfeCard = await screen.findByRole('button', { name: /^NFe\b/i });
    const nfceCard = screen.getByRole('button', { name: /^NFCe\b/i });
    expect(nfeCard).toHaveTextContent('2 NTs');
    expect(nfeCard).toHaveTextContent(/2025\.002/);
    expect(nfeCard).toHaveTextContent(/15\/10\/2025/);
    expect(nfceCard).toHaveTextContent('1 NT');
    expect(screen.queryByRole('button', { name: /Verificar conformidade/i })).not.toBeInTheDocument();

    // Filter card list by query before drilling in
    await user.type(screen.getByLabelText(/Filtrar DFe ou NT/i), 'NFCe');
    expect(screen.queryByRole('button', { name: /^NFe\b/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^NFCe\b/i })).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/Filtrar DFe ou NT/i));
    await user.click(screen.getByRole('button', { name: /^NFe\b/i }));

    expect(await screen.findByRole('heading', { name: /Notas Técnicas — NFe/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Status$/i })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Status Fonte/i })).not.toBeInTheDocument();
    expect(screen.getByText('2025.002')).toBeInTheDocument();
    expect(screen.getByText('2024.001')).toBeInTheDocument();
    expect(screen.getByText('15/10/2025')).toBeInTheDocument();
    expect(screen.getByText('01/08/2024')).toBeInTheDocument();
    expect(screen.queryByText('2025-10-15')).not.toBeInTheDocument();
    expect(screen.queryByText('2025.001')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Verificar conformidade/i })).toHaveLength(2);

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('2025.002');
    expect(rows[1]).toHaveTextContent('2024.001');
    expect(rows[1]).toHaveTextContent('Publicada');
    expect(rows[1]).not.toHaveTextContent('DISCOVERED');

    await user.type(screen.getByLabelText(/Buscar NT/i), '2025.002');
    expect(screen.getByText('2025.002')).toBeInTheDocument();
    expect(screen.queryByText('2024.001')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Voltar à Tela Inicial' }));
    expect(await screen.findByRole('heading', { name: /Notas Técnicas por Documento Fiscal/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^NFCe\b/i })).toBeInTheDocument();
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

  it('UI-DN-03: triggers checkCompliance after selecting a DFe card and forwards draft to parent', async () => {
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

    await user.click(await screen.findByRole('button', { name: /^NFe\b/i }));
    await user.click(await screen.findByRole('button', { name: /Verificar conformidade/i }));
    expect(checkCompliance).toHaveBeenCalledTimes(1);
    expect(onDraftReady).toHaveBeenCalledWith('run-new-1', '/tmp/cache/xsd');
  });

  it('UI-DN-04: renders the DFe logo on the home screen without summary stat boxes or the Execuções Recentes table', async () => {
    const baseRun = {
      dfe: 'NFe' as const,
      ntId: 'NFe:2025.002:1.30',
      failedStep: null,
      errorMessage: null,
      operatorName: 'Op',
      provider: 'gemini' as const,
      modelId: 'gemini-3.1-pro-preview',
      baseCommitSha: '1'.repeat(40),
      branchName: null,
      ncJsonPath: 'NFe/NC.json',
      prUrl: null,
      tokenUsage: null,
      createdAt: '2026-11-19T12:00:00.000Z',
      updatedAt: '2026-11-19T12:00:00.000Z',
    };

    const api = makeMockApi({
      listNts: vi.fn(async () => [...SAMPLE_NTS]),
      listRuns: vi.fn(async () => [
        { ...baseRun, runId: 'run-draft', status: 'DRAFT' as const },
        { ...baseRun, runId: 'run-tested', status: 'TESTED' as const },
      ]),
    });

    render(
      <DashboardNts
        api={api}
        byokConfig={{ provider: 'gemini', modelId: 'gemini-3.1-pro-preview', operatorName: 'Op', secretKeyRef: 'ntc:llm:gemini' }}
        onDraftReady={() => undefined}
      />,
    );

    expect(
      await screen.findByRole('img', { name: /DFe — Documento Fiscal Eletrônico/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Documentos DF-e')).not.toBeInTheDocument();
    expect(screen.queryByText('NTs em cache')).not.toBeInTheDocument();
    expect(screen.queryByText('NTs verificadas')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Execuções Recentes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Abrir$/i })).not.toBeInTheDocument();
    const nfeCard = screen.getByRole('button', { name: /^NFe\b/i });
    expect(nfeCard).toHaveTextContent('1 verificada');
  });

  it('UI-DN-05: shows "Verificada" and "Revisar NC" when an NC already exists for an NT and opens the latest NC without re-running checkCompliance', async () => {
    const user = userEvent.setup();
    const onDraftReady = vi.fn();
    const checkCompliance = vi.fn();
    const baseRun = {
      dfe: 'NFe' as const,
      failedStep: null,
      errorMessage: null,
      operatorName: 'Op',
      provider: 'gemini' as const,
      modelId: 'gemini-2.5-pro',
      baseCommitSha: '1'.repeat(40),
      branchName: null,
      prUrl: null,
      tokenUsage: null,
    };

    const api = makeMockApi({
      listNts: vi.fn(async () => [SAMPLE_NTS[0]!, SAMPLE_NTS[1]!]),
      listRuns: vi.fn(async () => [
        {
          ...baseRun,
          runId: 'run-old-nc',
          ntId: 'NFe:2025.002:1.30',
          status: 'PR_OPENED' as const,
          ncJsonPath: 'NFe/NC-2025.002-v1.30.json',
          prUrl: 'https://gitea.local/pr/1',
          createdAt: '2026-11-18T10:00:00.000Z',
          updatedAt: '2026-11-18T10:00:00.000Z',
        },
        {
          ...baseRun,
          runId: 'run-latest-nc',
          ntId: 'NFe:2025.002:1.30',
          status: 'FAILED' as const,
          failedStep: 'MAVEN_TEST' as const,
          errorMessage: 'Build error',
          ncJsonPath: 'NFe/NC-2025.002-v1.30.json',
          createdAt: '2026-11-19T12:00:00.000Z',
          updatedAt: '2026-11-19T12:05:00.000Z',
        },
        {
          ...baseRun,
          runId: 'run-failed-no-nc',
          ntId: 'NFe:2024.001:1.00',
          status: 'FAILED' as const,
          failedStep: 'PDF_EXTRACT' as const,
          errorMessage: 'Corrupt PDF',
          ncJsonPath: null,
          createdAt: '2026-11-19T11:00:00.000Z',
          updatedAt: '2026-11-19T11:00:00.000Z',
        },
      ]),
      checkCompliance,
    });

    render(
      <DashboardNts
        api={api}
        byokConfig={{ provider: 'gemini', modelId: 'gemini-2.5-pro', operatorName: 'Op', secretKeyRef: 'ntc:llm:gemini' }}
        onDraftReady={onDraftReady}
      />,
    );

    await user.click(await screen.findByRole('button', { name: /^NFe\b/i }));

    const rows = screen.getAllByRole('row');
    const row2025 = rows.find((r) => r.textContent?.includes('2025.002'));
    const row2024 = rows.find((r) => r.textContent?.includes('2024.001'));
    expect(row2025).toHaveTextContent('Verificada');
    expect(row2025).not.toHaveTextContent('DOWNLOADED');
    expect(row2024).toHaveTextContent('Publicada');
    expect(row2024).not.toHaveTextContent('DISCOVERED');
    expect(row2024).not.toHaveTextContent('Verificada');

    const reviewButtons = screen.getAllByRole('button', { name: /^Revisar NC$/i });
    expect(reviewButtons).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Verificar conformidade/i })).toHaveLength(1);

    await user.click(reviewButtons[0]!);
    expect(onDraftReady).toHaveBeenCalledWith('run-latest-nc', '');
    expect(checkCompliance).not.toHaveBeenCalled();
  });
});
