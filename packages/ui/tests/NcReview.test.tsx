import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NcDocument } from '@ntc/core';
import { NcReview } from '../src/pages/NcReview.js';
import { makeMockApi } from './mock-api.js';

function makeNc(withBlocker: boolean, noGaps = false): NcDocument {
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
    no_structural_gaps: noGaps,
    confirmed_no_gaps: false,
    items: noGaps
      ? []
      : [
          {
            id: 'NC-1',
            category: 'STRUCTURAL_DTO',
            decision: 'APPROVE',
            title: 'Adicionar vIBSCBS em Nfe.java',
            description: 'Tag ausente no DTO.',
            tagPath: 'NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VIBSCBS',
            targetPackage: 'domain',
            targetClass: 'Nfe',
            diffKind: 'MISSING_TAG',
            pdfCitations: ['p. 1'],
            suggestedChange: 'private BigDecimal vIBSCBS;',
            editedNotes: null,
            blockerReason: null,
          },
          ...(withBlocker
            ? [
                {
                  id: 'NC-2',
                  category: 'SHARED_XML_PARSER_BLOCKER' as const,
                  decision: 'APPROVE' as const,
                  title: 'Lib compartilhada xml-parser desatualizada',
                  description: 'Necessário suporte prévio.',
                  tagPath: 'NFEPROC.ATTR_NOVO',
                  targetPackage: 'xml-parser' as const,
                  targetClass: null,
                  diffKind: 'MISSING_TAG' as const,
                  pdfCitations: ['p. 4'],
                  suggestedChange: null,
                  editedNotes: null,
                  blockerReason: 'Aguardar release xml-parser.',
                },
              ]
            : []),
        ],
    created_at: '2026-11-19T12:00:00.000Z',
    updated_at: '2026-11-19T12:00:00.000Z',
  };
}

const BYOK = {
  provider: 'gemini' as const,
  modelId: 'gemini-2.5-pro',
  operatorName: 'Op',
  secretKeyRef: 'ntc:llm:gemini',
};

describe('NcReview (CUJ 2–3)', () => {
  it('UI-NR-01: disables "Aplicar NC ao parser" while SHARED_XML_PARSER_BLOCKER is active, enables when SKIPped', async () => {
    const user = userEvent.setup();
    const saveNc = vi.fn(async ({ nc }: { nc: NcDocument }) => ({
      run: {
        runId: 'r1',
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
      nc,
      markdown: '# NC-2025.002-v1.30',
    }));

    const applyNc = vi.fn(async () => ({
      run: {
        runId: 'r1',
        dfe: 'NFe' as const,
        ntId: 'NFe:2025.002:1.30',
        status: 'TESTED' as const,
        failedStep: null,
        errorMessage: null,
        operatorName: 'Op',
        provider: 'gemini' as const,
        modelId: 'gemini-2.5-pro',
        baseCommitSha: '1'.repeat(40),
        branchName: 'nc/nfe-nt-2025.002-v1.30',
        ncJsonPath: 'NFe/NC-2025.002-v1.30.json',
        prUrl: null,
        tokenUsage: null,
        createdAt: '2026-11-19T12:00:00.000Z',
        updatedAt: '2026-11-19T12:00:00.000Z',
      },
      patchFilePath: '/tmp/r1.patch',
      prUrl: null,
      mavenResult: null,
    }));

    const api = makeMockApi({
      getNc: vi.fn(async () => ({
        run: {
          runId: 'r1',
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
        nc: makeNc(true),
        markdown: '# NC-2025.002-v1.30',
      })),
      saveNc,
      applyNc,
    });

    const onApplyStarted = vi.fn();
    render(
      <NcReview
        api={api}
        runId="r1"
        xsdDir="/tmp/xsd"
        byokConfig={BYOK}
        onApplyStarted={onApplyStarted}
      />,
    );

    const applyButton = await screen.findByRole('button', { name: /Aplicar NC ao parser/i });
    expect(applyButton).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/SHARED_XML_PARSER_BLOCKER/i);

    const decisionSelects = screen.getAllByLabelText(/Decisão/i);
    await user.selectOptions(decisionSelects[1]!, 'SKIP');

    expect(applyButton).not.toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Salvar Revisão/i }));
    expect(saveNc).toHaveBeenCalled();

    await user.click(applyButton);
    expect(onApplyStarted).toHaveBeenCalledWith('r1');
    expect(applyNc).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1', xsdDir: '/tmp/xsd' }));
  });

  it('UI-NR-02: requires explicit checkbox confirmation when no_structural_gaps is true', async () => {
    const user = userEvent.setup();
    const saveNc = vi.fn(async ({ nc }: { nc: NcDocument }) => ({
      run: {
        runId: 'r-clean',
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
        ncJsonPath: 'NFe/NC-clean.json',
        prUrl: null,
        tokenUsage: null,
        createdAt: '2026-11-19T12:00:00.000Z',
        updatedAt: '2026-11-19T12:00:00.000Z',
      },
      nc,
      markdown: '# Clean',
    }));

    const api = makeMockApi({
      getNc: vi.fn(async () => ({
        run: {
          runId: 'r-clean',
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
          ncJsonPath: 'NFe/NC-clean.json',
          prUrl: null,
          tokenUsage: null,
          createdAt: '2026-11-19T12:00:00.000Z',
          updatedAt: '2026-11-19T12:00:00.000Z',
        },
        nc: makeNc(false, true),
        markdown: '# Clean',
      })),
      saveNc,
    });

    render(
      <NcReview
        api={api}
        runId="r-clean"
        xsdDir="/tmp/xsd"
        byokConfig={BYOK}
        onApplyStarted={() => undefined}
      />,
    );

    const confirmCheckbox = await screen.findByLabelText(/Confirmo que não há lacunas estruturais/i);
    expect(confirmCheckbox).not.toBeChecked();
    await user.click(confirmCheckbox);
    await user.click(screen.getByRole('button', { name: /Salvar Revisão/i }));

    expect(saveNc).toHaveBeenCalledWith(
      expect.objectContaining({
        nc: expect.objectContaining({ confirmed_no_gaps: true }),
      }),
    );
  });

  it('UI-NR-03: keeps Apply button disabled with accessible hint when XSD dir is empty', async () => {
    const user = userEvent.setup();
    const api = makeMockApi({
      getNc: vi.fn(async () => ({
        run: {
          runId: 'r-no-xsd',
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
        nc: makeNc(false),
        markdown: '# NC',
      })),
    });

    render(<NcReview api={api} runId="r-no-xsd" xsdDir="" byokConfig={BYOK} />);
    const applyButton = await screen.findByRole('button', { name: /Aplicar NC ao parser/i });
    expect(applyButton).toBeDisabled();
    expect(screen.getByText(/Informe o diretório XSD/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Diretório XSD para validação/i), '/data/cache/svrs/NFe/xsd');
    expect(applyButton).not.toBeDisabled();
  });
});
