# Guia Passo a Passo de Execução — NT Conformidade (SEF/MG)

Este documento reúne o passo a passo completo para **instalar, compilar, configurar, executar em desenvolvimento, empacotar e operar** o aplicativo **NT Conformidade**.

---

## Passo 1 — Conferir Pré-Requisitos do Ambiente

Antes de começar, valide as ferramentas instaladas no seu host (Windows 11 ou Linux/WSL2 com suporte gráfico WSLg/X11/Wayland):

1. **Node.js `>= 22.0.0`** e **npm `>= 10`**:
   ```bash
   node -v
   npm -v
   ```
2. **Java JDK `>= 8`** (recomendado **JDK 8** ou **JDK 21**):
   ```bash
   java -version
   ```
   > **Nota:** Se o host usar JDK 9+, o `HostMavenRunner` detecta via `doctor` (`detectJavaNeedsRelease8Flag`) e injeta `-Dmaven.compiler.release=8` automaticamente durante o `mvn test` dos parsers. Projetos com `lombok <= 1.18.30` podem exigir JDK 8/17 ou atualização do Lombok caso rodem em JDK 21+.
3. **Apache Maven** acessível no `PATH` (`mvn` no Linux/WSL2 ou `mvn.cmd` no Windows):
   ```bash
   mvn -version
   ```
4. **Git** com configuração básica e padronização de quebra de linha UNIX:
   ```bash
   git --version
   git config --global core.autocrlf input
   git config --global user.name "Seu Nome"
   git config --global user.email "seu.email@fazenda.mg.gov.br"
   ```
5. **Acesso Maven / Nexus (`~/.m2/settings.xml`)**:
   - Garanta que seu `settings.xml` aponte para o repositório Nexus corporativo (ou que o cache local `~/.m2/repository` já contenha as dependências de `br.gov.mg.fazenda:*`).
6. **Keyring do Sistema Operacional (Linux/WSL2)**:
   - O cofre de segredos (`Electron safeStorage`) recusa operar em modo inseguro (`basic_text` / `unknown`). Em Linux/WSL2, certifique-se de que um serviço de keyring (`gnome-keyring` / `libsecret` ou `kwallet`) esteja ativo na sessão gráfica. No Windows, o DPAPI nativo é usado automaticamente.

---

## Passo 2 — Clonar o Repositório (se aplicável)

```bash
git clone https://github.com/willycornelissen/ntconformidade.git
cd ntconformidade
```

---

## Passo 3 — Instalar Dependências e Compilar o Oráculo Java

1. Instale as dependências Node.js de todos os workspaces (`@ntc/core`, `@ntc/ui`, `@ntc/desktop`):
   ```bash
   npm install
   ```
   > **Redes corporativas com proxy HTTP/HTTPS (ex.: `HTTPS_PROXY` na SEF/MG):** o baixador oficial do Electron (`@electron/get`) exige `ELECTRON_GET_USE_PROXY=1` para trafegar pelo proxy:
   > ```bash
   > ELECTRON_GET_USE_PROXY=1 npm install
   > ```
   > Se você já rodou `npm install` com `ELECTRON_SKIP_BINARY_DOWNLOAD=1` ou o download falhou, conclua apenas a instalação do binário sem reinstalar tudo:
   > ```bash
   > ELECTRON_GET_USE_PROXY=1 node node_modules/electron/install.js
   > ```
   >
   > *(Para pipelines/CI sem interface gráfica onde não seja necessário abrir o Electron, `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install` pula esse download.)*

2. Compile e empacote o utilitário CLI Java (`tools/xsd-oracle/target/xsd-oracle.jar`):
   ```bash
   mvn -f tools/xsd-oracle/pom.xml package
   ```
   *(Se o cache Maven já estiver populado e quiser rodar em modo offline, acrescente `-o`: `mvn -f tools/xsd-oracle/pom.xml -B -o package`.)*

---

## Passo 4 — Compilar os Pacotes TypeScript e React

Na raiz do monorepo, compile `@ntc/core`, `@ntc/desktop` (incluindo `dist/preload/preload.cjs`) e o bundle de produção de `@ntc/ui` (`packages/ui/dist/`):

```bash
npm run build
```

> Este comando executa automaticamente `npm run typecheck` antes de compilar todos os workspaces.

---

## Passo 5 — Recompilar o Addon Nativo SQLite para o Electron

Como o `@ntc/core` usa `better-sqlite3` com módulo nativo C++ (`.node`), alinhe a ABI do módulo à versão do Electron instalada no seu sistema operacional:

```bash
npm run rebuild:electron
```

---

## Passo 6 — Executar a Aplicação Desktop

### Modo A — Execução padrão com bundle de UI compilado (recomendado)

1. Certifique-se de ter executado os Passos 3, 4 e 5.
2. Opcionalmente, defina um diretório customizado para dados locais (`ntc.sqlite`, cofre criptografado, clones e worktrees) em modo desenvolvimento:
   ```bash
   # Linux / WSL2
   export NTC_DATA_DIR="$HOME/.ntc-data"
   npm run dev:desktop
   ```
   ```powershell
   # Windows PowerShell
   $env:NTC_DATA_DIR = "$env:USERPROFILE\.ntc-data"
   npm run dev:desktop
   ```
   > Se `NTC_DATA_DIR` não for definido, será utilizado `app.getPath('userData')` do Electron. Em executáveis empacotados (`app.isPackaged === true`), `NTC_DATA_DIR` é ignorado por segurança e usa-se sempre `userData`.

### Modo B — Desenvolvimento com Hot Reload (HMR) no React (`VITE_DEV_SERVER_URL`)

Em dois terminais na raiz do repositório:

1. **Terminal 1** (servidor de desenvolvimento Vite para `@ntc/ui`):
   ```bash
   npm --workspace=@ntc/ui run dev
   ```
   Anote a URL loopback exibida (ex.: `http://127.0.0.1:5173` ou `http://localhost:5173`).
2. **Terminal 2** (Electron apontando para o dev server):
   ```bash
   VITE_DEV_SERVER_URL=http://127.0.0.1:5173 npm run dev:desktop
   ```
   > Por segurança, `VITE_DEV_SERVER_URL` aceita apenas URLs `http://localhost` ou `http://127.0.0.1` e é sempre desabilitado em builds empacotados.

---

## Passo 7 — Configurar e Usar na Primeira Abertura da Interface

Siga esta sequência nas 5 abas da aplicação:

### 7.1 Aba `BYOK & Doctor`
1. Em **Configuração BYOK**:
   - Selecione o provedor (`Google Gemini`, `OpenAI / Ollama Local` ou `GitHub Copilot / Models`), modelo (ex.: `gemini-2.5-pro`) e **Operador (Auditoria)**.
   - Para **OpenAI / Ollama Local**, informe `Endpoint Base URL` (`https://...` ou `http://127.0.0.1:...`) e opcionalmente `Organization ID`.
   - Para **GitHub Copilot / Models**, escolha `GitHub Models PAT` ou `Copilot OAuth Device` e campos corporativos opcionais.
2. Em **Cofre de Segredos (Electron safeStorage)**:
   - Cole seu **Token Gitea PAT** (`ntc:gitea:pat`) e clique em **Salvar Gitea PAT**.
   - Cole a chave/token da LLM (`ntc:llm:<provedor>`) e clique em **Salvar Chave BYOK**.
   - Os valores são criptografados no cofre do SO (`secrets.enc.json`, permissão `0600`) e nunca retornam em texto claro para a interface.
3. Em **Diagnóstico de Ambiente (Doctor)**:
   - Informe a URL HTTPS do repositório no Gitea (e opcionalmente um diretório local de parser já clonado para checar `.m2`) e clique em **Executar Diagnóstico (Doctor)**.
   - Confirme status `OK` para `JAVA_JDK`, `MAVEN`, `GIT_CONFIG`, `XSD_ORACLE`, `GITEA_API` e `LLM_ENDPOINT`.

### 7.2 Aba `Repositórios`
1. Revise os 8 DFes pré-cadastrados (`NFe`, `BPe`, `MDFe`, `CTe`, `NF3e`, `NFCom`, `GTVe`, `NFCe` apontando para `nfce-parser` independente).
2. Ajuste URL Gitea (HTTPS obrigatório, sem usuário/senha na URL), branch base e pacotes Java conforme necessário e clique em **Salvar Repositório**.

### 7.3 Aba `Notas Técnicas` (CUJ 1)
- Clique em **Sincronizar SVRS** para consultar o portal SVRS por DFe em segundo plano (falhas ficam isoladas por DFe sem travar os demais).
- **Contingência offline / rede restrita:** clique em **Importar NT Manual**, preencha DFe, número, versão, data (`dd/MM/yyyy`), caminho local do PDF e caminho do pacote XSD (`.zip` ou pasta) e clique em **Confirmar Importação**.
- Localize a NT desejada na tabela e clique em **Verificar conformidade** para gerar o contrato revisável `NC-<NT>.json`.

### 7.4 Aba `Revisão NC` (CUJ 2)
1. Revise os itens estruturais identificados (XSD × AST Java + análise BYOK) e defina `APPROVE`, `EDIT` ou `SKIP` em cada item + notas do operador.
2. **Atenção aos bloqueios:**
   - Se houver item `SHARED_XML_PARSER_BLOCKER`, o botão **Aplicar NC ao parser** fica bloqueado até que o item seja resolvido ou marcado como `SKIP`.
   - Se `no_structural_gaps` for `true`, marque o checkbox explícito de confirmação.
   - Confirme que **Diretório XSD para validação** está preenchido.
3. Clique em **Salvar Revisão** (se editou algo) e depois em **Aplicar NC ao parser**.

### 7.5 Aba `Diff & PR` (CUJ 3 e 4)
1. **Conferência Pré-Build:** inspecione o diff gerado no worktree isolado (e eventuais avisos de alteração não estritamente declarativa) antes de rodar código Java no host; clique em **Aprovar Diff Pré-Build** (ou **Rejeitar Diff** para abortar com segurança).
2. **Execução Maven (`mvn test`):** o sistema executa `mvn test` com ambiente limpo e relatório Surefire; em falhas de compilação/testes sintéticos novos ocorrem até 3 tentativas de reparo sanitizadas (`test-files/**` nunca é enviado para a LLM).
3. **Confirmação Final de Push & PR:** o botão **Abrir PR no Gitea** só é liberado após o `mvn test` passar. Você pode abrir o PR ou escolher **Manter apenas .patch local** (salvo em `<dataDir>/artifacts/<run_id>.patch`).

---

## Passo 8 — Gerar Instaladores Desktop (Opcional)

Execute na máquina com o sistema operacional alvo (após os Passos 3, 4 e 5):

- **Windows (NSIS e Portable em `packages/desktop/release/`):**
  ```bash
  npm run package:win
  ```
- **Linux (AppImage e `.tar.gz` em `packages/desktop/release/`):**
  ```bash
  npm run package:linux
  ```

---

## Passo 9 — Rodar Verificações, Testes e Cobertura

Use os comandos abaixo sempre que validar alterações no projeto:

```bash
# 1. Typecheck estrito e ESLint em todos os workspaces
npm run typecheck
npm run lint

# 2. Testes unitários Java (tools/xsd-oracle)
mvn -f tools/xsd-oracle/pom.xml test

# 3. Suíte completa (monorepo + @ntc/core + @ntc/desktop + E2E + @ntc/ui)
npm test

# 4. Relatório de cobertura do núcleo headless (@ntc/core)
npm --workspace=@ntc/core run test:coverage

# 5. Auditoria de segurança em dependências de produção
npm audit --omit=dev --audit-level=high
```

---

## Solução Rápida de Problemas

- **`Electron failed to install correctly` / falha de TLS atrás de proxy corporativo:** execute:
  ```bash
  ELECTRON_GET_USE_PROXY=1 node node_modules/electron/install.js
  ```
  *(Caso prefira reinstalar do zero, apague `node_modules/electron` e rode `ELECTRON_GET_USE_PROXY=1 npm install`.)*
- **Erro `Cofre safeStorage operando em modo inseguro ('basic_text')` no Linux:** inicie uma sessão com `gnome-keyring-daemon` / `libsecret` ou `kwallet` ativo antes de abrir o aplicativo.
- **`NODE_MODULE_VERSION` mismatch ao abrir o Electron:** rode `npm run rebuild:electron` após trocar de versão do Node ou do Electron.
- **Lombok falhando no `mvn test` com JDK 21+:** use JDK 8/17 para rodar o aplicativo ou atualize a dependência do Lombok no parser Java alvo conforme alerta exibido pelo `doctor`.
- **Conflito CRLF/LF nos diffs gerados no Windows:** configure `git config --global core.autocrlf input` conforme validado pelo `doctor`.
