// ESLint flat config (ESLint 10). TypeScript sources get the recommended and type-aware
// typescript-eslint rules; tests also get the Jest rules; CommonJS files and the explorer's
// browser script the base rules.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jest from 'eslint-plugin-jest';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
	globalIgnores(['dist/', 'coverage/']), // generated output
	js.configs.recommended,
	{
		files: ['**/*.ts'],
		extends: [tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			globals: globals.node,
			parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
		},
		rules: {
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
		},
	},
	{
		files: ['src/**/__tests__/**/*.ts'],
		extends: [jest.configs['flat/recommended']],
	},
	{
		files: ['**/*.cjs'],
		languageOptions: { sourceType: 'commonjs', globals: globals.node },
	},
	{
		files: ['src/api/explorer/**/*.js'], // the block explorer page's script (a browser module)
		languageOptions: { globals: globals.browser },
	},
]);
