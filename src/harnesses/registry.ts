import type {AthenaHarness} from '../infra/plugins/config';
import type {HarnessProcessConfig} from '../core/runtime/process';
import type {HarnessAdapter} from './adapter';
import {claudeHarnessAdapter} from './claude/adapter';
import {codexHarnessAdapter} from './codex/adapter';
import type {BuildHarnessConfigInput} from './contracts/config';
import type {HarnessVerificationResult} from './types';

export type HarnessCapability = {
	id: AthenaHarness;
	label: string;
	enabled: boolean;
	verify?: () => HarnessVerificationResult;
};

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

const opencodeHarnessAdapter: HarnessAdapter = {
	id: 'opencode',
	label: 'OpenCode',
	enabled: false,
	createRuntime: input => claudeHarnessAdapter.createRuntime(input),
	createSessionController: input =>
		claudeHarnessAdapter.createSessionController(input),
	useSessionController: input =>
		claudeHarnessAdapter.useSessionController(input),
	resolveConfigProfile: () => ({
		harness: 'opencode',
		buildIsolationConfig: input => buildClaudeCompatibleIsolationConfig(input),
		resolveModelName: ({configuredModel}) => configuredModel ?? null,
	}),
};

const HARNESS_ADAPTERS: HarnessAdapter[] = [
	claudeHarnessAdapter,
	codexHarnessAdapter,
	opencodeHarnessAdapter,
];

export function listHarnessAdapters(): HarnessAdapter[] {
	return HARNESS_ADAPTERS;
}

export function resolveHarnessAdapter(harness: AthenaHarness): HarnessAdapter {
	return (
		HARNESS_ADAPTERS.find(candidate => candidate.id === harness) ??
		claudeHarnessAdapter
	);
}

export function listHarnessCapabilities(): HarnessCapability[] {
	return HARNESS_ADAPTERS.map(adapter => ({
		id: adapter.id,
		label: adapter.enabled ? adapter.label : `${adapter.label} (coming soon)`,
		enabled: adapter.enabled,
		verify: adapter.verify,
	}));
}
