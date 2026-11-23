import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DfeRepoEntry, PatchPayload } from '../src/domain/types.js';
import type { OracleAnalyzerPort } from '../src/ports/interfaces.js';
import {
  assertPatchGuardrails,
  PatchGuardrailError,
  validatePatchGuardrails,
} from '../src/patch/patch-guardrails.js';
import { applyPatchToWorktree, extractAllowedJavaContextForNc } from '../src/patch/patch-engine.js';

const tempDirs: string[] = [];

function createWorktree(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ntc-patch-wt-'));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe'), { recursive: true });
  mkdirSync(path.join(dir, 'src/main/java/br/gov/mg/fazenda/nfeparser/mapper'), { recursive: true });
  mkdirSync(path.join(dir, 'src/main/java/br/gov/mg/fazenda/nfeparser/parser'), { recursive: true });
  mkdirSync(path.join(dir, 'src/main/java/br/gov/mg/fazenda/nfeparser/util'), { recursive: true });
  mkdirSync(path.join(dir, 'src/test/java/br/gov/mg/fazenda/nfeparser'), { recursive: true });
  mkdirSync(path.join(dir, 'src/test/resources/synthetic'), { recursive: true });

  writeFileSync(
    path.join(dir, 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java'),
    'package br.gov.mg.fazenda.nfeparser.nfe;\n\npublic class Nfe {\n  private String id;\n}\n',
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'src/main/java/br/gov/mg/fazenda/nfeparser/parser/XmlParser.java'),
    'package br.gov.mg.fazenda.nfeparser.parser;\n\npublic class XmlParser {}\n',
    'utf8',
  );
  writeFileSync(path.join(dir, 'pom.xml'), '<project/>', 'utf8');
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const NFE_REPO: DfeRepoEntry = {
  dfe: 'NFe',
  repoSlug: 'nfe-parser',
  giteaUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser',
  baseBranch: 'main',
  basePackage: 'br.gov.mg.fazenda.nfeparser',
  domainPackage: 'br.gov.mg.fazenda.nfeparser.nfe',
  mapperPackage: 'br.gov.mg.fazenda.nfeparser.mapper',
  tablePackage: 'br.gov.mg.fazenda.nfeparser.table',
  parserPackage: 'br.gov.mg.fazenda.nfeparser.parser',
  utilPackage: 'br.gov.mg.fazenda.nfeparser.util',
  tagPrefix: 'NFEPROC',
  svrsRelativePath: '/Nfe/Documentos',
  baselineNt: null,
};

describe('Patch Guardrails & Patch Engine', () => {
  it('PG-01: blocks edits to pom.xml, shared parserPackage, utilPackage, and test-files/**', async () => {
    const wt = createWorktree();

    const blockedPaths: PatchPayload[] = [
      {
        edits: [{ filePath: 'pom.xml', searchBlock: '<project/>', replaceBlock: '<project><x/></project>' }],
        creates: [],
      },
      {
        edits: [
          {
            filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/parser/XmlParser.java',
            searchBlock: 'public class XmlParser {}',
            replaceBlock: 'public class XmlParser { int x; }',
          },
        ],
        creates: [],
      },
      {
        edits: [
          {
            filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/util/Helper.java',
            searchBlock: 'a',
            replaceBlock: 'b',
          },
        ],
        creates: [],
      },
      {
        edits: [
          {
            filePath: 'test-files/invoice.xml',
            searchBlock: 'a',
            replaceBlock: 'b',
          },
        ],
        creates: [],
      },
    ];

    for (const payload of blockedPaths) {
      const result = await validatePatchGuardrails({ payload, repo: NFE_REPO, worktreeDir: wt });
      expect(result.valid).toBe(false);
      await expect(applyPatchToWorktree(wt, NFE_REPO, payload)).rejects.toThrow(PatchGuardrailError);
    }
  });

  it('PG-02: rejects Java 11+/17+ syntax (var, text blocks, record), Runtime.exec, and test-files refs', async () => {
    const wt = createWorktree();

    const badJavaPayloads: PatchPayload[] = [
      {
        edits: [
          {
            filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
            searchBlock: '  private String id;',
            replaceBlock: '  private String id;\n  public void run() { var x = "java11"; }',
          },
        ],
        creates: [],
      },
      {
        edits: [],
        creates: [
          {
            filePath: 'src/test/java/br/gov/mg/fazenda/nfeparser/NtTest.java',
            content: 'class NtTest { String xml = """\n<nfe/>\n"""; }',
          },
        ],
      },
      {
        edits: [],
        creates: [
          {
            filePath: 'src/test/java/br/gov/mg/fazenda/nfeparser/RealFileTest.java',
            content: 'class RealFileTest { String p = "test-files/real_nfe.xml"; }',
          },
        ],
      },
      {
        edits: [
          {
            filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
            searchBlock: '  private String id;',
            replaceBlock: '  void danger() throws Exception { Runtime.getRuntime().exec("whoami"); }',
          },
        ],
        creates: [],
      },
    ];

    for (const payload of badJavaPayloads) {
      await expect(
        assertPatchGuardrails({ payload, repo: NFE_REPO, worktreeDir: wt }),
      ).rejects.toThrow(PatchGuardrailError);
    }
  });

  it('PG-03: blocks XXE in synthetic XML creates and rejects XSD-invalid synthetic XML via oracle', async () => {
    const wt = createWorktree();

    const xxePayload: PatchPayload = {
      edits: [],
      creates: [
        {
          filePath: 'src/test/resources/synthetic/xxe.xml',
          content: '<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><nfeProc/>',
        },
      ],
    };
    await expect(
      assertPatchGuardrails({ payload: xxePayload, repo: NFE_REPO, worktreeDir: wt }),
    ).rejects.toThrow(PatchGuardrailError);

    const invalidXsdPayload: PatchPayload = {
      edits: [],
      creates: [
        {
          filePath: 'src/test/resources/synthetic/invalid.xml',
          content: '<nfeProc><broken/></nfeProc>',
        },
      ],
    };
    const mockOracle: Pick<OracleAnalyzerPort, 'validateXml'> = {
      async validateXml() {
        return {
          valid: false,
          errors: [{ line: 1, column: 10, message: 'cvc-complex-type.2.4.a' }],
        };
      },
    };

    await expect(
      assertPatchGuardrails({
        payload: invalidXsdPayload,
        repo: NFE_REPO,
        worktreeDir: wt,
        xsdDir: '/tmp/xsds',
        oracle: mockOracle,
      }),
    ).rejects.toThrow(/XSD/i);
  });

  it('PG-04: rejects missing/ambiguous searchBlock and enforces touched-file / line blast-radius caps', async () => {
    const wt = createWorktree();
    writeFileSync(
      path.join(wt, 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java'),
      'class Nfe {\n  private String dup;\n  private String dup;\n}\n',
      'utf8',
    );

    await expect(
      assertPatchGuardrails({
        payload: {
          edits: [
            {
              filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
              searchBlock: 'private String missingField;',
              replaceBlock: 'private String ok;',
            },
          ],
          creates: [],
        },
        repo: NFE_REPO,
        worktreeDir: wt,
      }),
    ).rejects.toThrow(/não encontrad/i);

    await expect(
      assertPatchGuardrails({
        payload: {
          edits: [
            {
              filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
              searchBlock: 'private String dup;',
              replaceBlock: 'private String unique;',
            },
          ],
          creates: [],
        },
        repo: NFE_REPO,
        worktreeDir: wt,
      }),
    ).rejects.toThrow(/ambíguo|múltiplas/i);

    await expect(
      assertPatchGuardrails({
        payload: {
          edits: [],
          creates: [
            {
              filePath: 'src/test/java/br/gov/mg/fazenda/nfeparser/BigTest.java',
              content: Array.from({ length: 20 }, (_, i) => `// line ${i}`).join('\n'),
            },
          ],
        },
        repo: NFE_REPO,
        worktreeDir: wt,
        maxTotalChangedLines: 5,
      }),
    ).rejects.toThrow(/limite|linhas/i);
  });

  it('PG-05: blocks symlink escape inside worktree when reading or creating files', async () => {
    const wt = createWorktree();
    const outsideFile = path.join(os.tmpdir(), `outside-${Date.now()}.java`);
    writeFileSync(outsideFile, 'class Outside { private String x; }\n', 'utf8');
    tempDirs.push(outsideFile);

    symlinkSync(
      outsideFile,
      path.join(wt, 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Link.java'),
    );

    await expect(
      applyPatchToWorktree(wt, NFE_REPO, {
        edits: [
          {
            filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Link.java',
            searchBlock: 'private String x;',
            replaceBlock: 'private String y;',
          },
        ],
        creates: [],
      }),
    ).rejects.toThrow(PatchGuardrailError);
  });

  it('PG-06: applies valid domain/mapper edits and synthetic test/XML creates cleanly', async () => {
    const wt = createWorktree();
    const mockOracle: Pick<OracleAnalyzerPort, 'validateXml'> = {
      async validateXml() {
        return { valid: true, errors: [] };
      },
    };

    const payload: PatchPayload = {
      summary: 'Adiciona vIBSCBS em Nfe.java e teste sintético',
      edits: [
        {
          filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
          searchBlock: '  private String id;',
          replaceBlock: '  private String id;\n  private java.math.BigDecimal vIBSCBS;',
        },
      ],
      creates: [
        {
          filePath: 'src/test/resources/synthetic/nt2025_002.xml',
          content: '<nfeProc><vIBSCBS>10.00</vIBSCBS></nfeProc>',
        },
        {
          filePath: 'src/test/java/br/gov/mg/fazenda/nfeparser/Nt2025002Test.java',
          content:
            'package br.gov.mg.fazenda.nfeparser;\npublic class Nt2025002Test { public void ok() {} }\n',
        },
      ],
    };

    const applied = await applyPatchToWorktree(wt, NFE_REPO, payload, {
      xsdDir: '/tmp/xsds',
      oracle: mockOracle,
    });

    expect(applied.modifiedFiles).toEqual(['src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java']);
    expect(applied.createdFiles).toEqual([
      'src/test/resources/synthetic/nt2025_002.xml',
      'src/test/java/br/gov/mg/fazenda/nfeparser/Nt2025002Test.java',
    ]);
    expect(
      readFileSync(path.join(wt, 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java'), 'utf8'),
    ).toContain('vIBSCBS');
    expect(existsSync(path.join(wt, 'src/test/resources/synthetic/nt2025_002.xml'))).toBe(true);
  });

  it('PG-07: rejects creating a file that already exists on disk', async () => {
    const wt = createWorktree();
    const existingXml = path.join(wt, 'src/test/resources/synthetic/existing.xml');
    writeFileSync(existingXml, '<nfeProc/>', 'utf8');

    await expect(
      applyPatchToWorktree(wt, NFE_REPO, {
        edits: [],
        creates: [
          {
            filePath: 'src/test/resources/synthetic/existing.xml',
            content: '<nfeProc><new/></nfeProc>',
          },
        ],
      }),
    ).rejects.toThrow(/já existe/i);
  });

  it('PG-08: blocks @JsonProperty tampering, multi-hunk split bypass, @Disabled, and allows DefaultTableParser', async () => {
    const wt = createWorktree();
    writeFileSync(
      path.join(wt, 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java'),
      'package br.gov.mg.fazenda.nfeparser.nfe;\nimport com.fasterxml.jackson.annotation.JsonProperty;\npublic class Nfe {\n  @JsonProperty("vProd")\n  private String vProd;\n  private String tail;\n}\n',
      'utf8',
    );
    writeFileSync(
      path.join(wt, 'src/main/java/br/gov/mg/fazenda/nfeparser/parser/DefaultNfeTableParser.java'),
      'package br.gov.mg.fazenda.nfeparser.parser;\npublic class DefaultNfeTableParser {\n  private String col;\n}\n',
      'utf8',
    );
    writeFileSync(
      path.join(wt, 'src/test/java/br/gov/mg/fazenda/nfeparser/SmokeTest.java'),
      'package br.gov.mg.fazenda.nfeparser;\npublic class SmokeTest {\n  @Test public void ok() {}\n}\n',
      'utf8',
    );

    await expect(
      assertPatchGuardrails({
        payload: {
          edits: [
            {
              filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
              searchBlock: '  @JsonProperty("vProd")\n  private String vProd;',
              replaceBlock: '  @JsonProperty("valorProduto")\n  private String vProd;',
            },
          ],
          creates: [],
        },
        repo: NFE_REPO,
        worktreeDir: wt,
      }),
    ).rejects.toThrow(/@JsonProperty/i);

    await expect(
      assertPatchGuardrails({
        payload: {
          edits: [
            {
              filePath: 'src/test/java/br/gov/mg/fazenda/nfeparser/SmokeTest.java',
              searchBlock: '  @Test public void ok() {}',
              replaceBlock: '  @Disabled public void ok() {}',
            },
          ],
          creates: [],
        },
        repo: NFE_REPO,
        worktreeDir: wt,
      }),
    ).rejects.toThrow(/@Disabled/i);

    await expect(
      assertPatchGuardrails({
        payload: {
          edits: [
            {
              filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
              searchBlock: '  private String vProd;',
              replaceBlock: '  private String vProd; Runtime',
            },
            {
              filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
              searchBlock: '  private String tail;',
              replaceBlock: '.getRuntime().exec("id"); private String tail;',
            },
          ],
          creates: [],
        },
        repo: NFE_REPO,
        worktreeDir: wt,
      }),
    ).rejects.toThrow(PatchGuardrailError);

    const tableParserEdit = await validatePatchGuardrails({
      payload: {
        edits: [
          {
            filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/parser/DefaultNfeTableParser.java',
            searchBlock: '  private String col;',
            replaceBlock: '  private String col;\n  private String vIbs;',
          },
        ],
        creates: [],
      },
      repo: NFE_REPO,
      worktreeDir: wt,
    });
    expect(tableParserEdit.valid).toBe(true);

    const ctxFiles = await extractAllowedJavaContextForNc(wt, NFE_REPO, undefined, 10, ['Nfe']);
    expect(ctxFiles.some((f) => f.filePath.endsWith('DefaultNfeTableParser.java'))).toBe(true);
  });
});
