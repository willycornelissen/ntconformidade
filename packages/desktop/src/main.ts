import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DfeRegistrySchema,
  IPC_CHANNELS,
  isLoopbackHostname,
  openDatabase,
  type NtcDatabase,
} from '@ntc/core';
import { createDesktopIpcController } from './ipc-handlers.js';
import { SafeStorageSecretStore } from './secret-store.js';

export const STRICT_CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'; form-action 'none'";

/** Resolves `NTC_DATA_DIR` override in unpacked runs or falls back to Electron `app.getPath('userData')`. */
export function resolveNtcDataDir(
  env: NodeJS.ProcessEnv = process.env,
  fallbackUserDataDir = path.resolve('data'),
  isPackaged = false,
): string {
  if (!isPackaged) {
    const configured = env.NTC_DATA_DIR?.trim();
    if (configured) {
      return path.resolve(configured);
    }
  }
  return fallbackUserDataDir;
}

/** Validates dev server URL strictly in unpackaged dev runs; always returns `undefined` when packaged. */
export function resolveDevServerUrl(isPackaged: boolean, rawUrl?: string): string | undefined {
  if (isPackaged || !rawUrl?.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(rawUrl.trim());
    if (
      parsed.protocol === 'http:' &&
      !parsed.username &&
      !parsed.password &&
      isLoopbackHostname(parsed.hostname)
    ) {
      return parsed.origin;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Returns locked-down Electron BrowserWindow `webPreferences` disabling Node in renderer. */
export function buildHardenedWebPreferences(preloadPath: string): {
  readonly preload: string;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly webviewTag: false;
  readonly navigateOnDragDrop: false;
} {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
  };
}

/** Validates whether a top-level renderer navigation URL matches the bundled UI HTML file or loopback dev origin. */
export function isAllowedNavigationUrl(
  targetUrl: string,
  appHtmlPath: string,
  devServerUrl?: string,
): boolean {
  let targetParsed: URL;
  try {
    targetParsed = new URL(targetUrl);
  } catch {
    return false;
  }
  if (targetParsed.username || targetParsed.password) {
    return false;
  }

  if (devServerUrl) {
    try {
      const devParsed = new URL(devServerUrl);
      if (targetParsed.protocol === devParsed.protocol && targetParsed.origin === devParsed.origin) {
        return true;
      }
    } catch {
      return false;
    }
  }

  if (targetParsed.protocol !== 'file:') {
    return false;
  }
  try {
    return path.resolve(fileURLToPath(targetParsed)) === path.resolve(appHtmlPath);
  } catch {
    return false;
  }
}

function resolveBundledResource(
  resourcesPath: string | undefined,
  prodRel: string,
  devRel: string,
  isPackaged: boolean,
): string {
  if (resourcesPath) {
    const prodPath = path.join(resourcesPath, prodRel);
    try {
      accessSync(prodPath, fsConstants.R_OK);
      return prodPath;
    } catch (error) {
      if (isPackaged) {
        throw new Error(`Recurso empacotado obrigatório ausente: '${prodRel}'`, { cause: error });
      }
    }
  }
  return path.resolve(import.meta.dirname, devRel);
}

function seedDefaultDfeRegistry(db: NtcDatabase, registryPath: string): void {
  const raw = readFileSync(registryPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`JSON inválido no catálogo padrão '${registryPath}'`, { cause: error });
  }
  db.seedDefaultRepos(DfeRegistrySchema.parse(parsed));
}

function applySessionSecurityPolicies(session: Electron.Session): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler?.(() => false);
  session.webRequest.onHeadersReceived((details, callback) => {
    const cleanedHeaders: Record<string, string | string[]> = {};
    for (const [headerName, headerValue] of Object.entries(details.responseHeaders ?? {})) {
      if (headerName.toLowerCase() !== 'content-security-policy' && headerValue !== undefined) {
        cleanedHeaders[headerName] = headerValue;
      }
    }
    cleanedHeaders['Content-Security-Policy'] = [STRICT_CSP_HEADER];
    callback({ responseHeaders: cleanedHeaders });
  });
}

function attachWindowSecurityGuards(
  window: Electron.BrowserWindow,
  uiHtmlPath: string,
  devServerUrl: string | undefined,
): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (navEvent, targetUrl) => {
    if (!isAllowedNavigationUrl(targetUrl, uiHtmlPath, devServerUrl)) {
      navEvent.preventDefault();
    }
  });
  window.webContents.on('will-redirect', (navEvent, targetUrl) => {
    if (!isAllowedNavigationUrl(targetUrl, uiHtmlPath, devServerUrl)) {
      navEvent.preventDefault();
    }
  });
  window.webContents.on('will-attach-webview', (attachEvent) => {
    attachEvent.preventDefault();
  });
}

/** Boots Electron BrowserWindow, SQLite WAL database, SafeStorage vault, CSP, and IPC channels. */
export async function bootstrapDesktopApp(): Promise<void> {
  const { app, BrowserWindow, ipcMain, safeStorage, session } = await import('electron');
  await app.whenReady();

  const isPackaged = app.isPackaged;
  const dataDir = resolveNtcDataDir(process.env, app.getPath('userData'), isPackaged);
  const db = openDatabase(path.join(dataDir, 'ntc.sqlite'));
  let controller: ReturnType<typeof createDesktopIpcController> | null = null;
  let dbClosed = false;
  const safeClose = (): void => {
    controller?.dispose();
    if (!dbClosed) {
      dbClosed = true;
      db.close();
    }
  };
  app.on('will-quit', safeClose);

  try {
    const resourcesPath =
      'resourcesPath' in process && typeof process.resourcesPath === 'string'
        ? process.resourcesPath
        : undefined;
    const registryPath = resolveBundledResource(
      isPackaged ? resourcesPath : undefined,
      'config/dfe-registry.default.json',
      '../../../config/dfe-registry.default.json',
      isPackaged,
    );
    seedDefaultDfeRegistry(db, registryPath);

    const oracleJarPath = resolveBundledResource(
      isPackaged ? resourcesPath : undefined,
      'oracle/xsd-oracle.jar',
      '../../../tools/xsd-oracle/target/xsd-oracle.jar',
      isPackaged,
    );
    const secretStore = new SafeStorageSecretStore({
      vaultFilePath: path.join(dataDir, 'secrets.enc.json'),
      backend: safeStorage,
    });
    applySessionSecurityPolicies(session.defaultSession);

    const uiHtmlPath = isPackaged
      ? path.join(resourcesPath ?? '', 'ui', 'index.html')
      : path.resolve(import.meta.dirname, '../../ui/dist/index.html');
    const devServerUrl = resolveDevServerUrl(isPackaged, process.env.VITE_DEV_SERVER_URL);
    const allowedOrigins = [
      pathToFileURL(uiHtmlPath).toString(),
      ...(devServerUrl ? [devServerUrl] : []),
    ];

    let mainWindow: InstanceType<typeof BrowserWindow> | null = null;
    controller = createDesktopIpcController({
      db,
      secretStore,
      dataDir,
      oracleJarPath,
      allowedSenderOrigins: allowedOrigins,
      emitProgress: (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.RUN_PROGRESS, event);
        }
      },
    });
    controller.register(ipcMain);

    const preloadPath = path.resolve(import.meta.dirname, 'preload/preload.cjs');
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 840,
      title: 'NT Conformidade — SEF/MG',
      webPreferences: buildHardenedWebPreferences(preloadPath),
    });
    attachWindowSecurityGuards(mainWindow, uiHtmlPath, devServerUrl);
    mainWindow.on('closed', () => {
      mainWindow = null;
      controller?.dispose();
    });

    if (devServerUrl) {
      await mainWindow.loadURL(devServerUrl);
    } else {
      await mainWindow.loadFile(uiHtmlPath);
    }
  } catch (error) {
    safeClose();
    throw error;
  }
}

if (typeof process !== 'undefined' && process.versions?.electron) {
  void bootstrapDesktopApp().catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[desktop] Falha fatal ao iniciar aplicação: ${msg}`);
    process.exitCode = 1;
  });
}
