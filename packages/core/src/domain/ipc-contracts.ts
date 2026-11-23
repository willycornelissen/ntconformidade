import { z } from 'zod';
import type { ManualNtImportRequest, MavenTestRunResult } from '../ports/interfaces.js';
import {
  ByokConfigSchema,
  ComplianceRunSchema,
  DfeCodeSchema,
  DfeRepoEntrySchema,
  DoctorReportSchema,
  GITEA_PAT_SECRET_KEY,
  HttpsUrlSchema,
  ManualNtImportRequestSchema,
  MavenTestRunResultIpcSchema,
  NcDocumentSchema,
  NtCatalogEntrySchema,
  PreBuildDiffPreviewSchema,
  RunProgressEventSchema,
  SvrsDfeSyncResultSchema,
  llmSecretKey,
  type ByokConfig,
  type ComplianceRun,
  type DfeCode,
  type DfeRepoEntry,
  type DoctorReport,
  type NcDocument,
  type NtCatalogEntry,
  type PreBuildDiffPreview,
  type RunProgressEvent,
  type SvrsDfeSyncResult,
} from './types.js';

/** Closed list of Electron IPC channels authorized across `contextBridge`. */
export const IPC_CHANNELS = Object.freeze({
  SYNC_SVRS: 'ntc:sync-svrs',
  LIST_NTS: 'ntc:list-nts',
  IMPORT_MANUAL_NT: 'ntc:import-manual-nt',
  LIST_REPOS: 'ntc:list-repos',
  SAVE_REPO: 'ntc:save-repo',
  RUN_DOCTOR: 'ntc:run-doctor',
  CHECK_COMPLIANCE: 'ntc:check-compliance',
  GET_NC: 'ntc:get-nc',
  SAVE_NC: 'ntc:save-nc',
  APPLY_NC: 'ntc:apply-nc',
  CONFIRM_PRE_BUILD_DIFF: 'ntc:confirm-pre-build-diff',
  OPEN_PR: 'ntc:open-pr',
  SET_SECRET: 'ntc:set-secret',
  GET_SECRET_STATUS: 'ntc:get-secret-status',
  GET_BYOK_CONFIG: 'ntc:get-byok-config',
  SAVE_BYOK_CONFIG: 'ntc:save-byok-config',
  START_COPILOT_AUTH: 'ntc:start-copilot-auth',
  POLL_COPILOT_AUTH: 'ntc:poll-copilot-auth',
  LIST_RUNS: 'ntc:list-runs',
  GET_PENDING_GATE: 'ntc:get-pending-gate',
  RUN_PROGRESS: 'ntc:run-progress',
} as const);

export type IpcChannelName = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
export type InvokeIpcChannelName = Exclude<IpcChannelName, typeof IPC_CHANNELS.RUN_PROGRESS>;

export const MAX_IPC_SECRET_BYTES = 64 * 1024;

export const SECRET_KEY_TARGETS = [
  GITEA_PAT_SECRET_KEY,
  llmSecretKey('gemini'),
  llmSecretKey('openai-compatible'),
  llmSecretKey('github-copilot'),
] as const;

export const SecretKeyTargetSchema = z.enum(SECRET_KEY_TARGETS);
export type SecretKeyTarget = z.infer<typeof SecretKeyTargetSchema>;

/** Enforces that IPC-supplied BYOK configurations only reference the matching provider secret slot. */
export const IpcByokConfigSchema = ByokConfigSchema.superRefine((cfg, ctx) => {
  const expectedKey = llmSecretKey(cfg.provider);
  if (cfg.secretKeyRef !== expectedKey) {
    ctx.addIssue({
      code: 'custom',
      path: ['secretKeyRef'],
      message: `secretKeyRef inválido para provedor '${cfg.provider}': esperado '${expectedKey}'`,
    });
  }
});

export const SyncSvrsRequestSchema = z
  .object({
    dfes: z.array(DfeCodeSchema).optional(),
  })
  .optional();

export const ListNtsRequestSchema = z
  .object({
    dfe: DfeCodeSchema.optional(),
  })
  .optional();

export const ListReposRequestSchema = z.undefined();

export const ListRunsRequestSchema = z
  .object({
    dfe: DfeCodeSchema.optional(),
  })
  .optional();

export const RunDoctorRequestSchema = z
  .object({
    giteaUrl: HttpsUrlSchema.optional(),
    sampleRepoDir: z.string().min(1).optional(),
    byokConfig: IpcByokConfigSchema.optional(),
  })
  .optional();

export const CheckComplianceRequestSchema = z
  .object({
    runId: z.string().min(1).optional(),
    dfe: DfeCodeSchema,
    ntId: z.string().min(1),
    byokConfig: IpcByokConfigSchema,
    xsdDir: z.string().min(1).optional(),
    pdfPath: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if ((val.pdfPath === undefined) !== (val.xsdDir === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [val.pdfPath === undefined ? 'pdfPath' : 'xsdDir'],
        message: 'pdfPath e xsdDir devem ser informados em conjunto.',
      });
    }
  });
export type CheckComplianceRequest = z.infer<typeof CheckComplianceRequestSchema>;

export const GetNcRequestSchema = z.object({
  runId: z.string().min(1),
});

export const SaveNcRequestSchema = z.object({
  runId: z.string().min(1),
  nc: NcDocumentSchema,
});

export const ApplyNcRequestSchema = z.object({
  runId: z.string().min(1),
  byokConfig: IpcByokConfigSchema,
  xsdDir: z.string().min(1),
});
export type ApplyNcRequest = z.infer<typeof ApplyNcRequestSchema>;

export const ConfirmPreBuildDiffRequestSchema = z.object({
  runId: z.string().min(1),
  approved: z.boolean(),
  reason: z.string().optional(),
  gateToken: z.string().min(1).optional(),
});

export const OpenPrRequestSchema = z.object({
  runId: z.string().min(1),
  approved: z.boolean(),
  gateToken: z.string().min(1).optional(),
});

export const SetSecretRequestSchema = z.object({
  key: SecretKeyTargetSchema,
  value: z
    .string()
    .max(MAX_IPC_SECRET_BYTES, 'Segredo excede o limite de 64 KB')
    .refine((v) => v.trim().length > 0, 'Segredo não pode ser vazio'),
});

export const GetSecretStatusRequestSchema = z.object({
  key: SecretKeyTargetSchema,
});

export const GetPendingGateRequestSchema = z.object({
  runId: z.string().min(1),
});

export const GetByokConfigRequestSchema = z.undefined();
export const SaveByokConfigRequestSchema = IpcByokConfigSchema;
export const StartCopilotAuthRequestSchema = z.undefined();
export const PollCopilotAuthRequestSchema = z.object({
  deviceCode: z.string().min(1),
});

export const CopilotAuthStartResponseSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: HttpsUrlSchema,
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
});
export type CopilotAuthStartResponse = z.infer<typeof CopilotAuthStartResponseSchema>;

export const CopilotAuthPollResponseSchema = z.object({
  status: z.enum(['pending', 'slow_down', 'authorized', 'expired', 'denied', 'error']),
  interval: z.number().int().positive().optional(),
  error: z.string().optional(),
});
export type CopilotAuthPollResponse = z.infer<typeof CopilotAuthPollResponseSchema>;

export const GetByokConfigResponseSchema = ByokConfigSchema.nullable();

export interface NcLoadedView {
  readonly run: ComplianceRun;
  readonly nc: NcDocument;
  readonly markdown: string;
}

export interface PendingApprovalGate {
  readonly runId: string;
  readonly kind: 'PRE_BUILD_DIFF' | 'PR_CONFIRMATION';
  readonly gateToken?: string;
  readonly preview?: PreBuildDiffPreview;
  readonly branchName?: string;
  readonly patchFilePath?: string;
  readonly mavenResult?: MavenTestRunResult;
}

export interface ApplyNcOutcome {
  readonly run: ComplianceRun;
  readonly patchFilePath: string | null;
  readonly prUrl: string | null;
  readonly mavenResult: MavenTestRunResult | null;
}

export const ImportManualNtResponseSchema = z.object({
  entry: NtCatalogEntrySchema,
  xsdDir: z.string().min(1),
});

export const CheckComplianceResponseSchema = z.object({
  run: ComplianceRunSchema,
  nc: NcDocumentSchema,
  xsdDir: z.string().min(1),
});

export const NcLoadedViewSchema = z.object({
  run: ComplianceRunSchema,
  nc: NcDocumentSchema,
  markdown: z.string(),
});

export const PendingApprovalGateSchema = z.object({
  runId: z.string().min(1),
  kind: z.enum(['PRE_BUILD_DIFF', 'PR_CONFIRMATION']),
  gateToken: z.string().min(1).optional(),
  preview: PreBuildDiffPreviewSchema.optional(),
  branchName: z.string().optional(),
  patchFilePath: z.string().optional(),
  mavenResult: MavenTestRunResultIpcSchema.optional(),
});

export const ApplyNcOutcomeSchema = z.object({
  run: ComplianceRunSchema,
  patchFilePath: z.string().nullable(),
  prUrl: z.string().nullable(),
  mavenResult: MavenTestRunResultIpcSchema.nullable(),
});

export const AckResponseSchema = z.object({ acknowledged: z.boolean() });
export const SyncSvrsResponseSchema = z.array(SvrsDfeSyncResultSchema);
export const ListNtsResponseSchema = z.array(NtCatalogEntrySchema);
export const ListReposResponseSchema = z.array(DfeRepoEntrySchema);
export const ListRunsResponseSchema = z.array(ComplianceRunSchema);
export const SecretStatusResponseSchema = z.object({ configured: z.boolean() });
export const DoctorReportIpcSchema = DoctorReportSchema;
export const PreBuildDiffIpcSchema = PreBuildDiffPreviewSchema;
export const RunProgressIpcSchema = RunProgressEventSchema;
export const SaveRepoInputSchema = DfeRepoEntrySchema;
export const ImportManualNtInputSchema = ManualNtImportRequestSchema;

/** Map of all 16 request/response invoke channels to their canonical response types. */
export interface NtcInvokeResponseMap {
  readonly [IPC_CHANNELS.SYNC_SVRS]: readonly SvrsDfeSyncResult[];
  readonly [IPC_CHANNELS.LIST_NTS]: readonly NtCatalogEntry[];
  readonly [IPC_CHANNELS.IMPORT_MANUAL_NT]: { readonly entry: NtCatalogEntry; readonly xsdDir: string };
  readonly [IPC_CHANNELS.LIST_REPOS]: readonly DfeRepoEntry[];
  readonly [IPC_CHANNELS.SAVE_REPO]: DfeRepoEntry;
  readonly [IPC_CHANNELS.LIST_RUNS]: readonly ComplianceRun[];
  readonly [IPC_CHANNELS.RUN_DOCTOR]: DoctorReport;
  readonly [IPC_CHANNELS.CHECK_COMPLIANCE]: {
    readonly run: ComplianceRun;
    readonly nc: NcDocument;
    readonly xsdDir: string;
  };
  readonly [IPC_CHANNELS.GET_NC]: NcLoadedView;
  readonly [IPC_CHANNELS.SAVE_NC]: NcLoadedView;
  readonly [IPC_CHANNELS.APPLY_NC]: ApplyNcOutcome;
  readonly [IPC_CHANNELS.GET_PENDING_GATE]: PendingApprovalGate | null;
  readonly [IPC_CHANNELS.CONFIRM_PRE_BUILD_DIFF]: { readonly acknowledged: boolean };
  readonly [IPC_CHANNELS.OPEN_PR]: { readonly acknowledged: boolean };
  readonly [IPC_CHANNELS.SET_SECRET]: { readonly configured: boolean };
  readonly [IPC_CHANNELS.GET_SECRET_STATUS]: { readonly configured: boolean };
  readonly [IPC_CHANNELS.GET_BYOK_CONFIG]: ByokConfig | null;
  readonly [IPC_CHANNELS.SAVE_BYOK_CONFIG]: ByokConfig;
  readonly [IPC_CHANNELS.START_COPILOT_AUTH]: CopilotAuthStartResponse;
  readonly [IPC_CHANNELS.POLL_COPILOT_AUTH]: CopilotAuthPollResponse;
}

/** Typed preload bridge contract exposed to `@ntc/ui` as `window.ntcApi`. */
export interface NtcDesktopApi {
  syncSvrs(request?: { readonly dfes?: readonly DfeCode[] }): Promise<readonly SvrsDfeSyncResult[]>;
  listNts(request?: { readonly dfe?: DfeCode }): Promise<readonly NtCatalogEntry[]>;
  importManualNt(
    request: ManualNtImportRequest,
  ): Promise<{ readonly entry: NtCatalogEntry; readonly xsdDir: string }>;
  listRepos(): Promise<readonly DfeRepoEntry[]>;
  saveRepo(repo: DfeRepoEntry): Promise<DfeRepoEntry>;
  listRuns(request?: { readonly dfe?: DfeCode }): Promise<readonly ComplianceRun[]>;
  runDoctor(request?: {
    readonly giteaUrl?: string;
    readonly sampleRepoDir?: string;
    readonly byokConfig?: ByokConfig;
  }): Promise<DoctorReport>;
  checkCompliance(request: CheckComplianceRequest): Promise<{
    readonly run: ComplianceRun;
    readonly nc: NcDocument;
    readonly xsdDir: string;
  }>;
  getNc(request: { readonly runId: string }): Promise<NcLoadedView>;
  saveNc(request: { readonly runId: string; readonly nc: NcDocument }): Promise<NcLoadedView>;
  applyNc(request: ApplyNcRequest): Promise<ApplyNcOutcome>;
  getPendingGate(request: { readonly runId: string }): Promise<PendingApprovalGate | null>;
  confirmPreBuildDiff(request: {
    readonly runId: string;
    readonly approved: boolean;
    readonly reason?: string;
    readonly gateToken?: string;
  }): Promise<{ readonly acknowledged: boolean }>;
  openPr(request: {
    readonly runId: string;
    readonly approved: boolean;
    readonly gateToken?: string;
  }): Promise<{
    readonly acknowledged: boolean;
  }>;
  setSecret(request: { readonly key: SecretKeyTarget; readonly value: string }): Promise<{
    readonly configured: boolean;
  }>;
  getSecretStatus(request: { readonly key: SecretKeyTarget }): Promise<{
    readonly configured: boolean;
  }>;
  getByokConfig(): Promise<ByokConfig | null>;
  saveByokConfig(config: ByokConfig): Promise<ByokConfig>;
  startCopilotAuth(): Promise<CopilotAuthStartResponse>;
  pollCopilotAuth(request: { readonly deviceCode: string }): Promise<CopilotAuthPollResponse>;
  onRunProgress(listener: (event: RunProgressEvent) => void): () => void;
}
