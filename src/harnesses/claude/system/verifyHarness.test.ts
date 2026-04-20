import {describe, it, expect, vi} from 'vitest';
import {
	runClaudeSmokePrompt,
	verifyClaudeHarness,
	type VerifyClaudeHarnessOptions,
} from './verifyHarness';

function runVerify(options: Partial<VerifyClaudeHarnessOptions> = {}) {
	return verifyClaudeHarness({
		pathValue: '/usr/local/bin:/opt/homebrew/bin',
		fileExists: () => true,
		resolveClaudeBinaryFn: () => '/usr/local/bin/claude',
		detectClaudeVersionFn: () => '2.5.0',
		runClaudeAuthStatusFn: () => ({
			ok: true,
			message: 'Authenticated account (max) via claude.ai',
		}),
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
	it('runs the smoke prompt through Athena strict settings with runtime auth overlay', () => {
		const cleanup = vi.fn();
		const resolveRuntimeAuthOverlayFn = vi.fn(() => ({
			apiKeyHelper: 'printf %s token',
		}));
		const generateHookSettingsFn = vi.fn(() => ({
			settingsPath: '/tmp/athena-hooks.json',
			cleanup,
		}));
		const execFileSyncFn = vi.fn(() => 'ATHENA_SETUP_OK');

		const result = runClaudeSmokePrompt('/usr/local/bin/claude', {
			cwd: '/repo/project',
			resolveRuntimeAuthOverlayFn,
			generateHookSettingsFn,
			execFileSyncFn,
		});

		expect(result).toEqual({
			ok: true,
			message: 'Claude replied: ATHENA_SETUP_OK',
		});
		expect(resolveRuntimeAuthOverlayFn).toHaveBeenCalledWith({
			cwd: '/repo/project',
		});
		expect(generateHookSettingsFn).toHaveBeenCalledWith(undefined, {
			apiKeyHelper: 'printf %s token',
		});
		expect(execFileSyncFn).toHaveBeenCalledWith(
			'/usr/local/bin/claude',
			[
				'-p',
				'Reply with exactly: ATHENA_SETUP_OK',
				'--output-format',
				'text',
				'--tools',
				'',
				'--max-turns',
				'1',
				'--no-session-persistence',
				'--setting-sources',
				'',
				'--settings',
				'/tmp/athena-hooks.json',
			],
			{
				timeout: 30000,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it('cleans up generated strict settings when the smoke prompt fails', () => {
		const cleanup = vi.fn();
		const execFileSyncFn = vi.fn(() => {
			throw new Error('boom');
		});

		const result = runClaudeSmokePrompt('/usr/local/bin/claude', {
			generateHookSettingsFn: () => ({
				settingsPath: '/tmp/athena-hooks.json',
				cleanup,
			}),
			execFileSyncFn,
		});

		expect(result.ok).toBe(false);
		expect(result.message).toContain('Smoke prompt failed: boom');
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

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
				label: 'Claude auth',
				status: 'pass',
				message: 'Authenticated account (max) via claude.ai',
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
			label: 'Claude auth',
			status: 'fail',
			message:
				'Skipped until Claude is installed and responds to `claude --version`.',
		});
		expect(result.checks[3]).toEqual({
			label: 'Smoke prompt',
			status: 'fail',
			message:
				'Skipped until Claude is installed, authenticated, and responds to `claude --version`.',
		});
	});

	it('fails when claude auth is not healthy', () => {
		const result = runVerify({
			runClaudeAuthStatusFn: () => ({
				ok: false,
				message: 'Claude is not logged in. Run `claude auth login` and retry.',
			}),
		});

		expect(result.ok).toBe(false);
		expect(result.summary).toBe('Claude Code setup needs attention');
		expect(result.checks[2]).toEqual({
			label: 'Claude auth',
			status: 'fail',
			message: 'Claude is not logged in. Run `claude auth login` and retry.',
		});
		expect(result.checks[3]).toEqual({
			label: 'Smoke prompt',
			status: 'fail',
			message:
				'Skipped until Claude is installed, authenticated, and responds to `claude --version`.',
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
