import { describe, it, expect, expectTypeOf } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DfeRegistrySchema,
  DfeRepoEntrySchema,
  ComplianceRunSchema,
  ExtractXsdResultSchema,
  ValidateXmlResultSchema,
  OracleRegistryEntrySchema,
  ExtractJavaAstResultSchema,
  NcDocumentSchema,
  PatchPayloadSchema,
  ByokConfigSchema,
  DoctorReportSchema,
  SurefireSummarySchema,
  PreBuildDiffPreviewSchema,
  RunProgressEventSchema,
  ALLOWED_RUN_TRANSITIONS,
  canTransitionRunStatus,
  assertValidRunTransition,
  canApplyNc,
  hasActiveSharedParserBlocker,
  aggregateTokenUsage,
  toOracleRegistryEntry,
  GITEA_PAT_SECRET_KEY,
  llmSecretKey,
  type NtSourcePort,
  type OracleAnalyzerPort,
  type LlmGatewayPort,
  type GitMavenForgePort,
  type SecretStorePort,
} from '../src/index.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..', '..');

const BASE_RUN = {
  runId: 'run-001',
  dfe: 'NFe' as const,
  ntId: 'NFe:2026.005:v1.00',
  status: 'DRAFT' as const,
  failedStep: null,
  errorMessage: null,
  operatorName: 'willy',
  provider: 'gemini' as const,
  modelId: 'gemini-2.5-pro',
  baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
  branchName: 'nc/nfe-2026-005-v1-00',
  ncJsonPath: 'ncs/NC-2026.005.json',
  prUrl: null,
  tokenUsage: { promptTokens: 1200, completionTokens: 450, totalTokens: 1650, stage: 'analyze' },
  createdAt: '2026-11-19T12:00:00.000Z',
  updatedAt: '2026-11-19T12:00:00.000Z',
};

describe('Ciclo 1 — Contratos de Domínio, Estados e Portas', () => {
  it('DT-01 aceita todas as transições válidas dos 5 estados', () => {
    expect(Object.isFrozen(ALLOWED_RUN_TRANSITIONS)).toBe(true);
    expect(canTransitionRunStatus('DRAFT', 'APPROVED')).toBe(true);
    expect(canTransitionRunStatus('DRAFT', 'FAILED')).toBe(true);
    expect(canTransitionRunStatus('APPROVED', 'TESTED')).toBe(true);
    expect(canTransitionRunStatus('APPROVED', 'FAILED')).toBe(true);
    expect(canTransitionRunStatus('TESTED', 'PR_OPENED')).toBe(true);
    expect(canTransitionRunStatus('TESTED', 'FAILED')).toBe(true);

    expect(() => assertValidRunTransition('DRAFT', 'APPROVED')).not.toThrow();
    expect(() => assertValidRunTransition('TESTED', 'PR_OPENED')).not.toThrow();
  });

  it('DT-02 rejeita saltos, retornos, self-loops e saídas de estados terminais', () => {
    const invalidPairs: Array<['DRAFT' | 'APPROVED' | 'TESTED' | 'PR_OPENED' | 'FAILED', 'DRAFT' | 'APPROVED' | 'TESTED' | 'PR_OPENED' | 'FAILED']> = [
      ['DRAFT', 'TESTED'],
      ['DRAFT', 'PR_OPENED'],
      ['DRAFT', 'DRAFT'],
      ['APPROVED', 'DRAFT'],
      ['APPROVED', 'PR_OPENED'],
      ['TESTED', 'APPROVED'],
      ['PR_OPENED', 'FAILED'],
      ['PR_OPENED', 'TESTED'],
      ['FAILED', 'DRAFT'],
      ['FAILED', 'APPROVED'],
    ];

    for (const [from, to] of invalidPairs) {
      expect(canTransitionRunStatus(from, to)).toBe(false);
      expect(() => assertValidRunTransition(from, to)).toThrow(/Transição/i);
    }
  });

  it('DT-03 exige failedStep e errorMessage preenchidos quando status === FAILED', () => {
    expect(
      ComplianceRunSchema.safeParse({
        ...BASE_RUN,
        status: 'FAILED',
        failedStep: 'MAVEN_TEST',
        errorMessage: 'Falha em teste legado',
      }).success,
    ).toBe(true);

    expect(
      ComplianceRunSchema.safeParse({
        ...BASE_RUN,
        status: 'FAILED',
        failedStep: null,
        errorMessage: 'Erro qualquer',
      }).success,
    ).toBe(false);

    expect(
      ComplianceRunSchema.safeParse({
        ...BASE_RUN,
        status: 'FAILED',
        failedStep: 'SVRS_SYNC',
        errorMessage: '   ',
      }).success,
    ).toBe(false);

    expect(ComplianceRunSchema.safeParse({ ...BASE_RUN, branchName: '--upload-pack=evil' }).success).toBe(false);
    expect(ComplianceRunSchema.safeParse({ ...BASE_RUN, ncJsonPath: '../../etc/passwd' }).success).toBe(false);
  });

  it('DT-04 valida config/dfe-registry.default.json real com os 8 DFes e nfce-parser separado', async () => {
    const raw = await fs.readFile(path.join(ROOT_DIR, 'config', 'dfe-registry.default.json'), 'utf8');
    const parsed = DfeRegistrySchema.parse(JSON.parse(raw));
    expect(parsed).toHaveLength(8);
    expect(new Set(parsed.map((e) => e.repoSlug)).size).toBe(8);
    expect(parsed.find((e) => e.dfe === 'NFCe')?.repoSlug).toBe('nfce-parser');
    expect(parsed.find((e) => e.dfe === 'NFe')?.repoSlug).toBe('nfe-parser');
  });

  it('DT-05 rejeita DFe desconhecido, URL Gitea insegura e tagPrefix em minúsculas', () => {
    const validBase = {
      dfe: 'NFe',
      repoSlug: 'nfe-parser',
      giteaUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser',
      baseBranch: 'main',
      basePackage: 'br.gov.mg.fazenda.nfeparser',
      domainPackage: 'br.gov.mg.fazenda.nfeparser.nfe',
      mapperPackage: 'br.gov.mg.fazenda.nfeparser.mapper',
      tablePackage: 'br.gov.mg.fazenda.nfeparser.table',
      parserPackage: 'br.gov.mg.fazenda.nfeparser.parser',
      utilPackage: null,
      tagPrefix: 'NFEPROC',
      svrsRelativePath: '/Nfe/Documentos',
      baselineNt: null,
    };

    expect(DfeRepoEntrySchema.safeParse({ ...validBase, dfe: 'NFSe' }).success).toBe(false);
    expect(DfeRepoEntrySchema.safeParse({ ...validBase, giteaUrl: 'http://gitea.local/nfe' }).success).toBe(false);
    expect(
      DfeRepoEntrySchema.safeParse({ ...validBase, giteaUrl: 'https://user:pass@gitea.local/nfe' }).success,
    ).toBe(false);
    expect(DfeRepoEntrySchema.safeParse({ ...validBase, tagPrefix: 'nfeproc' }).success).toBe(false);
    expect(DfeRepoEntrySchema.safeParse({ ...validBase, svrsRelativePath: 'Nfe/Documentos' }).success).toBe(false);
  });

  it('DT-06 valida contratos XSD alinhados ao OracleDtos (incluindo maxOccurs 0 e unbounded)', () => {
    expect(
      ExtractXsdResultSchema.safeParse({
        rootElements: ['NFEPROC'],
        nodes: [
          { tagPath: 'NFEPROC.NFE.INFNFE.VERSAO', xsdType: 'TVerNFe', minOccurs: 1, maxOccurs: 1, isAttribute: true },
          { tagPath: 'NFEPROC.NFE.INFNFE.DET', xsdType: 'TNFe_Det', minOccurs: 1, maxOccurs: 'unbounded', isAttribute: false },
          { tagPath: 'NFEPROC.NFE.INFNFE.OBSOLETE', xsdType: 'xs:string', minOccurs: 0, maxOccurs: 0, isAttribute: false },
        ],
      }).success,
    ).toBe(true);

    expect(
      ExtractXsdResultSchema.safeParse({
        rootElements: [],
        nodes: [{ tagPath: 'A', xsdType: 'xs:string', minOccurs: -1, maxOccurs: 1, isAttribute: false }],
      }).success,
    ).toBe(false);

    expect(
      ExtractXsdResultSchema.safeParse({
        rootElements: ['A'],
        nodes: [{ tagPath: 'A', xsdType: 'xs:string', minOccurs: 0, maxOccurs: 'many', isAttribute: false }],
      }).success,
    ).toBe(false);
  });

  it('DT-07 valida contratos ValidateXmlResult e ExtractJavaAstResult do OracleDtos', () => {
    expect(ValidateXmlResultSchema.safeParse({ valid: true, errors: [] }).success).toBe(true);
    expect(
      ValidateXmlResultSchema.safeParse({
        valid: false,
        errors: [{ line: 6, column: 24, message: 'cvc-complex-type.2.4.a' }],
      }).success,
    ).toBe(true);
    expect(
      ValidateXmlResultSchema.safeParse({
        valid: false,
        errors: [{ line: 0, column: 1, message: 'bad line' }],
      }).success,
    ).toBe(false);

    expect(
      ExtractJavaAstResultSchema.safeParse({
        setterKeys: [
          { fullTagPath: 'NFEPROC.NFE.INFNFE.IDE.CUF', leafTag: 'CUF', mapperClass: 'NfeMapper', targetDtoField: 'cuf' },
        ],
        jsonProperties: [{ className: 'Item', fieldName: 'cProd', jsonName: 'cProd' }],
        tableFields: [{ tableClass: 'ItemTable', fieldName: 'cfop' }],
      }).success,
    ).toBe(true);

    const oracleReg = OracleRegistryEntrySchema.parse({
      dfe: 'NFe',
      basePackage: 'br.gov.mg.fazenda.nfeparser',
      domainPackage: 'br.gov.mg.fazenda.nfeparser.nfe',
      mapperPackage: 'br.gov.mg.fazenda.nfeparser.mapper',
      tablePackage: 'br.gov.mg.fazenda.nfeparser.table',
      parserPackage: 'br.gov.mg.fazenda.nfeparser.parser',
      utilPackage: 'br.gov.mg.fazenda.nfeparser.util',
      tagPrefix: 'NFEPROC',
      extraIgnoredProp: 'ok',
    });
    expect(oracleReg.dfe).toBe('NFe');
  });

  it('DT-08 e DT-09 validam NcDocument, data calendário e bloqueio de SHARED_XML_PARSER_BLOCKER', () => {
    const baseNc = {
      nc_id: 'NC-2026.005-v1.00',
      nt_ref: {
        dfe: 'NFe' as const,
        nt_number: '2026.005',
        nt_version: 'v1.00',
        published_date: '2026-10-26',
        pdf_sha256: 'a'.repeat(64),
      },
      base_commit_sha: '0123456789abcdef0123456789abcdef01234567',
      no_structural_gaps: false,
      items: [
        {
          id: 'item-1',
          category: 'STRUCTURAL_MAPPER' as const,
          decision: 'APPROVE' as const,
          title: 'Mapear tag cCredPres',
          description: 'Nova tag no grupo IBSCBS',
          tagPath: 'NFEPROC.NFE.INFNFE.DET.IMPOSTO.IBSCBS.CCREDPRES',
          targetPackage: 'mapper' as const,
          targetClass: 'IbsCbsMapper',
          diffKind: 'MISSING_TAG' as const,
          pdfCitations: ['[p. 12]'],
          suggestedChange: 'Adicionar entrada em FIELD_SETTERS',
          editedNotes: null,
          blockerReason: null,
        },
        {
          id: 'item-2',
          category: 'SHARED_XML_PARSER_BLOCKER' as const,
          decision: 'APPROVE' as const,
          title: 'Atributo novo em XmlElement',
          description: 'Requer alteração em br.gov.mg.fazenda:xml-parser',
          tagPath: null,
          targetPackage: 'xml-parser' as const,
          targetClass: null,
          diffKind: null,
          pdfCitations: ['[p. 4]'],
          suggestedChange: null,
          editedNotes: null,
          blockerReason: 'Dependência compartilhada fora do escopo do repositório',
        },
      ],
      created_at: '2026-11-19T12:00:00.000Z',
      updated_at: '2026-11-19T12:00:00-03:00',
    };

    const parsedWithBlocker = NcDocumentSchema.parse(baseNc);
    expect(hasActiveSharedParserBlocker(parsedWithBlocker)).toBe(true);
    expect(canApplyNc(parsedWithBlocker)).toBe(false);

    const parsedWithSkippedBlocker = NcDocumentSchema.parse({
      ...baseNc,
      items: [baseNc.items[0], { ...baseNc.items[1], decision: 'SKIP' as const }],
    });
    expect(hasActiveSharedParserBlocker(parsedWithSkippedBlocker)).toBe(false);
    expect(canApplyNc(parsedWithSkippedBlocker)).toBe(true);

    expect(
      NcDocumentSchema.safeParse({
        ...baseNc,
        nt_ref: { ...baseNc.nt_ref, published_date: '2026-02-31' },
      }).success,
    ).toBe(false);
  });

  it('DT-10 e DT-11 validam PatchPayload e rejeitam traversal, creates fora de synthetic/Test e searchBlock vazio', () => {
    expect(
      PatchPayloadSchema.safeParse({
        edits: [
          {
            filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/mapper/NfeMapper.java',
            searchBlock: 'NFE_FIELD_SETTERS.put("A", (n, v) -> n.setA(v));',
            replaceBlock: 'NFE_FIELD_SETTERS.put("A", (n, v) -> n.setA(v));',
          },
        ],
        creates: [
          {
            filePath: 'src/test/java/br/gov/mg/fazenda/nfeparser/Nt2026005Test.java',
            content: 'class Nt2026005Test {}',
          },
          {
            filePath: 'src/test/resources/synthetic/nt2026005_valid.xml',
            content: '<nfeProc/>',
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      PatchPayloadSchema.safeParse({
        edits: [],
        creates: [{ filePath: 'src/main/java/Hack.java', content: 'class Hack {}' }],
      }).success,
    ).toBe(false);

    for (const badPath of [
      '../pom.xml',
      'src/test/resources/test-files/real.xml',
      'src\\main\\java\\A.java',
      'src/main/java/\u0000A.java',
      '/etc/passwd',
      './src/main/java/./A.java',
    ]) {
      expect(
        PatchPayloadSchema.safeParse({
          edits: [{ filePath: badPath, searchBlock: 'a', replaceBlock: 'b' }],
          creates: [],
        }).success,
      ).toBe(false);
    }

    expect(
      PatchPayloadSchema.safeParse({
        edits: [{ filePath: 'src/main/java/A.java', searchBlock: '', replaceBlock: 'b' }],
        creates: [],
      }).success,
    ).toBe(false);
  });

  it('DT-12 valida ByokConfig (.strict), IPv6 [::1] e rejeita tokens inline ou SSRF privado', () => {
    expect(
      ByokConfigSchema.safeParse({
        provider: 'gemini',
        modelId: 'gemini-2.5-pro',
        operatorName: 'willy',
        secretKeyRef: 'byok:gemini',
      }).success,
    ).toBe(true);

    expect(
      ByokConfigSchema.safeParse({
        provider: 'openai-compatible',
        modelId: 'gpt-4o',
        operatorName: 'willy',
        secretKeyRef: 'byok:openai',
        baseUrl: 'http://localhost:11434/v1',
      }).success,
    ).toBe(true);

    expect(
      ByokConfigSchema.safeParse({
        provider: 'openai-compatible',
        modelId: 'gpt-4o',
        operatorName: 'willy',
        secretKeyRef: 'byok:openai',
        baseUrl: 'http://[::1]:11434/v1',
      }).success,
    ).toBe(true);

    expect(
      ByokConfigSchema.safeParse({
        provider: 'openai-compatible',
        modelId: 'gpt-4o',
        operatorName: 'willy',
        secretKeyRef: 'byok:openai',
        baseUrl: 'http://127.0.0.1:8080/v1',
      }).success,
    ).toBe(true);

    expect(
      ByokConfigSchema.safeParse({
        provider: 'github-copilot',
        modelId: 'gpt-4.1',
        operatorName: 'willy',
        secretKeyRef: 'byok:github-copilot',
        authMode: 'github-models-pat',
      }).success,
    ).toBe(true);

    // Proibido embutir segredo inline
    expect(
      ByokConfigSchema.safeParse({
        provider: 'gemini',
        modelId: 'gemini-2.5-pro',
        operatorName: 'willy',
        secretKeyRef: 'byok:gemini',
        apiKey: 'AIzaSyInlineSecret',
      }).success,
    ).toBe(false);

    // Proibidos http remoto, credenciais em URL e IPs privados/metadata/ULA/mapped-IPv6 em HTTPS
    for (const badUrl of [
      'http://evil.example.com/v1',
      'https://user:secret@openai.example.com/v1',
      'ftp://example.com',
      'not a url',
      'https://10.0.0.1/v1',
      'https://100.64.0.1/v1',
      'https://172.16.0.1/v1',
      'https://192.168.1.1/v1',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::ffff:127.0.0.1]/v1',
      'https://[::ffff:7f00:1]/v1',
      'https://[fe80::1]/v1',
      'https://[fc00::1]/v1',
      'https://llm.local/v1',
      'https://llm.internal/v1',
    ]) {
      expect(
        ByokConfigSchema.safeParse({
          provider: 'openai-compatible',
          modelId: 'gpt-4o',
          operatorName: 'willy',
          secretKeyRef: 'byok:openai',
          baseUrl: badUrl,
        }).success,
      ).toBe(false);
    }
  });

  it('DT-13 garante assinaturas tipadas das 5 portas hexagonais', () => {
    expectTypeOf<SecretStorePort['getSecretStatus']>().returns.toEqualTypeOf<Promise<{ configured: boolean }>>();
    expectTypeOf<OracleAnalyzerPort['extractXsd']>().toBeFunction();
    expectTypeOf<NtSourcePort['syncAll']>().toBeFunction();
    expectTypeOf<LlmGatewayPort['analyzeCompliance']>().toBeFunction();
    expectTypeOf<GitMavenForgePort['createWorktree']>().toBeFunction();
  });

  it('DT-14 valida contratos Doctor, Surefire, DiffPreview, RunProgressEvent e helpers Fase 3', () => {
    expect(GITEA_PAT_SECRET_KEY).toBe('ntc:gitea:pat');
    expect(llmSecretKey('github-copilot')).toBe('ntc:llm:github-copilot');

    const report = DoctorReportSchema.parse({
      ok: false,
      checkedAt: '2026-11-19T14:00:00.000Z',
      checks: [
        {
          id: 'JAVA_JDK',
          status: 'WARN',
          summary: 'JDK 21 detectado com alerta Lombok 1.18.30',
          details: 'Usar -Dmaven.compiler.release=8',
          needsRelease8Flag: true,
        },
        {
          id: 'GITEA_API',
          status: 'ERROR',
          summary: 'PAT Gitea não configurado',
          details: null,
        },
      ],
    });
    expect(report.checks).toHaveLength(2);

    const summary = SurefireSummarySchema.parse({
      total: 12,
      errors: 0,
      failures: 1,
      skipped: 0,
      failedClasses: ['br.gov.mg.fazenda.nfeparser.LegacyTest'],
    });
    expect(summary.failedClasses).toHaveLength(1);

    const preview = PreBuildDiffPreviewSchema.parse({
      runId: 'run-1',
      branchName: 'nc/nfe-2026-005-v1-00',
      unifiedDiff: 'diff --git a/A.java b/A.java',
      isStrictlyDeclarative: true,
      nonDeclarativeReasons: [],
      editedFiles: ['src/main/java/A.java'],
      createdFiles: ['src/test/resources/synthetic/ok.xml'],
    });
    expect(preview.isStrictlyDeclarative).toBe(true);

    const progress = RunProgressEventSchema.parse({
      runId: 'run-1',
      dfe: 'NFe',
      ntId: 'NFe:2026.005:v1.00',
      step: 'PATCH_REPAIR',
      status: 'APPROVED',
      message: 'Tentativa 1/3 de reparo',
      attempt: 1,
      maxAttempts: 3,
      timestamp: '2026-11-19T14:00:00.000Z',
    });
    expect(progress.attempt).toBe(1);

    const agg = aggregateTokenUsage([
      { promptTokens: 100, completionTokens: 50, totalTokens: 150, stage: 'analyze' },
      { promptTokens: 200, completionTokens: 80, totalTokens: 280, stage: 'generate_patch' },
    ]);
    expect(agg.totalTokens).toBe(430);
    expect(agg.stages).toHaveLength(2);

    const oracleReg = toOracleRegistryEntry({
      dfe: 'NFCe',
      repoSlug: 'nfce-parser',
      giteaUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfce-parser',
      baseBranch: 'main',
      basePackage: 'br.gov.mg.fazenda.nfceparser',
      domainPackage: 'br.gov.mg.fazenda.nfceparser.nfce',
      mapperPackage: 'br.gov.mg.fazenda.nfceparser.mapper',
      tablePackage: 'br.gov.mg.fazenda.nfceparser.table',
      parserPackage: 'br.gov.mg.fazenda.nfceparser.parser',
      utilPackage: null,
      tagPrefix: 'NFEPROC',
      svrsRelativePath: '/Nfce/Documentos',
      baselineNt: null,
    });
    expect(oracleReg.tagPrefix).toBe('NFEPROC');
  });
});
