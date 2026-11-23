import type {
  IPC_CHANNELS,
  InvokeIpcChannelName,
  NtcDesktopApi,
  NtcInvokeResponseMap,
  RunProgressEvent,
} from '@ntc/core';

/** Minimal `contextBridge` surface exposed in Electron sandboxed preload. */
export interface ContextBridgeLike {
  exposeInMainWorld(apiKey: string, api: unknown): void;
}

/** Minimal `ipcRenderer` subset permitted inside preload (never exposed to renderer directly). */
export interface IpcRendererLike {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (_event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (_event: unknown, payload: unknown) => void): void;
}

const RUN_PROGRESS_CHANNEL: typeof IPC_CHANNELS.RUN_PROGRESS = 'ntc:run-progress';

function invokeChannel<C extends InvokeIpcChannelName>(
  ipcRenderer: IpcRendererLike,
  channel: C,
  payload?: unknown,
): Promise<NtcInvokeResponseMap[C]> {
  return ipcRenderer.invoke(channel, payload) as Promise<NtcInvokeResponseMap[C]>;
}

function isRunProgressEventLike(value: unknown): value is RunProgressEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.runId === 'string' &&
    typeof rec.dfe === 'string' &&
    typeof rec.ntId === 'string' &&
    typeof rec.step === 'string' &&
    typeof rec.status === 'string' &&
    typeof rec.message === 'string' &&
    typeof rec.timestamp === 'string'
  );
}

/** Builds a strictly typed, frozen, allowlisted `window.ntcApi` wrapper without leaking Electron primitives. */
export function createNtcBridge(ipcRenderer: IpcRendererLike): NtcDesktopApi {
  return Object.freeze<NtcDesktopApi>({
    syncSvrs: (req) => invokeChannel(ipcRenderer, 'ntc:sync-svrs', req),
    listNts: (req) => invokeChannel(ipcRenderer, 'ntc:list-nts', req),
    importManualNt: (req) => invokeChannel(ipcRenderer, 'ntc:import-manual-nt', req),
    listRepos: () => invokeChannel(ipcRenderer, 'ntc:list-repos'),
    saveRepo: (repo) => invokeChannel(ipcRenderer, 'ntc:save-repo', repo),
    listRuns: (req) => invokeChannel(ipcRenderer, 'ntc:list-runs', req),
    runDoctor: (req) => invokeChannel(ipcRenderer, 'ntc:run-doctor', req),
    checkCompliance: (req) => invokeChannel(ipcRenderer, 'ntc:check-compliance', req),
    getNc: (req) => invokeChannel(ipcRenderer, 'ntc:get-nc', req),
    saveNc: (req) => invokeChannel(ipcRenderer, 'ntc:save-nc', req),
    applyNc: (req) => invokeChannel(ipcRenderer, 'ntc:apply-nc', req),
    getPendingGate: (req) => invokeChannel(ipcRenderer, 'ntc:get-pending-gate', req),
    confirmPreBuildDiff: (req) => invokeChannel(ipcRenderer, 'ntc:confirm-pre-build-diff', req),
    openPr: (req) => invokeChannel(ipcRenderer, 'ntc:open-pr', req),
    setSecret: (req) => invokeChannel(ipcRenderer, 'ntc:set-secret', req),
    getSecretStatus: (req) => invokeChannel(ipcRenderer, 'ntc:get-secret-status', req),
    getByokConfig: () => invokeChannel(ipcRenderer, 'ntc:get-byok-config'),
    saveByokConfig: (cfg) => invokeChannel(ipcRenderer, 'ntc:save-byok-config', cfg),
    startCopilotAuth: () => invokeChannel(ipcRenderer, 'ntc:start-copilot-auth'),
    pollCopilotAuth: (req) => invokeChannel(ipcRenderer, 'ntc:poll-copilot-auth', req),
    onRunProgress: (listener) => {
      if (typeof listener !== 'function') {
        throw new TypeError('listener de progresso deve ser uma função');
      }
      const wrapped = (_event: unknown, payload: unknown): void => {
        if (isRunProgressEventLike(payload)) {
          listener(payload);
        }
      };
      ipcRenderer.on(RUN_PROGRESS_CHANNEL, wrapped);
      return () => {
        ipcRenderer.removeListener(RUN_PROGRESS_CHANNEL, wrapped);
      };
    },
  });
}

/** Exposes `window.ntcApi` safely via `contextBridge`. */
export function exposeNtcApi(
  contextBridge: ContextBridgeLike,
  ipcRenderer: IpcRendererLike,
): void {
  contextBridge.exposeInMainWorld('ntcApi', createNtcBridge(ipcRenderer));
}

if (
  typeof process !== 'undefined' &&
  Boolean(process.versions?.electron) &&
  Object.getOwnPropertyDescriptor(process, 'contextIsolated')?.value === true
) {
  // Dynamically resolved only inside Electron sandboxed preload runtime
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as {
    contextBridge: ContextBridgeLike;
    ipcRenderer: IpcRendererLike;
  };
  exposeNtcApi(electron.contextBridge, electron.ipcRenderer);
}
