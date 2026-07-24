import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import googleappsscript from 'eslint-plugin-googleappsscript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const globalsPath = path.join(root, 'eslint.gas-globals.json');
const projectGlobals = fs.existsSync(globalsPath)
  ? JSON.parse(fs.readFileSync(globalsPath, 'utf8'))
  : {};

const rawGasGlobals =
  googleappsscript.environments?.googleappsscript?.globals ?? {};

/** Convert legacy `false`/`true` globals to ESLint flat-config strings. */
const gasEnvGlobals = Object.fromEntries(
  Object.entries(rawGasGlobals).map(([name, value]) => [
    name,
    value === true || value === 'writable' ? 'writable' : 'readonly',
  ])
);

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['node_modules/**', 'scripts/**', '.claude/**', 'docs/**', '.devcontainer/**'],
  },
  {
    files: ['**/*.gs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...gasEnvGlobals,
        ...projectGlobals,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...prettier.rules,
      // Syntax / correctness that often break GAS at runtime
      'no-undef': 'error',
      // Symbols are declared in one .gs and used in others (shared GAS global scope)
      'no-redeclare': 'off',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'valid-typeof': 'error',
      'use-isnan': 'error',
      'no-sparse-arrays': 'error',
      'no-unexpected-multiline': 'error',
      // Style / hygiene (warn so edits stay unblocked while still visible)
      'no-unused-vars': [
        'warn',
        {
          // Top-level functions/consts are shared across .gs files or are triggers
          vars: 'local',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-console': 'off',
      // Allow intentional full-width spaces in Slack / Japanese message templates
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }],
    },
  },
];
