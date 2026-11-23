# NT Conformidade (SEF/MG)

Aplicação desktop e núcleo headless para rastreamento de Notas Técnicas (NTs) no portal SVRS, análise determinística **XSD × AST Java** (`tools/xsd-oracle`), geração de Notas de Conformidade (`NC-<NT>.json` / `.md`), aplicação isolada em `git worktree` com testes `mvn test` e abertura assistida de Pull Requests no Gitea.

---

## 1. Arquitetura do Monorepo

| Pacote / Diretório | Função |
| :--- | :--- |
| `packages/core` (`@ntc/core`) | Núcleo headless Node.js/TypeScript: domínio, SQLite WAL + migrações, coletor SVRS, extrator PDF (`pdfjs-dist`), filtro DLP (`test-files/**` bloqueado), ponte `xsd-oracle`, gateway BYOK (`Gemini`, `OpenAI`-compatível/Ollama, `GitHub Copilot`), serviço `NC-<NT>`, guardrails/engine de patch, `doctor`, `HostMavenRunner`, `WorktreeManager`, `GiteaAdapter` e `ComplianceOrchestrator`. |
| `packages/ui` (`@ntc/ui`) | Interface React + Vite (`DashboardNts`, `NcReview`, `DiffAndPr`, `RepoRegistry`, `SettingsByokDoctor`) comunicando-se exclusivamente com `window.ntcApi` via `import type` de `@ntc/core`. |
| `packages/desktop` (`@ntc/desktop`) | Processo principal e preload sandboxed Electron (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP estrita), `SecretStorePort` apoiado por `Electron safeStorage`, roteamento IPC Zod e empacotamento `electron-builder`. |
| `tools/xsd-oracle` | Utilitário CLI Java 8 (`xsd-oracle.jar`) com `xercesImpl` + `SchemaFactory` (`FEATURE_SECURE_PROCESSING` + `LSResourceResolver` local) e `JavaParser` para extração/validação XSD e AST dos parsers Java. |
| `config/dfe-registry.default.json` | Catálogo padrão dos 8 DFes (`NFe`, `BPe`, `MDFe`, `CTe`, `NF3e`, `NFCom`, `GTVe`, `NFCe` com `nfce-parser` separado). |
| `nfe-parser/` | Referência local **somente leitura** utilizada nos testes integrados do oráculo (não faz parte do código da aplicação). |

---

## 2. Pré-Requisitos (Linux / WSL2 e Windows 11)

- **Node.js**: `>= 22.0.0` (`npm >= 10`)
- **Java JDK**: JDK 8+ (recomendado JDK 8 ou JDK 21). Quando executar `mvn test` com JDK 9+, o `HostMavenRunner` aplica automaticamente `-Dmaven.compiler.release=8` ao identificar necessidade via `doctor` (observando compatibilidade de projetos com `lombok <= 1.18.30`).
- **Apache Maven**: `mvn` (Linux/WSL2) ou `mvn.cmd` (Windows) no `PATH`.
- **Git**: `git` configurado no host. Em Windows, recomenda-se configurar quebras de linha UNIX nos clones locais:
  ```bash
  git config --global core.autocrlf input
  git config --global user.name "Seu Nome"
  git config --global user.email "seu.email@fazenda.mg.gov.br"
  ```
- **Nexus / Cache Maven (`~/.m2/settings.xml`)**: garanta que o `settings.xml` aponte para o repositório Nexus corporativo (ou cache `~/.m2/repository` populado) antes de executar `mvn test` offline/corporativo.

---

## 3. Instalação e Build

1. Instale dependências JS/TS e compile o oráculo Java:
   ```bash
   npm install
   mvn -f tools/xsd-oracle/pom.xml package
   ```
   *(Em ambientes headless/CI sem binário Electron local, use `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`.)*

2. Compile todos os workspaces (`@ntc/core`, `@ntc/ui`, `@ntc/desktop`):
   ```bash
   npm run build
   ```

3. Recompilação nativa do `better-sqlite3` e empacotamento Electron (execute `rebuild:electron` no SO alvo):
   ```bash
   npm run rebuild:electron
   npm run package:win    # Windows (NSIS / Portable)
   npm run package:linux  # Linux (AppImage / tar.gz)
   ```

---

## 4. Armazenamento Local, Segredos e Configuração Inicial

- **Diretório de dados (`NTC_DATA_DIR`)**: em modo dev/desempacotado, se definido, armazena todos os dados da aplicação; em builds empacotados utiliza sempre `app.getPath('userData')` do Electron:
  - `ntc.sqlite`: catálogo SVRS, registro dos 8 DFes, execuções (`compliance_runs`) e travas por repositório (`repo_locks`).
  - `secrets.enc.json`: cofre criptografado via `Electron safeStorage` (`0o600`), jamais expondo tokens em texto claro para o renderer ou para variáveis de ambiente de `mvn`/`git`/`java`.
  - `cache/svrs/<dfe>/`: PDFs e XSDs baixados/importados e textos extraídos por SHA-256.
  - `ncs/<DFE>/`: contratos `NC-<NT>.json` (fonte única da verdade) e previews unidirecionais `NC-<NT>.md`.
  - `repos/<repo>.git`: clones `bare` locais.
  - `worktrees/` e `artifacts/<run_id>.patch`: worktrees isolados temporários e diffs `.patch` exportados para auditoria ou contingência offline.

- **Primeiros Passos na Interface (`npm run dev:desktop`)**:
  1. Acesse a aba **BYOK & Doctor**, configure o provedor (`Google Gemini`, `OpenAI / Ollama Local` ou `GitHub Copilot / Models`), salve o **Token Gitea PAT** (`ntc:gitea:pat`) e a chave BYOK, e clique em **Executar Diagnóstico (Doctor)**.
  2. Em **Repositórios**, revise URLs HTTPS e pacotes dos 8 DFes (`nfce-parser` independente de `nfe-parser`).
  3. Em **Notas Técnicas**, sincronize o portal SVRS ou use **Importar NT Manual** para carregar offline um par `PDF + ZIP/XSD`.
  4. Acione **Verificar conformidade**, revise/aprove os itens em **Revisão NC** (itens `SHARED_XML_PARSER_BLOCKER` exigem resolução ou `SKIP`), aprove o diff pré-build em **Diff & PR** e confirme o push/PR após `mvn test` verde.

---

## 5. Verificação, Testes e Cobertura

```bash
# Typecheck estrito e lint em todos os workspaces
npm run typecheck
npm run lint

# Testes unitários Java do oráculo XSD/AST
mvn -f tools/xsd-oracle/pom.xml test

# Suíte de testes completa (raiz + @ntc/core + @ntc/ui + @ntc/desktop incluindo E2E)
npm test

# Relatório de cobertura do núcleo (gate >= 80% global e por módulo crítico)
npm --workspace=@ntc/core run test:coverage
```
