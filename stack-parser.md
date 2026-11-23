# Stack do `nfe-parser`

O projeto **nfe-parser** (`br.gov.mg.fazenda:nfe-parser:2.1.5`) é uma biblioteca Java baseada em **Apache Maven** para leitura de XMLs de NF-e/NFC-e e transformação tanto para modelos de domínio serializáveis em JSON quanto para estruturas tabulares achatadas.

## 1. Linguagem, Build e CI/CD

* **Linguagem / Target JVM:** Java 8 (`maven.compiler.source` e `maven.compiler.target` = `8`, encoding `UTF-8`), conforme [`nfe-parser/pom.xml`](nfe-parser/pom.xml).
* **Build e Empacotamento:** Apache Maven com `maven-assembly-plugin` gerando `jar-with-dependencies` na fase `package` (`nfe-parser/pom.xml`).
* **CI/CD e Repositórios:**
  * Pipeline GitLab CI usando a imagem `maven:3.8.7-eclipse-temurin-17` ([`nfe-parser/.gitlab-ci.yml`](nfe-parser/.gitlab-ci.yml)).
  * Publicação configurada para **Sonatype Nexus** interno (`maven-releases` e `maven-snapshots`) em `nfe-parser/pom.xml`, com suporte a autenticação via `CI_JOB_TOKEN` em [`nfe-parser/ci_settings.xml`](nfe-parser/ci_settings.xml).

## 2. Bibliotecas e Dependências

Conforme [`nfe-parser/pom.xml`](nfe-parser/pom.xml):

* **Parsing XML:**
  * **SAX (`javax.xml.parsers.SAXParserFactory` / `org.xml.sax`)**: engine SAX padrão do JDK para leitura baseada em eventos/streaming (ver [`NfceParserImplTest.java`](nfe-parser/src/test/java/br/gov/mg/fazenda/nfeparser/parser/NfceParserImplTest.java)).
  * **`br.gov.mg.fazenda:xml-parser:2.0.8`** (`compile`): biblioteca interna da SEF-MG que abstrai o SAX (`XmlParser`, `XmlHandler`, `XmlElement`, `XmlSearch`, `StringConverter`, `UnexpectedTagException`), convertendo o XML em uma lista de `XmlElement` identificados pelo caminho completo da tag (`tagPath`).
* **Produtividade / Boilerplate:**
  * **Project Lombok `1.18.30`** (`compile`): usado com `@Data`, `@Builder` e `@AllArgsConstructor` nos modelos, tabelas e implementações.
* **Serialização:**
  * **Jackson Annotations `2.15.1`** (`com.fasterxml.jackson.core:jackson-annotations`): anotações `@JsonProperty` nas classes de domínio (`nfe`) para preservar os nomes dos campos na serialização JSON (ver [`Nfe.java`](nfe-parser/src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java) e [`nfe-parser/release_notes.txt`](nfe-parser/release_notes.txt)).
* **Testes:**
  * **JUnit 5 (`junit-jupiter-engine:5.9.0` + `junit-platform-launcher:1.9.0`)** (`test`), executando testes sobre amostras XML de NF-e/NFC-e em `nfe-parser/src/test/resources/test-files/`.

## 3. Arquitetura Interna do Parser (`br.gov.mg.fazenda.nfeparser`)

* **`parser`** — Pontos de entrada e orquestração:
  * [`NfeParser.java`](nfe-parser/src/main/java/br/gov/mg/fazenda/nfeparser/parser/NfeParser.java) e [`NfeParserImpl.java`](nfe-parser/src/main/java/br/gov/mg/fazenda/nfeparser/parser/NfeParserImpl.java): recebem `InputStream`, extraem `List<XmlElement>` via `XmlParser`, normalizam prefixos (`NFE` e `PROC.NFEPROC` → `NFEPROC`) e delegam o preenchimento do grafo de objetos ao `NfeMapper`.
  * [`NfeTableParser.java`](nfe-parser/src/main/java/br/gov/mg/fazenda/nfeparser/parser/NfeTableParser.java) e [`DefaultNfeTableParser.java`](nfe-parser/src/main/java/br/gov/mg/fazenda/nfeparser/parser/DefaultNfeTableParser.java): achatam a lista hierárquica `List<Nfe>` em DTOs tabulares (`*Table`), incluindo campos fiscais de ICMS, IPI, PIS/COFINS, ISSQN, IS e IBS/CBS.
* **`mapper`** (ex.: [`NfeMapper.java`](nfe-parser/src/main/java/br/gov/mg/fazenda/nfeparser/mapper/NfeMapper.java)): mapeia `XmlElement` para objetos Java por meio de mapas `Map<String, BiConsumer<..., String>>` indexados pelo `tagPath` em caixa alta (ex.: `NFEPROC.NFE.INFNFE.IDE.CUF`) com conversões via `StringConverter`.
* **`nfe`** (ex.: [`Nfe.java`](nfe-parser/src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java)): entidades/DTOs hierárquicos com Lombok `@Data` e Jackson `@JsonProperty`.
* **`table`** (ex.: [`NfeTable.java`](nfe-parser/src/main/java/br/gov/mg/fazenda/nfeparser/table/NfeTable.java)): modelos relacionais/tabulares com Lombok `@Data` e `@Builder`.
* **`util`** ([`Cnpj.java`](nfe-parser/src/main/java/br/gov/mg/fazenda/nfeparser/util/Cnpj.java)): utilitário de codificação de CNPJ usado na geração das tabelas.
