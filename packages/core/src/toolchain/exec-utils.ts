import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ExecFileAsyncFn } from '../oracle/xsd-ast-diff.js';

const execFileAsync = promisify(execFile);

/** Extracts Node errno code cleanly from an unknown thrown value without unsafe casts. */
export function getErrnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === 'string' ? candidate : undefined;
}

/** Extracts process exit code, stdout, stderr, and message safely from an unknown error. */
export function extractExecFailureDetails(error: unknown): {
  readonly code?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
} {
  if (typeof error !== 'object' || error === null) {
    return { stdout: '', stderr: '', message: String(error) };
  }
  const rec = error as {
    code?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  return {
    code: typeof rec.code === 'number' ? rec.code : undefined,
    stdout: typeof rec.stdout === 'string' ? rec.stdout : '',
    stderr: typeof rec.stderr === 'string' ? rec.stderr : '',
    message: typeof rec.message === 'string' ? rec.message : String(error),
  };
}

/** Resolves default path to the built Java `xsd-oracle.jar`. */
export function resolveDefaultOracleJarPath(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, '../../../../tools/xsd-oracle/target/xsd-oracle.jar');
}

function quoteCmdArg(arg: string): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error('Argumento contém caractere de controle proibido');
  }
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Default async `execFile` wrapper keeping `shell: false` on POSIX and regular binaries,
 * while safely quoting Windows `.cmd`/`.bat` entrypoints (`mvn.cmd`) for Node 22+.
 */
export const defaultExecFileAsync: ExecFileAsyncFn = async (file, args, options) => {
  const isWinCmd =
    process.platform === 'win32' &&
    (/\.(?:cmd|bat)$/i.test(file) || file.toLowerCase() === 'mvn');

  if (isWinCmd) {
    const cmdBin = process.env.COMSPEC || 'cmd.exe';
    const commandLine = [quoteCmdArg(file), ...args.map(quoteCmdArg)].join(' ');
    const res = await execFileAsync(cmdBin, ['/d', '/s', '/c', commandLine], {
      ...options,
      shell: false,
      windowsVerbatimArguments: true,
      encoding: 'utf8',
    });
    return { stdout: res.stdout, stderr: res.stderr };
  }

  const res = await execFileAsync(file, [...args], {
    ...options,
    shell: false,
    encoding: 'utf8',
  });
  return { stdout: res.stdout, stderr: res.stderr };
};

/** Checks asynchronously whether a path exists without blocking the event loop. */
export async function pathExistsAsync(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks path segments under `rootDir` forbidding symlinks and escaping realpaths,
 * then returns the canonicalized target file path inside `rootDir`.
 */
export async function resolveContainedNoSymlinkPath(
  rootDir: string,
  relativePath: string,
): Promise<string> {
  const rootReal = await realpath(rootDir);
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  let cursor = rootReal;

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error(`Segmento inválido em caminho relativo: '${relativePath}'`);
    }
    cursor = path.join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlink proibido no caminho '${relativePath}'`);
      }
      const real = await realpath(cursor);
      if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
        throw new Error(`Caminho '${relativePath}' escapa do diretório raiz`);
      }
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        break;
      }
      throw error;
    }
  }

  const resolved = path.resolve(rootReal, ...segments);
  if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error(`Caminho '${relativePath}' fora do diretório raiz`);
  }
  return resolved;
}

/** Opens and reads a regular UTF-8 file using `O_NOFOLLOW` within `maxBytes`. */
export async function readNoFollowUtf8(
  absPath: string,
  maxBytes = 16 * 1024 * 1024,
): Promise<string> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(absPath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Destino não é arquivo regular: '${absPath}'`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`Arquivo '${absPath}' excede limite de ${maxBytes} bytes`);
    }
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}
