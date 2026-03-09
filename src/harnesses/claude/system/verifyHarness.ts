import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {detectClaudeVersion} from './detectVersion';
import {resolveClaudeBinary} from './resolveBinary';
import {resolveHookForwarderCommand} from '../hooks/generateHookSettings';

import type {
	HarnessVerificationCheck,
	HarnessVerificationResult,
} from '../../types';

export type {HarnessVerificationCheck, HarnessVerificationResult};

export type VerifyClaudeHarnessOptions = {
	pathValue?: string;
	resolveClaudeBinaryFn?: typeof resolveClaudeBinary;
	detectClaudeVersionFn?: typeof detectClaudeVersion;
	resolveHookForwarderCommandFn?: typeof resolveHookForwarderCommand;
	fileExists?: (candidatePath: string) => boolean;
	runClaudeAuthStatusFn?: typeof runClaudeAuthStatus;
	runClaudeSmokePromptFn?: typeof runClaudeSmokePrompt;
};

const SETUP_SMOKE_PROMPT = 'Reply with exactly: ATHENA_SETUP_OK';

type ClaudeAuthStatus = {
	loggedIn?: boolean;
	authMethod?: string;
	apiProvider?: string;
	subscriptionType?: string;
};

function readExecStream(error: unknown, key: 'stdout' | 'stderr'): string {
	if (!(error instanceof Error) || !(key in error)) {
		return '';
	}

	const value = (
		error as Error & Partial<Record<'stdout' | 'stderr', unknown>>
	)[key];
	if (typeof value === 'string') {
		return value;
	}
	if (Buffer.isBuffer(value)) {
		return value.toString('utf8');
	}
	return '';
}

function formatExecFailure(error: unknown): string {
	if (error instanceof Error) {
		const stderr = readExecStream(error, 'stderr');
		const detail = stderr.trim();
		return detail.length > 0 ? detail : error.message;
	}
	return String(error);
}

function parseClaudeAuthStatusOutput(output: string): ClaudeAuthStatus | null {
	try {
		return JSON.parse(output) as ClaudeAuthStatus;
	} catch {
		return null;
	}
}

export function runClaudeSmokePrompt(claudeBinary: string): {
	ok: boolean;
	message: string;
} {
	try {
		const output = execFileSync(
			claudeBinary,
			[
				'-p',
				SETUP_SMOKE_PROMPT,
				'--output-format',
				'text',
				'--tools',
				'',
				'--max-turns',
				'1',
				'--no-session-persistence',
			],
			{
				timeout: 30000,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		).trim();

		if (output.length === 0) {
			return {
				ok: false,
				message: 'Claude returned an empty response to the smoke prompt.',
			};
		}

		return {
			ok: true,
			message: `Claude replied: ${output}`,
		};
	} catch (error) {
		return {
			ok: false,
			message: `Smoke prompt failed: ${formatExecFailure(error)}`,
		};
	}
}

export function runClaudeAuthStatus(claudeBinary: string): {
	ok: boolean;
	message: string;
} {
	try {
		const output = execFileSync(claudeBinary, ['auth', 'status'], {
			timeout: 10000,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trim();

		const parsed = parseClaudeAuthStatusOutput(output);
		if (!parsed) {
			return {
				ok: false,
				message: 'Unable to parse `claude auth status` output.',
			};
		}

		if (!parsed.loggedIn) {
			return {
				ok: false,
				message: 'Claude is not logged in. Run `claude auth login` and retry.',
			};
		}

		const authMethod = parsed.authMethod ?? 'unknown auth';
		const subscription = parsed.subscriptionType
			? ` (${parsed.subscriptionType})`
			: '';

		return {
			ok: true,
			message: `Authenticated account${subscription} via ${authMethod}`,
		};
	} catch (error) {
		const parsed = parseClaudeAuthStatusOutput(
			readExecStream(error, 'stdout').trim(),
		);
		if (parsed && !parsed.loggedIn) {
			return {
				ok: false,
				message: 'Claude is not logged in. Run `claude auth login` and retry.',
			};
		}

		return {
			ok: false,
			message: `Auth status failed: ${formatExecFailure(error)}`,
		};
	}
}

function canExecute(candidatePath: string): boolean {
	try {
		fs.accessSync(candidatePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveExecutableOnPath(
	commandName: string,
	pathValue: string,
	fileExists: (candidatePath: string) => boolean,
): string | null {
	for (const entry of pathValue.split(path.delimiter)) {
		if (!entry) continue;
		const candidate = path.join(entry, commandName);
		if (fileExists(candidate)) {
			return candidate;
		}
	}
	return null;
}

export function verifyClaudeHarness(
	options: VerifyClaudeHarnessOptions = {},
): HarnessVerificationResult {
	const resolveBinaryFn = options.resolveClaudeBinaryFn ?? resolveClaudeBinary;
	const detectVersionFn = options.detectClaudeVersionFn ?? detectClaudeVersion;
	const resolveForwarderFn =
		options.resolveHookForwarderCommandFn ?? resolveHookForwarderCommand;
	const pathValue = options.pathValue ?? process.env['PATH'] ?? '';
	const fileExists = options.fileExists ?? canExecute;
	const runAuthStatusFn = options.runClaudeAuthStatusFn ?? runClaudeAuthStatus;
	const runSmokePromptFn =
		options.runClaudeSmokePromptFn ?? runClaudeSmokePrompt;

	const checks: HarnessVerificationCheck[] = [];
	const claudeBinary = resolveBinaryFn();
	const version = claudeBinary ? detectVersionFn() : null;
	const authStatus = claudeBinary ? runAuthStatusFn(claudeBinary) : null;
	const hookForwarder = resolveForwarderFn();

	if (claudeBinary) {
		checks.push({
			label: 'Claude binary',
			status: 'pass',
			message: claudeBinary,
		});
	} else {
		checks.push({
			label: 'Claude binary',
			status: 'fail',
			message:
				'Not found in PATH. Install Claude Code, then run `claude doctor`.',
		});
	}

	if (version) {
		checks.push({
			label: 'Claude version',
			status: 'pass',
			message: `v${version}`,
		});
	} else {
		checks.push({
			label: 'Claude version',
			status: 'fail',
			message:
				'Unable to read `claude --version`. Run `claude doctor` in this shell.',
		});
	}

	if (authStatus) {
		checks.push({
			label: 'Claude auth',
			status: authStatus.ok ? 'pass' : 'fail',
			message: authStatus.message,
		});
	} else {
		checks.push({
			label: 'Claude auth',
			status: 'fail',
			message:
				'Skipped until Claude is installed and responds to `claude --version`.',
		});
	}

	if (claudeBinary && version && authStatus?.ok) {
		const smokePrompt = runSmokePromptFn(claudeBinary);
		checks.push({
			label: 'Smoke prompt',
			status: smokePrompt.ok ? 'pass' : 'fail',
			message: smokePrompt.message,
		});
	} else {
		checks.push({
			label: 'Smoke prompt',
			status: 'fail',
			message:
				'Skipped until Claude is installed, authenticated, and responds to `claude --version`.',
		});
	}

	if (hookForwarder.source === 'bundled') {
		const nodeOk = fileExists(hookForwarder.executable);
		const scriptOk =
			!!hookForwarder.scriptPath && fs.existsSync(hookForwarder.scriptPath);
		checks.push({
			label: 'Hook forwarder',
			status: nodeOk && scriptOk ? 'pass' : 'fail',
			message:
				nodeOk && scriptOk
					? 'Bundled Athena hook forwarder is available'
					: 'Bundled Athena hook forwarder is missing. Rebuild or reinstall Athena.',
		});
	} else {
		const resolvedForwarder = resolveExecutableOnPath(
			hookForwarder.executable,
			pathValue,
			fileExists,
		);
		checks.push({
			label: 'Hook forwarder',
			status: resolvedForwarder ? 'pass' : 'fail',
			message:
				resolvedForwarder ??
				'`athena-hook-forwarder` is not available in PATH. Reinstall Athena.',
		});
	}

	const jqBinary = resolveExecutableOnPath('jq', pathValue, fileExists);
	checks.push({
		label: 'jq',
		status: jqBinary ? 'pass' : 'warn',
		message: jqBinary
			? jqBinary
			: 'Not found. Athena only needs jq for `--verbose` streaming output.',
	});

	const hasFailure = checks.some(check => check.status === 'fail');
	const summary = hasFailure
		? 'Claude Code setup needs attention'
		: version
			? `Claude Code v${version} detected`
			: 'Claude Code detected';

	return {
		ok: !hasFailure,
		summary,
		checks,
	};
}
