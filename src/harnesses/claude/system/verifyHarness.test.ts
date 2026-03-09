import {describe, it, expect} from 'vitest';
import {
	verifyClaudeHarness,
	type VerifyClaudeHarnessOptions,
} from './verifyHarness';

function runVerify(options: Partial<VerifyClaudeHarnessOptions> = {}) {
	return verifyClaudeHarness({
		pathValue: '/usr/local/bin:/opt/homebrew/bin',
		fileExists: () => true,
		resolveClaudeBinaryFn: () => '/usr/local/bin/claude',
		detectClaudeVersionFn: () => '2.5.0',
		runClaudeSmokePromptFn: () => ({
			ok: true,
			message: 'Claude replied: ATHENA_SETUP_OK',
		}),
		resolveHookForwarderCommandFn: () => ({
			command: 'athena-hook-forwarder',
			executable: 'athena-hook-forwarder',
			args: [],
			source: 'path',
		}),
		...options,
	});
}

describe('verifyClaudeHarness', () => {
	it('returns passing checks when claude and hook forwarder are available', () => {
		const result = runVerify();

		expect(result.ok).toBe(true);
		expect(result.summary).toBe('Claude Code v2.5.0 detected');
		expect(result.checks).toEqual([
			{
				label: 'Claude binary',
				status: 'pass',
				message: '/usr/local/bin/claude',
			},
			{
				label: 'Claude version',
				status: 'pass',
				message: 'v2.5.0',
			},
			{
				label: 'Smoke prompt',
				status: 'pass',
				message: 'Claude replied: ATHENA_SETUP_OK',
			},
			{
				label: 'Hook forwarder',
				status: 'pass',
				message: '/usr/local/bin/athena-hook-forwarder',
			},
			{
				label: 'jq',
				status: 'pass',
				message: '/usr/local/bin/jq',
			},
		]);
	});

	it('fails when claude cannot be resolved', () => {
		const result = runVerify({
			resolveClaudeBinaryFn: () => null,
			detectClaudeVersionFn: () => null,
		});

		expect(result.ok).toBe(false);
		expect(result.summary).toBe('Claude Code setup needs attention');
		expect(result.checks[0]).toEqual({
			label: 'Claude binary',
			status: 'fail',
			message:
				'Not found in PATH. Install Claude Code, then run `claude doctor`.',
		});
		expect(result.checks[1]?.status).toBe('fail');
		expect(result.checks[2]).toEqual({
			label: 'Smoke prompt',
			status: 'fail',
			message:
				'Skipped until Claude is installed and responds to `claude --version`.',
		});
	});

	it('warns instead of failing when jq is missing', () => {
		const result = runVerify({
			fileExists: candidatePath => !candidatePath.endsWith('/jq'),
		});

		expect(result.ok).toBe(true);
		expect(result.checks.at(-1)).toEqual({
			label: 'jq',
			status: 'warn',
			message:
				'Not found. Athena only needs jq for `--verbose` streaming output.',
		});
	});
});
