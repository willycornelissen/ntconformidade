import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AckResponseSchema,
  ApplyNcOutcomeSchema,
  ApplyNcRequestSchema,
  ByokLlmGateway,
  CheckComplianceRequestSchema,
  CheckComplianceResponseSchema,
  ComplianceOrchestrator,
  ConfirmPreBuildDiffRequestSchema,
  CopilotAuthPollResponseSchema,
  CopilotAuthStartResponseSchema,
  DoctorReportIpcSchema,
  GetByokConfigRequestSchema,
  GetByokConfigResponseSchema,
  GetNcRequestSchema,
  GetPendingGateRequestSchema,
  GetSecretStatusRequestSchema,
  GiteaAdapter,
  GiteaForgeBridge,
  HostMavenRunner,
  IPC_CHANNELS,
  ImportManualNtInputSchema,
  ImportManualNtResponseSchema,
  ListNtsRequestSchema,
  ListNtsResponseSchema,
  ListReposRequestSchema,
  ListReposResponseSchema,
  ListRunsRequestSchema,
  ListRunsResponseSchema,
  NcLoadedViewSchema,
  OpenPrRequestSchema,
  PendingApprovalGateSchema,
  PollCopilotAuthRequestSchema,
  RunDoctorRequestSchema,
  RunProgressIpcSchema,
  SaveByokConfigRequestSchema,
  SaveNcRequestSchema,
  SaveRepoInputSchema,
  SecretStatusResponseSchema,
  SetSecretRequestSchema,
  StartCopilotAuthRequestSchema,
  SyncSvrsRequestSchema,
  SyncSvrsResponseSchema,
  WorktreeManager,
  XsdOracleBridge,
  detectJavaNeedsRelease8Flag,
  extractNtPdf,
  importManualNt,
  llmSecretKey,
  loadNcDocument,
  pollCopilotDeviceToken,
  renderNcMarkdown,
  requestCopilotDeviceCode,
  resolveContainedNoSymlinkPath,
  runDoctor,
  sanitizeLogMessage,
  saveNcDocument,
  syncAllSvrsNts,
  type ApplyNcOutcome,
  type ComplianceRun,
  type InvokeIpcChannelName,
  type NtcDatabase,
  type NtcInvokeResponseMap,
  type PendingApprovalGate,
  type PreBuildDiffPreview,
  type RunProgressEvent,
  type SecretStorePort,
} from '@ntc/core';

/** Minimal IPC event contract decoupled from Electron internals for unit testing. */
export interface IpcMainEventLike {
  readonly senderFrame?: { readonly url?: string } | null;
}

/** Minimal `ipcMain.handle` registry contract decoupled from Electron internals. */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcMainEventLike, payload: unknown) => Promise<unknown>,
  ): void;
}

/** Structural subset of `ComplianceOrchestrator` injected or defaulted by the IPC controller. */
export interface OrchestratorLike {
  generateDraftNc(input: Parameters<ComplianceOrchestrator['generateDraftNc']>[0]): Promise<{
    readonly run: ComplianceRun;
    readonly savedNc: { readonly nc: Awaited<ReturnType<typeof loadNcDocument>> };
    readonly xsdDir: string;
  }>;
  approveAndRunCompliance(
    input: Parameters<ComplianceOrchestrator['approveAndRunCompliance']>[0],
  ): Promise<ApplyNcOutcome>;
}

/** Dependencies required to instantiate the Electron main-process IPC controller. */
export interface DesktopIpcControllerDeps {
  readonly db: NtcDatabase;
  readonly secretStore: SecretStorePort;
  readonly dataDir: string;
  readonly oracleJarPath: string;
  readonly allowedSenderOrigins: readonly string[];
  readonly allowedXsdRoots?: readonly string[];
  readonly allowedRepoRoots?: readonly string[];
  readonly fetchFn?: typeof fetch;
  readonly emitProgress: (event: RunProgressEvent) => void;
  readonly orchestrator?: OrchestratorLike;
}

type PendingResolverEntry =
  | {
      readonly kind: 'PRE_BUILD_DIFF';
      readonly gateToken: string;
      readonly gate: PendingApprovalGate;
      readonly resolve: (decision: { readonly approved: boolean; readonly reason?: string }) => void;
      readonly reject: (reason: Error) => void;
    }
  | {
      readonly kind: 'PR_CONFIRMATION';
      readonly gateToken: string;
      readonly gate: PendingApprovalGate;
      readonly resolve: (decision: { readonly approved: boolean }) => void;
      readonly reject: (reason: Error) => void;
    };

type TypedInvokeHandlerMap = {
  readonly [K in InvokeIpcChannelName]: (rawPayload: unknown) => Promise<NtcInvokeResponseMap[K]>;
};

function normalizeFileUrlToPath(rawUrl: URL): string | null {
  try {
    return path.resolve(fileURLToPath(rawUrl));
  } catch {
    return null;
  }
}

/**
 * Verifies IPC sender frame URL against trusted app origins (`file://` app path or exact HTTP dev origin).
 * Uses URL parsing instead of prefix matching so sibling ports or directories never match.
 */
export function isAllowedSenderFrame(
  frameUrl: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!frameUrl) {
    return false;
  }
  let frameParsed: URL;
  try {
    frameParsed = new URL(frameUrl);
  } catch {
    return false;
  }
  if (frameParsed.username || frameParsed.password) {
    return false;
  }

  for (const allowed of allowedOrigins) {
    let allowedParsed: URL;
    try {
      allowedParsed = new URL(allowed);
    } catch {
      continue;
    }
    if (frameParsed.protocol !== allowedParsed.protocol) {
      continue;
    }
    if (frameParsed.protocol === 'http:' || frameParsed.protocol === 'https:') {
      if (frameParsed.origin === allowedParsed.origin) {
        return true;
      }
      continue;
    }
    if (frameParsed.protocol === 'file:') {
      const framePath = normalizeFileUrlToPath(frameParsed);
      const allowedPath = normalizeFileUrlToPath(allowedParsed);
      if (!framePath || !allowedPath) {
        continue;
      }
      if (allowedParsed.pathname.endsWith('/')) {
        if (framePath === allowedPath || framePath.startsWith(`${allowedPath}${path.sep}`)) {
          return true;
        }
      } else if (framePath === allowedPath) {
        return true;
      }
    }
  }
  return false;
}

function assertSafeLocalFilesystemPath(rawPath: string, label: string): string {
  if (
    !rawPath ||
    rawPath.includes('\0') ||
    /[\r\n]/.test(rawPath) ||
    rawPath.startsWith('\\\\') ||
    rawPath.startsWith('//')
  ) {
    throw new Error(`Caminho inválido ou UNC bloqueado para ${label}`);
  }
  return path.resolve(rawPath);
}

async function resolvePathWithinAllowedRoots(
  rawPath: string,
  allowedRoots: readonly string[],
  label: string,
): Promise<string> {
  const candidate = assertSafeLocalFilesystemPath(rawPath, label);
  for (const root of allowedRoots) {
    const resolvedRoot = path.resolve(root);
    const rel = path.relative(resolvedRoot, candidate);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      if (existsSync(resolvedRoot)) {
        return resolveContainedNoSymlinkPath(resolvedRoot, rel);
      }
      return candidate;
    }
  }
  throw new Error(`Caminho para ${label} fora dos diretórios permitidos`);
}

function sanitizeIpcErrorMessage(rawMessage: string, dataDir: string): string {
  const resolvedDataDir = path.resolve(dataDir);
  const escapedWin = resolvedDataDir.replace(/\\/g, '/');
  const masked = rawMessage
    .split(resolvedDataDir)
    .join('[DATA_DIR]')
    .split(escapedWin)
    .join('[DATA_DIR]');
  return sanitizeLogMessage(masked);
}

function assertBoundByokSecretKeyRef(config: {
  readonly provider: 'gemini' | 'openai-compatible' | 'github-copilot';
  readonly secretKeyRef: string;
}): void {
  if (config.secretKeyRef !== llmSecretKey(config.provider)) {
    throw new Error('secretKeyRef inválido para o provedor BYOK informado');
  }
}

function buildDefaultOrchestrator(deps: DesktopIpcControllerDeps): OrchestratorLike {
  const oracle = new XsdOracleBridge({ jarPath: deps.oracleJarPath });
  const llmGateway = new ByokLlmGateway({
    secretStore: deps.secretStore,
    fetchFn: deps.fetchFn,
  });
  const gitForge = new GiteaForgeBridge({
    worktrees: new WorktreeManager({ secretStore: deps.secretStore }),
    maven: new HostMavenRunner(),
    gitea: new GiteaAdapter({ secretStore: deps.secretStore, fetchFn: deps.fetchFn }),
    useRelease8Flag: () => detectJavaNeedsRelease8Flag(),
  });

  return new ComplianceOrchestrator({
    db: deps.db,
    oracle,
    llmGateway,
    gitForge,
    ncWorkspaceDir: path.join(deps.dataDir, 'ncs'),
    cacheRootDir: path.join(deps.dataDir, 'cache'),
    mirrorsRootDir: path.join(deps.dataDir, 'repos'),
    worktreesRootDir: path.join(deps.dataDir, 'worktrees'),
    patchesDir: path.join(deps.dataDir, 'artifacts'),
    fetchFn: deps.fetchFn,
    onProgress: (ev) => deps.emitProgress(RunProgressIpcSchema.parse(ev)),
  });
}

async function resolveManualOfflineArtifacts(
  deps: DesktopIpcControllerDeps,
  dfe: ComplianceRun['dfe'],
  ntId: string,
): Promise<{
  readonly pdf: Awaited<ReturnType<typeof extractNtPdf>>;
  readonly pdfPath: string;
  readonly xsdDir: string;
} | null> {
  const entry = deps.db.listNtCatalogByDfe(dfe).find((item) => item.id === ntId);
  if (!entry || entry.sourceStatus !== 'MANUAL') {
    return null;
  }
  const safeSlug = `${entry.ntNumber}_${entry.ntVersion}`;
  if (safeSlug.includes('..') || /[\\/]/.test(safeSlug)) {
    throw new Error(`Identificador de NT manual inválido: '${ntId}'`);
  }
  const manualBase = path.join(deps.dataDir, 'cache', 'svrs', dfe, 'manual', safeSlug);
  const pdfPath = await resolveContainedNoSymlinkPath(manualBase, 'nt.pdf');
  const xsdDir = await resolveContainedNoSymlinkPath(manualBase, 'xsd');
  if (!existsSync(pdfPath) || !existsSync(xsdDir)) {
    throw new Error(`Artefatos locais da NT manual '${ntId}' não encontrados em cache`);
  }
  const pdf = await extractNtPdf(pdfPath, {
    cacheDir: path.join(deps.dataDir, 'cache', 'svrs', dfe),
  });
  return { pdf, pdfPath, xsdDir };
}

function createGateHooks(
  deps: DesktopIpcControllerDeps,
  runId: string,
  pendingResolvers: Map<string, PendingResolverEntry>,
): {
  readonly requestPreBuildApproval: (
    preview: PreBuildDiffPreview,
  ) => Promise<{ readonly approved: boolean; readonly reason?: string }>;
  readonly requestPrApproval: (info: {
    readonly runId: string;
    readonly branchName: string;
    readonly patchFilePath: string;
    readonly mavenResult: NonNullable<PendingApprovalGate['mavenResult']>;
  }) => Promise<{ readonly approved: boolean }>;
} {
  return {
    requestPreBuildApproval: (preview) =>
      new Promise((resolve, reject) => {
        const gateToken = crypto.randomUUID();
        const gate: PendingApprovalGate = { runId, kind: 'PRE_BUILD_DIFF', gateToken, preview };
        pendingResolvers.set(runId, { kind: 'PRE_BUILD_DIFF', gateToken, gate, resolve, reject });
        const current = deps.db.getComplianceRun(runId);
        if (current) {
          deps.emitProgress(
            RunProgressIpcSchema.parse({
              runId,
              dfe: current.dfe,
              ntId: current.ntId,
              step: 'PRE_BUILD_DIFF_REVIEW',
              status: current.status,
              message: 'Aguardando conferência pré-build do diff',
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }),
    requestPrApproval: (info) =>
      new Promise((resolve, reject) => {
        const gateToken = crypto.randomUUID();
        const gate: PendingApprovalGate = {
          runId,
          kind: 'PR_CONFIRMATION',
          gateToken,
          branchName: info.branchName,
          patchFilePath: info.patchFilePath,
          mavenResult: info.mavenResult,
        };
        pendingResolvers.set(runId, { kind: 'PR_CONFIRMATION', gateToken, gate, resolve, reject });
        const current = deps.db.getComplianceRun(runId);
        if (current) {
          deps.emitProgress(
            RunProgressIpcSchema.parse({
              runId,
              dfe: current.dfe,
              ntId: current.ntId,
              step: 'PR_REVIEW',
              status: current.status,
              message: 'Aguardando confirmação para push e PR no Gitea',
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }),
  };
}

/**
 * Registers and dispatches all allowlisted `ntc:*` IPC channels with strict Zod validation,
 * sender-frame verification, path confinement, async gate handshake tokens, and sanitized errors.
 */
export function createDesktopIpcController(deps: DesktopIpcControllerDeps): {
  readonly register: (ipcMain: IpcMainLike) => void;
  readonly dispatch: (
    channel: string,
    event: IpcMainEventLike,
    rawPayload: unknown,
  ) => Promise<unknown>;
  readonly dispose: () => void;
} {
  const orchestrator = deps.orchestrator ?? buildDefaultOrchestrator(deps);
  const allowedXsdRoots = deps.allowedXsdRoots ?? [path.join(deps.dataDir, 'cache', 'svrs')];
  const allowedRepoRoots = deps.allowedRepoRoots ?? [
    path.join(deps.dataDir, 'repos'),
    path.join(deps.dataDir, 'worktrees'),
  ];
  const pendingResolvers = new Map<string, PendingResolverEntry>();
  const activeApplyRuns = new Set<string>();

  const channelHandlers: TypedInvokeHandlerMap = {
    [IPC_CHANNELS.SYNC_SVRS]: async (raw) => {
      const req = SyncSvrsRequestSchema.parse(raw);
      const repos = deps.db.listDfeRepos();
      const targetRepos = req?.dfes
        ? repos.filter((repo) => req.dfes?.includes(repo.dfe))
        : repos;
      const results = await syncAllSvrsNts(targetRepos, { fetchFn: deps.fetchFn });
      const allEntries = results.flatMap((result) => result.entries);
      if (allEntries.length > 0) {
        deps.db.upsertNtCatalogEntries(allEntries);
      }
      return SyncSvrsResponseSchema.parse(results);
    },
    [IPC_CHANNELS.LIST_NTS]: async (raw) => {
      const req = ListNtsRequestSchema.parse(raw);
      return ListNtsResponseSchema.parse(deps.db.listNtCatalogByDfe(req?.dfe));
    },
    [IPC_CHANNELS.IMPORT_MANUAL_NT]: async (raw) => {
      const req = ImportManualNtInputSchema.parse(raw);
      const safePdfSource = assertSafeLocalFilesystemPath(req.pdfSourcePath, 'pdfSourcePath');
      const safeXsdSource = assertSafeLocalFilesystemPath(req.xsdSourcePath, 'xsdSourcePath');
      const imported = await importManualNt(
        { ...req, pdfSourcePath: safePdfSource, xsdSourcePath: safeXsdSource },
        path.join(deps.dataDir, 'cache'),
        deps.db,
      );
      return ImportManualNtResponseSchema.parse(imported);
    },
    [IPC_CHANNELS.LIST_REPOS]: async (raw) => {
      ListReposRequestSchema.parse(raw);
      return ListReposResponseSchema.parse(deps.db.listDfeRepos());
    },
    [IPC_CHANNELS.SAVE_REPO]: async (raw) => {
      const repo = SaveRepoInputSchema.parse(raw);
      deps.db.saveDfeRepo(repo);
      return SaveRepoInputSchema.parse(repo);
    },
    [IPC_CHANNELS.LIST_RUNS]: async (raw) => {
      const req = ListRunsRequestSchema.parse(raw);
      return ListRunsResponseSchema.parse(
        deps.db.listComplianceRuns(req?.dfe ? { dfe: req.dfe } : undefined),
      );
    },
    [IPC_CHANNELS.RUN_DOCTOR]: async (raw) => {
      const req = RunDoctorRequestSchema.parse(raw);
      if (req?.byokConfig) {
        assertBoundByokSecretKeyRef(req.byokConfig);
      }
      const safeSampleRepoDir = req?.sampleRepoDir
        ? await resolvePathWithinAllowedRoots(req.sampleRepoDir, allowedRepoRoots, 'sampleRepoDir')
        : undefined;
      const report = await runDoctor({
        oracleJarPath: deps.oracleJarPath,
        secretStore: deps.secretStore,
        giteaUrl: req?.giteaUrl,
        sampleRepoDir: safeSampleRepoDir,
        byokConfig: req?.byokConfig,
        fetchFn: deps.fetchFn ?? fetch,
      });
      return DoctorReportIpcSchema.parse(report);
    },
    [IPC_CHANNELS.CHECK_COMPLIANCE]: async (raw) => {
      const req = CheckComplianceRequestSchema.parse(raw);
      assertBoundByokSecretKeyRef(req.byokConfig);
      const runId = req.runId ?? `run-${crypto.randomUUID()}`;
      let resolvedArtifacts:
        | { readonly pdf: Awaited<ReturnType<typeof extractNtPdf>>; readonly pdfPath: string; readonly xsdDir: string }
        | undefined;

      if (req.pdfPath && req.xsdDir) {
        const safePdfPath = await resolvePathWithinAllowedRoots(
          req.pdfPath,
          [deps.dataDir, ...allowedXsdRoots],
          'pdfPath',
        );
        const safeXsdDir = await resolvePathWithinAllowedRoots(req.xsdDir, allowedXsdRoots, 'xsdDir');
        const pdf = await extractNtPdf(safePdfPath, {
          cacheDir: path.join(deps.dataDir, 'cache', 'svrs', req.dfe),
        });
        resolvedArtifacts = { pdf, pdfPath: safePdfPath, xsdDir: safeXsdDir };
      } else {
        const manualArtifacts = await resolveManualOfflineArtifacts(deps, req.dfe, req.ntId);
        if (manualArtifacts) {
          resolvedArtifacts = manualArtifacts;
        }
      }

      const result = await orchestrator.generateDraftNc({
        runId,
        dfe: req.dfe,
        ntId: req.ntId,
        byokConfig: req.byokConfig,
        ...(resolvedArtifacts ? { resolvedArtifacts } : {}),
      });
      return CheckComplianceResponseSchema.parse({
        run: result.run,
        nc: result.savedNc.nc,
        xsdDir: result.xsdDir,
      });
    },
    [IPC_CHANNELS.GET_NC]: async (raw) => {
      const { runId } = GetNcRequestSchema.parse(raw);
      const run = deps.db.getComplianceRun(runId);
      if (!run?.ncJsonPath) {
        throw new Error(`NC não encontrada para execução '${runId}'`);
      }
      const absPath = await resolveContainedNoSymlinkPath(path.join(deps.dataDir, 'ncs'), run.ncJsonPath);
      const nc = await loadNcDocument(absPath);
      return NcLoadedViewSchema.parse({ run, nc, markdown: renderNcMarkdown(nc) });
    },
    [IPC_CHANNELS.SAVE_NC]: async (raw) => {
      const { runId, nc } = SaveNcRequestSchema.parse(raw);
      const run = deps.db.getComplianceRun(runId);
      if (!run) {
        throw new Error(`Execução '${runId}' não encontrada`);
      }
      if (run.status === 'FAILED' || run.status === 'PR_OPENED') {
        throw new Error(`Execução '${runId}' em estado terminal '${run.status}' não pode ser editada`);
      }
      const ncNtId = `${nc.nt_ref.dfe}:${nc.nt_ref.nt_number}:${nc.nt_ref.nt_version}`;
      if (nc.nt_ref.dfe !== run.dfe || ncNtId !== run.ntId) {
        throw new Error(`Documento NC não corresponde ao DFe/NT da execução '${runId}'`);
      }
      if (run.baseCommitSha && nc.base_commit_sha !== run.baseCommitSha) {
        throw new Error(`base_commit_sha da NC diverge do snapshot registrado na execução '${runId}'`);
      }
      const saved = await saveNcDocument(path.join(deps.dataDir, 'ncs', run.dfe), nc);
      const relNc = path.relative(path.join(deps.dataDir, 'ncs'), saved.jsonPath).replace(/\\/g, '/');
      const updatedRun = deps.db.updateComplianceRunProgress({ runId, ncJsonPath: relNc });
      return NcLoadedViewSchema.parse({ run: updatedRun, nc: saved.nc, markdown: renderNcMarkdown(saved.nc) });
    },
    [IPC_CHANNELS.APPLY_NC]: async (raw) => {
      const req = ApplyNcRequestSchema.parse(raw);
      assertBoundByokSecretKeyRef(req.byokConfig);
      if (activeApplyRuns.has(req.runId)) {
        throw new Error(`Execução '${req.runId}' já está aplicando NC em andamento`);
      }
      let safeXsdDir: string;
      if (req.xsdDir === 'N/A') {
        const run = deps.db.getComplianceRun(req.runId);
        if (!run?.ncJsonPath) {
          throw new Error('Caminho para xsdDir fora dos diretórios permitidos');
        }
        const ncAbsPath = await resolveContainedNoSymlinkPath(path.join(deps.dataDir, 'ncs'), run.ncJsonPath);
        const nc = await loadNcDocument(ncAbsPath);
        if (!nc.no_structural_gaps) {
          throw new Error('Caminho para xsdDir fora dos diretórios permitidos');
        }
        safeXsdDir = 'N/A';
      } else {
        safeXsdDir = await resolvePathWithinAllowedRoots(req.xsdDir, allowedXsdRoots, 'xsdDir');
      }
      activeApplyRuns.add(req.runId);
      try {
        const outcome = await orchestrator.approveAndRunCompliance({
          runId: req.runId,
          byokConfig: req.byokConfig,
          xsdDir: safeXsdDir,
          ...createGateHooks(deps, req.runId, pendingResolvers),
        });
        return ApplyNcOutcomeSchema.parse(outcome);
      } finally {
        activeApplyRuns.delete(req.runId);
        pendingResolvers.delete(req.runId);
      }
    },
    [IPC_CHANNELS.GET_PENDING_GATE]: async (raw) => {
      const { runId } = GetPendingGateRequestSchema.parse(raw);
      const entry = pendingResolvers.get(runId);
      return entry ? PendingApprovalGateSchema.parse(entry.gate) : null;
    },
    [IPC_CHANNELS.CONFIRM_PRE_BUILD_DIFF]: async (raw) => {
      const { runId, approved, reason, gateToken } = ConfirmPreBuildDiffRequestSchema.parse(raw);
      const entry = pendingResolvers.get(runId);
      if (!entry || entry.kind !== 'PRE_BUILD_DIFF') {
        return AckResponseSchema.parse({ acknowledged: false });
      }
      if (gateToken !== undefined && gateToken !== entry.gateToken) {
        return AckResponseSchema.parse({ acknowledged: false });
      }
      pendingResolvers.delete(runId);
      entry.resolve({ approved, ...(reason ? { reason } : {}) });
      return AckResponseSchema.parse({ acknowledged: true });
    },
    [IPC_CHANNELS.OPEN_PR]: async (raw) => {
      const { runId, approved, gateToken } = OpenPrRequestSchema.parse(raw);
      const entry = pendingResolvers.get(runId);
      if (!entry || entry.kind !== 'PR_CONFIRMATION') {
        return AckResponseSchema.parse({ acknowledged: false });
      }
      if (gateToken !== undefined && gateToken !== entry.gateToken) {
        return AckResponseSchema.parse({ acknowledged: false });
      }
      pendingResolvers.delete(runId);
      entry.resolve({ approved });
      return AckResponseSchema.parse({ acknowledged: true });
    },
    [IPC_CHANNELS.SET_SECRET]: async (raw) => {
      const { key, value } = SetSecretRequestSchema.parse(raw);
      await deps.secretStore.setSecret(key, value);
      return SecretStatusResponseSchema.parse(await deps.secretStore.getSecretStatus(key));
    },
    [IPC_CHANNELS.GET_SECRET_STATUS]: async (raw) => {
      const { key } = GetSecretStatusRequestSchema.parse(raw);
      return SecretStatusResponseSchema.parse(await deps.secretStore.getSecretStatus(key));
    },
    [IPC_CHANNELS.GET_BYOK_CONFIG]: async (raw) => {
      GetByokConfigRequestSchema.parse(raw);
      return GetByokConfigResponseSchema.parse(deps.db.getByokConfig());
    },
    [IPC_CHANNELS.SAVE_BYOK_CONFIG]: async (raw) => {
      const config = SaveByokConfigRequestSchema.parse(raw);
      assertBoundByokSecretKeyRef(config);
      return SaveByokConfigRequestSchema.parse(deps.db.saveByokConfig(config));
    },
    [IPC_CHANNELS.START_COPILOT_AUTH]: async (raw) => {
      StartCopilotAuthRequestSchema.parse(raw);
      return CopilotAuthStartResponseSchema.parse(await requestCopilotDeviceCode(deps.fetchFn));
    },
    [IPC_CHANNELS.POLL_COPILOT_AUTH]: async (raw) => {
      const { deviceCode } = PollCopilotAuthRequestSchema.parse(raw);
      const outcome = await pollCopilotDeviceToken(deviceCode, deps.fetchFn);
      if (outcome.status === 'authorized' && outcome.accessToken) {
        await deps.secretStore.setSecret(llmSecretKey('github-copilot'), outcome.accessToken);
        return CopilotAuthPollResponseSchema.parse({ status: 'authorized' });
      }
      return CopilotAuthPollResponseSchema.parse({
        status: outcome.status,
        ...(outcome.interval !== undefined ? { interval: outcome.interval } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      });
    },
  };

  const handlerMap = new Map<string, (rawPayload: unknown) => Promise<unknown>>(
    Object.entries(channelHandlers),
  );

  async function dispatch(
    channel: string,
    event: IpcMainEventLike,
    rawPayload: unknown,
  ): Promise<unknown> {
    if (!isAllowedSenderFrame(event.senderFrame?.url, deps.allowedSenderOrigins)) {
      throw new Error('Origem de frame IPC não autorizada ou bloqueada');
    }
    try {
      const handler = handlerMap.get(channel);
      if (!handler) {
        throw new Error('Canal IPC não registrado');
      }
      return await handler(rawPayload);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(sanitizeIpcErrorMessage(msg, deps.dataDir));
    }
  }

  function register(ipcMain: IpcMainLike): void {
    for (const channel of handlerMap.keys()) {
      ipcMain.handle(channel, (event, payload) => dispatch(channel, event, payload));
    }
  }

  function dispose(): void {
    const err = new Error('Janela desktop encerrada durante aprovação pendente');
    for (const entry of pendingResolvers.values()) {
      entry.reject(err);
    }
    pendingResolvers.clear();
    activeApplyRuns.clear();
  }

  return { register, dispatch, dispose };
}
