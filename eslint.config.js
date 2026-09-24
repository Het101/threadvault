import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  // Type-aware, not just syntactic. The rules worth having here —
  // no-floating-promises above all — cannot work without type information,
  // and this codebase is almost entirely async calls against a remote API.
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // An unawaited ACS or pg call reports success and writes nothing, or
      // writes after the process has moved on. It is the bug class this
      // codebase is most exposed to.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  {
    // CLAUDE.md rule 3: src/log.ts is the only thing allowed to write to
    // stdout or stderr, because it is the only thing that strips message
    // bodies first. test/phi-guard.test.ts fails the build on a violation;
    // this catches it in the editor, before the commit.
    files: ['src/**/*.ts'],
    ignores: ['src/log.ts'],
    rules: { 'no-console': 'error' },
  },

  {
    // Config files sit outside tsconfig's include, so type-aware rules cannot
    // resolve them. Lint them syntactically rather than excluding them.
    files: ['*.config.js', '*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    // Tests mock SDK shapes and assert on loose structures. Demanding full
    // type discipline there buys nothing and makes fixtures unreadable.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // An async generator has to be async to be an AsyncIterable, whether or
      // not it awaits. Every ACS mock in here is one, so the rule reports the
      // shape the interface demands.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
