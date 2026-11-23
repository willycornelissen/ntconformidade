import {
  ByokConfigSchema,
  DoctorReportSchema,
  GITEA_PAT_SECRET_KEY,
  type ByokConfig,
  type DoctorCheckResult,
  type DoctorReport,
} from '../domain/types.js';
import { isAllowedByokUrl, isSafeHttpsUrl } from '../domain/validators.js';
import type { FetchFn } from '../llm/http-client.js';
import type { ExecFileAsyncFn } from '../oracle/xsd-ast-diff.js';
import type { SecretStorePort } from '../ports/interfaces.js';
import { sanitizeLogMessage } from '../privacy/dlp-filter.js';
import {
  defaultExecFileAsync,
  extractExecFailureDetails,
  pathExistsAsync,
  resolveDefaultOracleJarPath,
} from './exec-utils.js';
import { buildSanitizedToolchainEnv } from './host-maven-runner.js';

/** Options for running host environment and endpoint health diagnostics (`doctor`). */
export interface RunDoctorOptions {
  readonly javaBin?: string;
  readonly mavenBin?: string;
  readonly gitBin?: string;
  readonly oracleJarPath?: string;
  readonly sampleRepoDir?: string;
  readonly giteaUrl?: string;
  readonly byokConfig?: ByokConfig;
  readonly secretStore?: SecretStorePort;
  readonly execFileFn?: ExecFileAsyncFn;
  readonly fetchFn?: FetchFn;
}

export function parseJavaMajorVersion(versionOutput: string): number | null {
  const quotedMatch = /"(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (quotedMatch?.[1]) {
    const first = Number.parseInt(quotedMatch[1], 10);
    if (first === 1 && quotedMatch[2]) {
      return Number.parseInt(quotedMatch[2], 10);
    }
    return first;
  }
  const bareMatch = /\b(?:openjdk|java)\s+(\d+)/i.exec(versionOutput);
  return bareMatch?.[1] ? Number.parseInt(bareMatch[1], 10) : null;
}

async function checkJavaJdk(javaBin: string, execFn: ExecFileAsyncFn): Promise<DoctorCheckResult> {
  try {
    const res = await execFn(javaBin, ['-version'], {
      shell: false,
      timeout: 10_000,
      env: buildSanitizedToolchainEnv(),
    });
    const raw = `${res.stderr}\n${res.stdout}`.trim();
    const major = parseJavaMajorVersion(raw);
    if (major === null || major < 8) {
      return {
        id: 'JAVA_JDK',
        status: 'ERROR',
        summary: `Versão JDK incompatível ou não reconhecida: ${sanitizeLogMessage(raw.split('\n')[0] ?? '')}`,
        details: 'JDK >= 8 é obrigatório.',
      };
    }
    const lombokNote =
      major >= 21 ? ' | Lombok <= 1.18.30 pode exigir atualização em JDK 21+.' : '';
    return {
      id: 'JAVA_JDK',
      status: 'OK',
      summary: `JDK ${major} detectado`,
      details: `${sanitizeLogMessage(raw.split('\n')[0] ?? '')}${lombokNote}`,
      needsRelease8Flag: major >= 9,
    };
  } catch (error) {
    return {
      id: 'JAVA_JDK',
      status: 'ERROR',
      summary: 'Java JDK não encontrado no PATH',
      details: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** Detects whether the active host JDK requires `-Dmaven.compiler.release=8` (JDK >= 9). */
export async function detectJavaNeedsRelease8Flag(
  javaBin = 'java',
  execFn: ExecFileAsyncFn = defaultExecFileAsync,
): Promise<boolean> {
  const result = await checkJavaJdk(javaBin, execFn);
  return result.needsRelease8Flag === true;
}

async function checkMaven(mavenBin: string, execFn: ExecFileAsyncFn): Promise<DoctorCheckResult> {
  try {
    const res = await execFn(mavenBin, ['-version'], {
      shell: false,
      timeout: 10_000,
      env: buildSanitizedToolchainEnv(),
    });
    return {
      id: 'MAVEN',
      status: 'OK',
      summary: sanitizeLogMessage(res.stdout.trim().split('\n')[0] ?? 'Maven OK'),
      details: null,
    };
  } catch (error) {
    return {
      id: 'MAVEN',
      status: 'ERROR',
      summary: 'Apache Maven (mvn) não encontrado',
      details: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function readGitConfigValue(
  gitBin: string,
  key: string,
  execFn: ExecFileAsyncFn,
): Promise<string> {
  try {
    const res = await execFn(gitBin, ['config', '--get', key], {
      shell: false,
      timeout: 5_000,
      env: buildSanitizedToolchainEnv(),
    });
    return res.stdout.trim();
  } catch (error) {
    if (extractExecFailureDetails(error).code === 1) {
      return '';
    }
    throw error;
  }
}

async function checkGitConfig(gitBin: string, execFn: ExecFileAsyncFn): Promise<DoctorCheckResult> {
  try {
    const ver = await execFn(gitBin, ['--version'], {
      shell: false,
      timeout: 10_000,
      env: buildSanitizedToolchainEnv(),
    });
    const [name, email, autocrlf] = await Promise.all([
      readGitConfigValue(gitBin, 'user.name', execFn),
      readGitConfigValue(gitBin, 'user.email', execFn),
      readGitConfigValue(gitBin, 'core.autocrlf', execFn),
    ]);

    const hasIdentity = name.length > 0 && email.length > 0;
    const winCrlfRisk = process.platform === 'win32' && autocrlf.toLowerCase() === 'true';
    const warn = !hasIdentity || winCrlfRisk;
    return {
      id: 'GIT_CONFIG',
      status: warn ? 'WARN' : 'OK',
      summary: warn
        ? 'Git disponível com pendência de configuração (identidade ou core.autocrlf)'
        : sanitizeLogMessage(ver.stdout.trim()),
      details: warn
        ? `user.name=${name || '<vazio>'}, user.email=${email || '<vazio>'}, core.autocrlf=${autocrlf || '<vazio>'}`
        : null,
    };
  } catch (error) {
    return {
      id: 'GIT_CONFIG',
      status: 'ERROR',
      summary: 'Git CLI não encontrado',
      details: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function checkMavenDeps(
  mavenBin: string,
  sampleRepoDir: string | undefined,
  execFn: ExecFileAsyncFn,
): Promise<DoctorCheckResult> {
  if (!sampleRepoDir) {
    return {
      id: 'MAVEN_DEPS',
      status: 'WARN',
      summary: 'Cache .m2 offline não verificado (nenhum repositório informado)',
      details: null,
    };
  }
  try {
    await execFn(mavenBin, ['-o', '-B', 'dependency:resolve', '-q'], {
      cwd: sampleRepoDir,
      shell: false,
      timeout: 30_000,
      env: buildSanitizedToolchainEnv(),
    });
    return {
      id: 'MAVEN_DEPS',
      status: 'OK',
      summary: 'Dependências Maven resolvidas no cache local (.m2)',
      details: null,
    };
  } catch (error) {
    return {
      id: 'MAVEN_DEPS',
      status: 'WARN',
      summary: 'Cache Maven offline incompleto para o repositório alvo',
      details: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function checkOracleJar(jarPath: string): Promise<DoctorCheckResult> {
  const exists = await pathExistsAsync(jarPath);
  return exists
    ? { id: 'XSD_ORACLE', status: 'OK', summary: 'xsd-oracle.jar disponível', details: jarPath }
    : { id: 'XSD_ORACLE', status: 'ERROR', summary: 'xsd-oracle.jar não encontrado', details: `Caminho esperado: ${jarPath}` };
}

async function probeEndpointIfConfigured(
  fetchFn: FetchFn | undefined,
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  if (!fetchFn) {
    return null;
  }
  try {
    const res = await fetchFn(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    await res.body?.cancel().catch(() => undefined);
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (error) {
    return sanitizeLogMessage(error instanceof Error ? error.message : String(error));
  }
}

async function checkGiteaReadiness(
  giteaUrl: string | undefined,
  secretStore: SecretStorePort | undefined,
  fetchFn?: FetchFn,
): Promise<DoctorCheckResult> {
  if (!giteaUrl) {
    return { id: 'GITEA_API', status: 'WARN', summary: 'URL do Gitea não informada para diagnóstico', details: null };
  }
  if (!isSafeHttpsUrl(giteaUrl, false)) {
    return { id: 'GITEA_API', status: 'ERROR', summary: 'URL Gitea insegura (HTTPS sem credenciais obrigatório)', details: null };
  }
  const hasPat = secretStore ? (await secretStore.getSecretStatus(GITEA_PAT_SECRET_KEY)).configured : false;
  if (!hasPat) {
    return { id: 'GITEA_API', status: 'WARN', summary: 'Gitea HTTPS válido, PAT ainda não configurado', details: null };
  }
  const probeErr = await probeEndpointIfConfigured(fetchFn, `${new URL(giteaUrl).origin}/api/v1/version`, {});
  return {
    id: 'GITEA_API',
    status: probeErr ? 'WARN' : 'OK',
    summary: probeErr ? `Gitea inacessível (${probeErr})` : 'Gitea HTTPS válido e PAT configurado',
    details: probeErr,
  };
}

async function checkLlmReadiness(
  byokConfig: ByokConfig | undefined,
  secretStore: SecretStorePort | undefined,
  fetchFn?: FetchFn,
): Promise<DoctorCheckResult> {
  if (!byokConfig) {
    return { id: 'LLM_ENDPOINT', status: 'WARN', summary: 'Provedor BYOK não configurado para diagnóstico', details: null };
  }
  const parsed = ByokConfigSchema.safeParse(byokConfig);
  if (!parsed.success) {
    return { id: 'LLM_ENDPOINT', status: 'ERROR', summary: 'Configuração BYOK inválida', details: parsed.error.issues[0]?.message ?? null };
  }
  const configured = secretStore ? (await secretStore.getSecretStatus(parsed.data.secretKeyRef)).configured : false;
  if (!configured) {
    return {
      id: 'LLM_ENDPOINT',
      status: 'WARN',
      summary: `BYOK ${parsed.data.provider} sem segredo no keychain (${parsed.data.secretKeyRef})`,
      details: null,
    };
  }
  if (fetchFn && parsed.data.provider === 'openai-compatible' && isAllowedByokUrl(parsed.data.baseUrl, true)) {
    const probeErr = await probeEndpointIfConfigured(fetchFn, `${parsed.data.baseUrl.replace(/\/+$/, '')}/models`, {});
    if (probeErr) {
      return { id: 'LLM_ENDPOINT', status: 'WARN', summary: `Endpoint BYOK indisponível (${probeErr})`, details: probeErr };
    }
  }
  return { id: 'LLM_ENDPOINT', status: 'OK', summary: `BYOK ${parsed.data.provider} (${parsed.data.modelId}) pronto`, details: null };
}

/** Runs toolchain, Oracle JAR, Gitea, and BYOK readiness checks without leaking secrets. */
export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const execFn = options.execFileFn ?? defaultExecFileAsync;
  const oracleJarPath = options.oracleJarPath ?? resolveDefaultOracleJarPath();

  const checks = await Promise.all([
    checkJavaJdk(options.javaBin ?? 'java', execFn),
    checkMaven(options.mavenBin ?? 'mvn', execFn),
    checkGitConfig(options.gitBin ?? 'git', execFn),
    checkMavenDeps(options.mavenBin ?? 'mvn', options.sampleRepoDir, execFn),
    checkOracleJar(oracleJarPath),
    checkGiteaReadiness(options.giteaUrl, options.secretStore, options.fetchFn),
    checkLlmReadiness(options.byokConfig, options.secretStore, options.fetchFn),
  ]);

  return DoctorReportSchema.parse({
    ok: checks.every((check) => check.status !== 'ERROR'),
    checkedAt: new Date().toISOString(),
    checks,
  });
}
