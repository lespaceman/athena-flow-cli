import {defineConfig} from 'tsup';

export default defineConfig({
	entry: {
		cli: 'src/app/entry/cli.tsx',
		'hook-forwarder': 'src/harnesses/claude/hook-forwarder.ts',
	},
	format: ['esm'],
	target: 'node18',
	outDir: 'dist',
	clean: true,
	splitting: true,
	sourcemap: true,
	define: {
		// Injected at build time from POSTHOG_API_KEY env var.
		// Set this in CI via GitHub Actions secrets. When unset (local dev),
		// telemetry silently no-ops.
		__POSTHOG_API_KEY__: JSON.stringify(process.env['POSTHOG_API_KEY'] ?? ''),
	},
	external: [
		'better-sqlite3',
		'ink',
		'react',
		'@inkjs/ui',
		'react-devtools-core',
	],
});
