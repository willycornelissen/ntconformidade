# Estrutura da Nota Técnica de Exemplo — NT 2026.005 (v1.00)

Documento analisado: [`nt-nfe.pdf`](nt-nfe.pdf)  
Título: **Reforma Tributária do Consumo – Simples Nacional**  
Referência legal: **Lei Complementar nº 214/2025** (e art. 23 da LC nº 123/2006 no contexto do evento fiscal)  
Publicação: **Outubro de 2026** | Modelos abrangidos: **NF-e (55) e NFC-e (65)** | Órgãos: **CGIBS, Receita Federal e ENCAT**

---

## 1. Controle de Versões e Cronograma

| Versão | Escopo | Homologação / Teste | Produção |
| :--- | :--- | :--- | :--- |
| **1.00** | Criação de campos relacionados à tributação do Simples Nacional | Até **26/10/2026** | **16/11/2026** |
| **1.00** | Criação do Evento Tributação do Simples Nacional (`tpEvento = 412140`) | Implementação Futura | Implementação Futura |

---

## 2. Objetivo e Visão Geral

A NT 2026.005 adapta os leiautes da NF-e (modelo 55) e da NFC-e (modelo 65) às regras da Reforma Tributária do Consumo (LC nº 214/2025) para operações de contribuintes **optantes pelo Simples Nacional** (ou do Regime Normal com pedido de opção pendente).

O foco é viabilizar a **apuração assistida** do Simples Nacional, capturando por item as informações necessárias para o cálculo da:
- **RBSN** (Receita Bruta do Simples Nacional) e **RBT12** (Receita Bruta Total acumulada nos últimos 12 meses);
- Tributação de **IBS** e **CBS** aplicável ao Simples Nacional.

Os novos elementos permitem identificar:
1. Situação cadastral e regime de apuração IBS/CBS do emitente (`tpRegimeIBSCBS`);
2. Atividade econômica por item (`cAtivSN`);
3. Composição da tributação IBS/CBS no Simples Nacional por item (`gTribSN`) e nos totais (`total/IBSCBSTot/gTribSN`);
4. Evento fiscal automático de conformidade gerado pelo Fisco (`tpEvento = 412140`).

---

## 3. Orientações de Preenchimento

### 3.1. `tpRegimeIBSCBS` (tag `C21a`)
- **`1`**: Contribuinte do Simples Nacional (`CRT = 1` ou `2`) optante pelo Regime Regular do IBS/CBS.
- **`2`**: Regime Normal (`CRT = 3`) com solicitação pendente pelo Simples Nacional (`CRT = 1`) e **não optante** pelo regime regular do IBS/CBS.
- **`3`**: Regime Normal (`CRT = 3`) com solicitação pendente pelo Simples Nacional por excesso de sublimite (`CRT = 2`) e **não optante** pelo regime regular do IBS/CBS.
- **`4`**: Regime Normal (`CRT = 3`) com solicitação pendente pelo Simples Nacional (migrará para `CRT = 1` ou `2`) e **optante** pelo regime regular do IBS/CBS.
- **Demais casos:** não informar a tag. Contribuintes com solicitação pendente são tratados como regime regular para transferência de crédito, devolução e apuração.

### 3.2. `cAtivSN` (tag `I17d`)
- Deve ser informado por item quando `CRT = 1` ou `2`, ou quando `CRT = 3` com `tpRegimeIBSCBS` igual a `2`, `3` ou `4`.

### 3.3. Matriz de Preenchimento (`gIBSCBS` vs. `gTribSN`)

| Regime de Apuração do Emitente | `CRT` | `tpRegimeIBSCBS` | `cAtivSN` | `gIBSCBS` (quando exigido pelo CST) | `gTribSN` |
| :--- | :---: | :---: | :---: | :--- | :--- |
| Simples Nacional com Regime Regular do IBS/CBS | `1` | `"1"` | Informar | `gIBSUF`, `gIBSMun`, `gCBS` | Não informar |
| Simples Nacional, excesso sublimite com Regime Regular do IBS/CBS | `2` | `"1"` | Informar | `gIBSUF`, `gIBSMun`, `gCBS` | Não informar |
| Simples Nacional sem Regime Regular do IBS/CBS | `1` | Não informar | Informar | Não informar | `gIBSSN`, `gCBSSN` |
| Simples Nacional, excesso sublimite sem Regime Regular do IBS/CBS | `2` | Não informar | Informar | `gIBSUF`, `gIBSMun`, `gCBS` (alíquota zerada) | `gCBSSN` |
| Regime Normal com opção pendente (`CRT=1`) sem regime regular IBS/CBS | `3` | `"2"` | Informar | `gIBSUF`, `gIBSMun`, `gCBS` | `gIBSSN`, `gCBSSN` |
| Regime Normal com opção pendente (`CRT=2`) sem regime regular IBS/CBS | `3` | `"3"` | Informar | `gIBSUF`, `gIBSMun`, `gCBS` | `gCBSSN` |
| Regime Normal com opção pendente (`CRT=1` ou `2`) com regime regular IBS/CBS | `3` | `"4"` | Informar | `gIBSUF`, `gIBSMun`, `gCBS` | Não informar |

**Exceções:**
- **Combustíveis Monofásicos (`CST = 620`, art. 172 da LC 214/25):** preencher `gIBSCBSMono` e **não** preencher `gTribSN`.
- **MEI (`CRT = 4`):** não deve informar o grupo `IBSCBS`.
- **Devolução / Retorno por recusa:** o grupo `IBSCBS` do item deve espelhar a nota de fornecimento referenciada nos casos de `finNFe = 4` (Devolução), `finNFe = 5` com `tpNFCredito = 03` ou `06`, e `finNFe = 6` com `tpNFDebito = 09`.

---

## 4. Alterações no Leiaute da NF-e (Modelos 55 e 65)

### 4.1. Grupo C — Identificação do Emitente (`emit` / `C01`)

| # | ID | Campo | Ele | Pai | Tipo | Ocor. | Tam. | Valores / Descrição |
| :---: | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| 49b | `C21a` | `tpRegimeIBSCBS` | E | `C01` | N | 0-1 | 1 | Tipo de Regime de Apuração do IBS e da CBS (`1`, `2`, `3`, `4`) |

### 4.2. Grupo I — Produtos e Serviços (`prod` / `I01`)

| # | ID | Campo | Ele | Pai | Tipo | Ocor. | Tam. | Valores / Descrição |
| :---: | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| 116d | `I17d` | `cAtivSN` | E | `I01` | C | 0-1 | 2 | Código de atividade do Simples Nacional: `01` (Anexo I revenda/ind.), `02` (Anexo I sem ICMS), `03` (Anexo II ZFM), `04` (Anexo II ZFM sem ICMS), `90` (Operações não tributáveis) |

### 4.3. Grupo UB — Tributos IBS / CBS e Imposto Seletivo (pai `UB12`)

| # | ID | Campo | Ele | Pai | Tipo | Ocor. | Tam. | Descrição / Regra |
| :---: | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| 324.115a | `UB115a` | `gTribSN` | G | `UB12` | - | 0-1 | - | Grupo de informações da composição de IBS/CBS para o Simples Nacional |
| 324.115b | `UB115b` | `gIBSSN` | G | `UB115a` | - | 0-1 | - | Composição do valor do IBS para o Simples Nacional |
| 324.115c | `UB115c` | `pIBSSN` | E | `UB115b` | N | 1-1 | 3v2-4 | Alíquota efetiva do IBS (2027–2028 em Compra Gov.: `0` se `tpEnteGov = 1-União`; alíquota efetiva IBS nos demais) |
| 324.115d | `UB115d` | `vIBSSN` | E | `UB115b` | N | 1-1 | 13v2 | Valor do IBS para optantes do Simples Nacional |
| 324.115e | `UB115e` | `gCBSSN` | G | `UB115a` | - | 1-1 | - | Composição do valor da CBS para o Simples Nacional |
| 324.115f | `UB115f` | `pCBSSN` | E | `UB115e` | N | 1-1 | 3v2-4 | Alíquota efetiva da CBS (2027–2028 em Compra Gov.: soma IBS+CBS se `tpEnteGov = 1-União`; alíquota efetiva CBS nos demais) |
| 324.115g | `UB115g` | `vCBSSN` | E | `UB115e` | N | 1-1 | 13v2 | Valor da CBS para optantes do Simples Nacional |

### 4.4. Grupo W03 — Total da NF-e - IBS / CBS / IS (`IBSCBSTot` / `W34`)

| # | ID | Campo | Ele | Pai | Tipo | Ocor. | Tam. | Descrição |
| :---: | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| 355.29h | `W59h` | `gTribSN` | G | `W34` | - | 0-1 | - | Grupo de totais de IBS/CBS para o Simples Nacional |
| 355.29i | `W59i` | `vIBSSN` | E | `W59h` | N | 1-1 | 13v2 | Valor Total do IBS para os Optantes do Simples Nacional |
| 355.29j | `W59j` | `vCBSSN` | E | `W59h` | N | 1-1 | 13v2 | Valor Total da CBS para os Optantes do Simples Nacional |

---

## 5. Regras de Validação (Grupo W03 — Modelos 55 e 65)

Todas as regras abaixo são **obrigatórias** e verificam consistência entre `total/IBSCBSTot/gTribSN` (`W59h`) e os itens (`UB115a`):

| Regra | Cód. Rejeição | Condição de Rejeição | Mensagem |
| :--- | :---: | :--- | :--- |
| `W59h-10` | **1275** | Grupo `W59h` não informado quando pelo menos um item possui `gTribSN` (`UB115a`) | Grupo de totais do IBS e da CBS para o Simples Nacional não informado |
| `W59h-20` | **1276** | Grupo `W59h` informado quando nenhum item possui `gTribSN` (`UB115a`) | Grupo de totais do IBS e da CBS para o Simples Nacional informado indevidamente |
| `W59i-10` | **1277** | `W59i` (`vIBSSN`) difere da soma de `UB115d` (`vIBSSN`) dos itens | Total do IBS para o Simples Nacional difere da soma dos itens |
| `W59j-10` | **1284** | `W59j` (`vCBSSN`) difere da soma de `UB115g` (`vCBSSN`) dos itens | Total da CBS para o Simples Nacional difere da soma dos itens |

---

## 6. Evento: Tributação do Simples Nacional (`tpEvento = 412140`)

- **Autor:** Administração Tributária (`tpAutor = 5-Fisco`), gerado automaticamente pelo CGIBS/RFB para composição de receita bruta, confissão de dívida e eventual geração de crédito IBS/CBS (art. 23 da LC 123/06).
- **Web Service:** Parte Geral (`NFeRecepcaoEvento`, seção 5.8 do MOC) + parte específica em `detEvento` (`P17`).
- **Schemas XML:** `envEventoNFe_v9.99.xsd` e `e412140_v1.00.xsd`.
- **Cancelamento:** realizado via evento genérico **`110001` - Cancelamento de Evento**.

### Estrutura XML da Parte Específica (`detEvento` / `P17`)

| # | Campo | Ele | Pai | Tipo | Ocor. | Tam. | Descrição |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| P17 | `detEvento` | G | `P06` | - | 1-1 | - | Detalhes do Evento |
| P18 | `versao` | A | `P17` | N | 1-1 | 2v2 | Versão do leiaute do evento |
| P19 | `descEvento` | E | `P17` | C | 1-1 | 47 | `"Tributação do Simples Nacional"` |
| P20 | `cOrgaoAutor` | E | `P17` | N | 1-1 | 2 | Código do Órgão Autor do Evento |
| P21 | `tpAutor` | E | `P17` | N | 1-1 | 1 | Informar `5=Fisco` |
| P22 | `verAplic` | E | `P17` | N | 1-1 | 1-20 | Versão do aplicativo do autor |
| P23 | `gTribItemSN` | G | `P17` | - | 1-990 | - | Detalhamento dos tributos por item |
| P24 | `nItem` | A | `P23` | N | 1-1 | 1-3 | Número do item (`1-990`) |
| P26 | `vRBSNitem` | E | `P23` | N | 1-1 | 13v2 | Receita bruta do Simples Nacional atribuída ao item |
| P27 | `tpRBSN` | E | `P23` | N | 1-1 | 1 | Tipo de RBSN (`0`=Não é RB; `1`=Interna; `2`=Interna sem IBS/CBS; `3`=Exp. direta; `4`=Exp. indireta; `5`=Mercado interno e exp.; `9`=Incompatível com SN) |
| P28 | `pIBSSN` | E | `P23` | N | 0-1 | 3v2-4 | Alíquota aplicável de IBS do item |
| P29 | `vIBSSN` | E | `P23` | N | 0-1 | 13v2 | Valor do IBS devido pelo Simples Nacional |
| P30 | `pCBSSN` | E | `P23` | N | 0-1 | 3v2-4 | Alíquota aplicável de CBS do item |
| P31 | `vCBSSN` | E | `P23` | N | 0-1 | 13v2 | Valor da CBS devida pelo Simples Nacional |
| P32 | `vIBSPendSusp` | E | `P23` | N | 0-1 | 13v2 | Valor do IBS pendente ou suspenso do item |
| P33 | `vCBSPendSusp` | E | `P23` | N | 0-1 | 13v2 | Valor da CBS pendente ou suspenso do item |
| P34 | `gTotalSN` | G | `P17` | - | 1-1 | - | Totais da NF-e |
| P35 | `vRBSNtot` | E | `P34` | N | 1-1 | 13v2 | Valor total da receita bruta do Simples Nacional |
| P36 | `vIBSSNtot` | E | `P34` | N | 0-1 | 13v2 | Valor total do IBS devido apurado |
| P37 | `vIBSSNtotPendSusp` | E | `P34` | N | 0-1 | 13v2 | Valor total do IBS pendente ou com exigibilidade suspensa |
| P38 | `vCBSSNtot` | E | `P34` | N | 0-1 | 13v2 | Valor total da CBS devida apurada |
| P39 | `vCBSSNtotPendSusp` | E | `P34` | N | 0-1 | 13v2 | Valor total da CBS pendente ou com exigibilidade suspensa |
