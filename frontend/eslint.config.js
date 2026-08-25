import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Ignore the build output and the native Capacitor projects (they contain a
  // copy of the built web bundle and generated native sources, not lint targets).
  globalIgnores(['dist', 'android', 'ios']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // The TypeScript half of the tree — the entire app source. Same react-hooks /
  // react-refresh pairing as the JS block, with the typescript-eslint
  // recommended set (syntax-only; no type-aware rules, so lint stays as fast as
  // `tsc -b` is separate) replacing the core `js.configs.recommended` checks
  // that TypeScript already covers.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // Mirror the JS block: names that read as constants or components are
      // allowed to be declared without a use (re-exported types, enum-ish maps).
      // `argsIgnorePattern` matches what tsconfig's `noUnusedParameters` already
      // grants, so a `_`-prefixed placeholder argument means the same thing to
      // eslint as it does to tsc.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' },
      ],

      // The rules below fire on patterns that predate TypeScript linting here
      // and whose fixes are behavioural, not mechanical, so they are recorded as
      // warnings (visible, tracked) rather than silenced or mass-edited away:
      //
      //  - react-hooks/refs and set-state-in-effect flag the deliberate
      //    "mirror the latest value into a ref during render" and
      //    "derive one bit of state from a prop" idioms in App.tsx, Map.tsx and
      //    useSavedCarparks.ts. Each site carries a comment explaining why it is
      //    written that way; converting them needs a real refactor.
      //  - react-refresh/only-export-components is a fast-refresh granularity
      //    hint, not a correctness rule. The vendored shadcn components in
      //    src/components/ui export their `cva` variants alongside the
      //    component, which is the upstream convention.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-refresh/only-export-components': 'warn',
    },
  },
  // vite.config.ts and the other root-level tooling files run under Node, not
  // the browser.
  {
    files: ['*.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
])
