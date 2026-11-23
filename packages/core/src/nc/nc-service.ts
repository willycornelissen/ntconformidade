import crypto from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  NcDocumentSchema,
  canApplyNc,
  hasActiveSharedParserBlocker,
  type NcDocument,
  type NcItem,
  type NcItemDecision,
} from '../domain/types.js';
import { readNoFollowUtf8 } from '../toolchain/exec-utils.js';

/** Result returned when persisting an `NC-<NT>` document and its Markdown preview. */
export interface SavedNcResult {
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly nc: NcDocument;
}

/** Deterministic readiness evaluation for proceeding with patch application. */
export interface NcReadinessCheck {
  readonly ready: boolean;
  readonly staleCommit: boolean;
  readonly stalePdf: boolean;
  readonly hasBlocker: boolean;
  readonly needsNoGapConfirmation: boolean;
  readonly reasons: readonly string[];
}

function sanitizeFilenameSegment(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/** Computes safe `.json` and `.md` paths for an NC inside `workspaceDir`. */
export function buildNcFilePaths(
  workspaceDir: string,
  ntNumber: string,
  ntVersion: string,
): { readonly jsonPath: string; readonly markdownPath: string } {
  const baseDir = path.resolve(workspaceDir);
  const safeNum = sanitizeFilenameSegment(ntNumber);
  const safeVer = sanitizeFilenameSegment(ntVersion);
  const stem = `NC-${safeNum}-v${safeVer}`;
  return {
    jsonPath: path.join(baseDir, `${stem}.json`),
    markdownPath: path.join(baseDir, `${stem}.md`),
  };
}

function formatNcItemMarkdown(item: NcItem): string {
  const citations = item.pdfCitations.length > 0 ? `[${item.pdfCitations.join(', ')}]` : '[sem citação]';
  const lines = [
    `### [${item.decision}] ${item.id} — ${item.title}`,
    `- **Categoria**: \`${item.category}\``,
    `- **Tag XSD**: \`${item.tagPath ?? 'N/A'}\``,
    `- **Alvo Java**: pacote=\`${item.targetPackage ?? 'none'}\`, classe=\`${item.targetClass ?? 'N/A'}\`, diff=\`${item.diffKind ?? 'N/A'}\``,
    `- **Citações PDF**: ${citations}`,
    `- **Descrição**: ${item.description}`,
  ];
  if (item.suggestedChange) {
    lines.push(`- **Alteração sugerida**: \`${item.suggestedChange}\``);
  }
  if (item.editedNotes) {
    lines.push(`- **Notas do operador**: ${item.editedNotes}`);
  }
  if (item.blockerReason) {
    lines.push(`- **BLOQUEIO SHARED_XML_PARSER_BLOCKER**: ${item.blockerReason}`);
  }
  return lines.join('\n');
}

/** One-way deterministic PT-BR Markdown renderer derived strictly from `NcDocument`. */
export function renderNcMarkdown(nc: NcDocument): string {
  const validated = NcDocumentSchema.parse(nc);
  const lines: string[] = [
    `# ${validated.nc_id}`,
    '',
    `- **DFE**: ${validated.nt_ref.dfe}`,
    `- **NT**: ${validated.nt_ref.nt_number} (v${validated.nt_ref.nt_version}, publicada em ${validated.nt_ref.published_date})`,
    `- **PDF SHA-256**: \`${validated.nt_ref.pdf_sha256}\``,
    `- **Commit base**: \`${validated.base_commit_sha}\``,
    `- **Status estrutural**: ${
      validated.no_structural_gaps
        ? `Sem gaps estruturais (confirmado=${String(validated.confirmed_no_gaps === true)})`
        : `${validated.items.length} item(ns) identificados`
    }`,
  ];

  if (validated.summary) {
    lines.push(`- **Resumo**: ${validated.summary}`);
  }
  if (hasActiveSharedParserBlocker(validated)) {
    lines.push(
      '',
      '> **ATENÇÃO — BLOQUEIO DE PARSER COMPARTILHADO**: existe item `SHARED_XML_PARSER_BLOCKER` ativo; aprovação/aplicação bloqueada até resolução ou `SKIP`.',
    );
  }
  if (validated.items.length > 0) {
    lines.push('', '## Itens de Conformidade', '');
    for (const item of validated.items) {
      lines.push(formatNcItemMarkdown(item), '');
    }
  }
  if (validated.semantic_notes && validated.semantic_notes.length > 0) {
    lines.push('## Notas Semânticas (Informativo)', '');
    for (const note of validated.semantic_notes) {
      lines.push(`- ${note}`);
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

async function atomicWriteText(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Persists `NC-<NT>.json` atomically as the single source of truth and
 * regenerates the one-way `NC-<NT>.md` human-readable preview.
 */
export async function saveNcDocument(workspaceDir: string, nc: NcDocument): Promise<SavedNcResult> {
  const validated = NcDocumentSchema.parse(nc);
  const { jsonPath, markdownPath } = buildNcFilePaths(
    workspaceDir,
    validated.nt_ref.nt_number,
    validated.nt_ref.nt_version,
  );
  await atomicWriteText(jsonPath, `${JSON.stringify(validated, null, 2)}\n`);
  await atomicWriteText(markdownPath, renderNcMarkdown(validated));
  return { jsonPath, markdownPath, nc: validated };
}

/** Loads and validates an `NC-<NT>.json` artifact from disk with `O_NOFOLLOW` symlink defense. */
export async function loadNcDocument(jsonPath: string): Promise<NcDocument> {
  const raw = await readNoFollowUtf8(jsonPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`JSON inválido em '${jsonPath}'`, { cause: error });
  }
  return NcDocumentSchema.parse(parsed);
}

/** Returns a new `NcDocument` with an item's operator decision (`APPROVE` | `SKIP` | `EDIT`) updated. */
export function updateNcItemDecision(
  nc: NcDocument,
  itemId: string,
  decision: NcItemDecision,
  editedNotes?: string | null,
  nowIso: string = new Date().toISOString(),
): NcDocument {
  const idx = nc.items.findIndex((item) => item.id === itemId);
  if (idx < 0) {
    throw new Error(`Item NC '${itemId}' não encontrado em '${nc.nc_id}'`);
  }
  const updatedItems = nc.items.map((item, i) =>
    i === idx
      ? {
          ...item,
          decision,
          editedNotes: editedNotes !== undefined ? editedNotes : item.editedNotes,
        }
      : item,
  );
  return NcDocumentSchema.parse({
    ...nc,
    items: updatedItems,
    updated_at: nowIso,
  });
}

/** Records explicit operator confirmation when `no_structural_gaps === true`. */
export function confirmNoStructuralGaps(
  nc: NcDocument,
  nowIso: string = new Date().toISOString(),
): NcDocument {
  if (!nc.no_structural_gaps) {
    throw new Error(
      `NC '${nc.nc_id}' possui gaps estruturais (no_structural_gaps=false) e não pode ser confirmada sem alterações`,
    );
  }
  return NcDocumentSchema.parse({
    ...nc,
    confirmed_no_gaps: true,
    confirmed_at: nowIso,
    updated_at: nowIso,
  });
}

/** Evaluates commit SHA staleness, PDF SHA staleness, parser blockers, and no-gap confirmation. */
export function checkNcReadiness(
  nc: NcDocument,
  currentHeadSha: string,
  currentPdfSha256: string,
): NcReadinessCheck {
  const reasons: string[] = [];
  const staleCommit = nc.base_commit_sha !== currentHeadSha;
  const stalePdf = nc.nt_ref.pdf_sha256 !== currentPdfSha256;
  const hasBlocker = !canApplyNc(nc);
  const needsNoGapConfirmation = nc.no_structural_gaps && nc.confirmed_no_gaps !== true;

  if (staleCommit) {
    reasons.push(
      `base_commit_sha desatualizado (${nc.base_commit_sha} != ${currentHeadSha}); reanalisar NC.`,
    );
  }
  if (stalePdf) {
    reasons.push('pdf_sha256 divergente do artefato atual; reanalisar NC.');
  }
  if (hasBlocker) {
    reasons.push('Existe bloqueio SHARED_XML_PARSER_BLOCKER ativo aguardando resolução ou SKIP.');
  }
  if (needsNoGapConfirmation) {
    reasons.push('NC marcada como no_structural_gaps=true requer confirmação explícita do operador.');
  }

  return {
    ready: reasons.length === 0,
    staleCommit,
    stalePdf,
    hasBlocker,
    needsNoGapConfirmation,
    reasons,
  };
}
