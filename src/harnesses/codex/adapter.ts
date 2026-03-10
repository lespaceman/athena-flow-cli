import {createCodexRuntime} from './runtime';
import {createCodexSessionController} from './session/controller';
import {useCodexSessionController} from './session/useSessionController';
import {verifyCodexHarness} from './system/verifyHarness';
import type {HarnessAdapter} from '../adapter';
import type {HarnessConfigProfile} from '../contracts/config';
import type {UseSessionControllerResult} from '../contracts/session';
import type {HarnessProcessConfig} from '../../core/runtime/process';

const CODEX_CONFIG_PROFILE: HarnessConfigProfile = {
	harness: 'openai-codex',
	buildIsolationConfig: ({isolationPreset, configuredModel}) => ({
		preset: isolationPreset,
		model: configuredModel,
	}),
	resolveModelName: ({configuredModel}) => configuredModel ?? 'gpt-5.3-codex',
};

export const codexHarnessAdapter: HarnessAdapter = {
	id: 'openai-codex',
	label: 'OpenAI Codex',
	enabled: true,
	capabilities: {
		conversationModel: 'persistent_thread',
		killWaitsForTurnSettlement: true,
		supportsEphemeralSessions: true,
		supportsConfigurableIsolation: true,
	},
	verify: () => verifyCodexHarness(),
	createRuntime: input =>
		createCodexRuntime({
			projectDir: input.projectDir,
			instanceId: input.instanceId,
			env: input.workflow?.env,
		}),
	createSessionController: input => createCodexSessionController(input),
	useSessionController: input => {
		const process = useCodexSessionController(
			input.runtime ?? null,
			input.processConfig as HarnessProcessConfig | undefined,
			input.workflowPlan,
			input.ephemeral,
			input.options,
			input.pluginMcpConfig,
		);
		const controller: UseSessionControllerResult = {
			startTurn: process.startTurn,
			isRunning: process.isRunning,
			interrupt: process.sendInterrupt,
			kill: process.kill,
			usage: process.tokenUsage,
		};
		return controller;
	},
	resolveConfigProfile: () => CODEX_CONFIG_PROFILE,
};
