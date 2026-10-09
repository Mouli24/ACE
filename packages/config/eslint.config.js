/**
 * Shared ESLint (flat) presets for ACE.
 *
 * The `no-restricted-imports` / `no-restricted-globals` blocks below encode the dependency rules
 * of CLAUDE.md §3.4 rule 3 and the "Do not use" list of CLAUDE.md §2 as lint errors, so that a
 * layering mistake fails CI instead of being caught in review:
 *
 *   engine        -> contracts + its own ports only
 *   adapters      -> contracts (+ the engine port interfaces they implement)
 *   sdk / ui      -> contracts only
 *   web           -> sdk, ui, contracts; never Node APIs
 *   desktop       -> contracts only; never the engine side or a native module (D292)
 *   apps          -> packages; packages never import apps
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/** Every workspace package that can appear in an import specifier. */
const ACE_PACKAGES = [
  '@ace/config',
  '@ace/contracts',
  '@ace/engine',
  '@ace/storage-local',
  '@ace/providers',
  '@ace/guardrails',
  '@ace/context',
  '@ace/tools',
  '@ace/sdk',
  '@ace/ui',
  '@ace/server',
  '@ace/web',
];

/** Node built-ins, bare and `node:` prefixed — banned in web-facing packages (CLAUDE.md §2). */
const NODE_BUILTINS = [
  'fs',
  'fs/promises',
  'path',
  'os',
  'crypto',
  'child_process',
  'worker_threads',
  'http',
  'https',
  'net',
  'stream',
  'util',
  'process',
];

/** Browser globals — banned in engine-side packages (CLAUDE.md §2). */
const BROWSER_GLOBALS = ['window', 'document', 'localStorage', 'sessionStorage', 'navigator'];

/** Build a `no-restricted-imports` rule that allows only `allowed` out of the ACE packages. */
function onlyAceImports(allowed, message) {
  return [
    'error',
    {
      paths: ACE_PACKAGES.filter((p) => !allowed.includes(p)).map((name) => ({ name, message })),
    },
  ];
}

/** Ban every Node built-in, bare and `node:`-prefixed. */
const noNodeApis = [
  'error',
  {
    paths: NODE_BUILTINS.map((name) => ({
      name,
      message: 'Node APIs are not allowed in web-facing packages (CLAUDE.md §2).',
    })),
    patterns: [
      {
        group: ['node:*'],
        message: 'Node APIs are not allowed in web-facing packages (CLAUDE.md §2).',
      },
    ],
  },
];

/** Shared rules for every package: type-aware recommended set, Prettier last. */
export const base = tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/*.d.ts', '**/.turbo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/^sk-[A-Za-z0-9_-]{16,}$/]",
          message: 'Real API keys must never appear in the repository (CLAUDE.md §2).',
        },
      ],
    },
  },
);

/** Rules every engine-side package shares: no `any`, no `@ts-ignore`, no `console.*`, no DOM. */
const engineSideRules = {
  languageOptions: { globals: globals.node },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/ban-ts-comment': 'error',
    'no-console': 'error',
    'no-restricted-globals': [
      'error',
      ...BROWSER_GLOBALS.map((name) => ({
        name,
        message: 'Browser APIs are not allowed in engine-side packages (CLAUDE.md §2).',
      })),
    ],
  },
};

/** `packages/engine` — imports only `@ace/contracts` and its own ports (CLAUDE.md §3.4 rule 3). */
export const engineCore = tseslint.config(...base, {
  ...engineSideRules,
  rules: {
    ...engineSideRules.rules,
    'no-restricted-imports': onlyAceImports(
      ['@ace/contracts'],
      'packages/engine imports only @ace/contracts and its own port interfaces (CLAUDE.md §3.4 rule 3).',
    ),
  },
});

/** Port adapters (`storage-local`, `providers`, `guardrails`, `context`, `tools`). */
export const engineAdapter = tseslint.config(...base, {
  ...engineSideRules,
  rules: {
    ...engineSideRules.rules,
    'no-restricted-imports': onlyAceImports(
      ['@ace/contracts', '@ace/engine'],
      'Adapters import @ace/contracts and the @ace/engine port interfaces they implement (CLAUDE.md §3.4 rule 3).',
    ),
  },
});

/** `packages/contracts` — the seam; imports no other workspace package. */
export const contracts = tseslint.config(...base, {
  ...engineSideRules,
  rules: {
    ...engineSideRules.rules,
    'no-restricted-imports': onlyAceImports(
      [],
      '@ace/contracts is the seam and must not depend on any other workspace package (CLAUDE.md §3.4 rule 2).',
    ),
  },
});

/** `apps/server` — an app may import packages; packages never import apps. */
export const serverApp = tseslint.config(...base, {
  ...engineSideRules,
  rules: {
    ...engineSideRules.rules,
    'no-restricted-imports': onlyAceImports(
      [
        '@ace/contracts',
        '@ace/engine',
        '@ace/storage-local',
        '@ace/providers',
        '@ace/guardrails',
        '@ace/context',
        '@ace/tools',
      ],
      'apps/server wires engine-side packages only (CLAUDE.md §3.4 rule 3).',
    ),
  },
});

/** The engine side: the packages that make up the engine process (D292 keeps them out of Electron). */
const ENGINE_SIDE_PACKAGES = [
  '@ace/engine',
  '@ace/storage-local',
  '@ace/providers',
  '@ace/guardrails',
  '@ace/context',
  '@ace/tools',
  '@ace/server',
];

/** The engine's native modules — Node-ABI-bound or N-API; none may load in an Electron process. */
const NATIVE_MODULES = ['better-sqlite3', 'sqlite-vec', '@napi-rs/keyring'];

/**
 * `apps/desktop` — the Electron shell (D292).
 *
 * It is a Node process, so Node built-ins are allowed. What it must never do is run the engine in
 * its own process: Electron's ABI breaks `better-sqlite3`, `process.execPath` would stop being Node
 * for the sandbox and the CLI shims, and SQLite's synchronous calls would freeze the window. So every
 * engine-side package — bare or by subpath — and the three native modules are banned, and the only
 * workspace import left is `@ace/contracts` (the bridge and IPC message shapes).
 *
 * `console.info/warn/error` are allowed and `console.log` is not: the shell has no pino (the engine's
 * log is the log), and its few lines — "waiting for the engine", a failed spawn — go to the console
 * that launched it.
 */
export const desktopApp = tseslint.config(
  ...base,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      'no-console': ['error', { allow: ['info', 'warn', 'error'] }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...ACE_PACKAGES.filter((p) => p !== '@ace/contracts').map((name) => ({
              name,
              message:
                'apps/desktop imports @ace/contracts only; the engine runs in its own Node process (D292).',
            })),
            ...NATIVE_MODULES.map((name) => ({
              name,
              message: 'No native module may load inside Electron (D292).',
            })),
          ],
          patterns: [
            {
              group: [...ENGINE_SIDE_PACKAGES, ...NATIVE_MODULES].map((name) => `${name}/*`),
              message:
                'apps/desktop imports @ace/contracts only; the engine runs in its own Node process (D292).',
            },
          ],
        },
      ],
    },
  },
  {
    // The sandboxed preload (`*.cts`) is CommonJS that runs beside the page: DOM globals exist there,
    // and under `verbatimModuleSyntax` `import x = require('electron')` is its only import form.
    files: ['**/*.cts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': ['error', { allowAsImport: true }] },
  },
);

/** `packages/sdk` and `packages/ui` — import only `@ace/contracts`, never Node APIs. */
export const clientLib = tseslint.config(...base, {
  languageOptions: { globals: globals.browser },
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          ...ACE_PACKAGES.filter((p) => p !== '@ace/contracts').map((name) => ({
            name,
            message: '@ace/sdk and @ace/ui import only @ace/contracts (CLAUDE.md §3.4 rule 3).',
          })),
          ...noNodeApis[1].paths,
        ],
        patterns: noNodeApis[1].patterns,
      },
    ],
  },
});

/** `apps/web` — imports `@ace/sdk`, `@ace/ui`, `@ace/contracts`; never Node APIs. */
export const webApp = tseslint.config(...base, {
  languageOptions: { globals: globals.browser },
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          ...ACE_PACKAGES.filter(
            (p) => !['@ace/contracts', '@ace/sdk', '@ace/ui'].includes(p),
          ).map((name) => ({
            name,
            message: 'apps/web imports @ace/sdk, @ace/ui and @ace/contracts only (CLAUDE.md §3.4 rule 3).',
          })),
          ...noNodeApis[1].paths,
        ],
        patterns: noNodeApis[1].patterns,
      },
    ],
  },
});

export default base;
