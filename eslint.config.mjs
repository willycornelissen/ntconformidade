import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NODE_BUILTINS = [
  'node:*',
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'readline',
  'stream',
  'tls',
  'url',
  'util',
  'vm',
  'worker_threads',
  'zlib',
];

const CORE_BLOCKED_PATTERNS = [
  {
    group: [
      '**/packages/ui',
      '**/packages/ui/**',
      '../../ui',
      '../../ui/**',
      '**/packages/desktop',
      '**/packages/desktop/**',
      '../../desktop',
      '../../desktop/**',
      '@ntc/ui',
      '@ntc/ui/**',
      '@ntc/desktop',
      '@ntc/desktop/**',
      'electron',
    ],
    message: 'packages/core não pode depender de packages/ui, packages/desktop ou Electron.',
  },
];

const UI_RUNTIME_BLOCKED_PATTERNS = [
  {
    group: [
      ...NODE_BUILTINS,
      'better-sqlite3',
      'electron',
      '**/packages/desktop',
      '**/packages/desktop/**',
      '../../desktop',
      '../../desktop/**',
      '@ntc/desktop',
      '@ntc/desktop/**',
    ],
    message: 'packages/ui não pode importar APIs Node, Electron ou desktop.',
  },
];

const UI_CORE_JS_PATTERNS = [
  {
    group: [
      '**/packages/core',
      '**/packages/core/**',
      '../../core',
      '../../core/**',
      '../../../core',
      '../../../core/**',
      '@ntc/core',
      '@ntc/core/**',
    ],
    message: 'packages/ui (.js) não pode importar packages/core em runtime.',
  },
];

const UI_CORE_TS_PATTERNS = [
  {
    group: [
      '**/packages/core',
      '**/packages/core/**',
      '../../core',
      '../../core/**',
      '../../../core',
      '../../../core/**',
      '@ntc/core',
      '@ntc/core/**',
    ],
    allowTypeImports: true,
    message: 'packages/ui pode importar apenas tipos (import type) de packages/core.',
  },
];

const UI_SYNTAX_AND_GLOBAL_RULES = {
  'no-restricted-globals': ['error', 'process', 'Buffer', '__dirname', '__filename'],
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ImportExpression',
      message: 'Importação dinâmica é bloqueada na camada UI.',
    },
    {
      selector: 'CallExpression[callee.name="require"]',
      message: 'Chamada require() é bloqueada na camada UI.',
    },
    {
      selector: 'CallExpression[callee.name="createRequire"]',
      message: 'Chamada createRequire() é bloqueada na camada UI.',
    },
    {
      selector: 'CallExpression[callee.property.name="createRequire"]',
      message: 'Chamada createRequire() é bloqueada na camada UI.',
    },
    {
      selector: 'CallExpression[callee.property.name="getBuiltinModule"]',
      message: 'Chamada getBuiltinModule() é bloqueada na camada UI.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/target/**',
      '**/coverage/**',
      '.agents/**',
      'nfe-parser/**',
      'tools/**',
      'docs/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{mjs,cjs}', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    ...jsxA11y.flatConfigs.recommended,
    files: ['packages/ui/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      ...(jsxA11y.flatConfigs.recommended.languageOptions ?? {}),
      globals: globals.browser,
    },
    plugins: {
      ...(jsxA11y.flatConfigs.recommended.plugins ?? {}),
      'react-hooks': reactHooks,
    },
    rules: {
      ...(jsxA11y.flatConfigs.recommended.rules ?? {}),
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  ...tseslint.configs.recommended.map((cfg) => ({
    ...cfg,
    files: ['**/*.{ts,tsx,mts,cts}'],
  })),
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['packages/core/**/*.{js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: CORE_BLOCKED_PATTERNS }],
    },
  },
  {
    files: ['packages/core/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: CORE_BLOCKED_PATTERNS }],
    },
  },
  {
    files: ['packages/ui/**/*.{js,jsx,mjs,cjs}'],
    rules: {
      ...UI_SYNTAX_AND_GLOBAL_RULES,
      'no-restricted-imports': [
        'error',
        { patterns: [...UI_RUNTIME_BLOCKED_PATTERNS, ...UI_CORE_JS_PATTERNS] },
      ],
    },
  },
  {
    files: ['packages/ui/**/*.{ts,tsx,mts,cts}'],
    rules: {
      ...UI_SYNTAX_AND_GLOBAL_RULES,
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [...UI_RUNTIME_BLOCKED_PATTERNS, ...UI_CORE_TS_PATTERNS] },
      ],
    },
  },
);
