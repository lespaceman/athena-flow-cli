import {describe, it, expect} from 'vitest';
import {resolveClaudeBinary} from './resolveBinary';

describe('resolveClaudeBinary', () => {
	it('prefers explicit ATHENA_CLAUDE_PATH override when executable', () => {
		expect(
			resolveClaudeBinary({
				env: {
					ATHENA_CLAUDE_PATH: '/custom/claude',
					PATH: '/usr/bin:/bin',
				},
				isExecutable: candidatePath => candidatePath === '/custom/claude',
			}),
		).toBe('/custom/claude');
	});

	it('returns null for invalid explicit override instead of falling through', () => {
		expect(
			resolveClaudeBinary({
				env: {
					ATHENA_CLAUDE_PATH: '/missing/claude',
					PATH: '/opt/homebrew/bin:/usr/local/bin',
				},
				isExecutable: () => false,
			}),
		).toBeNull();
	});

	it('finds claude on PATH', () => {
		expect(
			resolveClaudeBinary({
				env: {PATH: '/usr/bin:/opt/homebrew/bin'},
				isExecutable: candidatePath =>
					candidatePath === '/opt/homebrew/bin/claude',
			}),
		).toBe('/opt/homebrew/bin/claude');
	});

	it('checks common macOS fallback locations when PATH misses claude', () => {
		expect(
			resolveClaudeBinary({
				env: {PATH: '/usr/bin:/bin'},
				platform: 'darwin',
				homeDir: '/Users/tester',
				isExecutable: candidatePath =>
					candidatePath === '/Users/tester/.local/bin/claude',
			}),
		).toBe('/Users/tester/.local/bin/claude');
	});

	it('returns null when no candidate is executable', () => {
		expect(
			resolveClaudeBinary({
				env: {PATH: '/usr/bin:/bin'},
				platform: 'darwin',
				homeDir: '/Users/tester',
				isExecutable: () => false,
			}),
		).toBeNull();
	});
});
