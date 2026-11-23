import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PendingApprovalGate } from '@ntc/core';
import { DiffAndPr } from '../src/pages/DiffAndPr.js';
import { makeMockApi } from './mock-api.js';

describe('DiffAndPr (CUJ 3–4)', () => {
  it('UI-DP-01: keeps "Abrir PR no Gitea" disabled until pre-build diff approved and PR gate ready', async () => {
    const user = userEvent.setup();
    let currentGate: PendingApprovalGate | null = {
      runId: 'r1',
      kind: 'PRE_BUILD_DIFF',
      preview: {
        runId: 'r1',
        branchName: 'nc/nfe-nt-2025.002-v1.30',
        unifiedDiff: '+ private BigDecimal vIBSCBS;',
        isStrictlyDeclarative: false,
        nonDeclarativeReasons: ['Nfe.java: controle de fluxo imperativo detectado'],
        editedFiles: ['src/main/java/Nfe.java'],
        createdFiles: ['src/test/resources/synthetic/nt.xml'],
      },
    };

    const confirmPreBuildDiff = vi.fn(async () => {
      currentGate = {
        runId: 'r1',
        kind: 'PR_CONFIRMATION',
        branchName: 'nc/nfe-nt-2025.002-v1.30',
        patchFilePath: '/data/artifacts/r1.patch',
        mavenResult: {
          passed: true,
          classification: 'PASSED',
          summary: 'Maven tests PASSED (12 executed).',
          failedTestClasses: [],
          sanitizedLog: 'BUILD SUCCESS',
          surefireSummary: { total: 12, errors: 0, failures: 0, skipped: 0, failedClasses: [] },
        },
      };
      return { acknowledged: true };
    });
    const openPr = vi.fn(async () => ({ acknowledged: true }));

    const api = makeMockApi({
      getPendingGate: vi.fn(async () => currentGate),
      confirmPreBuildDiff,
      openPr,
    });

    render(<DiffAndPr api={api} runId="r1" latestProgress={null} />);

    expect(await screen.findByText(/controle de fluxo imperativo detectado/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Abrir PR no Gitea/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Aprovar Diff Pré-Build/i }));
    expect(confirmPreBuildDiff).toHaveBeenCalledWith({ runId: 'r1', approved: true });

    const openPrButton = await screen.findByRole('button', { name: /Abrir PR no Gitea/i });
    expect(openPrButton).not.toBeDisabled();
    expect(screen.getByText(/Maven tests PASSED/i)).toBeInTheDocument();

    await user.click(openPrButton);
    expect(openPr).toHaveBeenCalledWith({ runId: 'r1', approved: true });
  });

  it('UI-DP-02: forwards gateToken and surfaces alert when confirmation returns acknowledged=false', async () => {
    const user = userEvent.setup();
    const confirmPreBuildDiff = vi.fn(async () => ({ acknowledged: false }));
    const api = makeMockApi({
      getPendingGate: vi.fn(async () => ({
        runId: 'r2',
        kind: 'PRE_BUILD_DIFF' as const,
        gateToken: 'tok-abc',
        preview: {
          runId: 'r2',
          branchName: 'nc/test',
          unifiedDiff: '+ campo',
          isStrictlyDeclarative: true,
          nonDeclarativeReasons: [],
          editedFiles: ['Nfe.java'],
          createdFiles: [],
        },
      })),
      confirmPreBuildDiff,
    });

    render(<DiffAndPr api={api} runId="r2" latestProgress={null} />);
    await user.click(await screen.findByRole('button', { name: /Aprovar Diff Pré-Build/i }));

    expect(confirmPreBuildDiff).toHaveBeenCalledWith({
      runId: 'r2',
      approved: true,
      gateToken: 'tok-abc',
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/expirou|respondida/i);
  });
});
