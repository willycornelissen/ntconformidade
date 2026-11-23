import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_CTS_PATH = path.join(THIS_DIR, 'src', 'preload.cts');

const ctsSupportPlugin: Plugin = {
  name: 'ntc-vitest-cts',
  enforce: 'pre',
  resolveId(source) {
    if (source.endsWith('preload.cjs')) {
      return PRELOAD_CTS_PATH;
    }
    return null;
  },
  load(id) {
    if (id.endsWith('.cts')) {
      const code = readFileSync(id, 'utf8');
      return transformWithEsbuild(code, id.replace(/\.cts$/, '.ts'), { loader: 'ts' });
    }
    return null;
  },
};

export default defineConfig({
  plugins: [ctsSupportPlugin],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
