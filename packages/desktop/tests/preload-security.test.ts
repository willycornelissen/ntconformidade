import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@ntc/core';
import {
  buildHardenedWebPreferences,
  buildMainWindowOptions,
  configureLinuxGpuAcceleration,
  configureLinuxKeyringBackend,
  isAllowedNavigationUrl,
  resolveDevServerUrl,
  resolveNtcDataDir,
  STRICT_CSP_HEADER,
} from '../src/main.js';
import { createNtcBridge, exposeNtcApi } from '../src/preload.cjs';

describe('Preload Bridge & Electron BrowserWindow Security', () => {
  it('PL-01: exposeNtcApi exposes strictly frozen allowlisted window.ntcApi without raw ipcRenderer', () => {
    const exposed: Record<string, unknown> = {};
    const contextBridge = {
      exposeInMainWorld(key: string, api: unknown) {
        exposed[key] = api;
      },
    };
    const invokeSpy = vi.fn(async () => []);
    const onSpy = vi.fn();
    const removeListenerSpy = vi.fn();
    const ipcRenderer = {
      invoke: invokeSpy,
      on: onSpy,
      removeListener: removeListenerSpy,
    };

    exposeNtcApi(contextBridge, ipcRenderer);

    const api = exposed.ntcApi as Record<string, unknown>;
    expect(api).toBeDefined();
    expect(Object.isFrozen(api)).toBe(true);
    expect(api.ipcRenderer).toBeUndefined();
    expect(api.process).toBeUndefined();

    const expectedMethods = [
      'syncSvrs',
      'listNts',
      'importManualNt',
      'listRepos',
      'saveRepo',
      'listRuns',
      'runDoctor',
      'checkCompliance',
      'getNc',
      'saveNc',
      'applyNc',
      'getPendingGate',
      'confirmPreBuildDiff',
      'openPr',
      'setSecret',
      'getSecretStatus',
      'getByokConfig',
      'saveByokConfig',
      'startCopilotAuth',
      'pollCopilotAuth',
      'listCopilotModels',
      'testCopilot',
      'testGitea',
      'onRunProgress',
    ];
    for (const method of expectedMethods) {
      expect(typeof api[method]).toBe('function');
    }
  });

  it('PL-02: createNtcBridge forwards invokes, filters malformed progress events, and unsubscribes cleanly', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const invokeSpy = vi.fn(async () => ({ configured: true }));
    const ipcRenderer = {
      invoke: invokeSpy,
      on(channel: string, listener: (...args: unknown[]) => void) {
        listeners.set(channel, listener);
      },
      removeListener(channel: string, listener: (...args: unknown[]) => void) {
        if (listeners.get(channel) === listener) {
          listeners.delete(channel);
        }
      },
    };

    const bridge = createNtcBridge(ipcRenderer);
    await bridge.getSecretStatus({ key: 'ntc:gitea:pat' });
    expect(invokeSpy).toHaveBeenCalledWith(IPC_CHANNELS.GET_SECRET_STATUS, { key: 'ntc:gitea:pat' });

    const received: unknown[] = [];
    const unsubscribe = bridge.onRunProgress((ev) => received.push(ev));
    expect(listeners.has(IPC_CHANNELS.RUN_PROGRESS)).toBe(true);

    // Malformed payloads are ignored
    listeners.get(IPC_CHANNELS.RUN_PROGRESS)!({}, { runId: 'r1' });
    expect(received).toHaveLength(0);

    const validEvent = {
      runId: 'r1',
      dfe: 'NFe',
      ntId: 'NFe:2025.002:1.30',
      step: 'COMPLETED',
      status: 'DRAFT',
      message: 'ok',
      timestamp: '2026-11-19T12:00:00.000Z',
    };
    listeners.get(IPC_CHANNELS.RUN_PROGRESS)!({}, validEvent);
    expect(received).toEqual([validEvent]);

    unsubscribe();
    expect(listeners.has(IPC_CHANNELS.RUN_PROGRESS)).toBe(false);
  });

  it('PL-03: enforces hardened webPreferences, CSP directives, packaged overrides, and blocks URL bypasses', () => {
    const prefs = buildHardenedWebPreferences('/opt/app/preload/preload.cjs');
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.nodeIntegrationInWorker).toBe(false);
    expect(prefs.nodeIntegrationInSubFrames).toBe(false);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.webviewTag).toBe(false);
    expect(prefs.navigateOnDragDrop).toBe(false);

    const windowOpts = buildMainWindowOptions('/opt/app/preload/preload.cjs');
    expect(windowOpts.autoHideMenuBar).toBe(true);
    expect(windowOpts.webPreferences).toEqual(prefs);

    const appended: Array<[string, string | undefined]> = [];
    const applied = configureLinuxKeyringBackend({
      platform: 'linux',
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      commandLine: {
        hasSwitch: () => false,
        appendSwitch: (k, v) => appended.push([k, v]),
      },
    });
    expect(applied).toBe(true);
    expect(appended).toEqual([['password-store', 'gnome-libsecret']]);

    expect(
      configureLinuxKeyringBackend({
        platform: 'linux',
        env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_CURRENT_DESKTOP: 'GNOME' },
        commandLine: { hasSwitch: () => false, appendSwitch: () => undefined },
      }),
    ).toBe(false);
    expect(
      configureLinuxKeyringBackend({
        platform: 'win32',
        env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
        commandLine: { hasSwitch: () => false, appendSwitch: () => undefined },
      }),
    ).toBe(false);

    const gpuSwitches: Array<[string, string | undefined]> = [];
    let hwAccelDisabled = 0;
    expect(
      configureLinuxGpuAcceleration({
        platform: 'linux',
        env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' },
        commandLine: {
          hasSwitch: () => false,
          appendSwitch: (k, v) => gpuSwitches.push([k, v]),
        },
        disableHardwareAcceleration: () => {
          hwAccelDisabled += 1;
        },
        hasDriDevice: () => true,
      }),
    ).toBe(true);
    expect(hwAccelDisabled).toBe(1);
    expect(gpuSwitches).toEqual([['disable-gpu', undefined]]);

    // Native Linux with /dev/dri keeps hardware acceleration enabled
    expect(
      configureLinuxGpuAcceleration({
        platform: 'linux',
        env: {},
        commandLine: { hasSwitch: () => false, appendSwitch: () => undefined },
        disableHardwareAcceleration: () => {
          hwAccelDisabled += 1;
        },
        hasDriDevice: () => true,
      }),
    ).toBe(false);

    // Explicit opt-out via NTC_DISABLE_GPU=0
    expect(
      configureLinuxGpuAcceleration({
        platform: 'linux',
        env: { WSL_DISTRO_NAME: 'Ubuntu-24.04', NTC_DISABLE_GPU: '0' },
        commandLine: { hasSwitch: () => false, appendSwitch: () => undefined },
        disableHardwareAcceleration: () => {
          hwAccelDisabled += 1;
        },
        hasDriDevice: () => false,
      }),
    ).toBe(false);
    expect(hwAccelDisabled).toBe(1);

    expect(STRICT_CSP_HEADER).toContain("default-src 'self'");
    expect(STRICT_CSP_HEADER).toContain("object-src 'none'");
    expect(STRICT_CSP_HEADER).toContain("frame-src 'none'");
    expect(STRICT_CSP_HEADER).toContain("form-action 'none'");

    expect(isAllowedNavigationUrl('file:///opt/app/ui/index.html', '/opt/app/ui/index.html')).toBe(true);
    expect(isAllowedNavigationUrl('file:///opt/app/ui-evil/index.html', '/opt/app/ui/index.html')).toBe(false);
    expect(isAllowedNavigationUrl('file:///opt/app/ui/other.html', '/opt/app/ui/index.html')).toBe(false);
    expect(isAllowedNavigationUrl('https://evil.example.com', '/opt/app/ui/index.html')).toBe(false);
    expect(
      isAllowedNavigationUrl('http://127.0.0.1:5173/dashboard', '/opt/app/ui/index.html', 'http://127.0.0.1:5173'),
    ).toBe(true);
    expect(
      isAllowedNavigationUrl('http://127.0.0.1:51730/dashboard', '/opt/app/ui/index.html', 'http://127.0.0.1:5173'),
    ).toBe(false);
    expect(
      isAllowedNavigationUrl('http://127.0.0.1:5173.evil.com/', '/opt/app/ui/index.html', 'http://127.0.0.1:5173'),
    ).toBe(false);

    expect(resolveDevServerUrl(true, 'http://127.0.0.1:5173')).toBeUndefined();
    expect(resolveDevServerUrl(false, 'http://127.0.0.1:5173/foo')).toBe('http://127.0.0.1:5173');
    expect(resolveDevServerUrl(false, 'https://evil.example.com')).toBeUndefined();
    expect(resolveNtcDataDir({ NTC_DATA_DIR: '/tmp/override' }, '/var/userData', true)).toBe('/var/userData');
    expect(resolveNtcDataDir({ NTC_DATA_DIR: '/tmp/override' }, '/var/userData', false)).toBe('/tmp/override');
  });
});
