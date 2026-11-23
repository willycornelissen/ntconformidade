import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DlpBlockedPathError,
  DlpViolationError,
  isAllowedRepoPath,
  readAllowedRepoFile,
  listAllowedRepoFiles,
  sanitizeForExternalLlm,
  sanitizeLogMessage,
  assertNoDlpViolations,
} from '../src/index.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..', '..');
const READ_ONLY_NFE_PARSER = path.join(ROOT_DIR, 'nfe-parser');
const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ntc-dlp-'));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, 'src/main/java/pkg'), { recursive: true });
  await fs.mkdir(path.join(dir, 'src/test/java/pkg'), { recursive: true });
  await fs.mkdir(path.join(dir, 'src/test/resources/synthetic'), { recursive: true });
  await fs.mkdir(path.join(dir, 'src/test/resources/test-files/icms'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'src/main/java/pkg/SampleMapper.java'),
    'package pkg;\npublic class SampleMapper {}\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'src/test/java/pkg/SampleTest.java'),
    'package pkg;\nclass SampleTest {}\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'src/test/resources/synthetic/valid.xml'),
    '<nfeProc versao="4.00"/>',
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'src/test/resources/test-files/nfe01.xml'),
    '<nfeProc><CNPJ>12345678000199</CNPJ></nfeProc>',
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'src/test/resources/test-files/icms/case.xml'),
    '<nfeProc><CPF>12345678901</CPF></nfeProc>',
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'pom.xml'), '<project/>', 'utf8');
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('Ciclo 5 — Filtro DLP, Allowlist Estrita e Redação', () => {
  it('DLP-01 a DLP-04 aplicam allowlist estrita e bloqueiam test-files, traversal e arquivos fora do escopo', () => {
    expect(isAllowedRepoPath('src/main/java/br/gov/mg/fazenda/nfeparser/mapper/NfeMapper.java')).toBe(true);
    expect(isAllowedRepoPath('src/test/java/br/gov/mg/fazenda/nfeparser/parser/NfceParserImplTest.java')).toBe(true);
    expect(isAllowedRepoPath('src/test/resources/synthetic/valid_nfe.xml')).toBe(true);

    const blockedPaths = [
      'src/test/resources/test-files/nfe01.xml',
      'src/test/resources/test-files/icms/case.xml',
      'src\\test\\resources\\test-files\\nfe01.xml',
      'SRC/TEST/RESOURCES/TEST-FILES/nfce.xml',
      './src/test/resources/./test-files/nfe01.xml',
      'pom.xml',
      '.gitlab-ci.yml',
      'ci_settings.xml',
      'src/test/resources/legacy.xml',
      '.env',
      '.git/config',
      'target/surefire-reports/TEST-Foo.xml',
      '../secret.txt',
      'src/main/java/../../../../etc/passwd',
      '/etc/passwd',
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      'src/main/java/\u0000Evil.java',
    ];

    for (const p of blockedPaths) {
      expect(isAllowedRepoPath(p), `Esperado bloqueio de ${p}`).toBe(false);
    }
  });

  it('DLP-05 e DLP-06 bloqueiam symlinks externos e symlinks apontando para test-files', async () => {
    const repo = await makeTempRepo();
    const outsideSecret = path.join(repo, '..', `outside-secret-${Date.now()}.txt`);
    await fs.writeFile(outsideSecret, 'TOP_SECRET', 'utf8');
    tempDirs.push(outsideSecret);

    await fs.symlink(outsideSecret, path.join(repo, 'src/main/java/pkg/Leak.java'));
    await fs.symlink(
      path.join(repo, 'src/test/resources/test-files/nfe01.xml'),
      path.join(repo, 'src/main/java/pkg/Sneaky.java'),
    );

    await expect(readAllowedRepoFile(repo, 'src/main/java/pkg/Leak.java')).rejects.toThrow(DlpBlockedPathError);
    await expect(readAllowedRepoFile(repo, 'src/main/java/pkg/Sneaky.java')).rejects.toThrow(DlpBlockedPathError);
    await expect(readAllowedRepoFile(repo, 'src/test/resources/test-files/nfe01.xml')).rejects.toThrow(
      DlpBlockedPathError,
    );

    const allowedList = await listAllowedRepoFiles(repo);
    expect(await readAllowedRepoFile(repo, 'src/test/resources/synthetic/valid.xml')).toBe(
      '<nfeProc versao="4.00"/>',
    );
    expect(allowedList).toContain('src/main/java/pkg/SampleMapper.java');
    expect(allowedList).toContain('src/test/java/pkg/SampleTest.java');
    expect(allowedList).toContain('src/test/resources/synthetic/valid.xml');
    expect(allowedList.some((f) => f.includes('Leak.java') || f.includes('Sneaky.java') || f.includes('test-files'))).toBe(
      false,
    );
  });

  it('DLP-07 enumera ./nfe-parser em modo somente leitura excluindo test-files', async () => {
    const files = await listAllowedRepoFiles(READ_ONLY_NFE_PARSER);
    expect(files).toContain('src/main/java/br/gov/mg/fazenda/nfeparser/mapper/NfeMapper.java');
    expect(files.some((f) => f.toLowerCase().includes('test-files'))).toBe(false);
    await expect(readAllowedRepoFile(READ_ONLY_NFE_PARSER, 'src/test/resources/test-files/x.xml')).rejects.toThrow(
      DlpBlockedPathError,
    );
  });

  it('DLP-08 e DLP-09 removem blocos/fragmentos XML preservando genéricos Java de compilador', () => {
    const mixed = [
      '[ERROR] SampleMapper.java:[42,10] error: incompatible types: Map<String, BiConsumer<Nfe, String>> cannot be converted to List<BigDecimal>',
      'Payload: <?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe31261112345678000195550010000001231000001234"><emit><CNPJ>12345678000195</CNPJ></emit></infNFe></NFe></nfeProc>',
      'Namespaced: <ns2:nfeProc><ns2:NFe><ns2:emit><ns2:xNome>EMPRESA SECRETA SA</ns2:xNome></ns2:emit></ns2:NFe></ns2:nfeProc>',
      'Retorno: <?xml version="1.0"?><retEnviNFe><cStat>104</cStat><emit><xNome>RAZAO SOCIAL</xNome></emit></retEnviNFe>',
      'Fragmento truncado multilinha: <nfeProc versao="4.00">\n  <emit>\n    <xNome>SIGILO FISCAL</xNome>\n  </emit>',
    ].join('\n\n');

    const redacted = sanitizeLogMessage(mixed);
    expect(redacted).toContain('Map<String, BiConsumer<Nfe, String>>');
    expect(redacted).toContain('List<BigDecimal>');
    expect(redacted).not.toContain('12345678000195');
    expect(redacted).not.toContain('EMPRESA SECRETA SA');
    expect(redacted).not.toContain('RAZAO SOCIAL');
    expect(redacted).not.toContain('SIGILO FISCAL');
    expect(redacted).not.toContain('<nfeProc');
    expect(redacted).not.toContain('<retEnviNFe');
    expect(redacted).toContain('[REDACTED_XML]');
  });

  it('DLP-10 e DLP-11 redigem números fiscais (incluindo CNPJ alfanumérico) e segredos de forma idempotente', () => {
    const raw = [
      'Ano 2026 NT 2026.005 HTTP 401 linha :42',
      'CPF=12345678901 e formatado 123.456.789-01',
      'CNPJ=12345678000195 e formatado 12.345.678/0001-95 e alnum 12.ABC.345/01DE-90',
      'Chave=31261112345678000195550010000001231000001234',
      'ChaveFmt=3126 1112 3456 7800 0195 5500 1000 0001 2310 0000 1234',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'Git1: https://willy:super_secret_pat@gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser.git',
      'Git2: https://pat_only_secret@gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser.git',
      'Keys: sk-proj-abcdef1234567890 ghp_abcdefghijklmnopqrstuvwxyz1234 ghu_abcdefghijklmnop glpat-abcdefgh1234 github_pat_11ABC_def AIzaSyDummySecretKey123456',
      'GITEA_TOKEN="tok123"; api_key=abc98765;',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ==\n-----END PRIVATE KEY-----',
    ].join('\n');

    const out = sanitizeForExternalLlm(raw);
    expect(out).toContain('Ano 2026 NT 2026.005 HTTP 401 linha :42');
    expect(out).not.toContain('12345678901');
    expect(out).not.toContain('123.456.789-01');
    expect(out).not.toContain('12345678000195');
    expect(out).not.toContain('12.345.678/0001-95');
    expect(out).not.toContain('12.ABC.345/01DE-90');
    expect(out).not.toContain('31261112345678000195550010000001231000001234');
    expect(out).not.toContain('3126 1112 3456');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain('super_secret_pat');
    expect(out).not.toContain('pat_only_secret');
    expect(out).not.toContain('sk-proj-abcdef1234567890');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234');
    expect(out).not.toContain('ghu_abcdefghijklmnop');
    expect(out).not.toContain('glpat-abcdefgh1234');
    expect(out).not.toContain('github_pat_11ABC_def');
    expect(out).not.toContain('AIzaSyDummySecretKey123456');
    expect(out).not.toContain('tok123');
    expect(out).not.toContain('abc98765');
    expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQ==');
    expect(out).toContain('GITEA_TOKEN=[REDACTED_SECRET];');
    expect(out).toContain('api_key=[REDACTED_SECRET];');
    expect(sanitizeForExternalLlm(out)).toBe(out);
    expect(() =>
      assertNoDlpViolations([{ filePath: 'src/main/java/Clean.java', content: out }]),
    ).not.toThrow();
  });

  it('DLP-12 garante varredura linear sem ReDoS, idempotência e bloqueio assertNoDlpViolations', () => {
    const adversarial = '<?xml version="1.0"?><a>\n'.repeat(5_000) + '<NFe>\n'.repeat(5_000);
    const cleaned = sanitizeLogMessage(adversarial);
    expect(sanitizeLogMessage(cleaned)).toBe(cleaned);

    expect(() =>
      assertNoDlpViolations([{ filePath: 'src/test/resources/test-files/leak.xml', content: '<NFe/>' }]),
    ).toThrow(DlpViolationError);
    expect(() =>
      assertNoDlpViolations([{ filePath: 'src/main/java/A.java', content: 'Authorization: Bearer secret12345' }]),
    ).toThrow(DlpViolationError);
    expect(() =>
      assertNoDlpViolations([
        { filePath: 'src/main/java/A.java', content: 'public class A {}' },
        { filePath: 'src/test/resources/synthetic/ok.xml', content: '<nfeProc versao="4.00"/>' },
      ]),
    ).not.toThrow();
  });
});
