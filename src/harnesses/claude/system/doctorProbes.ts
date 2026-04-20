/**
 * Probe runner and helpers for `athena doctor --harness=claude`.
 *
 * Each probe shells out to `claude -p` with a different flag combination,
 * captures stdout/stderr (including `--debug api,hooks` output), and reports
 * pass/fail/skip. Helpers here also resolve `ANTHROPIC_API_KEY` from the
 * environment or the macOS keychain for probes 4 and 5.
 */

import {spawn, spawnSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const DOCTOR_PROMPT = 'Reply with exactly: ATHENA_DOCTOR_OK';
export const DOCTOR_EXPECTED = 'ATHENA_DOCTOR_OK';
const DOCTOR_TIMEOUT_MS = 30000;
const TAIL_LINES = 40;

export type ProbeStatus = 'pass' | 'fail' | 'skip' | 'na';

export type ProbeGroup = 'athena' | 'inherited' | 'credential' | 'helper';

export type ProbeConfig = {
	id: string;
	group: ProbeGroup;
	groupLabel: string;
	label: string;
	args: string[];
	env?: Record<string, string>;
	tempPaths?: string[];
};

export type ProbeResult = {
	id: string;
	group: ProbeGroup;
	groupLabel: string;
	label: string;
	status: ProbeStatus;
	exitCode: number | null;
	durationMs: number;
	stdoutTail: string;
	stderrTail: string;
	skipReason?: string;
};

/**
 * Authentication precedence (per Anthropic auth docs):
 *   1. ANTHROPIC_AUTH_TOKEN env  → Authorization: Bearer
 *   2. ANTHROPIC_API_KEY env     → X-Api-Key
 *   3. apiKeyHelper script       → both headers
 *   4. CLAUDE_CODE_OAUTH_TOKEN env (NOT read in --bare mode)
 *   5. Subscription OAuth in keychain (macOS) / ~/.claude/.credentials.json
 *
 * For --bare doctor probes we resolve a usable credential from any of:
 *   • ANTHROPIC_API_KEY env (sk-ant- prefix)
 *   • ANTHROPIC_AUTH_TOKEN env
 *   • CLAUDE_CODE_OAUTH_TOKEN env
 *   • macOS keychain entry "Claude Code-credentials" → claudeAiOauth.accessToken
 *   • ~/.claude/.credentials.json (Linux/Windows or $CLAUDE_CONFIG_DIR)
 */
export type CredentialKind = 'apiKey' | 'authToken' | 'oauthToken';
export type CredentialSource =
	| 'env:ANTHROPIC_API_KEY'
	| 'env:ANTHROPIC_AUTH_TOKEN'
	| 'env:CLAUDE_CODE_OAUTH_TOKEN'
	| 'settings:apiKeyHelper'
	| 'keychain:Claude Code-credentials'
	| 'file:.credentials.json';

export type CredentialLookup = {
	source: CredentialSource;
	kind: CredentialKind;
	value: string;
};

/** Back-compat alias for the renamed type. */
export type KeyLookupResult = CredentialLookup;

export type LookupCredentialOptions = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	cwd?: string;
	keychainLookupFn?: (service: string) => string | null;
	readFileFn?: (filePath: string) => string;
	runHelperFn?: (command: string) => string | null;
};

function tail(value: string, lines: number): string {
	const trimmed = value.replace(/\s+$/u, '');
	if (!trimmed) return '';
	const split = trimmed.split('\n');
	return split.slice(-lines).join('\n');
}

function defaultKeychainLookup(service: string): string | null {
	try {
		const result = spawnSync(
			'security',
			['find-generic-password', '-s', service, '-w'],
			{
				encoding: 'utf-8',
				timeout: 5000,
				stdio: ['ignore', 'pipe', 'ignore'],
			},
		);
		if (result.status !== 0) return null;
		const value = result.stdout.trim();
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
}

function defaultRunHelper(command: string): string | null {
	try {
		const result = spawnSync('/bin/sh', ['-c', command], {
			encoding: 'utf-8',
			timeout: 10000,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		if (result.status !== 0) return null;
		const value = result.stdout.trim();
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
}

function readApiKeyHelperFromSettings(
	homeDir: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	readFileFn: (filePath: string) => string,
): string | null {
	const candidates: string[] = [];
	if (platform === 'darwin') {
		candidates.push(
			'/Library/Application Support/ClaudeCode/managed-settings.json',
		);
	} else if (platform === 'win32') {
		const programData = env['PROGRAMDATA'] ?? 'C:\\ProgramData';
		candidates.push(
			path.join(programData, 'ClaudeCode', 'managed-settings.json'),
		);
	} else {
		candidates.push('/etc/claude-code/managed-settings.json');
	}
	const configDir = env['CLAUDE_CONFIG_DIR'] ?? path.join(homeDir, '.claude');
	candidates.push(path.join(configDir, 'settings.json'));
	candidates.push(path.join(cwd, '.claude', 'settings.json'));
	candidates.push(path.join(cwd, '.claude', 'settings.local.json'));

	for (const file of candidates) {
		try {
			const raw = readFileFn(file);
			const parsed = JSON.parse(raw) as {apiKeyHelper?: unknown};
			if (
				typeof parsed.apiKeyHelper === 'string' &&
				parsed.apiKeyHelper.length > 0
			) {
				return parsed.apiKeyHelper;
			}
		} catch {
			// File missing, unreadable, or malformed — skip.
		}
	}
	return null;
}

function classifyToken(value: string): CredentialKind {
	// Console API keys start with sk-ant-api…; OAuth access tokens start with
	// sk-ant-oat…; long-lived OAuth tokens with sk-ant-ort…. Anything else that
	// the helper produces is treated as a bearer token (safest default for
	// proxies/gateways that mint custom tokens).
	if (value.startsWith('sk-ant-api')) return 'apiKey';
	if (value.startsWith('sk-ant-oat') || value.startsWith('sk-ant-ort')) {
		return 'oauthToken';
	}
	return 'authToken';
}

function extractOauthAccessToken(rawJson: string): string | null {
	try {
		const parsed = JSON.parse(rawJson) as {
			claudeAiOauth?: {accessToken?: string};
			accessToken?: string;
		};
		const token = parsed.claudeAiOauth?.accessToken ?? parsed.accessToken;
		return typeof token === 'string' && token.length > 0 ? token : null;
	} catch {
		return null;
	}
}

export function lookupCredential(
	options: LookupCredentialOptions = {},
): CredentialLookup | null {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const homeDir = options.homeDir ?? os.homedir();
	const cwd = options.cwd ?? process.cwd();
	const readFileFn =
		options.readFileFn ?? ((p: string) => fs.readFileSync(p, 'utf8'));

	// Order matches the bare-mode-friendly precedence: explicit env vars first
	// (most predictable), then user-configured apiKeyHelper script, then OAuth
	// fallbacks (which only work without --bare).

	const apiKey = env['ANTHROPIC_API_KEY'];
	if (typeof apiKey === 'string' && apiKey.startsWith('sk-ant-')) {
		return {source: 'env:ANTHROPIC_API_KEY', kind: 'apiKey', value: apiKey};
	}

	const authToken = env['ANTHROPIC_AUTH_TOKEN'];
	if (typeof authToken === 'string' && authToken.length > 0) {
		return {
			source: 'env:ANTHROPIC_AUTH_TOKEN',
			kind: 'authToken',
			value: authToken,
		};
	}

	const helperCommand = readApiKeyHelperFromSettings(
		homeDir,
		cwd,
		env,
		platform,
		readFileFn,
	);
	if (helperCommand) {
		const runHelper = options.runHelperFn ?? defaultRunHelper;
		const helperOutput = runHelper(helperCommand);
		if (helperOutput) {
			return {
				source: 'settings:apiKeyHelper',
				kind: classifyToken(helperOutput),
				value: helperOutput,
			};
		}
	}

	const oauthEnv = env['CLAUDE_CODE_OAUTH_TOKEN'];
	if (typeof oauthEnv === 'string' && oauthEnv.length > 0) {
		return {
			source: 'env:CLAUDE_CODE_OAUTH_TOKEN',
			kind: 'oauthToken',
			value: oauthEnv,
		};
	}

	if (platform === 'darwin') {
		const lookup = options.keychainLookupFn ?? defaultKeychainLookup;
		const raw = lookup('Claude Code-credentials');
		if (raw) {
			const token = extractOauthAccessToken(raw);
			if (token) {
				return {
					source: 'keychain:Claude Code-credentials',
					kind: 'oauthToken',
					value: token,
				};
			}
		}
	} else {
		const credentialsPath = path.join(
			env['CLAUDE_CONFIG_DIR'] ?? path.join(homeDir, '.claude'),
			'.credentials.json',
		);
		try {
			const readFile =
				options.readFileFn ?? ((p: string) => fs.readFileSync(p, 'utf8'));
			const raw = readFile(credentialsPath);
			const token = extractOauthAccessToken(raw);
			if (token) {
				return {
					source: 'file:.credentials.json',
					kind: 'oauthToken',
					value: token,
				};
			}
		} catch {
			// File missing or unreadable
		}
	}

	return null;
}

/** @deprecated Use {@link lookupCredential}. Retained for tests/back-compat. */
export function lookupAnthropicApiKey(
	options: LookupCredentialOptions = {},
): CredentialLookup | null {
	return lookupCredential(options);
}

export type ApiKeyHelperSettings = {
	settingsPath: string;
	cleanup: () => void;
};

export function buildApiKeyHelperSettings(
	athenaBin: string,
	tempDir: string = os.tmpdir(),
): ApiKeyHelperSettings {
	const filename = `athena-doctor-helper-${process.pid}-${Date.now()}.json`;
	const settingsPath = path.join(tempDir, filename);
	const settings = {
		apiKeyHelper: `${athenaBin} doctor --print-api-key`,
	};
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
	return {
		settingsPath,
		cleanup: () => {
			try {
				if (fs.existsSync(settingsPath)) {
					fs.unlinkSync(settingsPath);
				}
			} catch {
				// Ignore cleanup errors
			}
		},
	};
}

export type RunProbeOptions = {
	claudeBinary: string;
	probe: ProbeConfig;
	timeoutMs?: number;
	now?: () => number;
	/** Fires whenever the probe emits stdout data; useful for live streaming. */
	onStdoutChunk?: (chunk: string) => void;
	/** Fires whenever the probe emits stderr data; useful for live streaming. */
	onStderrChunk?: (chunk: string) => void;
};

export async function runProbe({
	claudeBinary,
	probe,
	timeoutMs = DOCTOR_TIMEOUT_MS,
	now = Date.now,
	onStdoutChunk,
	onStderrChunk,
}: RunProbeOptions): Promise<ProbeResult> {
	const start = now();

	return new Promise<ProbeResult>(resolve => {
		const child = spawn(claudeBinary, probe.args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {...process.env, ...(probe.env ?? {})},
		});

		let stdout = '';
		let stderr = '';
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);

		child.stdout.setEncoding('utf-8');
		child.stderr.setEncoding('utf-8');

		child.stdout.on('data', (chunk: string) => {
			stdout += chunk;
			if (onStdoutChunk) onStdoutChunk(chunk);
		});
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
			if (onStderrChunk) onStderrChunk(chunk);
		});

		const finish = (exitCode: number | null) => {
			clearTimeout(timer);
			const durationMs = now() - start;
			let status: ProbeStatus = stdout.includes(DOCTOR_EXPECTED)
				? 'pass'
				: 'fail';
			if (timedOut) {
				status = 'fail';
				stderr = `${stderr}\nProbe timed out after ${timeoutMs}ms`;
			}
			resolve({
				id: probe.id,
				group: probe.group,
				groupLabel: probe.groupLabel,
				label: probe.label,
				status,
				exitCode,
				durationMs,
				stdoutTail: tail(stdout, TAIL_LINES),
				stderrTail: tail(stderr, TAIL_LINES),
			});
		};

		child.on('error', error => {
			stderr = `${stderr}\n${error.message}`;
			finish(null);
		});
		child.on('close', code => finish(code));
	});
}

export function makeSkippedProbe(
	probe: ProbeConfig,
	reason: string,
	status: ProbeStatus = 'skip',
): ProbeResult {
	return {
		id: probe.id,
		group: probe.group,
		groupLabel: probe.groupLabel,
		label: probe.label,
		status,
		exitCode: null,
		durationMs: 0,
		stdoutTail: '',
		stderrTail: '',
		skipReason: reason,
	};
}

export type BuildProbesOptions = {
	strictSettingsPath: string;
	helperSettingsPath?: string;
	credential?: CredentialLookup;
	/** Human-readable reason credential lookup returned null. Drives SKIP messages. */
	credentialMissingReason?: string;
};

/** Pre-computed reason a probe should be marked SKIP rather than executed. */
export type ProbeSkip = {
	probe: ProbeConfig;
	reason: string;
};

type FlagCombo = {
	bare: boolean;
	emptySources: boolean;
};

const FLAG_COMBOS: FlagCombo[] = [
	{bare: false, emptySources: false},
	{bare: false, emptySources: true},
	{bare: true, emptySources: false},
	{bare: true, emptySources: true},
];

function comboLabel(combo: FlagCombo): string {
	const bare = combo.bare ? 'bare' : 'no-bare';
	const sources = combo.emptySources ? 'empty-sources' : 'default-sources';
	return `${bare.padEnd(7)} · ${sources}`;
}

function comboShortId(combo: FlagCombo): string {
	return `${combo.bare ? 'B' : 'b'}${combo.emptySources ? 'E' : 'e'}`;
}

function baseArgs(combo: FlagCombo, extraSettings?: string): string[] {
	const args: string[] = [];
	if (combo.bare) args.push('--bare');
	args.push('-p', DOCTOR_PROMPT, '--output-format', 'text', '--max-turns', '1');
	if (combo.emptySources) args.push('--setting-sources', '');
	if (extraSettings) args.push('--settings', extraSettings);
	args.push('--debug', 'api,hooks');
	return args;
}

function envVarForCredential(credential: CredentialLookup): string {
	// --bare reads ANTHROPIC_API_KEY (X-Api-Key) and ANTHROPIC_AUTH_TOKEN
	// (Authorization: Bearer); it does NOT read CLAUDE_CODE_OAUTH_TOKEN.
	// Subscription OAuth tokens (sk-ant-oat01-…) work as bearer tokens, so
	// route any non-API-key credential through ANTHROPIC_AUTH_TOKEN.
	return credential.kind === 'apiKey'
		? 'ANTHROPIC_API_KEY'
		: 'ANTHROPIC_AUTH_TOKEN';
}

export function buildProbeConfigs(opts: BuildProbesOptions): ProbeConfig[] {
	const probes: ProbeConfig[] = [];

	// Group A — Athena's own task path and a sanity baseline.
	probes.push({
		id: 'A1',
		group: 'athena',
		groupLabel: "Athena's task path (baseline)",
		label: 'strict-isolation (athena hook settings, no --bare, empty sources)',
		args: [
			'-p',
			DOCTOR_PROMPT,
			'--output-format',
			'stream-json',
			'--verbose',
			'--include-partial-messages',
			'--setting-sources',
			'',
			'--settings',
			opts.strictSettingsPath,
			'--debug',
			'api,hooks',
		],
	});
	probes.push({
		id: 'A2',
		group: 'athena',
		groupLabel: "Athena's task path (baseline)",
		label: 'default-context (no --bare, default sources, no extra settings)',
		args: baseArgs({bare: false, emptySources: false}),
	});

	// Group B — inherited subscription auth (no env override).
	// Tests every {bare, sources} combo with whatever Claude resolves on its own.
	for (const combo of FLAG_COMBOS) {
		probes.push({
			id: `B-${comboShortId(combo)}`,
			group: 'inherited',
			groupLabel: 'Inherited subscription auth (no env override)',
			label: comboLabel(combo),
			args: baseArgs(combo),
		});
	}

	// Group C — credential injected via env var, swept across all combos.
	const credentialGroupLabel = opts.credential
		? `Credential via env: ${envVarForCredential(opts.credential)} from ${opts.credential.source}`
		: 'Credential via env (no credential resolved)';
	for (const combo of FLAG_COMBOS) {
		const probe: ProbeConfig = {
			id: `C-${comboShortId(combo)}`,
			group: 'credential',
			groupLabel: credentialGroupLabel,
			label: comboLabel(combo),
			args: baseArgs(combo),
		};
		if (opts.credential) {
			probe.env = {
				[envVarForCredential(opts.credential)]: opts.credential.value,
			};
		}
		probes.push(probe);
	}

	// Group D — apiKeyHelper script (prints the resolved credential).
	const helperGroupLabel = opts.credential
		? `apiKeyHelper script (apiKeyHelper → ${opts.credential.kind})`
		: 'apiKeyHelper script (no credential for helper to print)';
	for (const combo of FLAG_COMBOS) {
		const probe: ProbeConfig = {
			id: `D-${comboShortId(combo)}`,
			group: 'helper',
			groupLabel: helperGroupLabel,
			label: comboLabel(combo),
			args: opts.helperSettingsPath
				? baseArgs(combo, opts.helperSettingsPath)
				: baseArgs(combo),
		};
		if (opts.helperSettingsPath) {
			probe.tempPaths = [opts.helperSettingsPath];
		}
		probes.push(probe);
	}

	return probes;
}

/**
 * Returns the reason a probe should be SKIPped instead of executed, or null if
 * it is ready to run. Used by the orchestrator so failures point at the missing
 * input ("token missing") rather than letting Claude error out with an empty
 * value.
 */
export function probeSkipReason(
	probe: ProbeConfig,
	opts: BuildProbesOptions,
): string | null {
	if (probe.group === 'credential' && !opts.credential) {
		return (
			opts.credentialMissingReason ??
			'No credential resolved (would have injected an empty token)'
		);
	}
	if (probe.group === 'helper' && !opts.credential) {
		return (
			opts.credentialMissingReason ??
			'apiKeyHelper would have nothing to print (no credential resolved)'
		);
	}
	if (probe.group === 'helper' && !opts.helperSettingsPath) {
		return 'helper settings file was not generated';
	}
	return null;
}
