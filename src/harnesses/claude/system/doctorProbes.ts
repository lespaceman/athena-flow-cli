/**
 * Probe runner and helpers for `athena doctor --harness=claude`.
 *
 * Each probe shells out to `claude -p` with a different flag combination
 * (see `buildProbeConfigs`), captures stdout/stderr including
 * `--debug api,hooks` output, and reports pass/fail/skip. Credential lookup
 * (`lookupAllCredentials`) walks every documented credential location so the
 * doctor can exercise each available auth method in its own probe group.
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
	/** When set on credential/helper probes, the kind of credential being injected. */
	credentialKind?: CredentialKind;
};

export type ProbeResult = {
	id: string;
	group: ProbeGroup;
	groupLabel: string;
	label: string;
	/** Shell-quoted command line (with prompt elided, credentials masked). */
	command: string;
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
	| 'flag:--api-key'
	| 'keychain:ANTHROPIC_API_KEY'
	| 'settings:apiKeyHelper'
	| 'dotenv:.env'
	| 'dotenv:.env.local'
	| 'dotenv:~/.env'
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
	/** Explicitly-provided API key (e.g. from --api-key flag). */
	apiKeyOverride?: string;
};

function parseDotenvForApiKey(content: string): string | null {
	for (const rawLine of content.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const match = /^(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/u.exec(
			line,
		);
		if (!match) continue;
		let value = match[1]!;
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (value.startsWith('sk-ant-')) return value;
	}
	return null;
}

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

/**
 * Returns the single best credential — prefers a real Console API key over any
 * OAuth/auth-token alternative, since `--bare` mode only accepts API keys (or
 * apiKeyHelper output that resolves to one).
 */
export function lookupCredential(
	options: LookupCredentialOptions = {},
): CredentialLookup | null {
	const all = lookupAllCredentials(options);
	if (all.length === 0) return null;
	const apiKey = all.find(c => c.kind === 'apiKey');
	if (apiKey) return apiKey;
	const authToken = all.find(c => c.kind === 'authToken');
	if (authToken) return authToken;
	return all[0]!;
}

/** @deprecated Use {@link lookupCredential}. Retained for tests/back-compat. */
export function lookupAnthropicApiKey(
	options: LookupCredentialOptions = {},
): CredentialLookup | null {
	return lookupCredential(options);
}

/**
 * Returns every distinct credential available, not just the first one in the
 * precedence order. Used by the doctor so each available auth method is
 * exercised independently (e.g. an OAuth token from the keychain AND a Console
 * API key from the env var get their own probe groups).
 */
export function lookupAllCredentials(
	options: LookupCredentialOptions = {},
): CredentialLookup[] {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const homeDir = options.homeDir ?? os.homedir();
	const cwd = options.cwd ?? process.cwd();
	const readFileFn =
		options.readFileFn ?? ((p: string) => fs.readFileSync(p, 'utf8'));
	const found: CredentialLookup[] = [];
	const seen = new Set<string>();
	const push = (cred: CredentialLookup) => {
		const key = `${cred.source}|${cred.value}`;
		if (seen.has(key)) return;
		seen.add(key);
		found.push(cred);
	};

	if (
		typeof options.apiKeyOverride === 'string' &&
		options.apiKeyOverride.startsWith('sk-ant-')
	) {
		push({
			source: 'flag:--api-key',
			kind: 'apiKey',
			value: options.apiKeyOverride,
		});
	}

	const apiKey = env['ANTHROPIC_API_KEY'];
	if (typeof apiKey === 'string' && apiKey.startsWith('sk-ant-')) {
		push({source: 'env:ANTHROPIC_API_KEY', kind: 'apiKey', value: apiKey});
	}

	const authToken = env['ANTHROPIC_AUTH_TOKEN'];
	if (typeof authToken === 'string' && authToken.length > 0) {
		push({
			source: 'env:ANTHROPIC_AUTH_TOKEN',
			kind: 'authToken',
			value: authToken,
		});
	}

	if (platform === 'darwin') {
		const lookup = options.keychainLookupFn ?? defaultKeychainLookup;
		const keychainKey = lookup('ANTHROPIC_API_KEY');
		if (keychainKey && keychainKey.startsWith('sk-ant-')) {
			push({
				source: 'keychain:ANTHROPIC_API_KEY',
				kind: 'apiKey',
				value: keychainKey,
			});
		}
	}

	const dotenvCandidates: Array<{
		source: Extract<
			CredentialSource,
			'dotenv:.env' | 'dotenv:.env.local' | 'dotenv:~/.env'
		>;
		path: string;
	}> = [
		{source: 'dotenv:.env', path: path.join(cwd, '.env')},
		{source: 'dotenv:.env.local', path: path.join(cwd, '.env.local')},
		{source: 'dotenv:~/.env', path: path.join(homeDir, '.env')},
	];
	for (const candidate of dotenvCandidates) {
		try {
			const content = readFileFn(candidate.path);
			const value = parseDotenvForApiKey(content);
			if (value) {
				push({source: candidate.source, kind: 'apiKey', value});
			}
		} catch {
			// Missing or unreadable; skip.
		}
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
			push({
				source: 'settings:apiKeyHelper',
				kind: classifyToken(helperOutput),
				value: helperOutput,
			});
		}
	}

	const oauthEnv = env['CLAUDE_CODE_OAUTH_TOKEN'];
	if (typeof oauthEnv === 'string' && oauthEnv.length > 0) {
		push({
			source: 'env:CLAUDE_CODE_OAUTH_TOKEN',
			kind: 'oauthToken',
			value: oauthEnv,
		});
	}

	if (platform === 'darwin') {
		const lookup = options.keychainLookupFn ?? defaultKeychainLookup;
		const raw = lookup('Claude Code-credentials');
		if (raw) {
			const token = extractOauthAccessToken(raw);
			if (token) {
				push({
					source: 'keychain:Claude Code-credentials',
					kind: 'oauthToken',
					value: token,
				});
			}
		}
	} else {
		const credentialsPath = path.join(
			env['CLAUDE_CONFIG_DIR'] ?? path.join(homeDir, '.claude'),
			'.credentials.json',
		);
		try {
			const raw = readFileFn(credentialsPath);
			const token = extractOauthAccessToken(raw);
			if (token) {
				push({
					source: 'file:.credentials.json',
					kind: 'oauthToken',
					value: token,
				});
			}
		} catch {
			// File missing or unreadable
		}
	}

	return found;
}

export type ApiKeyHelperSettings = {
	settingsPath: string;
	cleanup: () => void;
};

function shellQuoteSingle(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Writes a temp Claude settings JSON whose `apiKeyHelper` deterministically
 * prints the given credential value via `printf`. Each credential gets its own
 * helper file so D-group probes can test that exact value without our
 * `--print-api-key` resolver re-walking sources at probe time.
 */
export function buildApiKeyHelperSettings(
	value: string,
	tempDir: string = os.tmpdir(),
	tag = 'doctor',
): ApiKeyHelperSettings {
	const filename = `athena-${tag}-helper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
	const settingsPath = path.join(tempDir, filename);
	const settings = {
		apiKeyHelper: `printf %s ${shellQuoteSingle(value)}`,
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

/** Stable key for matching a credential to its helper settings file. */
export function credentialHelperKey(credential: CredentialLookup): string {
	return `${credential.source}|${credential.value}`;
}

const SHELL_SAFE = /^[A-Za-z0-9_./:=,@+-]+$/u;

function shellQuoteArg(value: string): string {
	if (value === '') return "''";
	if (SHELL_SAFE.test(value)) return value;
	return shellQuoteSingle(value);
}

/**
 * Formats the probe's invocation as a shell command line, eliding the long
 * smoke prompt so the output stays scannable. Env-var injections are rendered
 * as `KEY=<value>` prefixes (with the value masked for credentials). The
 * binary is rendered as its basename and any path matching an entry in
 * `aliases` is rendered as `$alias`.
 */
export function formatProbeCommand(
	probe: ProbeConfig,
	claudeBinary: string,
	aliases?: ReadonlyMap<string, string>,
): string {
	const parts: string[] = [];
	if (probe.env) {
		for (const [key, value] of Object.entries(probe.env)) {
			parts.push(`${key}=${shellQuoteArg(maskCredentialValue(value))}`);
		}
	}
	parts.push(path.basename(claudeBinary));
	const aliasFor = (arg: string): string | null => {
		if (!aliases) return null;
		for (const [name, fullPath] of aliases) {
			if (arg === fullPath) return `$${name}`;
		}
		return null;
	};
	const args = probe.args.map(arg => {
		if (arg === DOCTOR_PROMPT) return '<prompt>';
		return aliasFor(arg) ?? shellQuoteArg(arg);
	});
	parts.push(...args);
	return parts.join(' ');
}

function maskCredentialValue(value: string): string {
	if (value.length <= 12) return '***';
	return `${value.slice(0, 10)}…${value.slice(-4)}`;
}

/**
 * Classifies a failed probe into a structured, human-readable reason.
 *
 * The diagnostic is derived from the body Claude/SDK printed; it pinpoints
 * whether the failure was missing auth, an OAuth-vs-API-key mismatch, an
 * invalid credential, a timeout, or something else. Returns null for passing
 * probes.
 */
export type FailureClassification = {
	title: string;
	hint?: string;
	rawLine: string;
};

export function classifyFailure(
	result: ProbeResult,
): FailureClassification | null {
	if (result.status !== 'fail') return null;
	const haystack = `${result.stdoutTail}\n${result.stderrTail}`;
	const rawLine = pickMeaningfulLine(haystack);

	if (/Probe timed out/u.test(haystack)) {
		return {
			title: 'Probe timed out',
			hint: 'Helper script may be hanging or Claude is waiting for stdin.',
			rawLine,
		};
	}
	if (/Not logged in[^\n]*\/login/u.test(haystack)) {
		return {
			title: 'No auth available',
			hint: '--bare skips OAuth/keychain and no API key was injected.',
			rawLine,
		};
	}
	if (/OAuth authentication is currently not supported/u.test(haystack)) {
		return {
			title: 'OAuth token rejected',
			hint: 'Subscription OAuth tokens cannot authenticate the API; use a Console API key (sk-ant-api…).',
			rawLine,
		};
	}
	if (/API Error: 401/u.test(haystack)) {
		return {
			title: 'Authentication failed (401)',
			hint: 'Credential was sent but rejected — invalid, expired, or wrong type.',
			rawLine,
		};
	}
	if (/API Error: 403/u.test(haystack)) {
		return {
			title: 'Forbidden (403)',
			hint: 'Token lacks scope, or organization is disabled.',
			rawLine,
		};
	}
	if (/API Error: 400/u.test(haystack)) {
		return {
			title: 'Bad request (400)',
			hint: 'API rejected credential format (often: OAuth token sent as X-Api-Key).',
			rawLine,
		};
	}
	if (/API Error: 5\d\d/u.test(haystack)) {
		return {
			title: 'Server error (5xx)',
			hint: 'Transient — retry. Not a credential issue.',
			rawLine,
		};
	}
	return {title: rawLine || 'Unknown failure', rawLine};
}

function pickMeaningfulLine(text: string): string {
	const lines = text
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.filter(line => !line.startsWith('Command failed:'));
	return lines.at(-1) ?? '';
}

export type RunProbeOptions = {
	claudeBinary: string;
	probe: ProbeConfig;
	timeoutMs?: number;
	now?: () => number;
	/** Optional renderer for the probe's command line; defaults to formatProbeCommand. */
	formatCommandFn?: (probe: ProbeConfig) => string;
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
	formatCommandFn,
	onStdoutChunk,
	onStderrChunk,
}: RunProbeOptions): Promise<ProbeResult> {
	const formatCommand =
		formatCommandFn ??
		((p: ProbeConfig) => formatProbeCommand(p, claudeBinary));
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
				command: formatCommand(probe),
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
	claudeBinary = 'claude',
	formatCommandFn?: (probe: ProbeConfig) => string,
): ProbeResult {
	const command = formatCommandFn
		? formatCommandFn(probe)
		: formatProbeCommand(probe, claudeBinary);
	return {
		id: probe.id,
		group: probe.group,
		groupLabel: probe.groupLabel,
		label: probe.label,
		command,
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
	/** All credentials available; each gets its own C and D probe group. */
	credentials?: CredentialLookup[];
	/** Per-credential helper settings file path (keyed by `${source}|${value}`). */
	helperSettingsByCredential?: Map<string, string>;
	/** Human-readable reason credential lookup returned no credentials. */
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
	// Use --output-format stream-json to match Athena's production spawn
	// (src/harnesses/claude/process/spawn.ts:151). The sentinel string still
	// appears verbatim inside the NDJSON, so the simple stdout.includes() check
	// in runProbe works without a JSON parser.
	const args: string[] = [];
	if (combo.bare) args.push('--bare');
	args.push(
		'-p',
		DOCTOR_PROMPT,
		'--output-format',
		'stream-json',
		'--verbose',
		'--include-partial-messages',
		'--max-turns',
		'1',
	);
	if (combo.emptySources) args.push('--setting-sources', '');
	if (extraSettings) args.push('--settings', extraSettings);
	args.push('--debug', 'api,hooks');
	return args;
}

/**
 * Per the Anthropic auth docs, ANTHROPIC_API_KEY carries Console API keys
 * (X-Api-Key header) and ANTHROPIC_AUTH_TOKEN carries proxy/gateway bearer
 * tokens (Authorization: Bearer). Subscription OAuth tokens (sk-ant-oat…)
 * are NOT a valid value for either — they must go through `apiKeyHelper`
 * or `claude /login`. Returns null for OAuth credentials so the C-group
 * SKIPs them with an explanatory reason instead of producing a misleading
 * 401 by injecting an invalid value.
 */
function envVarForCredential(credential: CredentialLookup): string | null {
	if (credential.kind === 'apiKey') return 'ANTHROPIC_API_KEY';
	if (credential.kind === 'authToken') return 'ANTHROPIC_AUTH_TOKEN';
	return null;
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

	// Groups C and D — emitted per credential so each available auth method is
	// exercised independently. If no credentials were resolved, a single SKIP
	// placeholder group is emitted explaining why.
	const credentials = opts.credentials ?? [];
	if (credentials.length === 0) {
		for (const combo of FLAG_COMBOS) {
			probes.push({
				id: `C-${comboShortId(combo)}`,
				group: 'credential',
				groupLabel: 'Credential via env (no credential resolved)',
				label: comboLabel(combo),
				args: baseArgs(combo),
			});
		}
		for (const combo of FLAG_COMBOS) {
			probes.push({
				id: `D-${comboShortId(combo)}`,
				group: 'helper',
				groupLabel: 'apiKeyHelper script (no credential for helper to print)',
				label: comboLabel(combo),
				args: baseArgs(combo),
			});
		}
	} else {
		credentials.forEach((credential, credentialIndex) => {
			const credentialTag = `${credentialIndex + 1}`; // C1, C2 …
			const envVar = envVarForCredential(credential);
			const credentialGroupLabel = envVar
				? `Credential via env: ${envVar} from ${credential.source} (${credential.kind})`
				: `Credential via env: ${credential.source} (${credential.kind} — not env-injectable)`;
			for (const combo of FLAG_COMBOS) {
				const probe: ProbeConfig = {
					id: `C${credentialTag}-${comboShortId(combo)}`,
					group: 'credential',
					groupLabel: credentialGroupLabel,
					label: comboLabel(combo),
					args: baseArgs(combo),
					credentialKind: credential.kind,
				};
				if (envVar) probe.env = {[envVar]: credential.value};
				probes.push(probe);
			}

			const helperKey = `${credential.source}|${credential.value}`;
			const helperPath =
				opts.helperSettingsByCredential?.get(helperKey) ??
				opts.helperSettingsPath;
			const helperGroupLabel = `apiKeyHelper script (prints ${credential.kind} from ${credential.source})`;
			for (const combo of FLAG_COMBOS) {
				const probe: ProbeConfig = {
					id: `D${credentialTag}-${comboShortId(combo)}`,
					group: 'helper',
					groupLabel: helperGroupLabel,
					label: comboLabel(combo),
					args: helperPath ? baseArgs(combo, helperPath) : baseArgs(combo),
					credentialKind: credential.kind,
				};
				if (helperPath) probe.tempPaths = [helperPath];
				probes.push(probe);
			}
		});
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
	const hasCredentials = (opts.credentials?.length ?? 0) > 0;
	if (probe.group === 'credential' && !hasCredentials) {
		return (
			opts.credentialMissingReason ??
			'No credential resolved (would have injected an empty token)'
		);
	}
	// Subscription OAuth tokens (sk-ant-oat…) are not valid values for
	// ANTHROPIC_API_KEY (X-Api-Key) or ANTHROPIC_AUTH_TOKEN (Bearer). Skip the
	// env-injection group rather than producing a misleading 401 with a value
	// the API was never going to accept on those headers.
	if (probe.group === 'credential' && probe.credentialKind === 'oauthToken') {
		return 'No API key available. Set ANTHROPIC_API_KEY=sk-ant-api… or pass --api-key=… to run this group (OAuth tokens cannot be injected as env vars per Anthropic auth docs)';
	}
	if (probe.group === 'helper' && !hasCredentials) {
		return (
			opts.credentialMissingReason ??
			'apiKeyHelper would have nothing to print (no credential resolved)'
		);
	}
	if (
		probe.group === 'helper' &&
		!opts.helperSettingsPath &&
		!(
			opts.helperSettingsByCredential &&
			opts.helperSettingsByCredential.size > 0
		)
	) {
		return 'helper settings file was not generated';
	}
	return null;
}
