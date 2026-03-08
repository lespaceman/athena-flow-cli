import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		include: ['**/*.test.{ts,tsx}', 'test.tsx'],
		environment: 'node',
	},
	define: {
		// Mirror tsup's build-time define so telemetry tests can exercise the client.
		// In CI the real key comes from POSTHOG_API_KEY env var; in local dev a
		// test-only placeholder keeps tests functional.
		__POSTHOG_API_KEY__: JSON.stringify(
			process.env['POSTHOG_API_KEY'] ?? 'phc_test_key',
		),
	},
	esbuild: {
		jsx: 'automatic',
	},
});
