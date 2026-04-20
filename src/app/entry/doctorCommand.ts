/**
 * `athena doctor --harness=claude` orchestrator.
 *
 * Surveys the local Claude environment, then runs five `claude -p` probes
 * with different flag combinations and prints a pass/fail matrix.
 */

import process from 'node:process';
import {generateHookSettings} from '../../harnesses/claude/hooks/generateHookSettings';
import {
	collectEnvironment,
	type DoctorEnvironment,
	type SettingsScopeInfo,
} from '../../harnesses/claude/system/doctorEnvironment';
import {
	buildApiKeyHelperSettings,
	buildProbeConfigs,
	lookupCredential,
	makeSkippedProbe,
	probeSkipReason,
	runProbe,
	type ProbeConfig,
	type ProbeResult,
} from '../../harnesses/claude/system/doctorProbes';

export type DoctorCommandOptions = {
	harness: string;
	json: boolean;
	printApiKey: boolean;
};

const SUPPORTED_HARNESS = 'claude';
const LABEL_WIDTH = 36;

const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];
const c = {
	dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
	bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
	green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
	red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
	yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
	cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

function field(label: string, value: string): string {
	return `  ${c.dim(label.padEnd(18))} ${value}`;
}

function fmtBytes(bytes: number | undefined): string {
	if (typeof bytes !== 'number') return '';
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	return `${(kb / 1024).toFixed(1)} MB`;
}

function fmtScope(scope: SettingsScopeInfo): string {
	const name = scope.scope.padEnd(8);
	if (!scope.present) {
		return `${name}${c.dim('absent')}`;
	}
	const size = fmtBytes(scope.sizeBytes);
	const date = scope.mtime ? scope.mtime.slice(0, 10) : '';
	const meta = [size, date].filter(Boolean).join(', ');
	const errSuffix = scope.parseError
		? c.red(` (parse error: ${scope.parseError})`)
		: '';
	return `${name}${scope.path} ${c.dim(`(${meta})`)}${errSuffix}`;
}

function fmtAuth(env: DoctorEnvironment): string {
	if (!env.auth) return 'unknown (claude binary not found)';
	const a = env.auth;
	if (!a.loggedIn) return `not logged in — ${a.rawMessage}`;
	const parts: string[] = ['logged in'];
	if (a.authMethod) parts.push(a.authMethod);
	if (a.subscriptionType) parts.push(`subscription: ${a.subscriptionType}`);
	if (a.apiProvider && a.apiProvider !== 'anthropic') {
		parts.push(`provider: ${a.apiProvider}`);
	}
	return parts.join(' · ');
}

function printEnvironment(env: DoctorEnvironment): void {
	console.log(c.bold('Environment'));
	const binary = env.claudeBinary
		? `${env.claudeBinary}${env.claudeVersion ? c.dim(`  v${env.claudeVersion}`) : ''}`
		: c.red('not found');
	console.log(field('claude binary', binary));
	console.log(field('auth', fmtAuth(env)));
	if (env.auth && (env.auth.email || env.auth.organization)) {
		const acct = [
			env.auth.email,
			env.auth.organization ? `org: ${env.auth.organization}` : null,
		]
			.filter(Boolean)
			.join(' · ');
		console.log(field('account', acct));
	}
	const enf: string[] = [];
	if (env.enforcement.forceLoginMethod) {
		enf.push(`forceLoginMethod=${env.enforcement.forceLoginMethod}`);
	}
	if (env.enforcement.forceLoginOrgUUID) {
		const org = Array.isArray(env.enforcement.forceLoginOrgUUID)
			? env.enforcement.forceLoginOrgUUID.join(',')
			: env.enforcement.forceLoginOrgUUID;
		enf.push(`forceLoginOrgUUID=${org}`);
	}
	if (enf.length) console.log(field('enforcement', enf.join(' · ')));
	if (env.managedPolicyKeys.length) {
		console.log(field('managed policy', env.managedPolicyKeys.join(', ')));
	}
	console.log(
		field(
			'apiKeyHelper',
			env.apiKeyHelperOwner
				? `${env.apiKeyHelperOwner} ${c.dim(`(${env.apiKeyHelperCommand})`)}`
				: c.dim('none'),
		),
	);
	console.log(
		field(
			'provider env',
			env.providerEnvVars.length
				? env.providerEnvVars.join(', ')
				: c.dim('none'),
		),
	);
	console.log(
		field(
			'hook-forwarder',
			`${env.hookForwarder.source}${env.hookForwarder.scriptPath ? c.dim(`  ${env.hookForwarder.scriptPath}`) : ''}`,
		),
	);
	console.log(c.dim('  settings'));
	for (const scope of env.settings) {
		console.log(`    ${fmtScope(scope)}`);
	}
	console.log('');
}

function statusBadge(status: ProbeResult['status']): string {
	switch (status) {
		case 'pass':
			return c.green('✓ PASS');
		case 'fail':
			return c.red('✗ FAIL');
		case 'skip':
			return c.yellow('⊘ SKIP');
		case 'na':
			return c.dim('— N/A ');
	}
}

function extractDiagnostic(result: ProbeResult): string | null {
	const candidates = [result.stdoutTail, result.stderrTail];
	for (const raw of candidates) {
		if (!raw) continue;
		const lines = raw
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.length > 0)
			// Drop the noisy "Command failed: <full claude invocation>" prefix.
			.filter(line => !line.startsWith('Command failed:'));
		if (lines.length === 0) continue;
		return lines[lines.length - 1]!;
	}
	return null;
}

function printProbe(result: ProbeResult): void {
	const duration =
		result.durationMs > 0
			? c.dim(` ${(result.durationMs / 1000).toFixed(1)}s`)
			: '';
	const exit =
		result.exitCode !== null && result.status === 'fail'
			? c.dim(`  exit ${result.exitCode}`)
			: '';
	const id = c.dim(`[${result.id.padEnd(4)}]`);
	const label = result.label.padEnd(LABEL_WIDTH);
	console.log(
		`  ${id} ${label} ${statusBadge(result.status)}${duration}${exit}`,
	);

	if (result.skipReason) {
		console.log(`           ${c.dim(result.skipReason)}`);
		return;
	}

	if (result.status !== 'fail') return;

	const diagnostic = extractDiagnostic(result);
	if (diagnostic) {
		console.log(`           ${c.red('→')} ${diagnostic}`);
	}
}

function probeHeader(probe: ProbeConfig): string {
	const id = c.dim(`[${probe.id.padEnd(4)}]`);
	const label = probe.label.padEnd(LABEL_WIDTH);
	return `  ${id} ${label}`;
}

function printRunningLine(probe: ProbeConfig): void {
	const line = `${probeHeader(probe)} ${c.dim('⏳ running…')}`;
	if (process.stdout.isTTY) {
		process.stdout.write(line);
	} else {
		console.log(line);
	}
}

function clearRunningLine(): void {
	if (process.stdout.isTTY) {
		process.stdout.write('\r\x1b[K');
	}
}

function summarize(results: ProbeResult[]): {
	pass: number;
	fail: number;
	skip: number;
	na: number;
} {
	const out = {pass: 0, fail: 0, skip: 0, na: 0};
	for (const r of results) {
		out[r.status] += 1;
	}
	return out;
}

function recommendation(results: ProbeResult[]): string | null {
	const passing = results.filter(r => r.status === 'pass');
	if (passing.length === 0) return null;
	return passing[0]!.label;
}

function resolveAthenaBinary(): string {
	if (process.env['ATHENA_BIN']) return process.env['ATHENA_BIN']!;
	const argv0 = process.argv[1];
	if (argv0) return argv0;
	return 'athena';
}

function handlePrintApiKey(): number {
	const credential = lookupCredential();
	if (!credential) {
		console.error(
			'No Claude credential found. Tried: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, macOS keychain "Claude Code-credentials", and ~/.claude/.credentials.json.',
		);
		return 1;
	}
	process.stdout.write(credential.value);
	return 0;
}

export async function runDoctorCommand(
	options: DoctorCommandOptions,
): Promise<number> {
	if (options.printApiKey) {
		return handlePrintApiKey();
	}

	if (options.harness !== SUPPORTED_HARNESS) {
		console.error(
			`Error: doctor only supports --harness=claude (got '${options.harness}').`,
		);
		return 2;
	}

	const env = collectEnvironment();

	if (!env.claudeBinary) {
		const payload = {
			harness: options.harness,
			environment: env,
			probes: [],
			summary: {pass: 0, fail: 1, skip: 0, na: 0},
			error: 'Claude binary not found in PATH. Install Claude Code and retry.',
		};
		if (options.json) {
			process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		} else {
			printEnvironment(env);
			console.error(payload.error);
		}
		return 1;
	}

	const cleanups: Array<() => void> = [];
	const strictSettings = generateHookSettings();
	cleanups.push(strictSettings.cleanup);

	const credential = lookupCredential();
	const credentialMissingReason = credential
		? undefined
		: 'No credential resolved (tried: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, settings apiKeyHelper, CLAUDE_CODE_OAUTH_TOKEN, macOS keychain, ~/.claude/.credentials.json)';
	const helperSettings = buildApiKeyHelperSettings(resolveAthenaBinary());
	cleanups.push(helperSettings.cleanup);

	const buildOpts = {
		strictSettingsPath: strictSettings.settingsPath,
		helperSettingsPath: helperSettings.settingsPath,
		credential: credential ?? undefined,
		credentialMissingReason,
	};
	const probes = buildProbeConfigs(buildOpts);

	const NON_ANTHROPIC_PROVIDERS = new Set(['bedrock', 'vertex', 'foundry']);
	const isAnthropicProvider = !NON_ANTHROPIC_PROVIDERS.has(
		(env.auth?.apiProvider ?? '').toLowerCase(),
	);

	if (!options.json) {
		printEnvironment(env);
	}

	const results: ProbeResult[] = [];
	let currentGroup = '';
	for (const probe of probes) {
		if (!options.json && probe.groupLabel !== currentGroup) {
			if (currentGroup !== '') console.log('');
			console.log(c.bold(probe.groupLabel));
			currentGroup = probe.groupLabel;
		}

		const needsCredential =
			probe.group === 'credential' || probe.group === 'helper';
		if (needsCredential && !isAnthropicProvider) {
			const result = makeSkippedProbe(
				probe,
				`Not applicable: apiProvider=${env.auth?.apiProvider}`,
				'na',
			);
			results.push(result);
			if (!options.json) printProbe(result);
			continue;
		}

		const skipReason = probeSkipReason(probe, buildOpts);
		if (skipReason) {
			const result = makeSkippedProbe(probe, skipReason);
			results.push(result);
			if (!options.json) printProbe(result);
			continue;
		}

		if (!options.json) printRunningLine(probe);
		const result = await runProbe({claudeBinary: env.claudeBinary, probe});
		if (!options.json) {
			clearRunningLine();
			printProbe(result);
		}
		results.push(result);
	}

	for (const fn of cleanups) {
		try {
			fn();
		} catch {
			// best-effort
		}
	}

	const summary = summarize(results);
	const exitCode = summary.fail > 0 ? 1 : 0;

	if (options.json) {
		const payload = {
			harness: options.harness,
			environment: env,
			probes: results,
			summary,
			recommendation: recommendation(results),
		};
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return exitCode;
	}

	console.log('');
	const rec = recommendation(results);
	const summaryParts = [
		c.green(`${summary.pass} pass`),
		summary.fail > 0 ? c.red(`${summary.fail} fail`) : c.dim('0 fail'),
		summary.skip > 0 ? c.yellow(`${summary.skip} skip`) : c.dim('0 skip'),
		summary.na > 0 ? c.dim(`${summary.na} n/a`) : c.dim('0 n/a'),
	];
	const summaryLine = summaryParts.join('  ');
	console.log(
		rec
			? `${summaryLine}   ${c.dim('→')}  recommended: ${c.cyan(rec)}`
			: summaryLine,
	);

	return exitCode;
}
