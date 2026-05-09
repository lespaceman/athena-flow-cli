#!/usr/bin/env node
import {render} from 'ink';
import meow from 'meow';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import App from '../shell/AppShell';
import {processRegistry} from '../../shared/utils/processRegistry';
import {type IsolationPreset} from '../../harnesses/claude/config/isolation';
import type {AthenaHarness} from '../../infra/plugins/config';
import {listHarnessAdapters} from '../../harnesses/registry';
import {registerBuiltins} from '../commands/builtins/index';
import {
	readConfig,
	readGlobalConfig,
	resolveActiveWorkflow,
} from '../../infra/plugins/index';
import {
	initTelemetry,
	shutdownTelemetry,
	generateDeviceId,
	trackAppLaunched,
	trackError,
	trackTelemetryOptedOut,
} from '../../infra/telemetry/index';
import {writeGlobalConfig} from '../../infra/plugins/config';
import {bootstrapRuntimeConfig} from '../bootstrap/bootstrapConfig';
import {resolveTheme} from '../../ui/theme/index';
import {shouldShowSetup} from '../../setup/shouldShowSetup';
import {EXEC_EXIT_CODE} from '../exec';
import {runExecCommand} from './execCommand';
import {resolveInteractiveSession} from './interactiveSession';
import {runWorkflowCommand} from './workflowCommand';
import {runMarketplaceCommand} from './marketplaceCommand';
import {runChannelCommand} from './channelCommand';
import {runDashboardCommand} from './dashboardCommand';
import {runGatewayCommand} from './gatewayCommand';
import {runDoctorCommand} from './doctorCommand';
import {resolveWorkflowInstall} from '../../infra/plugins/marketplace';
import {
	installStdoutWriteMonitor,
	isPerfEnabled,
	logInkRender,
} from '../../shared/utils/perf';

function resolvePackageJsonPath(entryUrl: string): string {
	let currentDir = path.dirname(fileURLToPath(entryUrl));

	for (;;) {
		const candidatePath = path.join(currentDir, 'package.json');
		if (fs.existsSync(candidatePath)) {
			return candidatePath;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			throw new Error('Could not locate package.json for CLI metadata.');
		}

		currentDir = parentDir;
	}
}

const require = createRequire(import.meta.url);
const {version} = require(resolvePackageJsonPath(import.meta.url)) as {
	version: string;
};

const KNOWN_COMMANDS = new Set([
	'setup',
	'sessions',
	'resume',
	'exec',
	'workflow',
	'marketplace',
	'channel',
	'gateway',
	'dashboard',
	'telemetry',
	'doctor',
]);
const VALID_ISOLATION_PRESETS = ['strict', 'minimal', 'permissive'] as const;
const VALID_HARNESSES = listHarnessAdapters()
	.filter(a => a.enabled)
	.map(a => a.id);

function isOneOf<T extends string>(
	value: string,
	set: readonly T[],
): value is T {
	return (set as readonly string[]).includes(value);
}

async function exitWith(code: number): Promise<never> {
	await shutdownTelemetry();
	process.exit(code);
}

async function flushTelemetryOptOut(config: {
	deviceId?: string;
	telemetry?: boolean;
}): Promise<void> {
	if (config.telemetry === false) {
		return;
	}

	let deviceId = config.deviceId;
	if (!deviceId) {
		deviceId = generateDeviceId();
		writeGlobalConfig({deviceId});
	}

	initTelemetry({
		deviceId,
		telemetryEnabled: config.telemetry,
		appVersion: version,
		os: `${os.platform()}-${os.arch()}`,
	});
	trackTelemetryOptedOut();
	await shutdownTelemetry();
}

function printExecDryRunSummary(
	runtimeConfig: ReturnType<typeof bootstrapRuntimeConfig>,
	context: {
		projectDir: string;
		isolationPresetCli: IsolationPreset;
		workflowOverride: string | undefined;
		pluginFlags: string[];
	},
): void {
	const selection = resolveActiveWorkflow({
		globalConfig: runtimeConfig.globalConfig,
		projectConfig: runtimeConfig.projectConfig,
		override: context.workflowOverride,
	});
	const lines: string[] = [
		'athena-flow exec --dry-run',
		`  project:           ${context.projectDir}`,
		`  harness:           ${runtimeConfig.harness}`,
		`  active workflow:   ${selection.name} [${selection.source}]`,
	];
	if (runtimeConfig.workflow) {
		const version = runtimeConfig.workflow.version
			? ` (${runtimeConfig.workflow.version})`
			: '';
		lines.push(`  resolved workflow: ${runtimeConfig.workflow.name}${version}`);
	} else {
		lines.push('  resolved workflow: <none>');
	}
	if (context.workflowOverride !== undefined) {
		lines.push(`  --workflow flag:   ${context.workflowOverride}`);
	}
	lines.push(`  isolation (cli):   ${context.isolationPresetCli}`);
	lines.push(`  isolation (final): ${runtimeConfig.isolationConfig.preset}`);
	lines.push(`  model:             ${runtimeConfig.modelName ?? '(default)'}`);
	const pluginDirs = runtimeConfig.isolationConfig.pluginDirs ?? [];
	if (pluginDirs.length === 0) {
		lines.push('  plugin dirs:       <none>');
	} else {
		lines.push('  plugin dirs:');
		for (const dir of pluginDirs) {
			lines.push(`    - ${dir}`);
		}
	}
	if (context.pluginFlags.length > 0) {
		lines.push('  --plugin flags:');
		for (const flag of context.pluginFlags) {
			lines.push(`    - ${flag}`);
		}
	}
	lines.push(
		`  plugin mcp config: ${runtimeConfig.pluginMcpConfig ?? '<none>'}`,
	);
	for (const line of lines) {
		console.log(line);
	}
}

function inkRenderOptions() {
	// Ink's incremental diffing corrupts full-frame setup screens when
	// selection rows grow/shrink and shift surrounding content vertically.
	if (isPerfEnabled()) {
		installStdoutWriteMonitor(process.stdout);
		return {
			onRender: ({renderTime}: {renderTime: number}) => {
				logInkRender(renderTime);
			},
		};
	}

	return {};
}

// Set terminal tab title immediately so it appears before React renders.
// Only when stdout is a TTY — otherwise we'd be writing escape sequences
// into a pipe (e.g. `athena gateway status --json | jq`) and corrupting
// the consumer.
if (process.stdout.isTTY) {
	process.stdout.write('\x1b]1;Athena\x07\x1b]2;Athena\x07');
}

// Register cleanup handlers early to catch all exit scenarios
processRegistry.registerCleanupHandlers();

const cli = meow(
	`
		Usage
		  $ athena-flow [command] [options]

		Commands
			setup                 Re-run setup wizard
			sessions              Launch interactive session picker
			resume [sessionId]    Resume most recent (or specified) session
			exec "<prompt>"       Run non-interactively (CI/script mode)
			workflow <sub>        Manage workflows (install, list, search, remove, upgrade, use)
			marketplace <sub>     Manage marketplace sources (add, remove, list)
			channel <sub>         Manage external channels
			dashboard <sub>       Manage dashboard remote-instance pairing (pair, status, refresh, connect, unpair)
			telemetry [action]    Manage anonymous telemetry (enable/disable/status)
			doctor                Diagnose Claude headless setup (use with --harness=claude)

		Options
			--project-dir   Project directory for hook socket (default: cwd)
			--plugin        Path to a Claude Code plugin directory (repeatable)
			--harness       Runtime harness: claude-code (default), openai-codex
			--isolation     Isolation preset for spawned Claude process:
			                  strict (default) - Full isolation, no MCP servers
			                  minimal - Full isolation, allow project MCP servers
			                  permissive - Full isolation, allow project MCP servers
			--verbose       Show additional rendering detail and streaming display
			--theme         Color theme: dark (default), light, or high-contrast
			--ascii         Use ASCII-only UI glyphs for compatibility
			--continue      Resume most recent exec session, or use --continue=<athenaSessionId> (exec mode)
			--json          Emit JSONL events to stdout (exec mode)
			--output-last-message  Write final assistant message to a file (exec mode)
			--ephemeral     Do not persist Athena session data (exec mode)
			--timeout-ms    Hard timeout for exec run in milliseconds
			--workflow      Override the active workflow for this run only (no config change)
			--channel       Attach a channel for permission/question relay (repeatable). Built-in: telegram
			--bot-token     Telegram bot token (channel telegram configure)
			--user-id       Telegram allowed user id (channel telegram configure)
			--chat-id       Telegram destination chat id (defaults to --user-id)
			--token         Gateway link token (gateway link)
			--url           Dashboard origin (dashboard pair)
			--name          Friendly machine name (dashboard pair)
			--tls-ca        Gateway custom CA path (gateway link)
			--tls-cert      Gateway TLS certificate path (gateway start)
			--tls-key       Gateway TLS private key path (gateway start)
			--bind          Gateway listen address host:port (gateway start)
			--insecure      Allow plain WS on non-loopback trusted tunnels (gateway start)
			--grace-period-ms Gateway reconnect grace period in milliseconds (gateway start)
			--dry-run       Print resolved bootstrap (workflow, isolation, plugins, harness) and exit (exec mode)
			--project       Scope workflow command to project config (workflow use)
			--global        Scope workflow command to global config (workflow use, default)
			--help          Show command help
			--version       Show CLI version

		Note: All isolation modes use --setting-sources "" to completely isolate
		      from Claude Code's settings. athena-flow is fully self-contained.

	Config Files
		Global:  ~/.config/athena/config.json
		Project: {projectDir}/.athena/config.json
		Format:  {
		           "plugins": ["/path/to/plugin"],
		           "additionalDirectories": ["/path/to/allow"]
		         }
		Merge order: global → project → --plugin flags

		Examples
		  $ athena-flow
		  $ athena-flow setup
		  $ athena-flow sessions
		  $ athena-flow resume
		  $ athena-flow resume <sessionId>
		  $ athena-flow exec "summarize current repo status"
		  $ athena-flow exec "run tests" --json
		  $ athena-flow exec "delete /tmp/foo" --channel telegram
		  $ athena-flow --project-dir=/my/project
		  $ athena-flow --plugin=/path/to/my-plugin
		  $ athena-flow --isolation=minimal
		  $ athena-flow --verbose
		  $ athena-flow --ascii
	`,
	{
		importMeta: import.meta,
		allowUnknownFlags: false,
		flags: {
			projectDir: {
				type: 'string',
				default: process.cwd(),
			},
			plugin: {
				type: 'string',
				isMultiple: true,
			},
			harness: {
				type: 'string',
			},
			isolation: {
				type: 'string',
				default: 'strict',
			},
			verbose: {
				type: 'boolean',
				default: false,
			},
			theme: {
				type: 'string',
			},
			ascii: {
				type: 'boolean',
				default: false,
			},
			continue: {
				type: 'string',
			},
			json: {
				type: 'boolean',
				default: false,
			},
			outputLastMessage: {
				type: 'string',
			},
			ephemeral: {
				type: 'boolean',
				default: false,
			},
			timeoutMs: {
				type: 'number',
			},
			workflow: {
				type: 'string',
			},
			channel: {
				type: 'string',
				isMultiple: true,
			},
			botToken: {
				type: 'string',
			},
			userId: {
				type: 'string',
			},
			chatId: {
				type: 'string',
			},
			token: {
				type: 'string',
			},
			url: {
				type: 'string',
			},
			name: {
				type: 'string',
			},
			runner: {
				type: 'string',
			},
			tlsCa: {
				type: 'string',
			},
			tlsCert: {
				type: 'string',
			},
			tlsKey: {
				type: 'string',
			},
			bind: {
				type: 'string',
			},
			insecure: {
				type: 'boolean',
				default: false,
			},
			gracePeriodMs: {
				type: 'number',
			},
			dryRun: {
				type: 'boolean',
				default: false,
			},
			project: {
				type: 'boolean',
				default: false,
			},
			global: {
				type: 'boolean',
				default: false,
			},
			printApiKey: {
				type: 'boolean',
				default: false,
			},
			apiKey: {
				type: 'string',
			},
		},
	},
);

async function main(): Promise<void> {
	const projectDir = path.resolve(cli.flags.projectDir);
	const [command, ...commandArgs] = cli.input;

	if (command && !KNOWN_COMMANDS.has(command)) {
		console.error(
			`Unknown command: ${command}\n` +
				`Available commands: ${[...KNOWN_COMMANDS].join(', ')}`,
		);
		await exitWith(1);
		return;
	}

	if (
		(command === 'setup' || command === 'sessions') &&
		commandArgs.length > 0
	) {
		console.error(`Command "${command}" does not accept positional arguments.`);
		await exitWith(1);
		return;
	}

	if (command === 'resume' && commandArgs.length > 1) {
		console.error('Usage: athena-flow resume [sessionId]');
		await exitWith(1);
		return;
	}

	if (command === 'exec' && commandArgs.length !== 1) {
		console.error('Usage: athena-flow exec "<prompt>" [options]');
		await exitWith(EXEC_EXIT_CODE.USAGE);
		return;
	}

	if (command === 'workflow') {
		const [subcommand = '', ...subcommandArgs] = commandArgs;
		if (cli.flags.project) subcommandArgs.push('--project');
		if (cli.flags.global) subcommandArgs.push('--global');

		// Interactive install: renders MCP options wizard if servers have options
		if (subcommand === 'install' && subcommandArgs[0]) {
			const source = subcommandArgs[0];
			let resolvedSource: import('../../infra/plugins/marketplace').ResolvedWorkflowSource;
			try {
				const sources = readGlobalConfig().workflowMarketplaceSources ?? [
					'lespaceman/athena-workflow-marketplace',
				];
				resolvedSource = resolveWorkflowInstall(source, sources);
			} catch (error) {
				console.error(
					`Error: ${error instanceof Error ? error.message : String(error)}`,
				);
				await exitWith(1);
				return;
			}
			const {default: WorkflowInstallWizard} =
				await import('../../setup/steps/WorkflowInstallWizard');
			const {waitUntilExit} = render(
				<WorkflowInstallWizard
					source={resolvedSource}
					onDone={code => {
						process.exitCode = code;
					}}
				/>,
				inkRenderOptions(),
			);
			await waitUntilExit();
			return;
		}

		await exitWith(
			runWorkflowCommand({subcommand, subcommandArgs, projectDir}),
		);
		return;
	}

	if (command === 'marketplace') {
		const [subcommand = '', ...subcommandArgs] = commandArgs;
		await exitWith(runMarketplaceCommand({subcommand, subcommandArgs}));
		return;
	}

	if (command === 'channel') {
		await exitWith(
			runChannelCommand({
				subcommandArgs: commandArgs,
				flags: {
					botToken:
						typeof cli.flags.botToken === 'string'
							? cli.flags.botToken
							: undefined,
					userId:
						typeof cli.flags.userId === 'string' ? cli.flags.userId : undefined,
					chatId:
						typeof cli.flags.chatId === 'string' ? cli.flags.chatId : undefined,
				},
			}),
		);
		return;
	}

	if (command === 'gateway') {
		const [subcommand = '', ...subcommandArgs] = commandArgs;
		// Top-level meow consumes --json into cli.flags before subcommand args
		// are sliced off; forward it so `gateway probe/status` see it.
		if (cli.flags.json) subcommandArgs.push('--json');
		if (typeof cli.flags.token === 'string') {
			subcommandArgs.push('--token', cli.flags.token);
		}
		if (typeof cli.flags.tlsCa === 'string') {
			subcommandArgs.push('--tls-ca', cli.flags.tlsCa);
		}
		if (typeof cli.flags.tlsCert === 'string') {
			subcommandArgs.push('--tls-cert', cli.flags.tlsCert);
		}
		if (typeof cli.flags.tlsKey === 'string') {
			subcommandArgs.push('--tls-key', cli.flags.tlsKey);
		}
		if (typeof cli.flags.bind === 'string') {
			subcommandArgs.push('--bind', cli.flags.bind);
		}
		if (cli.flags.insecure) {
			subcommandArgs.push('--insecure');
		}
		if (typeof cli.flags.gracePeriodMs === 'number') {
			subcommandArgs.push('--grace-period-ms', String(cli.flags.gracePeriodMs));
		}
		await exitWith(await runGatewayCommand({subcommand, subcommandArgs}));
		return;
	}

	if (command === 'dashboard') {
		const [subcommand = '', ...subcommandArgs] = commandArgs;
		await exitWith(
			await runDashboardCommand({
				subcommand,
				subcommandArgs,
				flags: {
					url: typeof cli.flags.url === 'string' ? cli.flags.url : undefined,
					name: typeof cli.flags.name === 'string' ? cli.flags.name : undefined,
					runner:
						typeof cli.flags.runner === 'string' ? cli.flags.runner : undefined,
					json: Boolean(cli.flags.json),
				},
			}),
		);
		return;
	}

	if (command === 'doctor') {
		const harness =
			(typeof cli.flags.harness === 'string' && cli.flags.harness) || 'claude';
		await exitWith(
			await runDoctorCommand({
				harness,
				json: Boolean(cli.flags.json),
				printApiKey: Boolean(cli.flags.printApiKey),
				apiKey:
					typeof cli.flags.apiKey === 'string' ? cli.flags.apiKey : undefined,
			}),
		);
		return;
	}

	if (command === 'telemetry') {
		const currentConfig = readGlobalConfig();
		const action = commandArgs[0] ?? 'status';
		if (action === 'disable') {
			await flushTelemetryOptOut(currentConfig);
			writeGlobalConfig({telemetry: false});
			console.log(
				'Telemetry disabled. No anonymous usage data will be collected.',
			);
		} else if (action === 'enable') {
			writeGlobalConfig({telemetry: true});
			console.log(
				'Telemetry enabled. Anonymous usage data will be collected on next launch.',
			);
		} else {
			const envDisabled = process.env['ATHENA_TELEMETRY_DISABLED'] === '1';
			const isEnabled = currentConfig.telemetry !== false && !envDisabled;
			console.log(
				`Telemetry is currently ${isEnabled ? 'enabled' : 'disabled'}.`,
			);
		}
		return;
	}

	let harnessOverride: AthenaHarness | undefined;
	if (cli.flags.harness) {
		if (isOneOf(cli.flags.harness, VALID_HARNESSES)) {
			harnessOverride = cli.flags.harness as AthenaHarness;
		} else {
			console.error(
				`Error: Invalid harness '${cli.flags.harness}'. Valid options: ${VALID_HARNESSES.join(', ')}`,
			);
			await exitWith(command === 'exec' ? EXEC_EXIT_CODE.USAGE : 1);
			return;
		}
	}

	// Validate isolation preset
	let isolationPreset: IsolationPreset = 'strict';
	if (isOneOf(cli.flags.isolation, VALID_ISOLATION_PRESETS)) {
		isolationPreset = cli.flags.isolation;
	} else if (cli.flags.isolation !== 'strict') {
		console.error(
			`Warning: Invalid isolation preset '${cli.flags.isolation}', using 'strict'`,
		);
	}

	// Register commands: builtins first, then plugins (global -> project -> CLI flags)
	registerBuiltins();
	const globalConfig = readGlobalConfig();
	const projectConfig = readConfig(projectDir);

	// Interactive setup wizard must not run in exec mode
	const showSetup =
		command === 'exec'
			? false
			: shouldShowSetup({
					cliInput: cli.input,
					setupComplete: globalConfig.setupComplete,
					globalConfigExists: fs.existsSync(
						path.join(os.homedir(), '.config', 'athena', 'config.json'),
					),
				});

	let runtimeConfig: ReturnType<typeof bootstrapRuntimeConfig>;
	try {
		runtimeConfig = bootstrapRuntimeConfig({
			projectDir,
			showSetup,
			pluginFlags: cli.flags.plugin ?? [],
			isolationPreset,
			verbose: cli.flags.verbose,
			globalConfig,
			projectConfig,
			harnessOverride,
			workflowOverride: cli.flags.workflow,
		});
	} catch (error) {
		console.error(`Error: ${(error as Error).message}`);
		await exitWith(command === 'exec' ? EXEC_EXIT_CODE.BOOTSTRAP : 1);
		return;
	}

	for (const warning of runtimeConfig.warnings) {
		console.error(warning);
	}

	if (cli.flags.dryRun) {
		if (command !== 'exec') {
			console.error('Error: --dry-run is only supported in exec mode.');
			await exitWith(EXEC_EXIT_CODE.USAGE);
			return;
		}
		printExecDryRunSummary(runtimeConfig, {
			projectDir,
			isolationPresetCli: isolationPreset,
			workflowOverride: cli.flags.workflow,
			pluginFlags: cli.flags.plugin ?? [],
		});
		await exitWith(0);
		return;
	}

	// Initialize anonymous telemetry
	const isFirstRun = !globalConfig.deviceId;
	let resolvedDeviceId = globalConfig.deviceId;
	if (!resolvedDeviceId) {
		resolvedDeviceId = generateDeviceId();
		writeGlobalConfig({deviceId: resolvedDeviceId});
	}
	initTelemetry({
		deviceId: resolvedDeviceId,
		telemetryEnabled: globalConfig.telemetry,
		appVersion: version,
		os: `${os.platform()}-${os.arch()}`,
	});
	trackAppLaunched({version, harness: runtimeConfig.harness});

	// Show telemetry notice on first run
	if (command !== 'exec' && isFirstRun && globalConfig.telemetry !== false) {
		console.log(
			'\n  Athena collects anonymous usage data to improve the product.' +
				"\n  Run 'athena-flow telemetry disable' or set ATHENA_TELEMETRY_DISABLED=1 to opt out.\n",
		);
	}

	if (command === 'exec') {
		const exitCode = await runExecCommand({
			projectDir,
			prompt: commandArgs[0]!,
			flags: {
				continueFlag: cli.flags.continue,
				json: cli.flags.json,
				outputLastMessage: cli.flags.outputLastMessage,
				ephemeral: cli.flags.ephemeral,
				timeoutMs: cli.flags.timeoutMs,
				verbose: cli.flags.verbose,
				channels: cli.flags.channel ?? [],
			},
			runtimeConfig,
		});

		await exitWith(exitCode);
		return;
	}

	const showSessionPicker = command === 'sessions';
	const resumeSessionId = command === 'resume' ? commandArgs[0] : undefined;
	const resumeMostRecent = command === 'resume' && !resumeSessionId;

	// Resolve theme: CLI flag > project config > global config > default
	const themeName =
		cli.flags.theme ?? projectConfig.theme ?? globalConfig.theme ?? 'dark';
	const theme = resolveTheme(themeName);

	const interactiveSession = resolveInteractiveSession({
		projectDir,
		resumeSessionId,
		resumeMostRecent,
		logError: console.error,
	});
	if (!interactiveSession) {
		await exitWith(1);
		return;
	}

	const {athenaSessionId, initialSessionId} = interactiveSession;
	const instanceId = process.pid;

	// Channel attachments are deferred to the gateway in M6+; the legacy
	// per-session channel-subprocess wiring has been removed.

	render(
		<App
			projectDir={projectDir}
			instanceId={instanceId}
			harness={runtimeConfig.harness}
			isolation={runtimeConfig.isolationConfig}
			verbose={cli.flags.verbose}
			version={version}
			pluginMcpConfig={runtimeConfig.pluginMcpConfig}
			modelName={runtimeConfig.modelName}
			theme={theme}
			initialSessionId={initialSessionId}
			athenaSessionId={athenaSessionId}
			showSessionPicker={showSessionPicker}
			workflowRef={runtimeConfig.workflowRef}
			workflow={runtimeConfig.workflow}
			workflowPlan={runtimeConfig.workflowPlan}
			pluginFlags={cli.flags.plugin ?? []}
			isolationPreset={isolationPreset}
			ascii={cli.flags.ascii}
			showSetup={showSetup}
			initialTelemetryDiagnosticsConsent={globalConfig.telemetryDiagnostics}
		/>,
		inkRenderOptions(),
	);
}

void main().catch(async error => {
	trackError({
		errorName: error instanceof Error ? error.name : 'UnknownError',
		stackTrace: error instanceof Error ? (error.stack ?? '') : String(error),
	});
	console.error(
		`Error: ${error instanceof Error ? error.message : String(error)}`,
	);
	await exitWith(1);
});
