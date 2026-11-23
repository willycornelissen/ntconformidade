import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ESLint } from 'eslint';
import { CORE_VERSION } from '../src/index.js';
import vitestConfig from '../vitest.config.js';

const CORE_DIR = path.resolve(import.meta.dirname, '..');
const ROOT_DIR = path.resolve(CORE_DIR, '..', '..');

describe('Ciclo 0 — Scaffolding @ntc/core', () => {
  it('SC-01 resolve barrel ESM @ntc/core sob NodeNext', () => {
    expect(typeof process.versions.node).toBe('string');
    expect(CORE_VERSION).toBe('0.1.0');
  });

  it('SC-02 bloqueia electron/@ntc/ui e tipo any dentro de packages/core via ESLint', async () => {
    const eslint = new ESLint({
      cwd: ROOT_DIR,
      overrideConfigFile: path.join(ROOT_DIR, 'eslint.config.mjs'),
    });

    const restrictedMsgs = await eslint.lintText(
      "import { app } from 'electron';\nexport const x = app;\n",
      { filePath: path.join(CORE_DIR, 'src', 'bad-boundary.ts') },
    );
    expect(restrictedMsgs[0]?.messages.some((m) => m.ruleId === '@typescript-eslint/no-restricted-imports')).toBe(true);

    const anyMsgs = await eslint.lintText('export const bad: any = 1;\n', {
      filePath: path.join(CORE_DIR, 'src', 'bad-any.ts'),
    });
    expect(anyMsgs[0]?.messages.some((m) => m.ruleId === '@typescript-eslint/no-explicit-any')).toBe(true);
  }, 60_000);

  it('SC-03 configura Vitest coverage V8 >= 80% linhas e ramificações', () => {
    const cov = vitestConfig.test?.coverage;
    expect(cov?.provider).toBe('v8');
    if (cov && 'thresholds' in cov && cov.thresholds) {
      expect(cov.thresholds.lines).toBeGreaterThanOrEqual(80);
      expect(cov.thresholds.branches).toBeGreaterThanOrEqual(80);
    } else {
      throw new Error('Thresholds de cobertura ausentes em vitest.config.ts');
    }
  });

  it('SC-04 define scripts @ntc/core compatíveis com workspace-runner', async () => {
    const pkgRaw = await fs.readFile(path.join(CORE_DIR, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as {
      name: string;
      type: string;
      scripts: Record<string, string>;
    };
    expect(pkg.name).toBe('@ntc/core');
    expect(pkg.type).toBe('module');
    expect(pkg.scripts.build).toContain('tsconfig.build.json');
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.scripts.typecheck).toContain('tsconfig.json');
  });
});
