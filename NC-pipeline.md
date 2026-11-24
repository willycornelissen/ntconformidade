# Pipeline Pós-Verificação e Registro da NC (`NC-<NT>`)

## Aonde a NC é registrada?

A Nota de Conformidade (NC) é persistida em **dois lugares**, ambos sob o diretório de dados da aplicação (`dataDir`):

> **Como o `dataDir` é definido:** em execução empacotada é o `app.getPath('userData')` do Electron; em execução não empacotada pode ser definido pela variável `NTC_DATA_DIR` ([`resolveNtcDataDir`](packages/desktop/src/main.ts#L19-L31)).

1. **No disco (arquivos da NC):**
   Gravados atomicamente por [`saveNcDocument`](packages/core/src/nc/nc-service.ts#L133-L143) dentro de `<dataDir>/ncs/<DFE>/`:
   - `NC-<ntNumber>-v<ntVersion>.json` — contrato estruturado (fonte da verdade);
   - `NC-<ntNumber>-v<ntVersion>.md` — prévia legível em Markdown (também usada como descrição do Pull Request no Gitea).

2. **No banco SQLite (`<dataDir>/ntc.sqlite`):**
   Na tabela [`compliance_runs`](packages/core/src/storage/migrations/001_initial.sql#L34-L51), cada execução (`run_id`) armazena:
   - `nc_json_path`: caminho relativo até o JSON da NC (ex.: `<DFE>/NC-<ntNumber>-v<ntVersion>.json`);
   - `status` (`DRAFT`, `APPROVED`, `TESTED`, `PR_OPENED` ou `FAILED`), `base_commit_sha`, `branch_name`, `pr_url` e `token_usage_json`.

---

## O que acontece depois que uma ação de conformidade é executada?

### 1. Logo após **Verificar conformidade** (Fase A — geração da NC)

- A interface abre automaticamente a aba **Revisão NC** ([`NcReview.tsx`](packages/ui/src/pages/NcReview.tsx#L135-L378)).
- Nela você revisa cada item da NC (`APPROVE`, `EDIT`, `SKIP`), adiciona notas do operador (`editedNotes`), trata eventuais bloqueios `SHARED_XML_PARSER_BLOCKER` (que exigem `SKIP` para liberar a aplicação) e pode clicar em **Salvar Revisão** (`api.saveNc`), que atualiza o `.json` e o `.md` no disco e o registro no SQLite.

### 2. Ao executar **Aplicar NC ao parser** (Fase B — aplicação, testes e PR)

Ao clicar em **Aplicar NC ao parser** ([`NcReview.tsx`](packages/ui/src/pages/NcReview.tsx#L253-L278)), a UI salva a revisão atual, abre a aba **Diff & PR** ([`DiffAndPr.tsx`](packages/ui/src/pages/DiffAndPr.tsx#L81-L250)) e dispara [`approveAndRunCompliance`](packages/core/src/orchestrator/compliance-orchestrator.ts#L266-L304):

1. **Validações prévias (`STALENESS_CHECK`):**
   - Verifica se há bloqueios ativos, se o `base_commit_sha` continua igual ao `HEAD` remoto da branch base e se o SHA-256 do PDF não mudou.
   - Se a NC não tiver lacunas (`no_structural_gaps === true` e `confirmed_no_gaps === true`), o status avança `DRAFT -> APPROVED -> TESTED` e o fluxo termina sem gerar patch ou PR.
2. **Lock e Worktree isolada (`WORKTREE_PREP`):**
   - Adquire um *lock* exclusivo por DFe na tabela `repo_locks` do SQLite (impedindo duas aplicações simultâneas no mesmo parser).
   - Muda o status da execução para `APPROVED` e cria uma *worktree* isolada em `<dataDir>/worktrees/run-<runId>` na branch `nc/<dfe>-nt-<num>-v<ver>`.
3. **Geração de patch e guardrails (`PATCH_APPLY` / `PATCH_GUARDRAILS`):**
   - O LLM gera as alterações Java e testes unitários sintéticos, validados por guardrails e pelo XSD (`applyPatchToWorktree`).
4. **1º Gate humano — Conferência Pré-Build (`PRE_BUILD_DIFF_REVIEW`):**
   - A execução pausa e exibe o diff unificado na aba **Diff & PR**.
   - Se você **rejeitar**, a execução é abortada (`FAILED` com `USER_ABORT`).
5. **Execução de `mvn test` e loop de reparo (`MAVEN_TEST` / `PATCH_REPAIR`):**
   - Com o diff aprovado, roda `mvn test` no host. Se houver erro de compilação ou falha em teste sintético, o orquestrador solicita até **3 tentativas** de reparo ao LLM (`DEFAULT_MAX_REPAIR_ATTEMPTS = 3`), passando novamente pela conferência pré-build.
6. **Exportação do `.patch` e 2º Gate humano (`TESTED` -> `PR_REVIEW`):**
   - Com o Maven verde, exporta o diff para `<dataDir>/artifacts/<runId>.patch`, muda o status para `TESTED` e aguarda sua confirmação na aba **Diff & PR** com o resumo do Surefire.
   - Se você **confirmar o PR**: faz commit, `git push` da branch para o Gitea, abre o Pull Request usando o Markdown da NC como corpo, atualiza o status no SQLite para `PR_OPENED` (gravando `pr_url`) e emite `COMPLETED`.
   - Se você **não aprovar o push**: nenhum envio ao Gitea é feito, o arquivo `.patch` local é preservado e o status permanece `TESTED`.
7. **Limpeza final (sempre executada no `finally`):**
   - Remove a *worktree* temporária (`worktrees/run-<runId>`) — tentando antes exportar um `.patch` em `artifacts/` caso tenha ocorrido erro para diagnóstico — e libera o *lock* em `repo_locks`.
