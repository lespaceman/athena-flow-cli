import {createClaudeHookRuntime, type ClaudeRuntime} from './runtime';
import {resolveClaudeModel} from './config/modelResolver';
import {verifyClaudeHarness} from './system/verifyHarness';
import {createTokenAccumulator} from './process/tokenAccumulator';
import {
	useClaudeProcess,
	type UseClaudeProcessOptions,
} from './process/useProcess';
import {createClaudeSessionController} from './session/controller';
import type {HarnessAdapter} from '../adapter';
import type {
	BuildHarnessConfigInput,
	HarnessConfigProfile,
} from '../contracts/config';
import type {UseSessionControllerResult} from '../contracts/session';
import type {HarnessProcessConfig} from '../../core/runtime/process';
import type {IsolationConfig, IsolationPreset} from './config/isolation';

function buildClaudeCompatibleIsolationConfig({
	isolationPreset,
	additionalDirectories,
	pluginDirs,
	verbose,
	configuredModel,
}: BuildHarnessConfigInput): HarnessProcessConfig {
	return {
		preset: isolationPreset,
		additionalDirectories,
		pluginDirs: pluginDirs.length > 0 ? pluginDirs : undefined,
		debug: verbose,
		model: configuredModel,
	};
}

const CLAUDE_CONFIG_PROFILE: HarnessConfigProfile = {
	harness: 'claude-code',
	buildIsolationConfig: buildClaudeCompatibleIsolationConfig,
	resolveModelName: ({projectDir, configuredModel}) =>
		resolveClaudeModel({projectDir, configuredModel}),
};

export const claudeHarnessAdapter: HarnessAdapter = {
	id: 'claude-code',
	label: 'Claude Code',
	enabled: true,
	capabilities: {
		conversationModel: 'fresh_per_turn',
		killWaitsForTurnSettlement: true,
		supportsEphemeralSessions: false,
		supportsConfigurableIsolation: true,
	},
	verify: () => verifyClaudeHarness(),
	createRuntime: input =>
		createClaudeHookRuntime({
			projectDir: input.projectDir,
			instanceId: input.instanceId,
		}),
	createSessionController: input => createClaudeSessionController(input),
	useSessionController: input => {
		const claudeRuntime = input.runtime as ClaudeRuntime | null | undefined;
		const process = useClaudeProcess(
			input.projectDir,
			input.instanceId,
			input.processConfig as IsolationConfig | IsolationPreset | undefined,
			input.pluginMcpConfig,
			input.verbose,
			input.workflow,
			{
				...(input.options as UseClaudeProcessOptions | undefined),
				tokenParserFactory:
					input.options?.tokenParserFactory ?? createTokenAccumulator,
				onStdoutChunk: claudeRuntime?.feedStdout.bind(claudeRuntime),
			},
		);

		const controller: UseSessionControllerResult = {
			startTurn: process.spawn,
			isRunning: process.isRunning,
			interrupt: process.sendInterrupt,
			kill: process.kill,
			usage: process.tokenUsage,
		};
		return controller;
	},
	resolveConfigProfile: () => CLAUDE_CONFIG_PROFILE,
};
