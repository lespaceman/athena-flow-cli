import {beforeEach, describe, it, expect, vi} from 'vitest';
import {detectClaudeVersion} from './detectVersion';

vi.mock('node:child_process', () => ({
	execFileSync: vi.fn(),
}));

vi.mock('./resolveBinary', () => ({
	resolveClaudeBinary: vi.fn(() => '/resolved/claude'),
}));

import {execFileSync} from 'node:child_process';
import {resolveClaudeBinary} from './resolveBinary';
const mockExecFileSync = vi.mocked(execFileSync);
const mockResolveClaudeBinary = vi.mocked(resolveClaudeBinary);

describe('detectClaudeVersion', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockResolveClaudeBinary.mockReturnValue('/resolved/claude');
	});

	it('parses version from claude --version output, returns null on failure', () => {
		// Successful parse — standard format "2.1.38 (Claude Code)"
		mockExecFileSync.mockReturnValue('2.1.38 (Claude Code)\n');
		expect(detectClaudeVersion()).toBe('2.1.38');

		// ENOENT — claude binary not found
		mockExecFileSync.mockImplementation(() => {
			const err = new Error('spawnSync claude ENOENT') as NodeJS.ErrnoException;
			err.code = 'ENOENT';
			throw err;
		});
		expect(detectClaudeVersion()).toBeNull();

		// Unexpected output — no version number
		mockExecFileSync.mockReturnValue('something unexpected');
		expect(detectClaudeVersion()).toBeNull();

		// Version-only output (no suffix)
		mockExecFileSync.mockReturnValue('3.0.1\n');
		expect(detectClaudeVersion()).toBe('3.0.1');
	});

	it('returns null when claude binary cannot be resolved', () => {
		mockResolveClaudeBinary.mockReturnValue(null);
		expect(detectClaudeVersion()).toBeNull();
		expect(mockExecFileSync).not.toHaveBeenCalled();
	});
});
