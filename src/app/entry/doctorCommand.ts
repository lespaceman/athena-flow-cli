/**
 * `athena doctor --harness=claude` orchestrator.
 *
 * Surveys the local Claude environment, then streams a probe matrix that
 * sweeps `--bare × --setting-sources × auth source` combinations and prints
 * a pass/fail/skip table with a recommended path at the bottom.
 */

import process from 'node:process';
import {
	generateHookSettings,
	registerCleanupOnExit,
} from '../../harnesses/claude/hooks/generateHookSettings';
import {
	collectEnvironment,
	type DoctorEnvironment,
	type SettingsScopeInfo,
} from '../../harnesses/claude/system/doctorEnvironment';
import {
	buildApiKeyHelperSettings,
	buildProbeConfigs,
	classifyFailure,
	credentialHelperKey,
	CREDENTIAL_SOURCES_TRIED,
	formatProbeCommand,
	lookupAllCredentials,
	lookupCredential,
	makeSkippedProbe,
	probeSkipReason,
	runProbe,
	type FailureClassification,
	type ProbeConfig,
	type ProbeResult,
} from '../../harnesses/claude/system/doctorProbes';

export type DoctorCommandOptions = {
	harness: string;
	json: boolean;
	printApiKey: boolean;
	apiKey?: string;
};

const SUPPORTED_HARNESS = 'claude';
const LABEL_WIDTH = 36;
const NON_ANTHROPIC_PROVIDERS = new Set(['bedrock', 'vertex', 'foundry']);

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
	if (env.providerEnvVars.length > 0) {
		console.log(
			c.dim(
				`  note: ANTHROPIC_*/CLAUDE_CODE_* env vars are stripped from each probe's environment so credentials don't leak across the matrix.`,
			),
		);
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

const INDENT = '         ';

function probeHeader(probe: ProbeConfig): string {
	const id = c.dim(`[${probe.id.padEnd(4)}]`);
	const label = probe.label.padEnd(LABEL_WIDTH);
	return `  ${id} ${label}`;
}

function printProbe(
	result: ProbeResult,
	failure: FailureClassification | null,
	options: {previousClassificationTitle?: string} = {},
): void {
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

	if (result.status !== 'na') {
		console.log(c.dim(`${INDENT}$ ${result.command}`));
	}

	if (result.skipReason) {
		console.log(`${INDENT}${c.yellow('⊘')} ${c.dim(result.skipReason)}`);
		return;
	}

	if (!failure) return;

	// Subsequent failures with the same classification show only "(same as
	// above)" so the matrix stays scannable.
	const isRepeat = options.previousClassificationTitle === failure.title;
	console.log(`${INDENT}${c.red('→')} ${failure.title}`);
	if (isRepeat) {
		console.log(`${INDENT}  ${c.dim('(same as above)')}`);
		return;
	}
	if (failure.hint) {
		console.log(`${INDENT}  ${c.dim(failure.hint)}`);
	}
	if (failure.rawLine && failure.rawLine !== failure.title) {
		console.log(`${INDENT}  ${c.dim(failure.rawLine)}`);
	}
}

function printRunningLine(probe: ProbeConfig): void {
	const header = `${probeHeader(probe)} ${c.dim('⏳ running…')}`;
	if (process.stdout.isTTY) {
		process.stdout.write(header);
	} else {
		console.log(header);
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
	const top = passing[0]!;
	return `[${top.id.trim()}] ${top.label}`;
}

function handlePrintApiKey(): number {
	const credential = lookupCredential();
	if (!credential) {
		console.error(
			`No Claude credential found. Tried: ${CREDENTIAL_SOURCES_TRIED.join(', ')}.`,
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

	const isAnthropicProvider = !NON_ANTHROPIC_PROVIDERS.has(
		(env.auth?.apiProvider ?? '').toLowerCase(),
	);

	const cleanups: Array<() => void> = [];
	const strictSettings = generateHookSettings();
	cleanups.push(strictSettings.cleanup);
	registerCleanupOnExit(strictSettings.cleanup);

	const credentials = lookupAllCredentials({
		apiKeyOverride: options.apiKey,
		apiKeyHelperCommand: env.apiKeyHelperCommand,
	});
	const credentialMissingReason =
		credentials.length > 0
			? undefined
			: `No credential resolved (tried: --api-key, ${CREDENTIAL_SOURCES_TRIED.join(', ')})`;

	// One helper settings file per credential so each D-group probes that exact
	// credential value. Skipped for non-Anthropic providers (Bedrock/Vertex/
	// Foundry) since C/D groups are marked N/A and never executed.
	const helperSettingsByCredential = new Map<string, string>();
	if (isAnthropicProvider) {
		for (const credential of credentials) {
			const helper = buildApiKeyHelperSettings(credential.value);
			cleanups.push(helper.cleanup);
			registerCleanupOnExit(helper.cleanup);
			helperSettingsByCredential.set(
				credentialHelperKey(credential),
				helper.settingsPath,
			);
		}
	}

	const buildOpts = {
		strictSettingsPath: strictSettings.settingsPath,
		credentials,
		helperSettingsByCredential,
		credentialMissingReason,
	};
	const probes = buildProbeConfigs(buildOpts);

	// Path aliases: replace long temp paths with $hooks / $helper.<n> so the
	// per-probe command lines stay scannable. The alias table is printed once.
	const aliases = new Map<string, string>();
	aliases.set('hooks', strictSettings.settingsPath);
	let helperIndex = 0;
	for (const helperPath of helperSettingsByCredential.values()) {
		helperIndex += 1;
		aliases.set(
			helperSettingsByCredential.size === 1 ? 'helper' : `helper${helperIndex}`,
			helperPath,
		);
	}
	const formatCommandFn = (probe: ProbeConfig): string =>
		formatProbeCommand(probe, env.claudeBinary!, aliases);

	if (!options.json) {
		printEnvironment(env);
		if (aliases.size > 0) {
			const aliasColumnWidth =
				Math.max(...[...aliases.keys()].map(name => name.length)) + 2;
			console.log(c.dim('  paths'));
			for (const [name, fullPath] of aliases) {
				console.log(
					`    ${c.dim(`$${name}`.padEnd(aliasColumnWidth))} ${fullPath}`,
				);
			}
			console.log('');
		}
	}

	const results: ProbeResult[] = [];
	let currentGroup = '';
	const lastClassificationByGroup = new Map<string, string>();

	const recordAndPrint = (result: ProbeResult) => {
		results.push(result);
		if (options.json) return;
		const previous = lastClassificationByGroup.get(result.groupLabel);
		const failure = classifyFailure(result);
		printProbe(result, failure, {previousClassificationTitle: previous});
		if (failure) {
			lastClassificationByGroup.set(result.groupLabel, failure.title);
		} else {
			lastClassificationByGroup.delete(result.groupLabel);
		}
	};

	for (const probe of probes) {
		if (!options.json && probe.groupLabel !== currentGroup) {
			if (currentGroup !== '') console.log('');
			console.log(c.bold(probe.groupLabel));
			currentGroup = probe.groupLabel;
		}

		const needsCredential =
			probe.group === 'credential' || probe.group === 'helper';
		if (needsCredential && !isAnthropicProvider) {
			recordAndPrint(
				makeSkippedProbe(
					probe,
					`Not applicable: apiProvider=${env.auth?.apiProvider}`,
					'na',
					env.claudeBinary,
					formatCommandFn,
				),
			);
			continue;
		}

		const skipReason = probeSkipReason(probe, buildOpts);
		if (skipReason) {
			recordAndPrint(
				makeSkippedProbe(
					probe,
					skipReason,
					'skip',
					env.claudeBinary,
					formatCommandFn,
				),
			);
			continue;
		}

		if (!options.json) printRunningLine(probe);
		const result = await runProbe({
			claudeBinary: env.claudeBinary,
			probe,
			formatCommandFn,
		});
		if (!options.json) clearRunningLine();
		recordAndPrint(result);
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
