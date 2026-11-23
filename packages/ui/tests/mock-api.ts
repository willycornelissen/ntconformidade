import { vi } from 'vitest';
import type { NtcDesktopApi } from '@ntc/core';

export function makeMockApi(overrides: Partial<NtcDesktopApi> = {}): NtcDesktopApi {
  return {
    syncSvrs: vi.fn(async () => []),
    listNts: vi.fn(async () => []),
    importManualNt: vi.fn(async () => {
      throw new Error('not mocked');
    }),
    listRepos: vi.fn(async () => []),
    saveRepo: vi.fn(async (repo) => repo),
    listRuns: vi.fn(async () => []),
    runDoctor: vi.fn(async () => ({ ok: true, checkedAt: '2026-11-19T12:00:00.000Z', checks: [] })),
    checkCompliance: vi.fn(async () => {
      throw new Error('not mocked');
    }),
    getNc: vi.fn(async () => {
      throw new Error('not mocked');
    }),
    saveNc: vi.fn(async () => {
      throw new Error('not mocked');
    }),
    applyNc: vi.fn(async () => {
      throw new Error('not mocked');
    }),
    getPendingGate: vi.fn(async () => null),
    confirmPreBuildDiff: vi.fn(async () => ({ acknowledged: true })),
    openPr: vi.fn(async () => ({ acknowledged: true })),
    setSecret: vi.fn(async () => ({ configured: true })),
    getSecretStatus: vi.fn(async () => ({ configured: false })),
    getByokConfig: vi.fn(async () => null),
    saveByokConfig: vi.fn(async (cfg) => cfg),
    startCopilotAuth: vi.fn(async () => ({
      deviceCode: 'dev-code-mock',
      userCode: 'MOCK-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 1,
    })),
    pollCopilotAuth: vi.fn(async () => ({ status: 'pending' as const })),
    onRunProgress: vi.fn(() => () => undefined),
    ...overrides,
  };
}
