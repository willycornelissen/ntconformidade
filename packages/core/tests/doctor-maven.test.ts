import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecFileAsyncFn } from '../src/oracle/xsd-ast-diff.js';
import { runDoctor } from '../src/toolchain/doctor.js';
import {
  buildSanitizedToolchainEnv,
  classifyMavenFailure,
  HostMavenRunner,
  parseSurefireReports,
} from '../src/toolchain/host-maven-runner.js';

const tempDirs: string[] = [];

function createTempDir(prefix = 'ntc-maven-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
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

describe('Toolchain Doctor & Host Maven Runner', () => {
  it('DM-01: buildSanitizedToolchainEnv strips secrets/tokens and preserves toolchain paths only', () => {
    const env = buildSanitizedToolchainEnv({
      PATH: '/usr/bin:/bin',
      JAVA_HOME: '/usr/lib/jvm/java-21',
      HOME: '/home/dev',
      OPENAI_API_KEY: 'sk-live-secret',
      GEMINI_API_KEY: 'AIza-secret',
      GITHUB_TOKEN: 'ghp_secret',
      GITEA_PAT: 'pat-secret',
      NTC_INTERNAL_SECRET: 'hidden',
    });

    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.JAVA_HOME).toBe('/usr/lib/jvm/java-21');
    expect(env.HOME).toBe('/home/dev');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GITEA_PAT).toBeUndefined();
    expect(env.NTC_INTERNAL_SECRET).toBeUndefined();
  });

  it('DM-02: parseSurefireReports aggregates TEST-*.xml via cheerio without XXE and collects failing classes', async () => {
    const wt = createTempDir();
    const reportsDir = path.join(wt, 'target', 'surefire-reports');
    mkdirSync(reportsDir, { recursive: true });

    writeFileSync(
      path.join(reportsDir, 'TEST-br.gov.mg.NfeMapperTest.xml'),
      `<testsuite name="br.gov.mg.NfeMapperTest" tests="3" errors="0" failures="1" skipped="0">
         <testcase classname="br.gov.mg.NfeMapperTest" name="okTest"/>
         <testcase classname="br.gov.mg.NfeMapperTest" name="legacyMismatch">
           <failure message="expected 1 but was 2"/>
         </testcase>
       </testsuite>`,
      'utf8',
    );
    writeFileSync(
      path.join(reportsDir, 'TEST-br.gov.mg.Nt2025Test.xml'),
      `<testsuite name="br.gov.mg.Nt2025Test" tests="2" errors="1" failures="0" skipped="1">
         <testcase classname="br.gov.mg.Nt2025Test" name="brokenSynthetic">
           <error message="NullPointerException"/>
         </testcase>
       </testsuite>`,
      'utf8',
    );

    const summary = await parseSurefireReports(wt);
    expect(summary).toEqual({
      total: 5,
      errors: 1,
      failures: 1,
      skipped: 1,
      failedClasses: ['br.gov.mg.NfeMapperTest', 'br.gov.mg.Nt2025Test'],
    });
  });

  it('DM-03: classifyMavenFailure separates INFRA_ERROR, LEGACY_TEST_FAILURE, and SYNTHETIC_OR_COMPILE_ERROR', () => {
    expect(
      classifyMavenFailure({
        exitCode: 1,
        stdout: '[ERROR] Non-resolvable parent POM: Could not transfer artifact from central (offline mode)',
        stderr: '',
        surefireSummary: { total: 0, errors: 0, failures: 0, skipped: 0, failedClasses: [] },
        createdTestClassNames: ['br.gov.mg.Nt2025Test'],
      }),
    ).toBe('INFRA_ERROR');

    expect(
      classifyMavenFailure({
        exitCode: 1,
        stdout: '[ERROR] Failures: LegacyParserTest.oldCase:44',
        stderr: '',
        surefireSummary: {
          total: 10,
          errors: 0,
          failures: 1,
          skipped: 0,
          failedClasses: ['br.gov.mg.LegacyParserTest'],
        },
        createdTestClassNames: ['br.gov.mg.Nt2025Test'],
      }),
    ).toBe('LEGACY_TEST_FAILURE');

    expect(
      classifyMavenFailure({
        exitCode: 1,
        stdout: '[ERROR] COMPILATION ERROR : cannot find symbol',
        stderr: '',
        surefireSummary: { total: 0, errors: 0, failures: 0, skipped: 0, failedClasses: [] },
        createdTestClassNames: ['br.gov.mg.Nt2025Test'],
      }),
    ).toBe('SYNTHETIC_OR_COMPILE_ERROR');

    expect(
      classifyMavenFailure({
        exitCode: 1,
        stdout: '[ERROR] Failures: Nt2025Test.fails:21',
        stderr: '',
        surefireSummary: {
          total: 10,
          errors: 0,
          failures: 1,
          skipped: 0,
          failedClasses: ['br.gov.mg.Nt2025Test'],
        },
        createdTestClassNames: ['Nt2025Test'],
      }),
    ).toBe('SYNTHETIC_OR_COMPILE_ERROR');
  });

  it('DM-04: HostMavenRunner spawns mvn without shell, applies -Dmaven.compiler.release=8, and redacts logs', async () => {
    const wt = createTempDir();
    let seenArgs: readonly string[] = [];
    let seenShell: unknown;
    let seenEnv: NodeJS.ProcessEnv | undefined;

    const mockExecFile: ExecFileAsyncFn = async (_file, args, options) => {
      seenArgs = args;
      seenShell = options?.shell;
      seenEnv = options?.env;
      return {
        stdout: '[INFO] Tests run: 4, Failures: 0\nBearer token-abc-secret-12345\n[INFO] BUILD SUCCESS',
        stderr: '',
      };
    };

    const runner = new HostMavenRunner({
      execFileFn: mockExecFile,
      baseEnv: {
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'ghp_must_not_leak',
      },
    });

    const result = await runner.runMavenTests({
      worktreeDir: wt,
      useRelease8Flag: true,
      createdTestFiles: ['src/test/java/br/gov/mg/Nt2025Test.java'],
    });

    expect(seenShell).toBe(false);
    expect(seenArgs).toContain('-Dmaven.compiler.release=8');
    expect(seenEnv?.GITHUB_TOKEN).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(result.classification).toBe('PASSED');
    expect(result.sanitizedLog).toContain('[REDACTED_SECRET]');
    expect(result.sanitizedLog).not.toContain('token-abc-secret-12345');
  });

  it('DM-05: runDoctor detects JDK >= 9 needsRelease8Flag, Maven, Git, and missing Oracle jar', async () => {
    const missingJarPath = path.join(createTempDir('ntc-doc-'), 'missing.jar');
    const mockExecFile: ExecFileAsyncFn = async (file, args) => {
      if (file === 'java') {
        return { stdout: '', stderr: 'openjdk version "21.0.4" 2024-07-16' };
      }
      if (file === 'mvn') {
        return { stdout: 'Apache Maven 3.8.7', stderr: '' };
      }
      if (file === 'git' && args[0] === '--version') {
        return { stdout: 'git version 2.43.0', stderr: '' };
      }
      if (file === 'git' && args[0] === 'config') {
        return { stdout: 'Dev\n', stderr: '' };
      }
      throw new Error(`Unexpected command ${file}`);
    };

    const report = await runDoctor({
      execFileFn: mockExecFile,
      oracleJarPath: missingJarPath,
    });

    const jdkCheck = report.checks.find((c) => c.id === 'JAVA_JDK');
    const oracleCheck = report.checks.find((c) => c.id === 'XSD_ORACLE');

    expect(jdkCheck?.status).toBe('OK');
    expect(jdkCheck?.needsRelease8Flag).toBe(true);
    expect(oracleCheck?.status).toBe('ERROR');
    expect(report.ok).toBe(false);
  });

  it('DM-06: real HostMavenRunner + runDoctor validate environment against real host Java/Maven/Git', async () => {
    const report = await runDoctor({});
    const jdkCheck = report.checks.find((c) => c.id === 'JAVA_JDK');
    const mvnCheck = report.checks.find((c) => c.id === 'MAVEN');
    const gitCheck = report.checks.find((c) => c.id === 'GIT_CONFIG');
    const oracleCheck = report.checks.find((c) => c.id === 'XSD_ORACLE');

    expect(jdkCheck?.status).toBe('OK');
    expect(mvnCheck?.status).toBe('OK');
    expect(gitCheck?.status).not.toBe('ERROR');
    expect(oracleCheck?.status).toBe('OK');
  }, 15_000);

  it('DM-07: HostMavenRunner exercises offline flag, error catch block, and Surefire regression classification', async () => {
    const wt = createTempDir('ntc-mvn-err-');
    const reportsDir = path.join(wt, 'target', 'surefire-reports');

    const legacyRunner = new HostMavenRunner({
      execFileFn: async (_file, args) => {
        expect(args).toContain('-o');
        mkdirSync(reportsDir, { recursive: true });
        writeFileSync(
          path.join(reportsDir, 'TEST-br.gov.mg.LegacyTest.xml'),
          `<testsuite name="br.gov.mg.LegacyTest" tests="2" errors="0" failures="1" skipped="0">
             <testcase classname="br.gov.mg.LegacyTest" name="oldFail"><failure message="bad"/></testcase>
           </testsuite>`,
          'utf8',
        );
        const err = new Error('Build failed') as Error & { code?: number; stdout?: string; stderr?: string };
        err.code = 1;
        err.stdout = '[ERROR] Failures: LegacyTest.oldFail';
        err.stderr = '';
        throw err;
      },
    });

    const legacyRes = await legacyRunner.runMavenTests({
      worktreeDir: wt,
      mavenOffline: true,
      mavenOpts: '-Xmx512m',
      createdTestFiles: ['NtNewTest'],
    });
    expect(legacyRes.passed).toBe(false);
    expect(legacyRes.classification).toBe('LEGACY_TEST_FAILURE');
    expect(legacyRes.summary).toContain('LegacyTest');

    const emptyWt = createTempDir('ntc-mvn-infra-');
    const infraRunner = new HostMavenRunner({
      execFileFn: async () => {
        const err = new Error('Non-resolvable parent POM') as Error & { code?: number; stdout?: string; stderr?: string };
        err.code = 1;
        err.stdout = '';
        err.stderr = '[ERROR] Non-resolvable parent POM';
        throw err;
      },
    });
    const infraRes = await infraRunner.runMavenTests({ worktreeDir: emptyWt });
    expect(infraRes.classification).toBe('INFRA_ERROR');

    const compileRunner = new HostMavenRunner({
      execFileFn: async () => {
        throw new Error('COMPILATION ERROR: cannot find symbol');
      },
    });
    const compileRes = await compileRunner.runMavenTests({ worktreeDir: emptyWt });
    expect(compileRes.classification).toBe('SYNTHETIC_OR_COMPILE_ERROR');
  });

  it('DM-08: runDoctor checks JDK 8, missing binaries, sampleRepoDir, Gitea HTTPS/PAT, and BYOK readiness', async () => {
    const repoDir = createTempDir('ntc-doc-repo-');
    const secretStore = {
      async setSecret() {},
      async getSecret() {
        return null;
      },
      async getSecretStatus(key: string) {
        return { configured: key === 'ntc:gitea:pat' || key === 'ntc:llm:gemini' };
      },
      async deleteSecret() {},
    };

    const okReport = await runDoctor({
      sampleRepoDir: repoDir,
      giteaUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser',
      byokConfig: {
        provider: 'gemini',
        modelId: 'gemini-2.5-pro',
        operatorName: 'Op',
        secretKeyRef: 'ntc:llm:gemini',
      },
      secretStore,
      execFileFn: async (file, args) => {
        if (file === 'java') return { stdout: '', stderr: 'java version "1.8.0_412"' };
        if (file === 'mvn' && args.includes('dependency:resolve')) return { stdout: 'ok', stderr: '' };
        if (file === 'mvn') return { stdout: 'Apache Maven 3.8.7', stderr: '' };
        if (file === 'git' && args[0] === '--version') return { stdout: 'git version 2.43.0', stderr: '' };
        if (file === 'git' && args[0] === 'config') return { stdout: '', stderr: '' };
        throw new Error('unexpected');
      },
    });

    expect(okReport.checks.find((c) => c.id === 'JAVA_JDK')?.needsRelease8Flag).toBe(false);
    expect(okReport.checks.find((c) => c.id === 'GIT_CONFIG')?.status).toBe('WARN');
    expect(okReport.checks.find((c) => c.id === 'MAVEN_DEPS')?.status).toBe('OK');
    expect(okReport.checks.find((c) => c.id === 'GITEA_API')?.status).toBe('OK');
    expect(okReport.checks.find((c) => c.id === 'LLM_ENDPOINT')?.status).toBe('OK');

    const failReport = await runDoctor({
      sampleRepoDir: repoDir,
      giteaUrl: 'http://insecure.local/repo',
      execFileFn: async (file) => {
        if (file === 'java') return { stdout: '', stderr: 'java version "1.7.0_80"' };
        throw new Error(`${file} not found`);
      },
    });
    expect(failReport.ok).toBe(false);
    expect(failReport.checks.find((c) => c.id === 'JAVA_JDK')?.status).toBe('ERROR');
    expect(failReport.checks.find((c) => c.id === 'MAVEN')?.status).toBe('ERROR');
    expect(failReport.checks.find((c) => c.id === 'GIT_CONFIG')?.status).toBe('ERROR');
    expect(failReport.checks.find((c) => c.id === 'MAVEN_DEPS')?.status).toBe('WARN');
    expect(failReport.checks.find((c) => c.id === 'GITEA_API')?.status).toBe('ERROR');
  });

  it('DM-09: prioritizes LEGACY_TEST_FAILURE on mixed failures, validates MAVEN_OPTS, and probes endpoints', async () => {
    expect(
      classifyMavenFailure({
        exitCode: 1,
        stdout: '[ERROR] Failures in legacy + synthetic tests',
        stderr: '',
        surefireSummary: {
          total: 5,
          errors: 0,
          failures: 2,
          skipped: 0,
          failedClasses: ['br.gov.mg.Nt2025Test', 'br.gov.mg.LegacyParserTest'],
        },
        createdTestClassNames: ['br.gov.mg.Nt2025Test'],
      }),
    ).toBe('LEGACY_TEST_FAILURE');

    expect(() => buildSanitizedToolchainEnv({}, '-javaagent:/tmp/evil.jar')).toThrow(/MAVEN_OPTS/);

    const probeReport = await runDoctor({
      giteaUrl: 'https://git.fazenda.internal/Integracao/nfe-parser',
      byokConfig: {
        provider: 'openai-compatible',
        modelId: 'qwen2.5',
        operatorName: 'Op',
        secretKeyRef: 'ntc:llm:openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
      },
      secretStore: {
        async setSecret() {},
        async getSecret() {
          return null;
        },
        async getSecretStatus() {
          return { configured: true };
        },
        async deleteSecret() {},
      },
      fetchFn: async (url) =>
        url.includes('127.0.0.1')
          ? new Response('down', { status: 503 })
          : new Response(JSON.stringify({ version: '1.22' }), { status: 200 }),
      execFileFn: async (file, args) => {
        if (file === 'java') return { stdout: '', stderr: 'openjdk version "21.0.4"' };
        if (file === 'mvn') return { stdout: 'Apache Maven 3.8.7', stderr: '' };
        if (file === 'git' && args[0] === '--version') return { stdout: 'git version 2.43.0', stderr: '' };
        return { stdout: 'Dev\n', stderr: '' };
      },
    });
    expect(probeReport.checks.find((c) => c.id === 'GITEA_API')?.status).toBe('OK');
    expect(probeReport.checks.find((c) => c.id === 'LLM_ENDPOINT')?.status).toBe('WARN');

    const badPatReport = await runDoctor({
      giteaUrl: 'https://git.fazenda.internal/Integracao/nfe-parser',
      secretStore: {
        async setSecret() {},
        async getSecret(key) {
          return key === 'ntc:gitea:pat' ? 'expired-gitea-pat' : null;
        },
        async getSecretStatus(key) {
          return { configured: key === 'ntc:gitea:pat' };
        },
        async deleteSecret() {},
      },
      fetchFn: async () => new Response('Unauthorized', { status: 401 }),
      execFileFn: async (file, args) => {
        if (file === 'java') return { stdout: '', stderr: 'openjdk version "21.0.4"' };
        if (file === 'mvn') return { stdout: 'Apache Maven 3.8.7', stderr: '' };
        if (file === 'git' && args[0] === '--version') return { stdout: 'git version 2.43.0', stderr: '' };
        if (file === 'git' && args[0] === 'config') return { stdout: 'x', stderr: '' };
        throw new Error('unexpected');
      },
    });
    const giteaCheck = badPatReport.checks.find((c) => c.id === 'GITEA_API');
    expect(giteaCheck?.status).toBe('ERROR');
    expect(giteaCheck?.summary).toMatch(/401/);
    expect(JSON.stringify(badPatReport)).not.toContain('expired-gitea-pat');
  });
});
