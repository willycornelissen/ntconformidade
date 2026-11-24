import type { LlmComplianceAnalysisInput, LlmPatchRequest } from '../ports/interfaces.js';

const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Estimates token count conservatively using a 4-chars-per-token heuristic. */
export function estimatePromptTokens(systemPrompt: string, userPrompt: string): number {
  const totalChars = systemPrompt.length + userPrompt.length;
  return totalChars === 0 ? 0 : Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE);
}

/** Extracts structured JSON from optional fenced markdown or surrounding prose safely. */
export function extractJsonFromLlmText(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fencedMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
      } catch {
        // Falls through to explicit domain error
      }
    }
    throw new Error('Conteúdo retornado pelo LLM não contém JSON estruturado válido');
  }
}

function formatJavaContextFiles(
  files: ReadonlyArray<{ readonly filePath: string; readonly content: string }>,
): string {
  return files
    .map((file) => `### Arquivo: ${file.filePath}\n\`\`\`java\n${file.content}\n\`\`\``)
    .join('\n\n');
}

/** Builds structured system/user prompts for compliance analysis producing an `NcDocument` JSON. */
export function buildComplianceAnalysisPrompt(input: LlmComplianceAnalysisInput): {
  readonly systemPrompt: string;
  readonly userPrompt: string;
} {
  const systemPrompt = [
    'Você é um arquiteto Java sênior especialista em documentos fiscais eletrônicos (SEFAZ/SVRS).',
    'Responda EXCLUSIVAMENTE com um objeto JSON válido com os campos obrigatórios:',
    'nc_id, nt_ref { dfe, nt_number, nt_version, published_date, pdf_sha256 }, base_commit_sha, no_structural_gaps,',
    'items [{ id, category (STRUCTURAL_MAPPER|STRUCTURAL_DTO|STRUCTURAL_TABLE|SHARED_XML_PARSER_BLOCKER|SEMANTIC_RULE_INFO_ONLY),',
    'decision (APPROVE|SKIP|EDIT), title, description, tagPath (string|null),',
    'targetPackage ("mapper"|"domain"|"table"|"xml-parser"|"none"|null), targetClass (string|null),',
    'diffKind ("MISSING_TAG"|"CARDINALITY_MISMATCH"|"TYPE_MISMATCH"|null),',
    'pdfCitations (string[]), suggestedChange (string|null), editedNotes (string|null), blockerReason (string|null) }],',
    'created_at (ISO 8601 UTC com Z), updated_at (ISO 8601 UTC com Z).',
    'Para itens SEMANTIC_RULE_INFO_ONLY use targetPackage="none" e diffKind=null.',
    'Inclua citações no formato "p. N" em pdfCitations para toda evidência extraída da NT.',
  ].join(' ');

  const pdfPagesText = input.pdf.segments
    .map(
      (segment) =>
        `### ${segment.title} (pp. ${segment.pageStart}-${segment.pageEnd}${
          segment.xmlGroupHint ? `, grupo=${segment.xmlGroupHint}` : ''
        })\n${segment.citedText}`,
    )
    .join('\n\n');

  const diffSummary =
    input.diffFindings.length === 0
      ? 'Nenhum gap estrutural detectado pelo oracle determinístico XSD × AST.'
      : JSON.stringify(input.diffFindings, null, 2);

  const userPrompt = [
    `## Repositório Alvo\nDFE: ${input.repo.dfe} (${input.repo.repoSlug})\nCommit base: ${input.baseCommitSha}`,
    `Pacotes: base=${input.repo.basePackage}, domain=${input.repo.domainPackage}, mapper=${input.repo.mapperPackage}, table=${input.repo.tablePackage}, parser=${input.repo.parserPackage}`,
    `## Nota Técnica\nID: ${input.nt.id}\nNT ${input.nt.ntNumber} v${input.nt.ntVersion} (${input.nt.publishedDate})\nPDF SHA-256: ${input.pdf.pdfSha256}`,
    `## Achados Determinísticos (XSD × AST)\n${diffSummary}`,
    `## Conteúdo da Nota Técnica\n${pdfPagesText}`,
    `## Contexto Java Allowlisted\n${formatJavaContextFiles(input.javaContextFiles)}`,
  ].join('\n\n');

  return { systemPrompt, userPrompt };
}

/** Builds structured system/user prompts for generating Java edits and synthetic JUnit/XML tests. */
export function buildPatchGenerationPrompt(input: LlmPatchRequest): {
  readonly systemPrompt: string;
  readonly userPrompt: string;
} {
  const systemPrompt = [
    'Você é um engenheiro Java 8 sênior mantendo parsers SEFAZ.',
    'Responda EXCLUSIVAMENTE com JSON válido: { "summary": string?, "edits": [{ "filePath", "searchBlock", "replaceBlock" }],',
    '"creates": [{ "filePath" (apenas src/test/java/*Test.java ou src/test/resources/synthetic/*.xml), "content" }] }.',
    'Use searchBlock exato existente no arquivo para edits; mantenha Java 8, dados sintéticos fictícios e preserve @JsonProperty existentes.',
  ].join(' ');

  const actionableItems = input.nc.items.filter((item) => item.decision !== 'SKIP');
  const sections = [
    `## NC Aprovada: ${input.nc.nc_id} (${input.nc.nt_ref.dfe} NT ${input.nc.nt_ref.nt_number} v${input.nc.nt_ref.nt_version})`,
    input.repo ? `## Repositório: ${input.repo.repoSlug} (base=${input.repo.basePackage})` : null,
    input.xsdSummary ? `## Resumo XSD Relevante\n${input.xsdSummary}` : null,
    `## Itens Acionáveis\n${JSON.stringify(actionableItems, null, 2)}`,
    `## Contexto Java Allowlisted\n${formatJavaContextFiles(input.javaContextFiles)}`,
  ].filter((section): section is string => Boolean(section));

  return { systemPrompt, userPrompt: sections.join('\n\n') };
}

/** Extends the patch generation prompt with Maven/guardrail failure feedback for bounded repair. */
export function buildPatchRepairPrompt(input: LlmPatchRequest): {
  readonly systemPrompt: string;
  readonly userPrompt: string;
} {
  const base = buildPatchGenerationPrompt(input);
  const feedback =
    input.repairFeedback?.trim() || 'Erro de compilação ou teste sintético na tentativa anterior.';
  return {
    systemPrompt: base.systemPrompt,
    userPrompt: `${base.userPrompt}\n\n## Diagnóstico da Falha Anterior (Corrija com Diff Mínimo)\n${feedback}`,
  };
}
