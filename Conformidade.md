# Fluxo Passo a Passo: Verificação de Conformidade de Nota Técnica

Quando o usuário clica no botão **Verificar conformidade** de uma Nota Técnica (NT), a aplicação executa apenas a **Fase A** do pipeline: ela coleta os artefatos, compara o XSD da NT com o parser Java em um ambiente isolado, gera o rascunho da Nota de Conformidade (`NC-<NT>.json` e `.md`) usando o LLM configurado e abre a tela de revisão. **Nenhuma alteração é aplicada ao código do parser nem enviada ao Gitea nesta etapa.**

---

## 1. Disparo na Interface React (`DashboardNts`)

- Ao clicar em **Verificar conformidade** na tabela de NTs em [`DashboardNts.tsx`](packages/ui/src/pages/DashboardNts.tsx#L258-L266), o handler [`handleCheckCompliance`](packages/ui/src/pages/DashboardNts.tsx#L490-L512) é chamado.
- Ele marca `busy = true` (desabilitando os botões para evitar disparos simultâneos), limpa mensagens anteriores de status/erro e chama `api.checkCompliance({ dfe: entry.dfe, ntId: entry.id, byokConfig })`.
- Paralelamente, desde a montagem de [`App.tsx`](packages/ui/src/App.tsx#L43-L47), a UI fica inscrita em `api.onRunProgress`, exibindo cada etapa recebida do backend no banner superior ([`RunProgressBanner.tsx`](packages/ui/src/components/RunProgressBanner.tsx#L3-L28)).

---

## 2. Travessia pela Ponte IPC do Electron (`preload` -> `main`)

1. No preload isolado ([`preload.cts`](packages/desktop/src/preload.cts#L48-L57)), `window.ntcApi.checkCompliance` encaminha a chamada via `ipcRenderer.invoke('ntc:check-compliance', req)`.
2. No processo principal ([`ipc-handlers.ts`](packages/desktop/src/ipc-handlers.ts#L618-L636)), `dispatch` valida se a origem do frame remetente está na lista autorizada (`isAllowedSenderFrame`).
3. O handler de `ntc:check-compliance` ([`ipc-handlers.ts`](packages/desktop/src/ipc-handlers.ts#L455-L493)):
   - Valida o payload com `CheckComplianceRequestSchema` (Zod);
   - Verifica se `byokConfig.secretKeyRef` corresponde ao provedor selecionado (`assertBoundByokSecretKeyRef`);
   - Gera um `runId` no formato `run-<UUID>` (se não informado);
   - Caso a NT seja offline (`sourceStatus === 'MANUAL'`) ou tenha `pdfPath`/`xsdDir` explícitos, resolve os caminhos dentro dos diretórios permitidos (bloqueando *symlinks*) e já extrai o PDF antes de chamar o orquestrador (`resolveManualOfflineArtifacts`);
   - Chama `orchestrator.generateDraftNc(...)`.

---

## 3. Registro Inicial da Execução no SQLite

Em [`compliance-orchestrator.ts`](packages/core/src/orchestrator/compliance-orchestrator.ts#L220-L234), `generateDraftNc`:

- Verifica se o repositório do DFe e a NT existem no banco (`requireRepo` e `requireNt`).
- Cria uma linha na tabela `compliance_runs` via `db.createComplianceRun` ([`sqlite.ts`](packages/core/src/storage/sqlite.ts#L409-L455)) com status inicial **`DRAFT`**, vinculando operador, provedor e modelo BYOK.

---

## 4. Download e Extração dos Artefatos (PDF e XSD)

Em [`resolveDraftArtifacts`](packages/core/src/orchestrator/compliance-orchestrator.ts#L314-L336):

- **Se for NT manual/local:** reutiliza os artefatos já resolvidos e emite o progresso `PDF_EXTRACT`.
- **Se for NT do portal SVRS:**
  1. Emite progresso `SVRS_SYNC` e executa `downloadNtArtifacts` ([`svrs-scraper.ts`](packages/core/src/svrs/svrs-scraper.ts#L495-L548)) para baixar o PDF e o pacote XSD (`.zip` ou `.xsd`) em um diretório temporário de *staging*, validando redirects, limite de tamanho, assinatura `%PDF-` e SHA-256 (quando disponível), antes de persistir em `cache/svrs/<dfe>/<ntNumber>_<ntVersion>`.
  2. Emite progresso `PDF_EXTRACT` e chama `extractNtPdf` ([`nt-pdf-extractor.ts`](packages/core/src/pdf/nt-pdf-extractor.ts)), que valida cabeçalho `%PDF-`, marcador `%%EOF`, limites de tamanho/páginas e ausência de *symlinks*, extrai o texto página por página via `pdfjs-dist` (reaproveitando cache `.v1.json` pelo SHA-256, se houver) e gera segmentos citáveis por página.

---

## 5. Espelho Git e Worktree Temporária de Inspeção

De volta a [`compliance-orchestrator.ts`](packages/core/src/orchestrator/compliance-orchestrator.ts#L240-L258) e [`analyzeDraftInInspectionWorktree`](packages/core/src/orchestrator/compliance-orchestrator.ts#L346-L399):

1. Emite progresso `MIRROR_SYNC`.
2. Atualiza/cria o repositório *bare* local em `repos/` (`ensureBareMirror`).
3. Consulta o commit mais recente da branch base remota no Gitea (`getRemoteBranchHead`) e grava esse `baseCommitSha` na execução no SQLite.
4. Cria uma *worktree* temporária isolada em `worktrees/inspect-<runId>` nesse `baseCommitSha` para inspecionar o código Java (essa *worktree* é removida no bloco `finally` ao terminar, mesmo em caso de erro).

---

## 6. Análise Determinística XSD x AST Java (`xsd-oracle`)

O orquestrador emite progresso `ORACLE_DIFF` e executa três extrações em paralelo ([linhas 363–367](packages/core/src/orchestrator/compliance-orchestrator.ts#L363-L367)):

1. **`oracle.extractXsd(xsdDir)`**: invoca `java -jar xsd-oracle.jar extract-xsd` ([`XsdOracleMain.java`](tools/xsd-oracle/src/main/java/br/gov/mg/fazenda/ntc/XsdOracleMain.java#L70-L75)) para mapear os elementos, tipos e cardinalidades (`maxOccurs`) do XSD.
2. **`oracle.extractJavaAst(inspectDir, regEntry)`**: invoca `java -jar xsd-oracle.jar extract-java-ast` para extrair da AST Java as chaves mapeadas nos *mappers* (`setterKeys`).
3. **`extractJavaFieldTypeHints(...)`**: lê os arquivos Java do pacote de domínio (filtrados pela política DLP) para indexar os tipos declarados nos DTOs ([`xsd-ast-diff.ts`](packages/core/src/oracle/xsd-ast-diff.ts#L200-L233)).

Em seguida:

- [`computeXsdAstDiff`](packages/core/src/oracle/xsd-ast-diff.ts#L430-L483) cruza os nós folha do XSD com os *mappers* e DTOs Java e gera achados estruturais determinísticos: `MISSING_TAG`, `CARDINALITY_MISMATCH` e `TYPE_MISMATCH`.
- [`extractAllowedJavaContextForNc`](packages/core/src/patch/patch-engine.ts#L127-L179) seleciona até **25 arquivos `.java`** mais relevantes (priorizando classes afetadas pelos achados nos pacotes `domain`, `mapper`, `table` e `parser`), respeitando a *allowlist* de DLP.

---

## 7. Consulta ao LLM (BYOK) e Geração da NC Estruturada

O orquestrador emite progresso `LLM_CHECK` e chama `llmGateway.analyzeCompliance(...)` ([`byok-gateway.ts`](packages/core/src/llm/byok-gateway.ts#L325-L426)):

1. [`buildComplianceAnalysisPrompt`](packages/core/src/llm/prompt-builder.ts#L42-L84) monta o prompt contendo dados do repositório/NT, os achados do *oracle* XSD x AST, o texto extraído do PDF e os trechos Java selecionados.
2. O gateway valida o contexto contra violações de DLP (`assertNoDlpViolations`), sanitiza os prompts (`sanitizeForExternalLlm`) e verifica se a estimativa de tokens cabe no limite configurado (`ByokTokenLimitError`).
3. Recupera a chave/token da API no cofre do sistema (`secretStore.getSecret`) e envia a requisição ao adapter configurado (`gemini`, `openai-compatible` ou `github-copilot`).
4. Extrai e normaliza o JSON devolvido pelo modelo (`extractJsonFromLlmText` + `normalizeRawNcDraft`) e o valida contra `NcDocumentSchema` (Zod), classificando itens entre estruturais (`STRUCTURAL_MAPPER`, `STRUCTURAL_DTO`, `STRUCTURAL_TABLE`), bloqueio de biblioteca compartilhada (`SHARED_XML_PARSER_BLOCKER`) ou informativo (`SEMANTIC_RULE_INFO_ONLY`).

---

## 8. Persistência da NC e Atualização no SQLite

- [`saveNcDocument`](packages/core/src/nc/nc-service.ts#L133-L143) grava atomicamente dois arquivos em `<dataDir>/ncs/<dfe>/`:
  - `NC-<ntNumber>-v<ntVersion>.json` (documento estruturado, fonte da verdade);
  - `NC-<ntNumber>-v<ntVersion>.md` (prévia legível em Markdown).
- O SQLite recebe o caminho relativo `ncJsonPath` e o contabilizador `tokenUsage`, e o evento `NC_SAVED` é emitido para a UI.

---

## 9. Retorno para a UI e Abertura da Tela **Revisão NC**

- O handler IPC valida o retorno com `CheckComplianceResponseSchema` (`{ run, nc, xsdDir }`) e devolve ao renderer.
- Em [`DashboardNts.tsx`](packages/ui/src/pages/DashboardNts.tsx#L500-L502), `onDraftReady` é acionado, fazendo [`App.tsx`](packages/ui/src/App.tsx#L55-L61) guardar o `runId` e o `xsdDir` selecionados e trocar automaticamente para a aba **Revisão NC** (`'nc'`).
- Ao montar, [`NcReview.tsx`](packages/ui/src/pages/NcReview.tsx#L135-L147) chama `api.getNc({ runId })` e exibe os itens da NC para o operador aprovar (`APPROVE`), editar (`EDIT`) ou ignorar (`SKIP`) antes de eventualmente iniciar a aplicação do patch (`applyNc`).

> *(Se qualquer etapa falhar no meio do caminho, `failRunSafely` marca a execução como `FAILED` no SQLite com o `failedStep` correspondente, a worktree temporária de inspeção é removida e a mensagem sanitizada aparece no alerta de erro da tela.)*
