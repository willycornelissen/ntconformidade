import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts', 'src/ports/interfaces.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        'src/domain/types.ts': {
          lines: 80,
          branches: 80,
        },
        'src/privacy/dlp-filter.ts': {
          lines: 80,
          branches: 80,
        },
        'src/oracle/xsd-ast-diff.ts': {
          lines: 80,
          branches: 80,
        },
        'src/patch/patch-guardrails.ts': {
          lines: 80,
          branches: 80,
        },
        'src/toolchain/host-maven-runner.ts': {
          lines: 80,
          branches: 80,
        },
      },
    },
  },
});
