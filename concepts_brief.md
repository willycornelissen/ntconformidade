# NT Conformidade — Validação e Adequação de Parsers DFe a Notas Técnicas

* **Author:** Willy Garabini Cornelissen
* **Date:** 2026-11-19

## Overview

Aplicação para acompanhar Notas Técnicas (NTs) publicadas para 8 documentos fiscais eletrônicos (NFe, BPe, MDFe, CTe, NF3e, NFCom, GTVe e NFCe) no portal SVRS (`https://dfe-portal.svrs.rs.gov.br/`), exibir uma tabela inicial com as últimas NTs e datas, verificar a **conformidade estrutural** dos 8 repositórios de parsers Java 8/Maven no Gitea (`https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/`, com dependências internas no Sonatype Nexus) gerando uma Nota de Conformidade revisável (`NC-<NT>`) e, após aprovação humana, aplicar as alterações de código e testes unitários JUnit 5 obrigatórios, validar com `mvn test`, revisar o diff localmente e abrir branch, commits e Pull Request no Gitea.

A versão inicial será testada em WSL2/Linux com meta de execução em desktop Windows, construída sobre um núcleo headless (CLI/serviço local) com camada visual fina para reutilização futura em CLI e aplicação web.

## Analysis

### Status dos Revisores Goldfish (`Mode: BRAINSTORM`)

| Revisor | Status | Lente |
| :--- | :--- | :--- |
| `egm-design` | `completed` | Arquitetura, segurança, privacidade e riscos operacionais |
| `egm-codebase-details` | `completed` | Alinhamento com `nfe-parser`, contratos e ferramentas determinísticas |
| `egm-zoom-out` | `completed` | Simplicidade, YAGNI e reuso de ferramentas existentes |
| `egm-comprehension` | `completed` | Clareza de fluxo, UX e ergonomia operacional |
| `egm-implementation-readiness` | `completed` | Contratos ausentes, pré-requisitos e segurança de execução |
| `egm-structural` | `completed` | Fronteiras estruturais, máquina de estados e manutenção |
| `egm-inventive-catalyst` | `completed` | Contradições técnicas (TRIZ) e Resultado Final Ideal |

*(Nota de execução: `egm-synthesizer` reportou indisponibilidade de aninhamento de subagentes nesta sessão; os 7 revisores foram despachados diretamente em paralelo em contextos isolados conforme o protocolo EGM.)*

---

### Achados Críticos e Resoluções Incorporadas

#### 1. Escopo da v1 Limitado à Conformidade Estrutural e Alinhamento com Java 8 (`nfe-parser`)
* **Achado:** O arquivo `nfe-parser/pom.xml` comprova que o parser é uma biblioteca Java 8 pura (`maven.compiler.source/target = 8`), sem dependência do Spring Framework, usando SAX/`br.gov.mg.fazenda:xml-parser:2.0.8`, Lombok `1.18.30`, Jackson Annotations `2.15.1` e JUnit 5 `5.9.0`. Pela arquitetura descrita em `stack-parser.md` e `nfe-parser/release_notes.txt`, o parser apenas extrai XML por `tagPath` em caixa alta (`NFEPROC...`), preenche DTOs com `@JsonProperty` para o tópico Kafka `catalogo.nfe.json` e os achata em modelos tabulares `*Table`.
* **Resolução definida na v1:** A v1 fica limitada à **conformidade estrutural** (`tagPath`, DTOs de domínio com `@JsonProperty`, modelos tabulares `*Table`, conversões `StringConverter` e testes unitários JUnit 5). Regras semânticas e de autorização/rejeição cruzada da SEFAZ (`cStat`) serão apenas listadas em seção informativa da `NC-<NT>`, sem gerar código de validação dentro dos parsers estruturais e sem introduzir Spring Framework.

#### 2. Mapeamento dos 8 Repositórios no Gitea e Dependência Compartilhada
* **Achado:** `nfe-parser` contém um teste legado `NfceParserImplTest.java`, porém o autor confirmou a existência de repositórios separados para cada DFe no Gitea (por exemplo, `https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfce-parser`), além da dependência compartilhada `br.gov.mg.fazenda:xml-parser:2.0.8` publicada no Sonatype Nexus interno (`http://nexus-repo-sonatype-nexus-service.nexus.svc:8081/...` em `nfe-parser/pom.xml`).
* **Resolução definida:** O sistema usará um registro configurável por DFe apontando para a URL Gitea correspondente, branch base, pacotes alvo e versão base de NT/XSD. Quando uma NT exigir mudança na biblioteca compartilhada `xml-parser`, a `NC-<NT>` deve apontar o bloqueio explicitamente em vez de tentar contorná-lo nos parsers consumidores.

#### 3. Validação Cruzada Determinística (XSD + AST) para Evitar Validação Circular
* **Achado:** Usar LLM para ler PDFs da SEFAZ, redigir a `NC-<NT>`, editar o código Java e escrever os testes cria um ciclo fechado: erros de interpretação da LLM em tabelas complexas ou texto tachado de PDF passam nos próprios testes gerados.
* **Resolução definida:** Antes de acionar a LLM, o núcleo executará comparação determinística entre os **pacotes XSD oficiais** obtidos no portal SVRS e os `tagPath`s registrados no código Java (`*_FIELD_SETTERS` nos mappers e campos `@JsonProperty`/`*Table`). Os XMLs sintéticos criados para novos testes JUnit 5 serão validados contra o XSD oficial (`SchemaFactory`), e a `NC-<NT>` deverá citar seção/página do PDF de origem.

#### 4. Uso de `test-files/`, Sigilo de Dados e Economia de Tokens
* **Achado:** Os testes em `nfe-parser/src/test/resources/test-files/` contêm dezenas de XMLs (incluindo arquivos de até ~397 KB como `NFE-131246269100270.xml`). Embora o autor tenha autorizado o uso dos `test-files/` nos testes, há restrição prévia para envio de dados reais a LLMs externas, além de risco de estouro de contexto e custo de tokens.
* **Resolução definida:** Os arquivos em `test-files/` serão executados normalmente na suíte local do `mvn test` como teste de regressão. Para envio de contexto a LLMs externas, o núcleo enviará apenas código-fonte Java, definições XSD, esqueletos de tags e XMLs sintéticos pequenos (com filtro configurável para bloquear ou mascarar payloads reais de `test-files/` e saídas XML em logs de erro do `mvn test`).

#### 5. Núcleo Headless Desacoplado, Pré-requisitos de Build e Controle de Execução
* **Achado:** Construir um agente autônomo de edição Java do zero acoplado a uma interface desktop para WSL2 e Windows gera alto custo de manutenção, além de riscos com `pom.xml` apontando URL HTTP interna do Nexus (`maven-default-http-blocker` no Maven 3.8.1+), compilação em JDK 17 sem `<release>8</release>` permitindo APIs do Java 9+, e conflitos de fim de linha (`CRLF`/`LF`) entre WSL2 e Windows.
* **Resolução definida:**
  * Arquitetura com **núcleo headless** (CLI/API local com persistência de estado em SQLite) consumido por uma **interface visual fina**, permitindo testar em WSL2/Linux, empacotar para Windows depois e reutilizar o mesmo núcleo em CLI e web no futuro.
  * Execução de modificações em `git worktree` isolado por execução, com pré-checagem de ambiente (`java`, `mvn`, acesso ao Nexus, Gitea PAT/SSH, `core.autocrlf=input`), bloqueio de edição automática de `pom.xml`/`.gitlab-ci.yml`/`test-files/` e remoção de testes existentes, limite fixo de tentativas de correção no `mvn test` (ex.: máximo 3 iterações) e **revisão humana obrigatória** em dois momentos: aprovação/edição da `NC-<NT>` e conferência do diff antes do push/PR no Gitea.
  * Cache local das NTs coletadas do portal SVRS com importação manual de PDF/XSD como fallback caso o layout do portal mude ou fique indisponível.

---

### Contradições Inventivas e Resultado Final Ideal (TRIZ)

1. **Automação vs. Exatidão Fiscal (Validação Circular):** Separação entre diff determinístico (XSD oficial vs. AST dos mapas `tagPath` e `*Table`) e interpretação textual pela LLM, usando `SchemaFactory` como oráculo independente dos XMLs sintéticos de teste.
2. **Contexto da LLM vs. Restrição de Dados e Custo de Tokens:** Extração local de assinaturas Java, `tagPath`s e esqueletos estruturais + validação local completa com `test-files/` no `mvn test`, evitando trafegar XMLs extensos ou dados sensíveis para LLMs externas.
3. **Desktop WSL2/Windows Agora vs. CLI/Web Depois:** Núcleo headless único emitindo eventos de execução e persistindo estado local, servido a uma camada visual fina intercambiável, com adaptador de toolchain isolado para `mvn test`.

**Resultado Final Ideal (IFR):** O diff determinístico entre XSDs oficiais e o código Java aponta exatamente quais tags e colunas `*Table` faltam; a LLM traduz a NT para uma `NC-<NT>` revisável e aplica o patch estrutural com testes JUnit 5 validados por XSD + `mvn test` (incluindo regressão local em `test-files/`); e o desenvolvedor revisa o diff final antes da abertura automática do PR no Gitea.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Coleta, cache local e exibição inicial da tabela de últimas NTs e datas para os 8 DFes (NFe, BPe, MDFe, CTe, NF3e, NFCom, GTVe e NFCe) a partir do portal SVRS (`https://dfe-portal.svrs.rs.gov.br/`), com fallback para importação manual de PDF/XSD.
  * Registro configurável mapeando os 8 DFes aos seus repositórios dedicados no Gitea (`https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/...`).
  * Verificação de conformidade estrutural combinando diff determinístico (XSD oficial vs. AST do código Java) e análise por LLM para gerar `NC-<NT>` revisável e editável por humanos.
  * Aplicação de `NC-<NT>` aprovada em `git worktree` isolado: atualização de `nfe/` (`@JsonProperty`), `mapper/`, `table/` e testes unitários JUnit 5 obrigatórios (com fixtures sintéticas validadas via XSD + suíte existente em `test-files/`), validação via `mvn test` com limite de tentativas e gate humano de revisão do diff antes de abrir branch, commits e PR no Gitea.
  * Núcleo headless desacoplado (executável em WSL2/Linux e Windows) pronto para reutilização futura em CLI e aplicação web.

* **Out-of-Scope Non-Goals:**
  * Implementação de regras de validação semântica / autorização cruzada da SEFAZ (`cStat`) dentro dos parsers na v1 (permanecem apenas informativas na `NC-<NT>`).
  * Injeção de Spring Framework ou alteração da stack Java 8 pura das bibliotecas de parser.
  * Auto-merge de PRs, push direto em branch principal, alteração automática de `pom.xml`, alteração de `.gitlab-ci.yml` ou publicação automática de versões no Sonatype Nexus.
  * Envio automático de payloads XML brutos de `test-files/` com dados potencialmente reais para provedores externos de LLM.

## Alternatives Weighed

* **Abordagem 1 — Incluir geração automática de motor de validação semântica da SEFAZ na v1:** Descartada pelo autor após análise técnica, pois os parsers são bibliotecas estruturais de extração/achatamento e não possuem camada de validação nem Spring Framework.
* **Abordagem 2 — Aplicação sem oráculo XSD (100% baseada em LLM sobre PDF + código):** Descartada na análise técnica pelo risco de validação circular em tabelas complexas de PDFs da SEFAZ.
* **Abordagem 3 — Ferramenta exclusivamente CLI + Issues no Gitea sem app Desktop:** Levantada na revisão `egm-zoom-out` como corte máximo de escopo, mas mantido o requisito de aplicação desktop (com núcleo CLI/headless por baixo para preservar reuso futuro).

## Key Decisions & Staging for Next Steps

Decisões fechadas nesta etapa para orientar o design formal (`/egm:egm-draft`):

1. **Conformidade estrutural na v1:** Apenas mudanças de schema/tags/DTOs/tabelas e testes JUnit 5; regras semânticas da SEFAZ apenas documentadas na `NC-<NT>`.
2. **8 repositórios no Gitea:** Mapeamento configurável por DFe apontando para `https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/<repo>` (incluindo `nfce-parser` separado de `nfe-parser`).
3. **Oráculo XSD + `test-files/`:** Diff determinístico com XSDs do SVRS antes da LLM; `test-files/` usados localmente no `mvn test`, enquanto novos testes gerados pela LLM usam XMLs sintéticos validados por XSD sem trafegar XMLs extensos/reais para LLMs externas.
4. **Arquitetura headless + gates humanos:** Núcleo desacoplado da UI desktop (WSL2/Linux -> Windows -> futuro CLI/Web), com aprovação humana da `NC-<NT>` e conferência de diff obrigatória antes do PR no Gitea.
5. **Pontos de detalhe técnico a definir no `/egm:egm-draft`:** Escolha da stack da casca desktop + núcleo headless, estratégia de execução do `mvn test` (JDK/Maven no host vs. container `maven:3.8.7-eclipse-temurin-17` com `settings.xml` para o Nexus), provedor de LLM (externo vs. interno/local) e esquema detalhado do arquivo `NC-<NT>`.
