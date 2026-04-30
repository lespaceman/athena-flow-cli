import {readFileSync} from 'node:fs';
import {defineConfig} from 'tsup';

// Load .env file if present (for local builds). CI provides env vars directly.
try {
	const envFile = readFileSync('.env', 'utf-8');
	for (const line of envFile.split('\n')) {
		const match = line.match(/^([A-Z_]+)=(.+)$/);
		if (match && !process.env[match[1]]) {
			process.env[match[1]] = match[2].trim();
		}
	}
} catch {
	// No .env file — that's fine, CI sets env vars directly
}

export default defineConfig({
	entry: {
		cli: 'src/app/entry/cli.tsx',
		'hook-forwarder': 'src/harnesses/claude/hook-forwarder.ts',
		'channel-daemon': 'src/channels/daemon.ts',
		'channel-telegram': 'src/channels/telegram/index.ts',
	},
	format: ['esm'],
	target: 'node18',
	outDir: 'dist',
	clean: true,
	splitting: true,
	sourcemap: true,
	loader: {
		'.md': 'text',
	},
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
