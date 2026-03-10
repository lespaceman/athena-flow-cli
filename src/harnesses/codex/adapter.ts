import {createCodexRuntime} from './runtime';
import {createCodexSessionController} from './session/controller';
import {useCodexSessionController} from './session/useSessionController';
import {verifyCodexHarness} from './system/verifyHarness';
import type {HarnessAdapter} from '../adapter';
import type {HarnessConfigProfile} from '../contracts/config';
import type {UseSessionControllerResult} from '../contracts/session';

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
	verify: () => verifyCodexHarness(),
	createRuntime: input =>
		createCodexRuntime({
			projectDir: input.projectDir,
			instanceId: input.instanceId,
		}),
	createSessionController: input => createCodexSessionController(input),
	useSessionController: input => {
		const process = useCodexSessionController(input.runtime ?? null, input.options);
		const controller: UseSessionControllerResult = {
			spawn: process.spawn,
			isRunning: process.isRunning,
			interrupt: process.sendInterrupt,
			kill: process.kill,
			usage: process.tokenUsage,
		};
		return controller;
	},
	resolveConfigProfile: () => CODEX_CONFIG_PROFILE,
};
