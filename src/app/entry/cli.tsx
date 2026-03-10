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
import {registerBuiltins} from '../commands/builtins/index';
import {readConfig, readGlobalConfig} from '../../infra/plugins/index';
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
import {
	EXEC_EXIT_CODE,
	EXEC_PERMISSION_POLICIES,
	EXEC_QUESTION_POLICIES,
	EXEC_DEFAULT_PERMISSION_POLICY,
	EXEC_DEFAULT_QUESTION_POLICY,
} from '../exec';
import {runExecCommand} from './execCommand';
import {resolveInteractiveSession} from './interactiveSession';
import {runWorkflowCommand} from './workflowCommand';
import {resolveWorkflowInstallSource} from '../../infra/plugins/marketplace';
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
	'telemetry',
]);
const VALID_ISOLATION_PRESETS = ['strict', 'minimal', 'permissive'] as const;
const EXEC_PERMISSION_POLICIES_HELP = EXEC_PERMISSION_POLICIES.join(', ');
const EXEC_QUESTION_POLICIES_HELP = EXEC_QUESTION_POLICIES.join(', ');

function isIsolationPreset(value: string): value is IsolationPreset {
	return (VALID_ISOLATION_PRESETS as readonly string[]).includes(value);
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
			workflow <sub>        Manage workflows (install, list, update, use-marketplace, update-marketplace, remove, use)
			telemetry [action]    Manage anonymous telemetry (enable/disable/status)

		Options
			--project-dir   Project directory for hook socket (default: cwd)
			--plugin        Path to a Claude Code plugin directory (repeatable)
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
			--on-permission Policy for permission requests: ${EXEC_PERMISSION_POLICIES_HELP} (default: ${EXEC_DEFAULT_PERMISSION_POLICY}, exec mode)
			--on-question   Policy for AskUserQuestion: ${EXEC_QUESTION_POLICIES_HELP} (default: ${EXEC_DEFAULT_QUESTION_POLICY}, exec mode)
			--timeout-ms    Hard timeout for exec run in milliseconds
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
		  $ athena-flow exec "run tests" --json --on-permission=deny --on-question=empty
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
			onPermission: {
				type: 'string',
				default: EXEC_DEFAULT_PERMISSION_POLICY,
			},
			onQuestion: {
				type: 'string',
				default: EXEC_DEFAULT_QUESTION_POLICY,
			},
			timeoutMs: {
				type: 'number',
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

		// Interactive install: renders MCP options wizard if servers have options
		if (subcommand === 'install' && subcommandArgs[0]) {
			const source = subcommandArgs[0];
			let installSource: string;
			try {
				installSource = resolveWorkflowInstallSource(
					source,
					readGlobalConfig().workflowMarketplaceSource ??
						'lespaceman/athena-workflow-marketplace',
				);
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
					source={installSource}
					onDone={code => {
						process.exitCode = code;
					}}
				/>,
				inkRenderOptions(),
			);
			await waitUntilExit();
			return;
		}

		await exitWith(runWorkflowCommand({subcommand, subcommandArgs}));
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

	// Validate isolation preset
	let isolationPreset: IsolationPreset = 'strict';
	if (isIsolationPreset(cli.flags.isolation)) {
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
		});
	} catch (error) {
		console.error(`Error: ${(error as Error).message}`);
		await exitWith(command === 'exec' ? EXEC_EXIT_CODE.BOOTSTRAP : 1);
		return;
	}

	for (const warning of runtimeConfig.warnings) {
		console.error(warning);
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
				onPermission: cli.flags.onPermission,
				onQuestion: cli.flags.onQuestion,
				timeoutMs: cli.flags.timeoutMs,
				verbose: cli.flags.verbose,
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
