import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ESLint } from 'eslint';

const ROOT = path.resolve(import.meta.dirname, '..');
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: path.join(ROOT, 'eslint.config.mjs'),
});

async function lintVirtual(virtualRelPath, content) {
  const results = await eslint.lintText(content, {
    filePath: path.join(ROOT, virtualRelPath),
  });
  return results[0]?.messages ?? [];
}

describe('Fase 1 — Configuração do Monorepo e Registro DFe', () => {
  it('package.json define workspaces e scripts obrigatórios', async () => {
    const raw = await fs.readFile(path.join(ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);

    assert.equal(pkg.private, true);
    assert.equal(pkg.type, 'module');
    assert.deepEqual(pkg.workspaces, ['packages/*']);

    for (const script of [
      'build',
      'test',
      'lint',
      'typecheck',
      'dev:desktop',
      'package:win',
      'rebuild:electron',
    ]) {
      assert.equal(typeof pkg.scripts?.[script], 'string', `Script ausente: ${script}`);
    }
  });

  it('tsconfig.base.json aplica estrito NodeNext ES2022', async () => {
    const raw = await fs.readFile(path.join(ROOT, 'tsconfig.base.json'), 'utf8');
    const ts = JSON.parse(raw);
    const opts = ts.compilerOptions;

    assert.equal(opts.strict, true);
    assert.equal(opts.noImplicitAny, true);
    assert.equal(opts.target, 'ES2022');
    assert.equal(opts.module, 'NodeNext');
    assert.equal(opts.moduleResolution, 'NodeNext');
  });

  it('eslint.config.mjs aplica regras estritas e fronteiras entre camadas', async () => {
    const anyMsgs = await lintVirtual('sample.ts', 'export const value: any = 1;\n');
    assert.ok(anyMsgs.some((m) => m.ruleId === '@typescript-eslint/no-explicit-any'));

    const coreUiMsgs = await lintVirtual(
      'packages/core/src/bad.ts',
      "import { App } from '@ntc/ui';\nexport const y = App;\n",
    );
    assert.ok(coreUiMsgs.some((m) => m.ruleId === '@typescript-eslint/no-restricted-imports'));

    const coreElectronMsgs = await lintVirtual(
      'packages/core/src/bad2.ts',
      "import { app } from 'electron';\nexport const z = app;\n",
    );
    assert.ok(coreElectronMsgs.some((m) => m.ruleId === '@typescript-eslint/no-restricted-imports'));

    for (const mod of ['node:http', 'fs/promises', 'better-sqlite3', '@ntc/desktop']) {
      const uiMsgs = await lintVirtual(
        'packages/ui/src/bad.ts',
        `import x from '${mod}';\nexport const f = x;\n`,
      );
      assert.ok(
        uiMsgs.some((m) => m.ruleId === '@typescript-eslint/no-restricted-imports'),
        `Esperado bloqueio de ${mod} em packages/ui`,
      );
    }

    const uiCoreRuntime = await lintVirtual(
      'packages/ui/src/badCore.ts',
      "import { runDoctor } from '@ntc/core';\nexport const r = runDoctor;\n",
    );
    assert.ok(uiCoreRuntime.some((m) => m.ruleId === '@typescript-eslint/no-restricted-imports'));

    const uiCoreTypeOnly = await lintVirtual(
      'packages/ui/src/goodType.ts',
      "import type { NcDocument } from '@ntc/core';\nexport type Doc = NcDocument;\n",
    );
    assert.equal(uiCoreTypeOnly.length, 0);

    const uiLocalCoreFolder = await lintVirtual(
      'packages/ui/src/local.ts',
      "import { helper } from './core/helper.js';\nexport const h = helper;\n",
    );
    assert.equal(uiLocalCoreFolder.length, 0);

    const uiBareDirImport = await lintVirtual(
      'packages/ui/src/bareCore.js',
      "import { runDoctor } from '../../core';\nexport const r = runDoctor;\n",
    );
    assert.ok(
      uiBareDirImport.some(
        (m) =>
          m.ruleId === 'no-restricted-imports' ||
          m.ruleId === '@typescript-eslint/no-restricted-imports',
      ),
    );

    const uiDynamicImport = await lintVirtual(
      'packages/ui/src/dyn.ts',
      "export async function load(): Promise<unknown> { return import('node:fs'); }\n",
    );
    assert.ok(uiDynamicImport.some((m) => m.ruleId === 'no-restricted-syntax'));

    const uiCreateRequire = await lintVirtual(
      'packages/ui/src/req.mts',
      "const req = createRequire(import.meta.url);\nexport const x = req;\n",
    );
    assert.ok(uiCreateRequire.some((m) => m.ruleId === 'no-restricted-syntax'));

    const uiProcessGlobal = await lintVirtual(
      'packages/ui/src/proc.ts',
      'export const env = process.env;\n',
    );
    assert.ok(uiProcessGlobal.some((m) => m.ruleId === 'no-restricted-globals'));
  });

  it('config/dfe-registry.default.json mapeia exatamente os 8 DFes e inclui nfce-parser separado', async () => {
    const raw = await fs.readFile(path.join(ROOT, 'config', 'dfe-registry.default.json'), 'utf8');
    const registry = JSON.parse(raw);

    assert.ok(Array.isArray(registry), 'dfe-registry.default.json deve ser um array');
    const expectedDfes = ['NFe', 'BPe', 'MDFe', 'CTe', 'NF3e', 'NFCom', 'GTVe', 'NFCe'];
    assert.deepEqual(
      registry.map((entry) => entry.dfe),
      expectedDfes,
    );

    const slugs = new Set(registry.map((e) => e.repoSlug));
    assert.equal(slugs.size, 8, 'Cada DFe deve possuir repoSlug próprio');
    assert.ok(slugs.has('nfe-parser'));
    assert.ok(slugs.has('nfce-parser'));

    for (const entry of registry) {
      assert.ok(
        entry.giteaUrl.startsWith('https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/'),
        `URL Gitea inválida para ${entry.dfe}`,
      );
      for (const field of [
        'baseBranch',
        'basePackage',
        'domainPackage',
        'mapperPackage',
        'tablePackage',
        'parserPackage',
        'tagPrefix',
        'svrsRelativePath',
      ]) {
        assert.equal(typeof entry[field], 'string', `${entry.dfe}.${field} ausente`);
        assert.ok(entry[field].length > 0, `${entry.dfe}.${field} vazio`);
      }
      assert.equal(entry.tagPrefix, entry.tagPrefix.toUpperCase());
    }

    const nfe = registry.find((e) => e.dfe === 'NFe');
    assert.equal(nfe.basePackage, 'br.gov.mg.fazenda.nfeparser');
    assert.equal(nfe.utilPackage, 'br.gov.mg.fazenda.nfeparser.util');
    assert.equal(nfe.tagPrefix, 'NFEPROC');
    assert.equal(nfe.baselineNt, null);
  });
});
