import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { makeMockApi } from './mock-api.js';

describe('App Shell & Typed IPC Client', () => {
  it('UI-01: renders all 5 primary navigation views and switches tabs interactively', async () => {
    const user = userEvent.setup();
    const api = makeMockApi();

    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: /Notas Técnicas/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Repositórios/i }));
    expect(await screen.findByRole('heading', { name: /Registro de Repositórios/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Revisão NC/i }));
    expect(await screen.findByRole('heading', { name: /Revisão de NC/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Diff & PR/i }));
    expect(await screen.findByRole('heading', { name: /Conferência de Diff e PR/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /BYOK & Doctor/i }));
    expect(await screen.findByRole('heading', { name: /BYOK, Segredos e Doctor/i })).toBeInTheDocument();
  });

  it('UI-03: lifts applyNc execution so rejections during tab transition still surface in DiffAndPr', async () => {
    const user = userEvent.setup();
    const api = makeMockApi({
      checkCompliance: vi.fn(async () => ({
        run: {
          runId: 'run-lift-1',
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
          ncJsonPath: 'NFe/NC.json',
          prUrl: null,
          tokenUsage: null,
          createdAt: '2026-11-19T12:00:00.000Z',
          updatedAt: '2026-11-19T12:00:00.000Z',
        },
        nc: {
          nc_id: 'NC-1',
          nt_ref: {
            dfe: 'NFe' as const,
            nt_number: '2025.002',
            nt_version: '1.30',
            published_date: '2025-10-15',
            pdf_sha256: 'a'.repeat(64),
          },
          base_commit_sha: '1'.repeat(40),
          no_structural_gaps: false,
          items: [],
          created_at: '2026-11-19T12:00:00.000Z',
          updated_at: '2026-11-19T12:00:00.000Z',
        },
        xsdDir: '/tmp/xsd',
      })),
      listNts: vi.fn(async () => [
        {
          id: 'NFe:2025.002:1.30',
          dfe: 'NFe' as const,
          ntNumber: '2025.002',
          ntVersion: '1.30',
          publishedDate: '2025-10-15',
          homologDate: null,
          prodDate: null,
          pdfUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/NT.pdf',
          xsdUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/XSD.zip',
          pdfSha256: 'a'.repeat(64),
          sourceStatus: 'DOWNLOADED' as const,
          fetchedAt: '2026-11-19T12:00:00.000Z',
        },
      ]),
      getNc: vi.fn(async () => ({
        run: {
          runId: 'run-lift-1',
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
          ncJsonPath: 'NFe/NC.json',
          prUrl: null,
          tokenUsage: null,
          createdAt: '2026-11-19T12:00:00.000Z',
          updatedAt: '2026-11-19T12:00:00.000Z',
        },
        nc: {
          nc_id: 'NC-1',
          nt_ref: {
            dfe: 'NFe' as const,
            nt_number: '2025.002',
            nt_version: '1.30',
            published_date: '2025-10-15',
            pdf_sha256: 'a'.repeat(64),
          },
          base_commit_sha: '1'.repeat(40),
          no_structural_gaps: false,
          items: [],
          created_at: '2026-11-19T12:00:00.000Z',
          updated_at: '2026-11-19T12:00:00.000Z',
        },
        markdown: '# NC-1',
      })),
      saveNc: vi.fn(async ({ nc }) => ({
        run: {
          runId: 'run-lift-1',
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
          ncJsonPath: 'NFe/NC.json',
          prUrl: null,
          tokenUsage: null,
          createdAt: '2026-11-19T12:00:00.000Z',
          updatedAt: '2026-11-19T12:00:00.000Z',
        },
        nc,
        markdown: '# NC-1',
      })),
      applyNc: vi.fn(async () => {
        throw new Error('RepoLock ocupado para NFe');
      }),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: /^NFe\b/i }));
    await user.click(await screen.findByRole('button', { name: /Verificar conformidade/i }));
    await user.click(await screen.findByRole('button', { name: /Aplicar NC ao parser/i }));

    expect(await screen.findByRole('heading', { name: /Conferência de Diff e PR/i })).toBeInTheDocument();
    expect(await screen.findByText(/RepoLock ocupado para NFe/i)).toBeInTheDocument();
  });

  it('UI-02: subscribes to ntc:run-progress on mount and unsubscribes on unmount', async () => {
    const unsubscribe = vi.fn();
    const onRunProgress = vi.fn(() => unsubscribe);
    const api = makeMockApi({ onRunProgress });

    const { unmount } = render(<App api={api} />);
    expect(onRunProgress).toHaveBeenCalledTimes(1);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('UI-04: returns cleanly to the grouped home screen from DFe drill-down, secondary tabs, and completed runs', async () => {
    const user = userEvent.setup();
    const baseRun = {
      runId: 'run-home-1',
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
      ncJsonPath: 'NFe/NC.json',
      prUrl: null,
      tokenUsage: null,
      createdAt: '2026-11-19T12:00:00.000Z',
      updatedAt: '2026-11-19T12:00:00.000Z',
    };
    const baseNc = {
      nc_id: 'NC-1',
      nt_ref: {
        dfe: 'NFe' as const,
        nt_number: '2025.002',
        nt_version: '1.30',
        published_date: '2025-10-15',
        pdf_sha256: 'a'.repeat(64),
      },
      base_commit_sha: '1'.repeat(40),
      no_structural_gaps: false,
      items: [],
      created_at: '2026-11-19T12:00:00.000Z',
      updated_at: '2026-11-19T12:00:00.000Z',
    };

    const api = makeMockApi({
      listNts: vi.fn(async () => [
        {
          id: 'NFe:2025.002:1.30',
          dfe: 'NFe' as const,
          ntNumber: '2025.002',
          ntVersion: '1.30',
          publishedDate: '2025-10-15',
          homologDate: null,
          prodDate: null,
          pdfUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/NT.pdf',
          xsdUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/XSD.zip',
          pdfSha256: 'a'.repeat(64),
          sourceStatus: 'DOWNLOADED' as const,
          fetchedAt: '2026-11-19T12:00:00.000Z',
        },
      ]),
      checkCompliance: vi.fn(async () => ({
        run: baseRun,
        nc: baseNc,
        xsdDir: '/tmp/xsd',
      })),
      getNc: vi.fn(async () => ({
        run: baseRun,
        nc: baseNc,
        markdown: '# NC-1',
      })),
      saveNc: vi.fn(async ({ nc }) => ({
        run: baseRun,
        nc,
        markdown: '# NC-1',
      })),
      applyNc: vi.fn(async () => ({
        run: {
          ...baseRun,
          status: 'PR_OPENED' as const,
          branchName: 'nc/nfe-nt-2025.002-v1.30',
          prUrl: 'https://gitea.local/pr/1',
        },
        patchFilePath: '/tmp/run-home-1.patch',
        prUrl: 'https://gitea.local/pr/1',
        mavenResult: {
          passed: true,
          classification: 'PASSED' as const,
          summary: 'BUILD SUCCESS',
          failedTestClasses: [],
          sanitizedLog: 'BUILD SUCCESS',
          surefireSummary: { total: 1, errors: 0, failures: 0, skipped: 0, failedClasses: [] },
        },
      })),
    });

    render(<App api={api} />);
    expect(screen.queryByRole('button', { name: 'Tela Inicial' })).not.toBeInTheDocument();

    // 1) Drill into NFe card, then click "Voltar à Tela Inicial" and also "Notas Técnicas" tab to reset to grouped DFe view
    await user.click(await screen.findByRole('button', { name: /^NFe\b/i }));
    expect(await screen.findByRole('heading', { name: /Notas Técnicas — NFe/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Voltar à Tela Inicial' }));
    expect(await screen.findByRole('heading', { name: /Notas Técnicas por Documento Fiscal/i })).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /^NFe\b/i }));
    expect(await screen.findByRole('heading', { name: /Notas Técnicas — NFe/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Notas Técnicas' }));
    expect(await screen.findByRole('heading', { name: /Notas Técnicas por Documento Fiscal/i })).toBeInTheDocument();

    // 2) Navigate to Repositórios and return via "Voltar à Tela Inicial"
    await user.click(screen.getByRole('button', { name: /Repositórios/i }));
    expect(await screen.findByRole('heading', { name: /Registro de Repositórios/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Voltar à Tela Inicial' }));
    expect(await screen.findByRole('heading', { name: /Notas Técnicas por Documento Fiscal/i })).toBeInTheDocument();

    // 3) Run compliance check -> apply NC -> return from completion banner
    await user.click(await screen.findByRole('button', { name: /^NFe\b/i }));
    await user.click(await screen.findByRole('button', { name: /Verificar conformidade/i }));
    await user.click(await screen.findByRole('button', { name: /Aplicar NC ao parser/i }));
    await user.click(await screen.findByRole('button', { name: 'Concluir e voltar à Tela Inicial' }));
    expect(await screen.findByRole('heading', { name: /Notas Técnicas por Documento Fiscal/i })).toBeInTheDocument();
  });
});
