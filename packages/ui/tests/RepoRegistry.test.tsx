import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DfeRepoEntry } from '@ntc/core';
import { RepoRegistry } from '../src/pages/RepoRegistry.js';
import { makeMockApi } from './mock-api.js';

const REPOS: readonly DfeRepoEntry[] = [
  {
    dfe: 'NFe',
    repoSlug: 'nfe-parser',
    giteaUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser',
    baseBranch: 'main',
    basePackage: 'br.gov.mg.fazenda.nfeparser',
    domainPackage: 'br.gov.mg.fazenda.nfeparser.nfe',
    mapperPackage: 'br.gov.mg.fazenda.nfeparser.mapper',
    tablePackage: 'br.gov.mg.fazenda.nfeparser.table',
    parserPackage: 'br.gov.mg.fazenda.nfeparser.parser',
    utilPackage: 'br.gov.mg.fazenda.nfeparser.util',
    tagPrefix: 'NFEPROC',
    svrsRelativePath: '/Nfe/Documentos',
    baselineNt: null,
  },
  {
    dfe: 'NFCe',
    repoSlug: 'nfce-parser',
    giteaUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfce-parser',
    baseBranch: 'main',
    basePackage: 'br.gov.mg.fazenda.nfceparser',
    domainPackage: 'br.gov.mg.fazenda.nfceparser.nfce',
    mapperPackage: 'br.gov.mg.fazenda.nfceparser.mapper',
    tablePackage: 'br.gov.mg.fazenda.nfceparser.table',
    parserPackage: 'br.gov.mg.fazenda.nfceparser.parser',
    utilPackage: 'br.gov.mg.fazenda.nfceparser.util',
    tagPrefix: 'NFEPROC',
    svrsRelativePath: '/Nfce/Documentos',
    baselineNt: null,
  },
];

describe('RepoRegistry', () => {
  it('UI-RR-01: displays DFe repositories including separate nfce-parser with NFEPROC prefix and saves edits', async () => {
    const user = userEvent.setup();
    const saveRepo = vi.fn(async (r) => r);
    const api = makeMockApi({
      listRepos: vi.fn(async () => [...REPOS]),
      saveRepo,
    });

    render(<RepoRegistry api={api} />);

    expect(await screen.findByText('nfe-parser')).toBeInTheDocument();
    expect(screen.getByText('nfce-parser')).toBeInTheDocument();

    const branchInputs = screen.getAllByLabelText(/Branch base/i);
    await user.clear(branchInputs[1]!);
    await user.type(branchInputs[1]!, 'develop');
    await user.click(screen.getAllByRole('button', { name: /Salvar Repositório/i })[1]!);

    expect(saveRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        dfe: 'NFCe',
        repoSlug: 'nfce-parser',
        baseBranch: 'develop',
        tagPrefix: 'NFEPROC',
      }),
    );
  });

  it('UI-RR-02: blocks embedded credentials and non-HTTPS URLs before calling saveRepo', async () => {
    const user = userEvent.setup();
    const saveRepo = vi.fn(async (r) => r);
    const api = makeMockApi({
      listRepos: vi.fn(async () => [REPOS[0]!]),
      saveRepo,
    });

    render(<RepoRegistry api={api} />);
    const urlInput = await screen.findByLabelText(/URL Gitea HTTPS/i);
    await user.clear(urlInput);
    await user.type(urlInput, 'https://user:pass@gitea.local/Integracao/nfe-parser');
    await user.click(screen.getByRole('button', { name: /Salvar Repositório/i }));

    expect(saveRepo).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/sem credenciais embutidas/i);
  });
});
