# Ideia
Desenvolver uma aplicação desktop que permita validar a conformidade de repositórios de código (parsers) de documentos fiscais eletrônicos com notas técnicas publicadas por autoridades fiscais.

# Documentos Fiscais abrangidos

- NFe
- BPe
- MDFe
- CTe
- NF3e
- NFCom
- GTVe
- NFCe

# Características

* O aplicativo começa mostrando com um design atraente e eficiente, uma tabela com as últimas notas técnicas e suas respectivas datas para cada um dos documentos fiscais considerados por este aplicativo

* O aplicativo deve permitir invocar, para cada documento fiscal, a verificação de conformidade com uma determinada nota técnica em relação a um repositório de . Uma lista das notas técnicas de um determinado documento fiscal pode ser mostrada, permitindo invocar uma ação de verificação de conformidade e geração de uma nota de conformidade (NC) com o mesmo nome da nota técnica, mas com o prefixo NC.

* Cada NC pode ser aplicada aos parsers, gerando uma branch ao versionamento de código daquele parser com todos os commits e um PR (Pull Request). Antes da geração do pull request, o código corrigido foi testado pelo passo de conformidade anterior. 

* A aplicação deve usar o padrão de projeto BYOK que permita especificar o modelo e o usuário que vai fornecer os tokens. A versão final vai rodar usando o Github Copilot, mas o desenvolvimento atual está sendo feito usando o modelo Gemini 4 Hydrogen no Antigravity. 

