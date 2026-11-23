import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const command = process.argv[2];

function getWorkspaceDirs() {
  const pkgsDir = path.join(ROOT, 'packages');
  if (!fs.existsSync(pkgsDir)) {
    return [];
  }
  return fs.readdirSync(pkgsDir)
    .map((name) => path.join(pkgsDir, name))
    .filter((dir) => fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'package.json')));
}

function runTypecheck() {
  const dirs = getWorkspaceDirs().filter((dir) => fs.existsSync(path.join(dir, 'tsconfig.json')));
  if (dirs.length === 0) {
    const basePath = path.join(ROOT, 'tsconfig.base.json');
    const cfg = ts.readConfigFile(basePath, ts.sys.readFile);
    if (cfg.error) {
      throw new Error(ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n'));
    }
    const parsed = ts.convertCompilerOptionsFromJson(cfg.config.compilerOptions, ROOT);
    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n'));
    }
    return;
  }

  const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  for (const dir of dirs) {
    execFileSync(process.execPath, [tscBin, '--noEmit', '-p', path.join(dir, 'tsconfig.json')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    const preloadTsconfig = path.join(dir, 'tsconfig.preload.json');
    if (fs.existsSync(preloadTsconfig)) {
      execFileSync(process.execPath, [tscBin, '--noEmit', '-p', preloadTsconfig], {
        cwd: ROOT,
        stdio: 'inherit',
      });
    }
  }
}

function runWorkspacesNpmScript(scriptName) {
  const dirs = getWorkspaceDirs();
  if (dirs.length === 0) {
    return;
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCmd, ['run', scriptName, '--workspaces', '--if-present'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

if (command === 'typecheck') {
  runTypecheck();
} else if (command === 'build' || command === 'test') {
  runWorkspacesNpmScript(command);
} else {
  console.error(`Uso: node scripts/workspace-runner.mjs <typecheck|build|test>`);
  process.exit(2);
}
